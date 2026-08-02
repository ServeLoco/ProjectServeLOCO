/**
 * Single source of truth for multi-area resolution and scoping helpers.
 * See plans/multi-area.md §2.4 (locked resolution chain), §3 (performance
 * contract), §4.1/§4.2 (this module + its middleware).
 *
 * Nothing in this file is wired into any controller or route yet (TASK 6 —
 * "No controller uses any of this yet"). requireAdmin/requireCustomer gain
 * area awareness in TASK 7/8; the Phase C sweep (TASK 9-17) is what starts
 * actually reading req.areaId in queries.
 */
const { pool } = require('../db/mysql');
const { createTtlCache } = require('./ttlCache');
const { matchZone, loadActiveZones, parseBoundary } = require('./deliveryPricing');
const microCache = require('./microCache');

// ---------------------------------------------------------------------
// Areas: cached lookups (§3.9 — tens of areas, not millions; a 60s
// process-level cache is plenty and avoids a DB round trip on every
// request that needs to know an area's name/timezone/bbox).
// ---------------------------------------------------------------------
const AREAS_CACHE_TTL_MS = 60_000;
const areasCache = createTtlCache({ ttlMs: AREAS_CACHE_TTL_MS });
const ALL_AREAS_KEY = 'all';

async function loadAllAreas() {
  return areasCache.wrap(ALL_AREAS_KEY, async () => {
    const [rows] = await pool.query('SELECT * FROM areas ORDER BY id ASC');
    return rows;
  });
}

/** Returns the areas row for areaId, or null. 60s cached. */
async function getAreaById(areaId) {
  const areas = await loadAllAreas();
  return areas.find((a) => a.id === Number(areaId)) || null;
}

/** Returns all areas, optionally filtered to active ones. 60s cached. */
async function listAreas({ activeOnly = false } = {}) {
  const areas = await loadAllAreas();
  return activeOnly ? areas.filter((a) => Boolean(a.active)) : areas;
}

/** The area new/pin-less customer traffic falls back to (§2.12/§4.2). */
async function getDefaultArea() {
  const areas = await listAreas({ activeOnly: true });
  return areas.find((a) => Boolean(a.is_default)) || null;
}

// ---------------------------------------------------------------------
// Per-area delivery-zone loading, used by resolveAreaForPoint below.
// TASK 10 gave deliveryPricing.js's loadActiveZones(db, areaId) a real
// area filter, so this just wraps it in a short TTL cache — no more
// duplicate query (TASK 6 had its own inline query here, specifically
// because loadActiveZones was still platform-wide at the time; that
// reason is gone now).
// ---------------------------------------------------------------------
const AREA_ZONES_CACHE_TTL_MS = 15_000;
const areaZonesCache = createTtlCache({ ttlMs: AREA_ZONES_CACHE_TTL_MS });

async function loadZonesForArea(areaId) {
  return areaZonesCache.wrap(`zones:${areaId}`, () => loadActiveZones(pool, areaId));
}

/**
 * Bbox prefilter (§3.2 step 2): which active areas' bounding boxes could
 * possibly contain this point. An area with no bbox yet (min_lat IS NULL —
 * true for every area until TASK 10 starts recomputing it on zone writes)
 * is always included as a candidate, since we don't know its extent well
 * enough to exclude it. With a single area and no bbox computed yet, this
 * degrades to exactly today's behavior: check the one area there is.
 */
async function bboxCandidateAreas(lat, lng) {
  const areas = await listAreas({ activeOnly: true });
  return areas.filter((a) => {
    if (a.min_lat === null || a.min_lat === undefined) return true;
    const minLat = Number(a.min_lat);
    const maxLat = Number(a.max_lat);
    const minLng = Number(a.min_lng);
    const maxLng = Number(a.max_lng);
    return lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng;
  });
}

