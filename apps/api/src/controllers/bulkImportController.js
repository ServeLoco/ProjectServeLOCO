const path = require('path');
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const AdmZip = require('adm-zip');
const { pool } = require('../db/mysql');
const config = require('../config/env');
const s3 = require('../config/s3');
const { normalizeStoreType } = require('../utils/storeMode');
const microCache = require('../utils/microCache');

const GENERIC_ERROR = 'Something went wrong. Please try again later.';
const UPLOAD_DIR = path.join(__dirname, '../../', config.UPLOAD_DIR);
const MAX_IMAGE_BYTES = parseInt(config.MAX_IMAGE_SIZE_MB || '5') * 1024 * 1024;
const MAX_ZIP_ENTRIES = 500;
const MAX_ZIP_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // 50 MB
// Zip central-directory size fields are attacker-controlled metadata, not a
// guarantee of what getData() actually inflates. A crafted entry can declare
// a small size while its DEFLATE stream expands far larger, spiking memory
// before the post-decompression MAX_IMAGE_BYTES check below ever runs. Reject
// entries whose declared size already exceeds the per-image cap, and any
// entry with a compression ratio typical of a zip-bomb, before decompressing.
const MAX_COMPRESSION_RATIO = 200;

const normaliseMode = async (raw) => {
  if (!raw) return null;
  try {
    return await normalizeStoreType(raw, { fallback: false });
  } catch {
    return null;
  }
};

const isValidZip = (buffer) =>
  buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;

const detectImageType = (buffer) => {
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) return 'webp';
  return null;
};

const MIME_MAP = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

const parseSpreadsheet = (buffer, mimetype, originalname) => {
  const ext = path.extname(originalname || '').toLowerCase();
  const isXlsx =
    ext === '.xlsx' || ext === '.xls' ||
    mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimetype === 'application/vnd.ms-excel';

  if (isXlsx) {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { defval: '' });
  }
  return parse(buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true });
};

// Persist an image buffer (optimized full + WebP thumb) to disk or S3.
// Returns { filename, url, thumbUrl, mimeType, size } for images table INSERT.
const saveImage = async (buffer, originalFilename) => {
  const { processAndStoreUpload } = require('./imageController');
  const detectedExt = (path.extname(originalFilename || '').replace('.', '') || 'jpg').toLowerCase();
  const stored = await processAndStoreUpload(buffer, detectedExt, originalFilename);
  return {
    filename: stored.filename,
    url: stored.url,
    thumbUrl: stored.thumbUrl,
    mimeType: stored.mimetype,
    size: stored.size,
  };
};

// Delete a stored image from whichever backend holds it. Never throws.
const deleteStoredImage = async (filename) => {
  if (!filename) return;
  if (config.STORAGE_DRIVER === 's3') {
    await s3.deleteObject(filename);
  } else {
    safeDeleteFile(filename);
  }
};

