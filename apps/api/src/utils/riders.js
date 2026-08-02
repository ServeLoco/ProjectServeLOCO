const { pool } = require('../db/mysql');
const config = require('../config/env');
const { calculateDistance } = require('./deliveryPricing');

// Calendar day for "least orders completed today" (D8 = Asia/Kolkata).
// Use fixed offset so MySQL does not require named timezone tables loaded.
const RIDER_TODAY_TZ = config.RIDER_TODAY_TZ || '+05:30';
// Offer rings (km, ascending) and how stale a GPS ping may be to count.
const RIDER_SEARCH_RADIUS_TIERS_KM = (config.RIDER_SEARCH_RADIUS_TIERS_KM || []).length > 0
  ? config.RIDER_SEARCH_RADIUS_TIERS_KM
  : [1, 2, 3];
const RIDER_LOCATION_MAX_AGE_SEC = config.RIDER_LOCATION_MAX_AGE_SEC || 600;

const riderShape = (r) => {
  if (!r) return null;
  return {
    id: r.id,
    userId: r.user_id,
    user_id: r.user_id,
    displayName: r.display_name,
    display_name: r.display_name,
    phone: r.phone || null,
    active: Boolean(r.active),
    isOnline: Boolean(r.is_online),
    is_online: Boolean(r.is_online),
  };
};

/**
 * Returns the ACTIVE rider linked to this user, or null.
 * Mirrors getShopForUser — one rider per user by unique user_id.
 */
const getRiderForUser = async (userId) => {
  if (!userId) return null;
  try {
    const [rows] = await pool.query(
      `SELECT id, user_id, display_name, phone, active, is_online
       FROM riders
       WHERE user_id = ? AND active = 1
       LIMIT 1`,
      [userId]
    );
    if (rows.length === 0) return null;
    return riderShape(rows[0]);
  } catch (e) {
    // Table missing mid-migrate / old DB — never break /auth/me for customers.
    if (e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146)) {
      return null;
    }
    throw e;
  }
};

/**
 * Count riders who are admin-active and toggled online, scoped to one area —
 * a rider in area 2 must never count toward area 1's delivery gate.
 */
const countActiveRiders = async (areaId) => {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM riders r
     WHERE r.active = 1
       AND r.is_online = 1
       AND r.area_id = ?`,
    [areaId]
  );
  return Number(rows[0]?.cnt) || 0;
};

/**
 * Eligible for a new offer: active, online, no other pending offer, and not in
 * excludeIds (already offered/rejected this order). Multi-order is allowed.
 *
 * Also carries the rider's last known position plus a DB-clock freshness flag,
 * used by the radius rings in selectEligibleRider. These extra fields are
 * internal to the assignment engine — riderShape (what clients see) is left
 * alone so rider coordinates never leak into an API response by accident.
 *
 * areaId is required — an area 2 order must never offer to an area 1 rider.
 */
const listEligibleRiders = async ({ excludeIds = [], areaId } = {}) => {
  const exclude = (excludeIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  // Freshness param is bound before the area/exclude params — keep this order
  // in sync with the placeholders below.
  const params = [RIDER_LOCATION_MAX_AGE_SEC, areaId];
  let excludeClause = '';
  if (exclude.length > 0) {
    excludeClause = `AND r.id NOT IN (${exclude.map(() => '?').join(',')})`;
    params.push(...exclude);
  }

  const [rows] = await pool.query(
    `SELECT r.id, r.user_id, r.display_name, r.phone, r.active, r.is_online,
            r.last_lat, r.last_lng,
            (r.last_lat IS NOT NULL
             AND r.last_lng IS NOT NULL
             AND r.last_location_at IS NOT NULL
             AND r.last_location_at > (NOW() - INTERVAL ? SECOND)) AS location_fresh
     FROM riders r
     WHERE r.active = 1
       AND r.is_online = 1
       AND r.area_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM rider_order_offers ro
         WHERE ro.rider_id = r.id AND ro.status = 'pending'
       )
       ${excludeClause}
     ORDER BY r.id ASC`,
    params
  );

  return rows.map((r) => ({
    ...riderShape(r),
    lastLat: r.last_lat != null ? Number(r.last_lat) : null,
    lastLng: r.last_lng != null ? Number(r.last_lng) : null,
    locationFresh: Boolean(Number(r.location_fresh)),
  }));
};

/**
 * Count Delivered orders completed by this rider on the calendar day in RIDER_TODAY_TZ.
 * Uses COALESCE(rider_assigned_at, updated_at) converted to that timezone for the day boundary.
 */
const countCompletedDeliveriesToday = async (riderId) => {
  if (!riderId) return 0;
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM orders
     WHERE rider_id = ?
       AND status = 'Delivered'
       AND DATE(CONVERT_TZ(COALESCE(delivered_at, updated_at, created_at), '+00:00', ?)) =
           DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', ?))`,
    [riderId, RIDER_TODAY_TZ, RIDER_TODAY_TZ]
  );
  return Number(rows[0]?.cnt) || 0;
};

