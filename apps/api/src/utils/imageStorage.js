/**
 * Store image bytes to S3 (production) or local disk (dev).
 * Always sets long-lived cache headers on S3; disk uses express.static immutable.
 */
const path = require('path');
const fs = require('fs');
const config = require('../config/env');
const s3 = require('../config/s3');

const uploadDir = path.join(__dirname, '../../', config.UPLOAD_DIR);

function ensureUploadDir() {
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
}

/**
 * @param {string} filename - object key / disk filename
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @returns {Promise<{ url: string, storageType: 's3'|'disk' }>}
 */
async function storeBuffer(filename, buffer, mimeType) {
  if (config.STORAGE_DRIVER === 's3') {
    const url = await s3.uploadBuffer(filename, buffer, mimeType);
    return { url, storageType: 's3' };
  }
  ensureUploadDir();
  fs.writeFileSync(path.join(uploadDir, filename), buffer);
  const url = `${config.PUBLIC_BASE_URL}${config.STATIC_UPLOAD_PATH}/${filename}`;
  return { url, storageType: 'disk' };
}

/**
 * Read back stored bytes by storage type + key or public URL (TASK 18 — the
 * sha256 backfill needs to hash existing images' actual content). Throws on
 * failure so the caller can skip/report that one row rather than hash nothing.
 */
async function getStoredBuffer(storageType, filenameOrUrl) {
  const key = String(filenameOrUrl).includes('://')
    ? path.basename(String(filenameOrUrl).split('?')[0])
    : filenameOrUrl;

  if (storageType === 's3' || config.STORAGE_DRIVER === 's3') {
    return s3.downloadBuffer(key);
  }
  return fs.readFileSync(path.join(uploadDir, key));
}

/**
 * Best-effort delete by storage type + key or public URL.
 */
async function deleteStored(storageType, filenameOrUrl) {
  if (!filenameOrUrl) return;
  const key = String(filenameOrUrl).includes('://')
    ? path.basename(String(filenameOrUrl).split('?')[0])
    : filenameOrUrl;

  if (storageType === 's3' || config.STORAGE_DRIVER === 's3') {
    await s3.deleteObject(key);
    return;
  }
  const filePath = path.join(uploadDir, key);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

module.exports = {
  storeBuffer,
  deleteStored,
  getStoredBuffer,
  ensureUploadDir,
  uploadDir,
};
