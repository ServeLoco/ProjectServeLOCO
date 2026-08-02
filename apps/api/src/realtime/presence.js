// Live presence tracker for analytics.
// In-memory Map<socketId, {userId, role, platform, appVersion, screen,
// connectedAt, sessionId, screens}>. Every 5s emits an `analytics.live`
// snapshot to the admin room. Admin sockets are never counted as online users.
//
// Designed as a factory (createPresenceTracker) so the sessionStore and
// emitToAdmins deps are injectable for unit testing — no Mongo or socket.io
// needed in tests.

const SCREEN_WHITELIST = new Set([
  'Home',
  'Categories',
  'ProductList',
  'ProductDetail',
  'Cart',
  'Checkout',
  'Orders',
  'Search',
  'Profile',
]);

const DEFAULT_INTERVAL_MS = 5000;

/**
 * @param {{sessionStore:{openSession:Function,closeSession:Function}, emitToAdmins:Function}} deps
 * @param {{intervalMs?:number, now?:()=>Date}} [opts]
 */
const createPresenceTracker = (deps, opts = {}) => {
  const { sessionStore, emitToAdmins } = deps;
  const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
  const now = opts.now || (() => new Date());

  // socketId → entry
  const presence = new Map();
  let peakToday = 0;
  let peakDate = now().toDateString();

  const resetPeakIfNewDay = () => {
    const today = now().toDateString();
    if (today !== peakDate) {
      peakDate = today;
      peakToday = 0;
    }
  };

  const addPresence = async (socketId, meta) => {
    if (!socketId) return;
    // Admin sockets are never tracked as online users.
    if (meta?.role !== 'customer') return;

    let sessionId = null;
    try {
      sessionId = await sessionStore.openSession({
        userId: meta.userId,
        platform: meta.platform,
        appVersion: meta.appVersion,
        areaId: meta.areaId,
      });
    } catch (_) {
      // fire-and-forget — sessionStore already swallows, but double-guard
    }

    presence.set(socketId, {
      userId: meta.userId,
      role: meta.role,
      // Resolved by the caller (socket.js) at connect time — no pin exists
      // at the socket layer (H7), so this is users.last_area_id → default
      // area, same as the session doc just opened above. May be null if
      // even that fallback chain came up empty.
      areaId: meta.areaId ?? null,
      platform: meta.platform || null,
      appVersion: meta.appVersion || null,
      screen: null,
      connectedAt: now(),
      sessionId,
      screens: {},
    });
    resetPeakIfNewDay();
  };

  const updateScreen = (socketId, screen) => {
    const entry = presence.get(socketId);
    if (!entry) return;
    if (!SCREEN_WHITELIST.has(screen)) return;
    entry.screen = screen;
    entry.screens[screen] = (entry.screens[screen] || 0) + 1;
  };

  const removePresence = async (socketId) => {
    const entry = presence.get(socketId);
    if (!entry) return;
    presence.delete(socketId);
    try {
      await sessionStore.closeSession(entry.sessionId, entry.screens, entry.connectedAt);
    } catch (_) {
      // fire-and-forget
    }
  };

  /**
   * areaId filters to one area's online customers; omitted (default)
   * returns every area combined — today's pre-TASK-17 behavior, unchanged,
   * since per-area admin socket rooms don't exist yet (TASK 23). Each user
   * entry still carries its own areaId either way, and the combined
   * snapshot's `byArea` breakdown lets a caller split it client-side today
   * without waiting on real rooms.
   */
  const getLiveSnapshot = (areaId) => {
    resetPeakIfNewDay();
    const users = [];
    const byScreen = {};
    const byPlatform = { android: 0, ios: 0 };
    const byArea = {};

    let online = 0;
    for (const entry of presence.values()) {
      if (entry.role !== 'customer') continue;
      if (areaId !== undefined && entry.areaId !== areaId) continue;
      online += 1;

      if (entry.platform) {
        const p = String(entry.platform).toLowerCase();
        if (p === 'android' || p === 'ios') byPlatform[p] += 1;
      }

      if (entry.screen) {
        byScreen[entry.screen] = (byScreen[entry.screen] || 0) + 1;
      }

      const areaKey = entry.areaId == null ? 'unknown' : String(entry.areaId);
      byArea[areaKey] = (byArea[areaKey] || 0) + 1;

      const connectedMin = Math.max(0, Math.round((now() - entry.connectedAt) / 60000));
      users.push({
        userId: entry.userId,
        areaId: entry.areaId,
        screen: entry.screen,
        platform: entry.platform,
        connectedMin,
      });
    }

    if (areaId === undefined && online > peakToday) peakToday = online;

    return {
      online,
      peakToday,
      byScreen,
      byPlatform,
      byArea,
      users,
    };
  };

  // Not yet area-scoped on the socket layer (per-area admin rooms land in
  // TASK 23) — this still emits one combined snapshot to every admin
  // regardless of area, same as every other realtime emit in the codebase
  // until then. getLiveSnapshot(areaId) above is ready for TASK 23 to call
  // per area room; the `byArea` field on the combined snapshot is the
  // interim way a client can already split this today.
  const emitLiveSnapshot = () => {
    const snap = getLiveSnapshot();
    try {
      emitToAdmins('analytics.live', snap);
    } catch (_) {
      // never throw from the timer
    }
  };

  // Periodic push every `intervalMs`. unref() so it doesn't keep the process
  // alive in tests / on graceful shutdown.
  const timer = setInterval(emitLiveSnapshot, intervalMs);
  timer.unref();

  const stop = () => {
    clearInterval(timer);
    presence.clear();
  };

  return {
    addPresence,
    updateScreen,
    removePresence,
    getLiveSnapshot,
    emitLiveSnapshot,
    stop,
  };
};

module.exports = { createPresenceTracker, SCREEN_WHITELIST };
