// Analytics event store — one doc per business action in MongoDB.
// validateEvent is a pure whitelist validator (privacy guardrail: only known
// types + numeric ids; every other field is dropped). insertEvents caps at 50,
// stamps userId + createdAt, and is fire-and-forget (never throws into the
// request path — Rule 7).

const { getDb } = require('../../db/mongodb');

const VALID_TYPES = new Set([
  'cart_add',
  'cart_remove',
  'product_view',
  'category_view',
  'checkout_start',
  'checkout_abandon',
  'order_placed',
]);

// Whitelist of payload fields we keep. Anything else (location, deviceId, raw
// search text, …) is stripped before it ever touches Mongo.
const FIELD_RULES = {
  productId: (v) => Number.isFinite(v),
  categoryId: (v) => Number.isFinite(v),
  qty: (v) => Number.isFinite(v),
  price: (v) => Number.isFinite(v),
  orderId: (v) => Number.isFinite(v),
};

const MAX_EVENTS_PER_CALL = 50;

/**
 * Validate a single client event against the whitelist.
 * @param {unknown} event
 * @returns {object|null} a clean doc or null if invalid
 */
const validateEvent = (event) => {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;

  const type = event.type;
  if (!VALID_TYPES.has(type)) return null;

  const clean = { type };

  for (const [field, ok] of Object.entries(FIELD_RULES)) {
    if (event[field] !== undefined && ok(event[field])) {
      clean[field] = Number(event[field]);
    } else if (event[field] !== undefined) {
      // Field present but invalid (e.g. non-numeric productId) → drop whole event.
      return null;
    }
  }

  // Client timestamp: optional, must parse to a real Date.
  if (event.at !== undefined) {
    const d = new Date(event.at);
    if (Number.isNaN(d.getTime())) return null;
    clean.at = d;
  }

  return clean;
};

/**
 * Validate + bulk-insert events for a user. Caps at 50 valid events.
 * Never throws — returns 0 on Mongo failure.
 * @param {number} userId
 * @param {unknown[]} events
 * @param {number} [areaId] - from resolveCustomerArea on the ingest route
 *   (§9.5/§4.2 chain: pin → last_area_id → default area). Stamped on every
 *   doc so the rollup can group by (areaId, date).
 * @returns {Promise<number>} number of accepted events
 */
const insertEvents = async (userId, events, areaId) => {
  if (!Array.isArray(events)) return 0;

  const docs = [];
  for (const ev of events) {
    if (docs.length >= MAX_EVENTS_PER_CALL) break;
    const clean = validateEvent(ev);
    if (!clean) continue;
    docs.push({ userId, areaId, ...clean, createdAt: new Date() });
  }

  if (docs.length === 0) return 0;

  try {
    const res = await getDb().collection('analytics_events').insertMany(docs);
    return res.insertedCount || docs.length;
  } catch (error) {
    console.error('[analytics] insertEvents failed:', error.message);
    return 0;
  }
};

module.exports = { validateEvent, insertEvents, VALID_TYPES, MAX_EVENTS_PER_CALL };