/**
 * The resolution chain, in one function (§2.4): pin -> delivery zone
 * (nested child wins, via the existing matchZone) -> area. Exclusion
 * zones (delivery_exclusion_zones) are NOT consulted here — they block
 * DELIVERY at pricing time (resolveDeliveryPricing), which is orthogonal
 * to which area's catalog a customer standing at that point should see.
 *
 * @returns {Promise<{areaId: number, zoneId: number, zone: object}|null>}
 *   null when the point is missing/invalid, or falls inside no active
 *   zone in any candidate area — callers must treat that as "we don't
 *   deliver here yet", never fall back to the default area (§2.4).
 */
async function resolveAreaForPoint(lat, lng) {
  const numLat = Number(lat);
  const numLng = Number(lng);
  if (!Number.isFinite(numLat) || !Number.isFinite(numLng)) return null;

  const candidates = await bboxCandidateAreas(numLat, numLng);
  for (const area of candidates) {
    const zones = await loadZonesForArea(area.id);
    const zone = matchZone(numLat, numLng, zones);
    if (zone) {
      return { areaId: area.id, zoneId: zone.id, zone };
    }
  }
  return null;
}

/**
 * Best-effort area id for a pricing calculation (cart preview, order
 * creation) that already has its own "nothing matched" safety net —
 * resolveDeliveryPricing falls back to flat pricing when zones is empty,
 * regardless of WHY it's empty. Those callers don't need resolveAreaForPoint's
 * strict null-means-"we don't deliver here" distinction (that's a checkout-
 * gating concern, TASK 13/27's job); they just need a definite area id to
 * scope the zone/exclusion-zone queries with. Falls back to the default
 * area when the pin is missing/invalid or matches no zone.
 */
async function resolveAreaIdForPricing(lat, lng) {
  const resolved = await resolveAreaForPoint(lat, lng);
  if (resolved) return resolved.areaId;
  const defaultArea = await getDefaultArea();
  return defaultArea ? defaultArea.id : 1;
}

// ---------------------------------------------------------------------
// Request-scoped accessors
// ---------------------------------------------------------------------

/**
 * The single place req.areaId is read from. Throws if area middleware
 * never ran (req.areaId still undefined) — a bug at the call site, not a
 * legitimate state. `null` (customer: no resolvable area; super_admin: no
 * area picked) and `'all'` (super_admin cross-area) are both valid
 * resolved values and are returned as-is.
 */
function requestAreaId(req) {
  if (req.areaId === undefined) {
    throw new Error('req.areaId was read before area-resolution middleware ran');
  }
  return req.areaId;
}

/**
 * Throws a 403 (statusCode/code shaped for errorHandler.js) unless the
 * requesting admin is a super_admin, or an area_admin whose own area
 * matches areaId. Intended to be called from inside an asyncHandler-
 * wrapped controller before an area-targeted write; not a route
 * middleware itself (needs the specific target areaId, e.g. from a body
 * field, which varies per endpoint).
 */
function assertAreaAccess(req, areaId) {
  const admin = req.admin;
  if (admin && admin.adminRole === 'super_admin') return;
  if (admin && admin.adminRole === 'area_admin' && admin.areaId === areaId) return;
  const err = new Error('You do not have access to this area');
  err.statusCode = 403;
  err.code = 'FORBIDDEN';
  throw err;
}

// ---------------------------------------------------------------------
// Cache invalidation (§4.3) — the one call every mutation makes instead
// of the ~25 scattered microCache.bust() pairs it used to take.
// ---------------------------------------------------------------------

/**
 * UPDATE areas SET catalog_version = catalog_version + 1. Public GETs use
 * this to build an ETag (§3.10, TASK 27) so an unchanged catalog can 304
 * instead of re-sending a full body.
 */
async function bumpCatalogVersion(areaId) {
  await pool.query('UPDATE areas SET catalog_version = catalog_version + 1 WHERE id = ?', [areaId]);
  areasCache.del(ALL_AREAS_KEY); // the cached areas row is now stale
}

