const { pool } = require('../db/mysql');
const { createTtlCache } = require('./ttlCache');

// Legacy string aliases for the two original hardcoded modes. Kept forever so
// old app builds / bulk-import sheets / admin bookmarks that send these exact
// strings keep working even after modes become admin-configurable.
const LEGACY_ALIASES = {
  packed: 'packed',
  'packed items': 'packed',
  packed_items: 'packed',
  fast_food: 'fast_food',
  'fast food': 'fast_food',
  fastfood: 'fast_food',
  fast: 'fast_food'
};

// Every caller in this codebase that hasn't been threaded through with a
// real req.areaId yet falls back to this stopgap — same pattern as TASK 4's
// microCache work. Callers within TASK 11's own file list (productController,
// categoryController, comboController, bulkImportController) now pass a real
// areaId; the rest (settingsController, dashboardController, cartController,
// couponController) still get area 1 until the tasks that own THEM
// (TASK 12/13/14) thread it through — H4's area-scoped validation already
// applies for the callers that matter most today (catalog writes).
const STORE_MODE_AREA_ID_STOPGAP = 1;
const cacheKeyForArea = (areaId) => `active_slugs:${areaId}`;
const cache = createTtlCache({ ttlMs: 30_000 });

/**
 * Loads the set of currently-active store mode slugs for ONE area, cached
 * for 30s. Falls back to the two legacy system modes if the table is
 * briefly unreachable (e.g. mid-migration) so validation never hard-fails
 * startup.
 */
const loadActiveSlugs = async (areaId = STORE_MODE_AREA_ID_STOPGAP) => {
  return cache.wrap(cacheKeyForArea(areaId), async () => {
    try {
      const [rows] = await pool.query('SELECT slug FROM store_modes WHERE active = TRUE AND area_id = ?', [areaId]);
      const slugs = new Set(rows.map(r => r.slug));
      if (slugs.size === 0) return new Set(['packed', 'fast_food']);
      return slugs;
    } catch {
      return new Set(['packed', 'fast_food']);
    }
  });
};

/** Call after any admin store-mode create/update/deactivate so reads see it immediately. */
const invalidateStoreModeCache = (areaId = STORE_MODE_AREA_ID_STOPGAP) => cache.del(cacheKeyForArea(areaId));

/** Returns the active store mode slugs for an area (excludes the 'all' sentinel) as an array. */
const getActiveStoreModeSlugs = async (areaId = STORE_MODE_AREA_ID_STOPGAP) => Array.from(await loadActiveSlugs(areaId));

// The two original hardcoded modes are is_system rows that can never be
// deactivated (see storeModeController.updateStoreMode), so membership here
// is always valid without a DB round-trip — true in every area, since
// TASK 11 seeds is_system rows per area.
const SYSTEM_SLUGS = new Set(['packed', 'fast_food']);
const isSystemModeSlug = (slug) => SYSTEM_SLUGS.has(slug);

/**
 * Normalizes store mode values from UI or API to the canonical database slug.
 *
 * @param {string} value The incoming store mode value.
 * @param {Object} options Options for normalization.
 * @param {string|false} [options.fallback] A fallback mode if value is not provided (e.g. 'packed'). If false, throws error on missing.
 * @param {boolean} [options.allowAll] Whether 'all' is a valid mode (useful for legacy APIs before full cleanup).
 * @param {number} [options.areaId] Which area's active store modes to validate against (H4) —
 *   defaults to the stopgap area until the caller has been threaded through with a real one.
 * @returns {Promise<string>} The canonical store mode slug (or 'all' if allowed).
 */
const normalizeStoreType = async (value, options = {}) => {
  const { fallback = 'packed', allowAll = false, areaId = STORE_MODE_AREA_ID_STOPGAP } = options;

  if (!value) {
    if (fallback === false) {
      throw new Error('store_type is required');
    }
    return fallback;
  }

  const normalizedValue = value.toString().trim().toLowerCase();

  if (normalizedValue === 'all') {
    if (allowAll) return 'all';
    throw new Error('store_type "all" is not allowed in this context');
  }

  if (LEGACY_ALIASES[normalizedValue]) {
    return LEGACY_ALIASES[normalizedValue];
  }

  const activeSlugs = await loadActiveSlugs(areaId);
  if (activeSlugs.has(normalizedValue)) {
    return normalizedValue;
  }

  throw new Error(`Invalid store_type: ${value}`);
};

module.exports = {
  normalizeStoreType,
  invalidateStoreModeCache,
  getActiveStoreModeSlugs,
  isSystemModeSlug
};
