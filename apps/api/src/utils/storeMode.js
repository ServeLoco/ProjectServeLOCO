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

// Key is already area-shaped (`active_slugs:<areaId>`) even though the
// query below isn't scoped to an area yet — that's TASK 11 (H4: store_type
// is a free string validated against a per-area list once store_modes
// itself is per-area). This plumbing means that swap only needs to replace
// the hardcoded STOPGAP below with a real areaId, not touch the cache key
// format or the exported function signatures (still zero-arg — every
// current caller stays untouched until TASK 11 threads areaId through).
const STORE_MODE_AREA_ID_STOPGAP = 1;
const cacheKeyForArea = (areaId) => `active_slugs:${areaId}`;
const cache = createTtlCache({ ttlMs: 30_000 });

/**
 * Loads the set of currently-active store mode slugs from the DB, cached for
 * 30s. Falls back to the two legacy system modes if the table is briefly
 * unreachable (e.g. mid-migration) so validation never hard-fails startup.
 */
const loadActiveSlugs = async () => {
  return cache.wrap(cacheKeyForArea(STORE_MODE_AREA_ID_STOPGAP), async () => {
    try {
      const [rows] = await pool.query('SELECT slug FROM store_modes WHERE active = TRUE');
      const slugs = new Set(rows.map(r => r.slug));
      if (slugs.size === 0) return new Set(['packed', 'fast_food']);
      return slugs;
    } catch {
      return new Set(['packed', 'fast_food']);
    }
  });
};

/** Call after any admin store-mode create/update/deactivate so reads see it immediately. */
const invalidateStoreModeCache = () => cache.del(cacheKeyForArea(STORE_MODE_AREA_ID_STOPGAP));

/** Returns the active store mode slugs (excludes the 'all' sentinel) as an array. */
const getActiveStoreModeSlugs = async () => Array.from(await loadActiveSlugs());

// The two original hardcoded modes are is_system rows that can never be
// deactivated (see storeModeController.updateStoreMode), so membership here
// is always valid without a DB round-trip.
const SYSTEM_SLUGS = new Set(['packed', 'fast_food']);
const isSystemModeSlug = (slug) => SYSTEM_SLUGS.has(slug);

/**
 * Normalizes store mode values from UI or API to the canonical database slug.
 *
 * @param {string} value The incoming store mode value.
 * @param {Object} options Options for normalization.
 * @param {string|false} [options.fallback] A fallback mode if value is not provided (e.g. 'packed'). If false, throws error on missing.
 * @param {boolean} [options.allowAll] Whether 'all' is a valid mode (useful for legacy APIs before full cleanup).
 * @returns {Promise<string>} The canonical store mode slug (or 'all' if allowed).
 */
const normalizeStoreType = async (value, options = {}) => {
  const { fallback = 'packed', allowAll = false } = options;

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

  const activeSlugs = await loadActiveSlugs();
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