/**
 * Recomputes an area's bounding box (§3.2, TASK 10) from the union of its
 * OWN active zones' vertices — called by every zone write
 * (deliveryZonesController.notifyZonesChanged) so resolveAreaForPoint's
 * bbox prefilter stays accurate. Zero active zones (or zero with a usable
 * boundary) clears the bbox back to NULL, which bboxCandidateAreas already
 * treats as "always a candidate" — the same safe fallback a brand new
 * area has before it's drawn its first zone.
 */
async function recomputeAreaBbox(areaId) {
  const zones = await loadActiveZones(pool, areaId);
  let minLat = null, maxLat = null, minLng = null, maxLng = null;
  for (const zone of zones) {
    for (const point of parseBoundary(zone.boundary)) {
      if (minLat === null || point.lat < minLat) minLat = point.lat;
      if (maxLat === null || point.lat > maxLat) maxLat = point.lat;
      if (minLng === null || point.lng < minLng) minLng = point.lng;
      if (maxLng === null || point.lng > maxLng) maxLng = point.lng;
    }
  }
  await pool.query(
    'UPDATE areas SET min_lat = ?, max_lat = ?, min_lng = ?, max_lng = ? WHERE id = ?',
    [minLat, maxLat, minLng, maxLng, areaId]
  );
  areasCache.del(ALL_AREAS_KEY);
}

/**
 * Fans out to every area-scoped cache. Partial today, by necessity:
 * microCache namespaces (dashboard/categories/delivery-zones) are
 * genuinely area-keyed as of TASK 4, so busting them by areaId works
 * correctly right now. bustSettingsCache() is still zero-arg and only
 * ever busts area 1's stopgap key (TASK 12 parameterizes it for real) —
 * calling it here is forward-compatible plumbing, not yet a real per-area
 * bust. invalidateStoreModeCache(areaId) is real as of TASK 11. Documented
 * rather than hidden, so nobody mistakes settings for already area-scoped.
 */
function bustAreaCaches(areaId) {
  microCache.bust('dashboard', areaId);
  microCache.bust('categories', areaId);
  microCache.bust('delivery-zones', areaId);
  areaZonesCache.del(`zones:${areaId}`);

  // Lazy requires: both controllers require areaScope-adjacent utilities
  // at load time in later tasks, so a top-level require here risks a
  // circular import — same reasoning as utils/shops.js's existing lazy
  // requires of these two.
  try {
    const { bustSettingsCache } = require('../controllers/settingsController');
    bustSettingsCache();
  } catch (_) { /* settingsController not loaded in this context (e.g. a unit test) */ }
  try {
    const { invalidateStoreModeCache } = require('./storeMode');
    invalidateStoreModeCache(areaId);
  } catch (_) { /* storeMode not loaded in this context */ }

  return bumpCatalogVersion(areaId);
}

/**
 * Seeds the two is_system store modes (packed, fast_food) for one area.
 * INSERT IGNORE against uniq_store_modes_area_slug (area_id, slug) — safe
 * to call repeatedly (migration reruns) and reused by clone-area (TASK 25)
 * so a brand new area always opens with both legacy modes present.
 */
async function seedSystemStoreModes(areaId) {
  await pool.query(
    `INSERT IGNORE INTO store_modes (area_id, slug, label, display_order, active, is_system)
     VALUES (?, 'packed', 'Packed Items', 1, TRUE, TRUE), (?, 'fast_food', 'Fast Food', 2, TRUE, TRUE)`,
    [areaId, areaId]
  );
}

// ---------------------------------------------------------------------
// Test-only: reset every in-process cache this module owns, so tests
// don't leak state into each other via the 60s/15s TTL caches.
// ---------------------------------------------------------------------
function _resetCachesForTests() {
  areasCache.del();
  areaZonesCache.del();
}

module.exports = {
  getAreaById,
  listAreas,
  getDefaultArea,
  resolveAreaForPoint,
  resolveAreaIdForPricing,
  recomputeAreaBbox,
  requestAreaId,
  assertAreaAccess,
  bustAreaCaches,
  bumpCatalogVersion,
  seedSystemStoreModes,
  _resetCachesForTests,
};
