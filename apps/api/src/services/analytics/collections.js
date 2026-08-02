// Analytics MongoDB collections + indexes.
// All analytics data lives in MongoDB (already connected); MySQL is untouched.
// TTL indexes auto-expire docs so the DB can never grow unbounded.
//
// ensureAnalyticsIndexes is called once at startup from db/index.js AFTER Mongo
// connect succeeds; the caller wraps it in try/catch — index failure logs an
// error but must not crash startup (Rule 7).

const SESSIONS_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days = 2592000
const EVENTS_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days = 2592000
const DAILY_TTL_SECONDS = 365 * 24 * 60 * 60; // 1 year = 31536000

// Drops an index by name if it exists. MongoDB's dropIndex throws when the
// index is already gone (e.g. a second migrate run) — swallow only that
// specific "index not found" case (code 27 / message match) so a genuine
// failure still surfaces.
const dropIndexIfExists = async (collection, indexName) => {
  try {
    await collection.dropIndex(indexName);
  } catch (error) {
    if (error && (error.codeName === 'IndexNotFound' || error.code === 27)) return;
    throw error;
  }
};

/**
 * Area 1 is the only area that has ever existed (§6.6 forbids a second area
 * until this sweep is complete), so every pre-existing analytics_daily doc
 * genuinely IS Area 1 data — this is a real backfill, not a fudge (§9.5).
 * Must run BEFORE the new { areaId: 1, date: 1 } unique index is created:
 * Mongo can't build a unique index over a field that doesn't exist yet on
 * old docs. Cheap (~365 docs/year), no batching needed.
 */
const backfillDailyAreaId = async (db) => {
  const daily = db.collection('analytics_daily');
  await daily.updateMany({ areaId: { $exists: false } }, { $set: { areaId: 1 } });
};

/**
 * Create all indexes for the three analytics collections exactly as specced.
 * @param {import('mongodb').Db} db
 */
const ensureAnalyticsIndexes = async (db) => {
  const sessions = db.collection('analytics_sessions');
  await sessions.createIndex({ createdAt: 1 }, { expireAfterSeconds: SESSIONS_TTL_SECONDS });
  await sessions.createIndex({ userId: 1, createdAt: -1 });
  await sessions.createIndex({ areaId: 1, createdAt: -1 });

  const events = db.collection('analytics_events');
  await events.createIndex({ createdAt: 1 }, { expireAfterSeconds: EVENTS_TTL_SECONDS });
  await events.createIndex({ userId: 1, createdAt: -1 });
  await events.createIndex({ areaId: 1, createdAt: -1 });
  // Supersede the pre-area compound indexes with area-prefixed equivalents
  // (§3.3 leftmost-prefix rule) — drop the old ones so they don't sit around
  // as dead weight once nothing queries by { type } or { productId, type }
  // alone anymore.
  await dropIndexIfExists(events, 'type_1_createdAt_-1');
  await events.createIndex({ areaId: 1, type: 1, createdAt: -1 });
  await dropIndexIfExists(events, 'productId_1_type_1_createdAt_-1');
  await events.createIndex({ areaId: 1, productId: 1, type: 1, createdAt: -1 });

  const daily = db.collection('analytics_daily');
  await backfillDailyAreaId(db);
  await dropIndexIfExists(daily, 'date_1');
  await daily.createIndex({ areaId: 1, date: 1 }, { unique: true });
  // TTL index MUST stay single-field on createdAt — a compound TTL index
  // silently stops expiry and the collection grows unbounded (§9.5).
  await daily.createIndex({ createdAt: 1 }, { expireAfterSeconds: DAILY_TTL_SECONDS });
};

module.exports = {
  ensureAnalyticsIndexes,
  backfillDailyAreaId,
  SESSIONS_TTL_SECONDS,
  EVENTS_TTL_SECONDS,
  DAILY_TTL_SECONDS,
};
