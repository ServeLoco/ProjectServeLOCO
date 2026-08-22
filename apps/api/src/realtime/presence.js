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
  // Global peak (areaId omitted) is kept separately from per-area peaks
  // (areaId → high-water mark) — since emitLiveSnapshot now calls
  // getLiveSnapshot(areaId) once per real area (23), each area's own room
  // needs its own peak, not one shared global number.
  let peakToday = 0;
  const peakByArea = new Map();
  let peakDate = now().toDateString();

  const resetPeakIfNewDay = () => {
    const today = now().toDateString();
    if (today !== peakDate) {
      peakDate = today;
      peakToday = 0;
      peakByArea.clear();
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
      // Resolved by the caller (socket.js) at connect time — no pin exists
      // at the socket layer (H7), so this is users.last_area_id → default
      // area, same as the session doc opened below. May be null if even that
      // fallback chain came up empty.
      areaId: meta.areaId ?? null,
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
        areaId: meta.areaId,
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

  /**
   * areaId filters to one area's online customers; omitted returns every
   * area combined (used by tests and any caller wanting the old global
   * view). emitLiveSnapshot (below) calls this once per real area so each
   * admin:<areaId> room gets its own scoped snapshot.
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

    let scopedPeak;
    if (areaId === undefined) {
      if (online > peakToday) peakToday = online;
      scopedPeak = peakToday;
    } else {
      scopedPeak = peakByArea.get(areaId) || 0;
      if (online > scopedPeak) {
        scopedPeak = online;
        peakByArea.set(areaId, scopedPeak);
      }
    }

    return {
      online,
      peakToday: scopedPeak,
      byScreen,
      byPlatform,
      byArea,
      users,
    };
  };

  // One snapshot per area (§3.5/23) — a super admin's socket already joined
  // every admin:<areaId> room (socket.js's joinAreaRoom), so they still see
  // every area; an area_admin now only sees their own. Areas with zero
  // online customers right now still need their own zeroed snapshot pushed
  // (via listAreas), or their dashboard just goes stale instead of showing
  // online: 0. Lazy-required + NODE_ENV guarded like every other DB touch on
  // this socket-layer timer path (mirrors socket.js's own guard) so presence
  // unit tests stay DB-free.
  const emitLiveSnapshot = async () => {
    reapDeadSockets();
    try {
      const areaIds = new Set();
      for (const entry of presence.values()) {
        if (entry.role === 'customer' && entry.areaId != null) areaIds.add(entry.areaId);
      }
      if (process.env.NODE_ENV !== 'test') {
        const { listAreas } = require('../utils/areaScope');
        const areas = await listAreas();
        areas.forEach((area) => areaIds.add(area.id));
      }
      areaIds.forEach((areaId) => {
        emitToAdmins(areaId, 'analytics.live', getLiveSnapshot(areaId));
      });
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
