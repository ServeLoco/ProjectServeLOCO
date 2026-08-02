const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const config = require('./env');

// Lazily create a single S3 client. Credentials come from env (AWS_ACCESS_KEY_ID /
// AWS_SECRET_ACCESS_KEY) or, if those are absent, the default AWS provider chain
// (useful if the container later runs with an IAM role instead of static keys).
let client = null;
const getClient = () => {
  if (!client) {
    const opts = { region: config.S3_REGION };
    if (config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY) {
      opts.credentials = {
        accessKeyId: config.AWS_ACCESS_KEY_ID,
        secretAccessKey: config.AWS_SECRET_ACCESS_KEY
      };
    }
    client = new S3Client(opts);
  }
  return client;
};

// Build the public URL for a stored object. Prefers an explicit S3_PUBLIC_URL
// (so a CDN/custom domain can be swapped in later without code changes).
const publicUrl = (key) => {
  const base = config.S3_PUBLIC_URL ||
    `https://${config.S3_BUCKET}.s3.${config.S3_REGION}.amazonaws.com`;
  return `${base.replace(/\/$/, '')}/${key}`;
};

/**
 * Upload a buffer to S3 and return its public URL.
 * @param {string} key - object key (path within the bucket)
 * @param {Buffer} buffer - raw file bytes (already validated by caller)
 * @param {string} mimeType - e.g. 'image/webp'
 * @returns {Promise<string>} public URL
 */
const uploadBuffer = async (key, buffer, mimeType) => {
  await getClient().send(new PutObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
    CacheControl: 'public, max-age=31536000, immutable'
  }));
  return publicUrl(key);
};

/**
 * Download an object's bytes from S3 (TASK 18 — hashing existing images for
 * the sha256 dedupe backfill). Throws on failure — unlike deleteObject, the
 * caller needs to know a read failed so it can skip that row rather than
 * silently hash nothing.
 * @param {string} key
 * @returns {Promise<Buffer>}
 */
const downloadBuffer = async (key) => {
  const res = await getClient().send(new GetObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: key,
  }));
  const chunks = [];
  for await (const chunk of res.Body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

/**
 * Delete an object from S3 by key. Never throws — logs and resolves so callers
 * can fire-and-forget during cleanup without breaking the main flow.
 * @param {string} key
 */
const deleteObject = async (key) => {
  if (!key) return;
  try {
    await getClient().send(new DeleteObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key
    }));
  } catch (e) {
    console.error('[s3] Failed to delete object:', key, e.message);
  }
};

module.exports = { uploadBuffer, deleteObject, downloadBuffer, publicUrl };
