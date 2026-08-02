const path = require('path');
const { pool } = require('../db/mysql');
const config = require('../config/env');
const { processUploadedImage, thumbFilenameFor } = require('../utils/imageThumbs');
const { storeBuffer, deleteStored } = require('../utils/imageStorage');

const MIME_MAP = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

// Build a unique, collision-safe filename using the output extension.
const buildFilename = (fieldname, ext) => {
  const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
  return `${fieldname}-${uniqueSuffix}.${ext}`;
};

// `images` is global (shared/deduplicated across every area, §2.5/§2.6),
// so "is this image used anywhere" is deliberately a CROSS-AREA scan —
// none of these six queries filter by area_id, on purpose. The settings
// one specifically used to carry a `LIMIT 1`, which only ever checked
// area 1's UPI QR image; every other area's would report as unused and
// get deleted by cleanupOrphanedImage/the admin Images page (§6.4). Fixed
// by dropping the LIMIT — addUsage already iterates every row returned.
const getUsedImageIds = async () => {
  const [products] = await pool.query('SELECT DISTINCT image_id FROM products WHERE image_id IS NOT NULL AND deleted = 0');
  const [categories] = await pool.query('SELECT DISTINCT image_id FROM categories WHERE image_id IS NOT NULL AND deleted = 0');
  const [combos] = await pool.query('SELECT DISTINCT image_id FROM combos WHERE image_id IS NOT NULL AND deleted = 0');
  const [offers] = await pool.query('SELECT DISTINCT image_id FROM offers WHERE image_id IS NOT NULL AND deleted = 0');
  const [settings] = await pool.query('SELECT upi_qr_image_id FROM settings WHERE upi_qr_image_id IS NOT NULL');
  const [storeModes] = await pool.query('SELECT DISTINCT icon_image_id FROM store_modes WHERE icon_image_id IS NOT NULL');

  const used = new Set();
  const usageMap = {};

  const addUsage = (rows, type, field = 'image_id') => {
    for (const r of rows) {
      const id = String(r[field]);
      used.add(id);
      if (!usageMap[id]) usageMap[id] = [];
      if (!usageMap[id].includes(type)) usageMap[id].push(type);
    }
  };

  addUsage(products, 'Product');
  addUsage(categories, 'Category');
  addUsage(combos, 'Combo');
  addUsage(offers, 'Offer');
  addUsage(settings, 'Settings', 'upi_qr_image_id');
  addUsage(storeModes, 'Store Mode', 'icon_image_id');

  return { used, usageMap };
};

const getImageUrl = (image) => {
  if (!image) return null;
  return image.url ||
    (image.filename ? `${config.PUBLIC_BASE_URL}${config.STATIC_UPLOAD_PATH}/${image.filename}` : null);
};

