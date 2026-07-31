const { appEnv } = require('./loadEnv');

const ENV = process.env.NODE_ENV || appEnv || 'development';
const isProd = ENV === 'production';

// Safe defaults for local testing
const localDefaults = {
  PORT: '3000',
  CORS_ORIGIN: '*',
  PUBLIC_BASE_URL: 'http://10.0.2.2:3000',
  UPLOAD_DIR: 'uploads',
  MAX_IMAGE_SIZE_MB: '5',
  STATIC_UPLOAD_PATH: '/uploads'
};

const getEnv = (key, fallback) => {
  const value = process.env[key];
  if (value !== undefined) return value;
  if (!isProd && fallback !== undefined) return fallback;
  return undefined;
};

const config = {
  APP_ENV: appEnv,
  NODE_ENV: ENV,
  PORT: getEnv('PORT', localDefaults.PORT),
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '30d',
  ADMIN_JWT_EXPIRES_IN: process.env.ADMIN_JWT_EXPIRES_IN || '12h',
  
  ADMIN_OWNER_ID: process.env.ADMIN_OWNER_ID || (ENV === 'test' ? 'test_admin' : undefined),
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || (ENV === 'test' ? 'test_pass' : undefined),
  ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH || undefined,

  MYSQL_HOST: process.env.MYSQL_HOST,
  MYSQL_PORT: process.env.MYSQL_PORT,
  MYSQL_DATABASE: process.env.MYSQL_DATABASE,
  MYSQL_USER: process.env.MYSQL_USER,
  MYSQL_PASSWORD: process.env.MYSQL_PASSWORD,
  MYSQL_SSL: process.env.MYSQL_SSL,
  MYSQL_SSL_CA_PATH: process.env.MYSQL_SSL_CA_PATH,

  MONGODB_URI: process.env.MONGODB_URI,
  MONGODB_DATABASE: process.env.MONGODB_DATABASE,

  CORS_ORIGIN: getEnv('CORS_ORIGIN', localDefaults.CORS_ORIGIN),

  PUBLIC_BASE_URL: getEnv('PUBLIC_BASE_URL', localDefaults.PUBLIC_BASE_URL),
  UPLOAD_DIR: process.env.UPLOAD_DIR || localDefaults.UPLOAD_DIR,
  MAX_IMAGE_SIZE_MB: process.env.MAX_IMAGE_SIZE_MB || localDefaults.MAX_IMAGE_SIZE_MB,
  STATIC_UPLOAD_PATH: process.env.STATIC_UPLOAD_PATH || localDefaults.STATIC_UPLOAD_PATH,

  // Image storage backend: 'disk' (local files, default for dev/tests) or 's3'.
  STORAGE_DRIVER: process.env.STORAGE_DRIVER || 'disk',
  S3_BUCKET: process.env.S3_BUCKET,
  S3_REGION: process.env.S3_REGION,
  S3_PUBLIC_URL: process.env.S3_PUBLIC_URL,
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,

  // Rider assignment engine (optional overrides; defaults match product rules)
  RIDER_OFFER_TIMEOUT_SEC: Number(process.env.RIDER_OFFER_TIMEOUT_SEC) || 150,
  // After shops confirm (or house Accepted): if no eligible riders, keep searching
  // for this many seconds (default 30 min) before failAssignment / admin cancel-request.
  RIDER_SEARCH_WINDOW_SEC: Number(process.env.RIDER_SEARCH_WINDOW_SEC) || 1800,
  // Minimum seconds between re-scans while waiting for riders to come online.
  RIDER_SEARCH_SCAN_SEC: Number(process.env.RIDER_SEARCH_SCAN_SEC) || 30,
  // Offer rings around the pickup shop(s), in km, tried smallest first. Only
  // once a ring is exhausted (every rider in it rejected/timed out) does the
  // next one open. After the last ring, distance is dropped entirely so a far
  // rider can still save the order before the search window closes.
  RIDER_SEARCH_RADIUS_TIERS_KM: String(process.env.RIDER_SEARCH_RADIUS_TIERS_KM || '1,2,3')
    .split(',')
    .map((v) => Number(String(v).trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b),
  // A rider's last GPS ping must be newer than this to place them in a radius
  // ring; staler than this counts as unknown position (last ring only).
  RIDER_LOCATION_MAX_AGE_SEC: Number(process.env.RIDER_LOCATION_MAX_AGE_SEC) || 600,
  RIDER_SWEEPER_MS: Number(process.env.RIDER_SWEEPER_MS) || 5000,
  // Re-push pending delivery offers this often until accept/reject/expire.
  // 30s against the 150s offer timer is ~5 alarms per offer, not 10 — still
  // frequent enough that a rider can't miss it, less relentless than every 15s.
  RIDER_OFFER_REMIND_SEC: Number(process.env.RIDER_OFFER_REMIND_SEC) || 30,
  RIDER_TODAY_TZ: process.env.RIDER_TODAY_TZ || '+05:30',

  // Shop auto-open/auto-close schedule sweeper.
  // Wall-clock zone the admin enters open_time/close_time in. The API
  // container has no TZ set and runs on UTC, so the sweeper must convert
  // rather than read server local time — an IANA name (not a fixed offset)
  // because this is a wall-clock comparison, same as nightDelivery.js.
  SHOP_SCHEDULE_TZ: process.env.SHOP_SCHEDULE_TZ || 'Asia/Kolkata',
  SHOP_SCHEDULE_SWEEP_MS: Number(process.env.SHOP_SCHEDULE_SWEEP_MS) || 30000,
};

// Validation
const requiredKeys = [
  'JWT_SECRET',
  'MYSQL_HOST',
  'MYSQL_PORT',
  'MYSQL_DATABASE',
  'MYSQL_USER',
  'MYSQL_PASSWORD',
  'MONGODB_URI',
  'MONGODB_DATABASE',
  'ADMIN_OWNER_ID',
  'ADMIN_PASSWORD'
];

const missing = requiredKeys.filter((key) => {
  if (key === 'MYSQL_PASSWORD' && !isProd) return config[key] === undefined;
  return !config[key];
});
// Allow either ADMIN_PASSWORD (plain) or ADMIN_PASSWORD_HASH (bcrypt) to be set
const hasAdminAuth = config.ADMIN_PASSWORD || config.ADMIN_PASSWORD_HASH;
if (missing.includes('ADMIN_PASSWORD') && hasAdminAuth) {
  missing.splice(missing.indexOf('ADMIN_PASSWORD'), 1);
}
if (missing.length > 0) {
  throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
}

// When S3 is the storage backend, its config must be complete.
if (config.STORAGE_DRIVER === 's3') {
  const s3Missing = ['S3_BUCKET', 'S3_REGION'].filter((key) => !config[key]);
  if (s3Missing.length > 0) {
    throw new Error(`STORAGE_DRIVER=s3 but missing: ${s3Missing.join(', ')}`);
  }
}

// Safety check for JWT and CORS in production
if (isProd) {
  if (config.JWT_SECRET === 'your_jwt_secret_here' || config.JWT_SECRET.length < 16) {
    throw new Error('JWT_SECRET is unsafe for production environments.');
  }
  if (!config.CORS_ORIGIN || config.CORS_ORIGIN === '*' || config.CORS_ORIGIN.includes('*')) {
    throw new Error('CORS_ORIGIN must be explicitly defined in production (no wildcards).');
  }
  // Admin login: ADMIN_PASSWORD_HASH (bcrypt) is preferred; plaintext
  // ADMIN_PASSWORD is accepted as long as it isn't a known-weak default.
  if (config.ADMIN_PASSWORD_HASH) {
    if (!config.ADMIN_PASSWORD_HASH.startsWith('$2b$') && !config.ADMIN_PASSWORD_HASH.startsWith('$2a$')) {
      throw new Error('ADMIN_PASSWORD_HASH must be a valid bcrypt hash in production.');
    }
  } else if (config.ADMIN_PASSWORD) {
    if (config.ADMIN_PASSWORD === 'admin143' || config.ADMIN_PASSWORD === 'test_pass' || config.ADMIN_PASSWORD.length < 8) {
      throw new Error('ADMIN_PASSWORD is too weak for production. Use a longer password or ADMIN_PASSWORD_HASH.');
    }
  } else {
    throw new Error('Either ADMIN_PASSWORD_HASH or ADMIN_PASSWORD must be set.');
  }
  if (process.env.DEBUG === 'true') throw new Error('DEBUG must not be enabled in production.');
}

module.exports = config;