/**
 * Pure selection, two keys in order:
 *  1. fewest activeOrders — a rider carrying nothing always beats a rider who
 *     is mid-delivery, even if the free rider has completed more today;
 *  2. fewest completedToday — fair share among riders tied on load.
 * Ties on both are broken by randomFn.
 * Missing counts are treated as 0, so callers that only know completedToday
 * (all riders tie at 0 active) keep the original least-orders-today behaviour.
 * @param {Array<{id:number, activeOrders?:number, completedToday?:number}>} riders
 * @param {{ random?: () => number }} opts - random() returns [0,1)
 */
const selectRiderByLeastOrders = (riders, opts = {}) => {
  const random = typeof opts.random === 'function' ? opts.random : Math.random;
  if (!riders || riders.length === 0) return null;
  if (riders.length === 1) return riders[0];

  const activeOf = (r) => Number(r.activeOrders) || 0;
  const completedOf = (r) => Number(r.completedToday) || 0;

  let minActive = Infinity;
  for (const r of riders) {
    const a = activeOf(r);
    if (a < minActive) minActive = a;
  }
  const leastBusy = riders.filter((r) => activeOf(r) === minActive);
  if (leastBusy.length === 1) return leastBusy[0];

  let minCompleted = Infinity;
  for (const r of leastBusy) {
    const c = completedOf(r);
    if (c < minCompleted) minCompleted = c;
  }
  const candidates = leastBusy.filter((r) => completedOf(r) === minCompleted);
  if (candidates.length === 1) return candidates[0];
  const idx = Math.floor(random() * candidates.length);
  return candidates[Math.min(idx, candidates.length - 1)];
};

/**
 * Completed-today counts for a batch of riders in one query (avoids N+1).
 */