const safeDeleteFile = (filename) => {
  if (!filename) return;
  try {
    const filePath = path.join(UPLOAD_DIR, filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.error('[bulkImport] Failed to delete file:', filename, e.message);
  }
};

const cleanupFiles = async (filenames) => { for (const f of filenames) await deleteStoredImage(f); };

/**
 * Validate all rows. Returns { validRows, skippedRows }.
 * validRows: rows ready to commit (action = create|update)
 * skippedRows: rows with a reason why they were skipped
 */
const validateRows = async (rawRows, zipEntryMap, categoryMap, categoryNameMap) => {
  const validRows = [];
  const skippedRows = [];
  const seenImageFiles = new Map();
  const seenNameCategory = new Map();

  for (let i = 0; i < rawRows.length; i++) {
    const raw = rawRows[i];
    const rowNum = i + 2;
    const skipReasons = [];

    // ── name
    const name = String(raw.name || '').trim();
    if (!name) skipReasons.push('name is required');

    // ── price
    const priceRaw = String(raw.price || '').trim();
    const price = parseFloat(priceRaw);
    if (!priceRaw || isNaN(price) || price < 0)
      skipReasons.push('price must be a valid non-negative number');

    // ── unit
    const unit = String(raw.unit || '').trim();
    if (!unit) skipReasons.push('unit is required (e.g. 500ml, 1 Plate, 52g)');

    // ── mode (optional for validation)
    const modeRaw = String(raw.mode || '').trim();
    const normalisedMode = modeRaw ? await normaliseMode(modeRaw) : null;
    if (modeRaw && !normalisedMode)
      skipReasons.push(`unrecognised mode '${modeRaw}'. Accepted: packed, packed items, fast, fast food, fast_food, or any active store mode slug`);

    // ── category resolution
    let resolvedCategoryId = null;
    let resolvedCategoryType = null;
    let resolvedCategoryName = null;

    const categoryIdRaw = String(raw.category_id || '').trim();
    const categoryNameRaw = String(raw.category || '').trim();

    if (categoryIdRaw) {
      const catId = parseInt(categoryIdRaw, 10);
      if (isNaN(catId) || catId <= 0) {
        skipReasons.push(`category_id '${categoryIdRaw}' is not a valid integer`);
      } else if (!categoryMap[catId]) {
        skipReasons.push(`category_id ${catId} not found`);
      } else {
        resolvedCategoryId = catId;
        resolvedCategoryType = categoryMap[catId].type;
        resolvedCategoryName = categoryMap[catId].name;
      }
    } else if (categoryNameRaw) {
      const matches = categoryNameMap[categoryNameRaw.toLowerCase()] || [];
      if (matches.length === 0) {
        skipReasons.push(`category '${categoryNameRaw}' not found`);
      } else if (matches.length === 1) {
        resolvedCategoryId = matches[0].id;
        resolvedCategoryType = matches[0].type;
        resolvedCategoryName = matches[0].name;
      } else {
        // Multiple categories share this name — use mode to disambiguate
        if (normalisedMode) {
          const modeMatch = matches.filter(c => c.type === normalisedMode);
          if (modeMatch.length === 1) {
            resolvedCategoryId = modeMatch[0].id;
            resolvedCategoryType = modeMatch[0].type;
            resolvedCategoryName = modeMatch[0].name;
          } else {
            skipReasons.push(
              `multiple categories named '${categoryNameRaw}' with mode '${modeRaw}' — supply category_id to disambiguate`
            );
          }
        } else {
          skipReasons.push(
            `multiple categories named '${categoryNameRaw}' found — supply mode or category_id to disambiguate`
          );
        }
      }
    } else {
      skipReasons.push('category or category_id is required');
    }

    // ── mode vs category type validation
    if (normalisedMode && resolvedCategoryType && normalisedMode !== resolvedCategoryType) {
      skipReasons.push(
        `mode '${modeRaw}' does not match category type '${resolvedCategoryType}'`
      );
    }

    // ── image_file (conditional)
    const imageFile = String(raw.image_file || '').trim();
    const hasImageFile = imageFile.length > 0;

    // ── Determine action from explicit id/product_id
    const rawId = raw.id || raw.product_id;
    let explicitId = null;
    if (rawId !== undefined && String(rawId).trim() !== '') {
      const parsed = parseInt(String(rawId).replace(/\D/g, ''), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        skipReasons.push(`id '${rawId}' is not a valid product ID`);
      } else {
        explicitId = parsed;
      }
    }

    // ── optional fields
    let originalPrice = null;
    if (raw.original_price !== undefined && String(raw.original_price).trim() !== '') {
      originalPrice = parseFloat(String(raw.original_price).trim());
      if (isNaN(originalPrice)) {
        skipReasons.push('original_price must be a valid number');
        originalPrice = null;
      } else if (!isNaN(price) && originalPrice < price) {
        skipReasons.push('original_price cannot be less than price');
        originalPrice = null;
      }
    }

    const parseBool = (val, defaultVal) => {
      if (val === undefined || String(val).trim() === '') return defaultVal;
      const s = String(val).trim().toLowerCase();
      return s === 'true' || s === '1' || s === 'yes';
    };

    const available = parseBool(raw.available, true);
    const featured = parseBool(raw.featured, false);
    const displayOrder =
      raw.display_order !== undefined && String(raw.display_order).trim() !== ''
        ? Math.max(0, parseInt(String(raw.display_order).trim(), 10) || 0)
        : 0;
    const discountLabel = String(raw.discount_label || '').trim() || null;
    const description = String(raw.description || '').trim() || '';

    if (skipReasons.length > 0) {
      skippedRows.push({ row: rowNum, name: name || raw.name || '', category: resolvedCategoryName || categoryNameRaw || categoryIdRaw, reason: skipReasons.join('; ') });
      continue;
    }

    // ── Determine action
    let action = 'create';
    let existingId = null;
    let existingImageId = null;
    let keepExistingImage = false;

    if (explicitId) {
      const [found] = await pool.query('SELECT id, image_id FROM products WHERE id = ? AND deleted = 0 LIMIT 1', [explicitId]);
      if (found.length === 0) {
        skippedRows.push({ row: rowNum, name, category: resolvedCategoryName, reason: `product ID ${explicitId} not found` });
        continue;
      }
      action = 'update';
      existingId = found[0].id;
      existingImageId = found[0].image_id || null;
    } else {
      // Fall back to name+category match
      const [found] = await pool.query(
        'SELECT id, image_id FROM products WHERE name = ? AND category_id = ? AND deleted = 0 LIMIT 1',
        [name, resolvedCategoryId]
      );
      if (found.length > 0) {
        action = 'update';
        existingId = found[0].id;
        existingImageId = found[0].image_id || null;
      }
    }

    // ── image validation
    if (action === 'create' && !hasImageFile) {
      skippedRows.push({ row: rowNum, name, category: resolvedCategoryName, reason: 'image_file is required for new products' });
      continue;
    }

    if (hasImageFile) {
      if (seenImageFiles.has(imageFile)) {
        skippedRows.push({ row: rowNum, name, category: resolvedCategoryName, reason: `duplicate image_file "${imageFile}" — first used at row ${seenImageFiles.get(imageFile)}` });
        continue;
      }
      seenImageFiles.set(imageFile, rowNum);

      if (!zipEntryMap || !zipEntryMap[imageFile]) {
        skippedRows.push({ row: rowNum, name, category: resolvedCategoryName, reason: zipEntryMap ? `"${imageFile}" not found in the ZIP file` : `image_file supplied but no ZIP was uploaded` });
        continue;
      }

      if (!zipEntryMap[imageFile]._cachedData) {
        zipEntryMap[imageFile]._cachedData = zipEntryMap[imageFile].getData();
      }
      const buf = zipEntryMap[imageFile]._cachedData;
      if (buf.length > MAX_IMAGE_BYTES) {
        skippedRows.push({ row: rowNum, name, category: resolvedCategoryName, reason: `"${imageFile}" exceeds the ${config.MAX_IMAGE_SIZE_MB || 5} MB size limit` });
        continue;
      }
      if (!detectImageType(buf)) {
        skippedRows.push({ row: rowNum, name, category: resolvedCategoryName, reason: `"${imageFile}" is not a valid image (JPG, PNG, or WebP required)` });
        continue;
      }
    } else {
      // update row with no image_file → keep existing
      keepExistingImage = true;
    }

    // ── Duplicate name+category check within CSV (create rows only)
    if (action === 'create') {
      const nameKey = `${name.toLowerCase()}::${resolvedCategoryId}`;
      if (seenNameCategory.has(nameKey)) {
        skippedRows.push({ row: rowNum, name, category: resolvedCategoryName, reason: `duplicate name+category — first at row ${seenNameCategory.get(nameKey)}` });
        continue;
      }
      seenNameCategory.set(nameKey, rowNum);
    }

    validRows.push({
      rowNum,
      name,
      price,
      category_id: resolvedCategoryId,
      category_name: resolvedCategoryName,
      unit,
      description,
      image_file: hasImageFile ? imageFile : null,
      available,
      featured,
      display_order: displayOrder,
      original_price: originalPrice,
      discount_label: discountLabel,
      _action: action,
      _existingId: existingId,
      _existingImageId: existingImageId,
      _keepExistingImage: keepExistingImage,
    });
  }

  return { validRows, skippedRows };
};

// ─────────────────────────────────────────────
// Shared parse logic
// ─────────────────────────────────────────────

const parseAndValidate = async (req) => {
  const csvFile = req.files?.csvFile?.[0];
  const zipFile = req.files?.imagesZip?.[0];

  if (!csvFile) throw { status: 400, message: 'csvFile is required (CSV or XLSX)' };
  // ZIP is optional — absence is handled per-row during validation

  let rawRows;
  try {
    rawRows = parseSpreadsheet(csvFile.buffer, csvFile.mimetype, csvFile.originalname);
  } catch (e) {
    throw { status: 422, message: `Failed to parse spreadsheet: ${e.message}` };
  }
  if (!rawRows || rawRows.length === 0)
    throw { status: 422, message: 'The spreadsheet contains no data rows.' };
  if (rawRows.length > 1000) {
    throw { status: 400, message: 'CSV has too many rows (max 1000).' };
  }

  // Parse ZIP if provided
  let zipEntryMap = null;
  if (zipFile) {
    if (!isValidZip(zipFile.buffer))
      throw { status: 422, message: 'imagesZip is not a valid ZIP file.' };
    try {
      const zip = new AdmZip(zipFile.buffer);
      const entries = zip.getEntries();
      const totalUncompressedSize = entries.reduce((sum, entry) => sum + (entry.header?.size || 0), 0);
      if (entries.length > MAX_ZIP_ENTRIES || totalUncompressedSize > MAX_ZIP_UNCOMPRESSED_BYTES) {
        throw { status: 400, message: 'ZIP file too large or contains too many files.' };
      }
      zipEntryMap = {};
      for (const entry of entries) {
        if (entry.isDirectory) continue;
        if (
          entry.entryName.includes('..') ||
          entry.entryName.startsWith('/') ||
          entry.entryName.startsWith('\\')
        ) continue;
        const declaredSize = entry.header?.size || 0;
        const compressedSize = entry.header?.compressedSize || 0;
        if (declaredSize > MAX_IMAGE_BYTES) continue;
        if (compressedSize > 0 && declaredSize / compressedSize > MAX_COMPRESSION_RATIO) continue;
        zipEntryMap[path.basename(entry.entryName)] = entry;
      }
    } catch (e) {
      if (e.status) throw e;  // preserve intentional status codes (e.g. 400)
      throw { status: 422, message: `Failed to read ZIP file: ${e.message}` };
    }
  }

  // Load categories
  const [catRows] = await pool.query('SELECT id, name, type FROM categories WHERE deleted = 0');
  const categoryMap = {};
  const categoryNameMap = {}; // lowercase name → array of category objects
  for (const c of catRows) {
    categoryMap[c.id] = c;
    const key = c.name.toLowerCase();
    if (!categoryNameMap[key]) categoryNameMap[key] = [];
    categoryNameMap[key].push(c);
  }

  const { validRows, skippedRows } = await validateRows(rawRows, zipEntryMap, categoryMap, categoryNameMap);

  return { rawRows, validRows, skippedRows, zipEntryMap, categoryMap };
};

// ─────────────────────────────────────────────
// Controllers
// ─────────────────────────────────────────────

const previewBulkImport = async (req, res) => {
  try {
    const { rawRows, validRows, skippedRows } = await parseAndValidate(req);

    const createCount = validRows.filter(r => r._action === 'create').length;
    const updateCount = validRows.filter(r => r._action === 'update').length;

    return res.status(200).json({
      preview: true,
      summary: {
        total: rawRows.length,
        valid: validRows.length,
        will_create: createCount,
        will_update: updateCount,
        skipped: skippedRows.length,
        error_count: 0,
      },
      rows: validRows.map(r => ({
        row: r.rowNum,
        name: r.name,
        price: r.price,
        category: r.category_name,
        category_id: r.category_id,
        unit: r.unit,
        image_file: r.image_file,
        action: r._action,
        status: 'valid',
      })),
      skipped: skippedRows,
      errors: [],
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ code: 'VALIDATION_ERROR', message: err.message });
    console.error('[bulkImport] preview error:', err);
    return res.status(500).json({ code: 'SERVER_ERROR', message: GENERIC_ERROR });
  }
};

const commitBulkImport = async (req, res) => {
  const savedFiles = [];
  let connection;

  try {
    const { validRows, skippedRows, zipEntryMap } = await parseAndValidate(req);

    if (validRows.length === 0) {
      return res.status(422).json({
        code: 'VALIDATION_ERROR',
        message: 'No valid rows to import. All rows were skipped.',
        skipped: skippedRows,
      });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    let created = 0;
    let updated = 0;

    for (const row of validRows) {
      let newImageId;

      if (!row._keepExistingImage) {
        // 1. Get image from ZIP
        const imgEntry = zipEntryMap[row.image_file];
        const imgBuffer = imgEntry._cachedData || imgEntry.getData();
        const imgType = detectImageType(imgBuffer);
        const mimetype = MIME_MAP[imgType] || 'image/jpeg';

        // 2. Optimize + store full + WebP thumb (disk or S3)
        const saved = await saveImage(imgBuffer, row.image_file);
        const { filename: savedFilename, url: imageUrl, thumbUrl, mimeType: savedMime, size: savedSize } = saved;
        savedFiles.push(savedFilename);

        // 3. Delete old image if updating
        if (row._action === 'update' && row._existingImageId) {
          try {
            const [oldRows] = await connection.query('SELECT filename, thumb_url FROM images WHERE id = ?', [row._existingImageId]);
            if (oldRows[0]) {
              await deleteStoredImage(oldRows[0].filename);
              if (oldRows[0].thumb_url) {
                await deleteStoredImage(path.basename(String(oldRows[0].thumb_url).split('?')[0]));
              }
              await connection.query('DELETE FROM images WHERE id = ?', [row._existingImageId]);
            }
          } catch (e) {
            console.error('[bulkImport] Failed to clean up old image:', row._existingImageId, e.message);
          }
        }

        // 4. Insert image metadata row (same transaction as the product write —
        // a rollback below automatically undoes this, no manual cleanup needed).
        const [imageInsertResult] = await connection.query(
          `INSERT INTO images (filename, original_name, mime_type, size, storage_type, url, alt_text, thumb_url)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            savedFilename,
            path.basename(row.image_file).replace(/[^a-zA-Z0-9._-]/g, ''),
            savedMime || mimetype,
            savedSize || imgBuffer.length,
            config.STORAGE_DRIVER === 's3' ? 's3' : 'disk',
            imageUrl,
            row.name,
            thumbUrl || null,
          ]
        );
        newImageId = imageInsertResult.insertId;
      } else {
        // Keep existing image
        newImageId = row._existingImageId;
      }

      if (row._action === 'create') {
        await connection.query(
          `INSERT INTO products (name, price, category_id, unit, description, image_id, available, is_combo, featured, display_order, original_price, discount_label)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.name, row.price, row.category_id, row.unit, row.description, newImageId,
           row.available ? 1 : 0, 0, row.featured ? 1 : 0, row.display_order, row.original_price, row.discount_label]
        );
        created++;
      } else {
        await connection.query(
          `UPDATE products SET name = ?, price = ?, category_id = ?, unit = ?, description = ?,
           image_id = ?, available = ?, featured = ?, display_order = ?, original_price = ?, discount_label = ?
           WHERE id = ? AND deleted = 0`,
          [row.name, row.price, row.category_id, row.unit, row.description, newImageId,
           row.available ? 1 : 0, row.featured ? 1 : 0, row.display_order, row.original_price, row.discount_label,
           row._existingId]
        );
        updated++;
      }
    }

    await connection.commit();
    // Hardcoded to area 1 for now (TASK 11 makes bulk import area-scoped).
    microCache.bust('dashboard', 1);
    microCache.bust('categories', 1);
    connection.release();

    return res.status(201).json({
      message: `Bulk import completed. ${created} created, ${updated} updated, ${skippedRows.length} skipped.`,
      created,
      updated,
      skipped: skippedRows.length,
      skipped_rows: skippedRows,
      failed: 0,
      errors: [],
    });

  } catch (err) {
    if (connection) {
      // Rollback undoes both the product rows AND the image metadata rows
      // inserted in this run (same transaction) — no manual cleanup needed.
      try { await connection.rollback(); } catch (e) { /* ignore */ }
      try { connection.release(); } catch (e) { /* ignore */ }
    }
    await cleanupFiles(savedFiles);

    if (err.status) return res.status(err.status).json({ code: 'VALIDATION_ERROR', message: err.message });
    console.error('[bulkImport] commit error:', err);
    return res.status(500).json({ code: 'SERVER_ERROR', message: GENERIC_ERROR });
  }
};

module.exports = { previewBulkImport, commitBulkImport };
