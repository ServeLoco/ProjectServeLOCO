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
 * @param {{sessionStore:{openSession:Function,closeSession:Function}, emitToAdmins:Function,
 *   isSocketAlive?:(socketId:string)=>boolean}} deps
 *   isSocketAlive is the liveness probe for the reaper below (socket.js passes
 *   io.sockets.sockets.has). Optional: omitted in unit tests, where there is no
 *   socket.io server and the reaper is simply inert.
 * @param {{intervalMs?:number, now?:()=>Date}} [opts]
 */
const createPresenceTracker = (deps, opts = {}) => {
  const { sessionStore, emitToAdmins, isSocketAlive } = deps;
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

    // Insert into the Map BEFORE any await. Previously the entry was written
    // only after openSession's Mongo round-trip resolved, so a socket that
    // disconnected inside that window hit removePresence while the Map was
    // still empty — that call no-opped, and this set() then re-inserted an
    // entry for an already-dead socket. Nothing could ever remove it: the
    // Map has no TTL and 'disconnect' had already fired. The result was a
    // permanent phantom "online" user (seen stuck at 20+ hours in the live
    // analytics panel) plus an analytics_sessions doc never closed.
    const entry = {
      userId: meta.userId,
      role: meta.role,
      platform: meta.platform || null,
      appVersion: meta.appVersion || null,
      screen: null,
      connectedAt: now(),
      sessionId: null,
      screens: {},
    };
    presence.set(socketId, entry);
    resetPeakIfNewDay();

    let sessionId = null;
    try {
      sessionId = await sessionStore.openSession({
        userId: meta.userId,
        platform: meta.platform,
        appVersion: meta.appVersion,
      });
    } catch (_) {
      // fire-and-forget — sessionStore already swallows, but double-guard
    }

    if (presence.get(socketId) === entry) {
      entry.sessionId = sessionId;
      return;
    }

    // The socket disconnected (or was reaped) while openSession was in flight.
    // removePresence already dropped the entry and saw sessionId still null,
    // so it could not close the doc — close it here rather than resurrecting
    // a dead entry in the Map.
    if (sessionId) {
      Promise.resolve(sessionStore.closeSession(sessionId, entry.screens, entry.connectedAt))
        .catch(() => {});
    }
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

  // Safety net. The addPresence race above is fixed, but the Map still has no
  // TTL and its only eviction path is a 'disconnect' event — any future path
  // that drops one (a handler throwing before removePresence, a socket the
  // server tears down without emitting) leaks an entry that counts as online
  // forever and rides in every 5s snapshot. Sweeping against the live socket
  // set on the same timer bounds that to one interval, whatever the cause.
  const reapDeadSockets = () => {
    if (typeof isSocketAlive !== 'function') return;
    for (const socketId of [...presence.keys()]) {
      if (!isSocketAlive(socketId)) {
        removePresence(socketId).catch(() => {});
      }
    }
  };

  const getLiveSnapshot = () => {
    resetPeakIfNewDay();
    const users = [];
    const byScreen = {};
    const byPlatform = { android: 0, ios: 0 };

    let online = 0;
    for (const entry of presence.values()) {
      if (entry.role !== 'customer') continue;
      online += 1;

      if (entry.platform) {
        const p = String(entry.platform).toLowerCase();
        if (p === 'android' || p === 'ios') byPlatform[p] += 1;
      }

      if (entry.screen) {
        byScreen[entry.screen] = (byScreen[entry.screen] || 0) + 1;
      }

      const connectedMin = Math.max(0, Math.round((now() - entry.connectedAt) / 60000));
      users.push({
        userId: entry.userId,
        screen: entry.screen,
        platform: entry.platform,
        connectedMin,
      });
    }

    if (online > peakToday) peakToday = online;

    return {
      online,
      peakToday,
      byScreen,
      byPlatform,
      users,
    };
  };

  const emitLiveSnapshot = () => {
    reapDeadSockets();
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
    reapDeadSockets,
    getLiveSnapshot,
    emitLiveSnapshot,
    stop,
  };
};

module.exports = { createPresenceTracker, SCREEN_WHITELIST };
