// Analytics session store — one doc per app session in MongoDB.
// All writes are fire-and-forget per Rule 7: a Mongo outage never throws into
// the request path. openSession returns null on failure; closeSession swallows.

const { getDb } = require('../../db/mongodb');

/**
 * Insert a new session doc and return its _id (null if Mongo is unavailable).
 * areaId is resolved by the caller (socket.js, at connect time, via
 * users.last_area_id → default area — same §4.2 fallback chain as everywhere
 * else no pin exists) and passed straight through; this module stays a thin
 * Mongo-only wrapper with no MySQL dependency of its own.
 * @param {{userId:number, platform:string, appVersion:string, areaId?:number}} meta
 * @returns {Promise<string|null>}
 */
const openSession = async ({ userId, platform, appVersion, areaId }) => {
  try {
    const now = new Date();
    const res = await getDb().collection('analytics_sessions').insertOne({
      userId,
      areaId,
      platform: platform || null,
      appVersion: appVersion || null,
      connectedAt: now,
      disconnectedAt: null,
      durationSec: 0,
      screens: {},
      createdAt: now,
    });
    return res.insertedId || null;
  } catch (error) {
    console.error('[analytics] openSession failed:', error.message);
    return null;
  }
};

/**
 * Stamp disconnect time, screen counts, and duration on a session doc.
 * No-op without a sessionId; never throws (fire-and-forget).
 * @param {string|null} sessionId
 * @param {Record<string, number>} screens  e.g. { Home: 3, Cart: 1 }
 * @param {Date} [connectedAt]  optional anchor to compute duration; if omitted
 *   the doc's existing connectedAt is left untouched and durationSec is set
 *   from now vs the Map-tracked connectedAt by the caller.
 */
const closeSession = async (sessionId, screens, connectedAt) => {
  if (!sessionId) return;
  try {
    const now = new Date();
    const durationSec = connectedAt
      ? Math.max(0, Math.round((now - new Date(connectedAt)) / 1000))
      : 0;
    await getDb().collection('analytics_sessions').updateOne(
      { _id: sessionId },
      [{
        $set: {
          disconnectedAt: now,
          durationSec,
          screens: screens || {},
        },
      }]
    );
  } catch (error) {
    console.error('[analytics] closeSession failed:', error.message);
  }
};

module.exports = { openSession, closeSession };