const normalizeImage = (row) => {
  if (!row) return row;
  const url = getImageUrl(row);
  const thumbUrl = row.thumb_url || null;

  return {
    id: String(row.id),
    filename: row.filename,
    originalName: row.original_name,
    mimeType: row.mime_type,
    size: row.size,
    storageType: row.storage_type,
    altText: row.alt_text,
    imageUrl: url,
    image_url: url,
    url,
    thumbUrl,
    thumb_url: thumbUrl,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
};

/**
 * Optimize + store full image and WebP thumb.
 * Works for STORAGE_DRIVER=s3 (production) and disk (dev).
 * Returns metadata ready for INSERT into images.
 */
const processAndStoreUpload = async (inputBuffer, detectedExt, originalname) => {
  const sourceExt = detectedExt || (path.extname(originalname || '').replace('.', '') || 'jpg');
  const { full, thumb } = await processUploadedImage(inputBuffer, sourceExt);

  // Prefer optimized full; fall back to raw upload so a sharp failure never blocks admin.
  const fullPayload = full || {
    buffer: inputBuffer,
    mimeType: MIME_MAP[sourceExt] || 'image/jpeg',
    ext: sourceExt === 'jpeg' ? 'jpg' : sourceExt,
  };

  const filename = buildFilename('image', fullPayload.ext);
  const safeOriginalName = path.basename(originalname || filename).replace(/[^a-zA-Z0-9._-]/g, '');

  const { url, storageType } = await storeBuffer(filename, fullPayload.buffer, fullPayload.mimeType);

  let thumbUrl = null;
  if (thumb) {
    try {
      const thumbFilename = thumbFilenameFor(filename, thumb.ext);
      const stored = await storeBuffer(thumbFilename, thumb.buffer, thumb.mimeType);
      thumbUrl = stored.url;
    } catch (err) {
      console.error('[images] thumb store failed:', err.message);
    }
  }

  return {
    filename,
    safeOriginalName,
    mimetype: fullPayload.mimeType,
    size: fullPayload.buffer.length,
    storageType,
    url,
    thumbUrl,
  };
};

const uploadImage = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'No image file provided' });
  }

  const { buffer, originalname, detectedExt } = req.file;
  const stored = await processAndStoreUpload(buffer, detectedExt, originalname);
  const altText = req.body.altText || '';

  const [result] = await pool.query(
    `INSERT INTO images (filename, original_name, mime_type, size, storage_type, url, alt_text, thumb_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      stored.filename,
      stored.safeOriginalName,
      stored.mimetype,
      stored.size,
      stored.storageType,
      stored.url,
      altText,
      stored.thumbUrl,
    ]
  );
  const [savedRows] = await pool.query('SELECT * FROM images WHERE id = ?', [result.insertId]);
  const normalized = normalizeImage(savedRows[0]);

  res.status(201).json({
    message: 'Image uploaded successfully',
    data: normalized,
    image: normalized
  });
};

const isValidImageId = (id) => /^\d+$/.test(String(id));

const deleteImage = async (req, res) => {
  const { id } = req.params;

  if (!isValidImageId(id)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid image ID' });
  }

  const { used, usageMap } = await getUsedImageIds();
  if (used.has(id)) {
    const usages = usageMap[id].join(', ');
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Cannot delete image in use by: ${usages}` });
  }

  await deleteImageDocAndFile(id);
  res.status(200).json({ message: 'Image deleted successfully' });
};

// Internal: removes the MySQL row + underlying S3/disk object for a single image.
const deleteImageDocAndFile = async (id) => {
  if (!isValidImageId(id)) return;

  const [rows] = await pool.query('SELECT * FROM images WHERE id = ?', [id]);
  const image = rows[0];
  if (!image) return;

  try {
    await deleteStored(image.storage_type, image.filename);
  } catch (e) {
    console.error('[images] delete full failed:', e.message);
  }
  if (image.thumb_url) {
    try {
      await deleteStored(image.storage_type, image.thumb_url);
    } catch (e) {
      console.error('[images] delete thumb failed:', e.message);
    }
  }

  await pool.query('DELETE FROM images WHERE id = ?', [id]);
};

const cleanupOrphanedImage = async (imageId) => {
  if (!imageId) return { deleted: false, reason: 'no-image-id' };
  const idStr = String(imageId);
  if (!isValidImageId(idStr)) return { deleted: false, reason: 'invalid-id' };

  try {
    const { used } = await getUsedImageIds();
    if (used.has(idStr)) {
      return { deleted: false, reason: 'still-in-use' };
    }
    await deleteImageDocAndFile(idStr);
    return { deleted: true };
  } catch (e) {
    console.error('[images] cleanupOrphanedImage failed for', idStr, e.message);
    return { deleted: false, reason: 'error', error: e.message };
  }
};

const getImages = async (req, res) => {
  const [images] = await pool.query('SELECT * FROM images ORDER BY created_at DESC');
  const { used, usageMap } = await getUsedImageIds();

  const normalizedImages = images.map(img => {
    const norm = normalizeImage(img);
    norm.in_use = used.has(norm.id);
    norm.usage = usageMap[norm.id] || [];
    return norm;
  });
  res.status(200).json({ data: normalizedImages });
};

const getImage = async (req, res) => {
  const { id } = req.params;

  if (!isValidImageId(id)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid image ID' });
  }

  const [rows] = await pool.query('SELECT * FROM images WHERE id = ?', [id]);
  const image = rows[0];

  if (!image) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Image not found' });
  }

  res.status(200).json({ data: normalizeImage(image) });
};

module.exports = {
  uploadImage,
  deleteImage,
  getImages,
  getImage,
  cleanupOrphanedImage,
  // Exported for bulk import / scripts
  processAndStoreUpload,
};
