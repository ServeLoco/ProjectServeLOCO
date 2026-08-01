/**
 * In-process micro-cache for hot public GETs (dashboard, categories,
 * delivery zones). Plain Map, FIFO eviction. No redis.
 *
 * Multi-area: every key MUST be shaped `<namespace>:<areaId>:<rest>` (or
 * bare `<namespace>:<areaId>` with no rest) so a mutation in one area can
 * never bust another area's cached response. set() validates this shape
 * outside production and throws on a malformed key — catching a missing
 * areaId at the call site that wrote it, not months later as a customer
 * seeing another area's dashboard. get() stays lenient: a malformed read
 * key just misses the cache rather than crashing a request.
 * bust(namespace, areaId) then clears exactly one area's slice;
 * bust(namespace) with no areaId is kept only for genuinely global
 * (non-area) cache entries — see plans/multi-area.md §3.4.
 */

const MAX_ENTRIES = 600;

/** @type {Map<string, { value: any, expiresAt: number }>} */
const store = new Map();

const KEY_SHAPE = /^[^:]+:\d+(:.*)?$/;

function assertValidKey(key) {
  if (process.env.NODE_ENV === 'production') return;
  if (typeof key !== 'string' || !KEY_SHAPE.test(key)) {
    throw new Error(
      `microCache: key ${JSON.stringify(key)} is not shaped "<namespace>:<areaId>:<rest>" — ` +
      'every entry must be scoped to an area. See plans/multi-area.md §3.4.'
    );
  }
}

function get(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

function set(key, value, ttlMs) {
  assertValidKey(key);
  if (store.has(key)) store.delete(key);
  store.set(key, { value, expiresAt: Date.now() + Math.max(0, Number(ttlMs) || 0) });
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
}

/**
 * bust(namespace) — global prefix bust (plain startsWith), for genuinely
 * non-area-scoped data only.
 * bust(namespace, areaId) — clears exactly that area's slice. Matches the
 * bare `namespace:areaId` key and everything under `namespace:areaId:`,
 * guarded by the trailing colon so area 1 can never accidentally sweep
 * area 10's keys via a naive substring prefix match.
 */
function bust(namespace, areaId) {
  if (areaId === undefined) {
    for (const key of [...store.keys()]) {
      if (key.startsWith(namespace)) store.delete(key);
    }
    return;
  }
  const exact = `${namespace}:${areaId}`;
  const prefix = `${exact}:`;
  for (const key of [...store.keys()]) {
    if (key === exact || key.startsWith(prefix)) store.delete(key);
  }
}

function clearAll() {
  store.clear();
}

module.exports = { get, set, bust, clearAll, MAX_ENTRIES };