const countCompletedDeliveriesTodayBatch = async (riderIds) => {
  const ids = (riderIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (ids.length === 0) return {};
  const [rows] = await pool.query(
    `SELECT rider_id, COUNT(*) AS cnt
     FROM orders
     WHERE rider_id IN (${ids.map(() => '?').join(',')})
       AND status = 'Delivered'
       AND DATE(CONVERT_TZ(COALESCE(delivered_at, updated_at, created_at), '+00:00', ?)) =
           DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', ?))
     GROUP BY rider_id`,
    [...ids, RIDER_TODAY_TZ, RIDER_TODAY_TZ]
  );
  const map = {};
  for (const row of rows) map[row.rider_id] = Number(row.cnt) || 0;
  return map;
};

/**
 * Active (undelivered) orders currently carried by a batch of riders, in one
 * query. Same "still on the rider's plate" definition the rider app uses for
 * its assignment list: assigned and not yet Delivered/Cancelled.
 */
const countActiveOrdersBatch = async (riderIds) => {
  const ids = (riderIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (ids.length === 0) return {};
  const [rows] = await pool.query(
    `SELECT rider_id, COUNT(*) AS cnt
     FROM orders
     WHERE rider_id IN (${ids.map(() => '?').join(',')})
       AND status NOT IN ('Delivered', 'Cancelled')
     GROUP BY rider_id`,
    ids
  );
  const map = {};
  for (const row of rows) map[row.rider_id] = Number(row.cnt) || 0;
  return map;
};

/**
 * Straight-line km from a rider to the CLOSEST pickup point, or null when the
 * rider's position is unknown/stale or the order has no shop pins.
 * Multi-shop orders measure every shop and keep the nearest — the rings then
 * grow around all shops at once rather than one arbitrary shop.
 * @param {{lastLat:?number, lastLng:?number, locationFresh:?boolean}} rider
 * @param {Array<{lat:number, lng:number}>} pickupPoints
 */
const distanceToNearestPickupKm = (rider, pickupPoints) => {
  // Number(null) is 0 and Number.isFinite(0) is true, so a missing coordinate
  // would otherwise be read as lat/lng 0,0 — the Atlantic off Africa — and
  // yield a confident ~8600 km instead of "unknown".
  const coord = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  if (!rider || rider.locationFresh !== true) return null;
  const lat = coord(rider.lastLat);
  const lng = coord(rider.lastLng);
  if (lat === null || lng === null) return null;

  let min = null;
  for (const point of pickupPoints || []) {
    const pLat = coord(point?.lat);
    const pLng = coord(point?.lng);
    if (pLat === null || pLng === null) continue;
    const km = calculateDistance(lat, lng, pLat, pLng);
    if (!Number.isFinite(km)) continue;
    if (min === null || km < min) min = km;
  }
  return min;
};

/**
 * Pure ring selection. Walks the radius tiers smallest-first and returns the
 * first tier that still holds anyone, ranked inside that tier by the normal
 * rule (free riders first, then least delivered today).
 *
 * A tier only "empties" because everyone in it was already offered this order
 * and rejected/timed out — those riders arrive here pre-filtered via
 * listEligibleRiders' excludeIds — so rejection naturally widens the search.
 * Re-evaluating from the smallest ring on every call is deliberate: a rider
 * who comes online 500 m away mid-search jumps ahead of the 3 km fallback.
 *
 * Riders with unknown/stale positions match no ring and are only reachable in
 * the final distance-blind pass, which runs once every ring is exhausted so a
 * far (or unlocatable) rider can still take the order.
 * @param {Array<object>} riders - carrying distanceKm, activeOrders, completedToday
 * @param {number[]} tiersKm - ascending radii
 */
const selectRiderByRadiusTiers = (riders, tiersKm, opts = {}) => {
  if (!riders || riders.length === 0) return null;
  for (const tier of tiersKm || []) {
    const inTier = riders.filter((r) => r.distanceKm != null && r.distanceKm <= tier);
    if (inTier.length > 0) return selectRiderByLeastOrders(inTier, opts);
  }
  return selectRiderByLeastOrders(riders, opts);
};

/**
 * Attach activeOrders + completedToday to each eligible rider, then pick.
 * With pickupPoints: nearest ring wins, and inside a ring the normal rule
 * applies (free riders first, least-delivered-today among equals).
 * Without pickupPoints (house-only orders, or shops missing pins) it degrades
 * to the plain distance-blind rule.
 * @param {Array<object>} riders
 * @param {{ random?: () => number, pickupPoints?: Array<{lat:number,lng:number}>, tiersKm?: number[] }} opts
 */
const selectEligibleRider = async (riders, opts = {}) => {
  if (!riders || riders.length === 0) return null;
  const ids = riders.map((r) => r.id);
  const counts = await countCompletedDeliveriesTodayBatch(ids);
  const active = await countActiveOrdersBatch(ids);
  const pickupPoints = Array.isArray(opts.pickupPoints) ? opts.pickupPoints : [];
  const withCounts = riders.map((r) => ({
    ...r,
    completedToday: counts[r.id] || 0,
    activeOrders: active[r.id] || 0,
    distanceKm: pickupPoints.length > 0 ? distanceToNearestPickupKm(r, pickupPoints) : null,
  }));

  if (pickupPoints.length === 0) return selectRiderByLeastOrders(withCounts, opts);
  const tiersKm = Array.isArray(opts.tiersKm) ? opts.tiersKm : RIDER_SEARCH_RADIUS_TIERS_KM;
  return selectRiderByRadiusTiers(withCounts, tiersKm, opts);
};

/**
 * Auto-manage settings.delivery_available from online rider count (D12),
 * scoped to one area — a rider coming online in area 2 must never flip
 * area 1's delivery gate. Then re-sync shop_open via shops util, same area.
 * Never throws.
 */
const syncDeliveryAvailabilityFromRiders = async (areaId) => {
  try {
    const activeCount = await countActiveRiders(areaId);
    const desired = activeCount > 0 ? 1 : 0;

    const [settingsRows] = await pool.query('SELECT delivery_available FROM settings WHERE area_id = ? LIMIT 1', [areaId]);
    if (settingsRows.length === 0) return { changed: false, activeCount, deliveryAvailable: Boolean(desired) };

    const current = settingsRows[0].delivery_available ? 1 : 0;
    let changed = false;

    if (current !== desired) {
      const [result] = await pool.query(
        'UPDATE settings SET delivery_available = ? WHERE delivery_available != ? AND area_id = ?',
        [desired, desired, areaId]
      );
      changed = result.affectedRows > 0;
    }

    if (changed) {
      try {
        const { bustSettingsCache } = require('../controllers/settingsController');
        bustSettingsCache(areaId);
      } catch (_) {
        // best-effort
      }

      try {
        // Not yet area-scoped on the socket layer (per-area rooms land in
        // TASK 23) — every customer gets this event regardless of area.
        const { emitToAllCustomers } = require('../realtime/socket');
        emitToAllCustomers('settings.delivery_available.updated', {
          deliveryAvailable: Boolean(desired),
          delivery_available: Boolean(desired),
        });
      } catch (_) {
        // best-effort
      }

      // Existing master-gate side effect: delivery off forces shop_open closed, etc.
      const { syncAreaShopOpenState } = require('./shops');
      await syncAreaShopOpenState(areaId);
    }

    return { changed, activeCount, deliveryAvailable: Boolean(desired) };
  } catch (e) {
    console.error('[riders] syncDeliveryAvailabilityFromRiders failed:', e.message);
    return { changed: false, activeCount: 0, deliveryAvailable: false, error: e.message };
  }
};

module.exports = {
  RIDER_TODAY_TZ,
  RIDER_SEARCH_RADIUS_TIERS_KM,
  RIDER_LOCATION_MAX_AGE_SEC,
  distanceToNearestPickupKm,
  selectRiderByRadiusTiers,
  riderShape,
  getRiderForUser,
  countActiveRiders,
  listEligibleRiders,
  countCompletedDeliveriesToday,
  countCompletedDeliveriesTodayBatch,
  countActiveOrdersBatch,
  selectRiderByLeastOrders,
  selectEligibleRider,
  syncDeliveryAvailabilityFromRiders,
};
