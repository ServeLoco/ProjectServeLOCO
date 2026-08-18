const { Server } = require('socket.io');
const config = require('../config/env');
const { verifyToken } = require('../utils/auth');
const { createPresenceTracker } = require('./presence');
const sessionStore = require('../services/analytics/sessionStore');
const { pool } = require('../db/mysql');
const { getDefaultArea, listAreas, getAreaById } = require('../utils/areaScope');

let io = null;
let presenceTracker = null;

const parseAllowedOrigins = () => {
  const origins = String(config.CORS_ORIGIN || '*')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

  if (origins.length === 0 || origins.includes('*')) return '*';
  return origins;
};

const extractSocketToken = (socket) => {
  const authToken = socket.handshake.auth?.token;
  if (authToken) return authToken;

  const header = socket.handshake.headers?.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.substring(7);
  }

  return null;
};

const authenticateSocket = async (socket, next) => {
  const token = extractSocketToken(socket);

  if (!token) {
    return next(new Error('AUTH_TOKEN_MISSING'));
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch (_error) {
    return next(new Error('AUTH_TOKEN_INVALID'));
  }

  const role = payload.role;
  const id = payload.sub || payload.id;

  if (!id || !['customer', 'admin'].includes(role)) {
    return next(new Error('FORBIDDEN_ROLE'));
  }

  // Mirror requireAdmin's revocation check (authMiddleware.js) — an admin
  // hitting "revoke sessions" for a leaked token must also cut that
  // token's realtime access, not just its REST access.
  if (role === 'admin' && process.env.NODE_ENV !== 'test') {
    try {
      const [rows] = await pool.query('SELECT revoked_before FROM admin_auth_state WHERE id = 1');
      const revokedBefore = rows[0]?.revoked_before;
      if (revokedBefore && payload.iat && payload.iat * 1000 < new Date(revokedBefore).getTime()) {
        return next(new Error('AUTH_TOKEN_INVALID'));
      }

      // Same live re-check requireAdmin does on every REST request (bug
      // fix, multi-area audit finding #4). Without this, a deactivated or
      // reassigned admin who is already connected keeps receiving that
      // OTHER area's live order broadcasts (customer name/phone/address)
      // for the rest of the socket's life, up to ADMIN_JWT_EXPIRES_IN
      // (12h) — the REST-only re-check only stops their next HTTP call,
      // not a socket connection made before the demotion/deactivation.
      const liveState = await getLiveAdminState(payload);
      if (liveState === 'revoked') {
        return next(new Error('AUTH_TOKEN_INVALID'));
      }
      if (liveState) {
        payload.adminRole = liveState.role;
        payload.areaId = liveState.area_id;
      }
    } catch (_error) {
      // The token itself verified fine above — this is the revocation/
      // live-recheck queries failing (DB connection blip, pool exhaustion),
      // not a bad token. Distinct error code so it doesn't read as an
      // invalid/expired session in logs or client telemetry, same
      // distinction requireAdmin's HTTP path already makes (its own catch
      // calls next(error) rather than collapsing every failure to a 401).
      // Still rejects the connection either way — skipping this check
      // because the DB is unreachable would let a demoted/revoked admin's
      // stale JWT claims through for the outage's duration, exactly what
      // it exists to prevent.
      return next(new Error('AUTH_SERVICE_UNAVAILABLE'));
    }
  }

  socket.data.auth = { id, role, adminRole: payload.adminRole, areaId: payload.areaId };
  return next();
};

// No pin exists at the socket layer (H7 — a cold-start connect races the
// app's own area resolution), so this mirrors resolveCustomerArea's no-pin
// fallback chain (§4.2/§9.5): users.last_area_id, then the default area.
// One lookup per connect (not per event/row) — same acceptable one-time cost
// as any other per-request user lookup elsewhere in this codebase.
const resolveAreaIdForSocketUser = async (userId) => {
  try {
    const [rows] = await pool.query('SELECT last_area_id FROM users WHERE id = ?', [userId]);
    if (rows[0]?.last_area_id) return rows[0].last_area_id;
  } catch (_) {
    // fall through to default area
  }
  try {
    const defaultArea = await getDefaultArea();
    return defaultArea ? defaultArea.id : null;
  } catch (_) {
    return null;
  }
};

// Rooms are per-area (§3.5) so a zone/settings/order broadcast in area 2
// never reaches an area 1 socket. `customer:<userId>` stays global — it's
// identity-scoped, not area-scoped. A socket that hasn't resolved an area
// yet (H7 cold-start race) simply joins no `customers:<areaId>`/`admin:<areaId>`
// room and misses area broadcasts until joinAreaRoom runs — never blocked.
const joinAreaRoom = async (socket) => {
  const auth = socket.data.auth;
  if (!auth) return;

  if (auth.role === 'customer') {
    const areaId = process.env.NODE_ENV !== 'test'
      ? await resolveAreaIdForSocketUser(auth.id)
      : null;
    if (areaId) {
      socket.data.areaId = areaId;
      socket.join(`customers:${areaId}`);
    }
    return;
  }

  if (auth.role === 'admin') {
    if (auth.adminRole === 'super_admin') {
      // Super admin sees every area's admin traffic (§3.5/23.5).
      const areas = process.env.NODE_ENV !== 'test' ? await listAreas() : [];
      areas.forEach((area) => socket.join(`admin:${area.id}`));
      socket.data.allAdminAreas = true;
      return;
    }
    if (auth.areaId) {
      socket.join(`admin:${auth.areaId}`);
    }
  }
};

// Client-pushed rejoin when the app's own area pin changes mid-connection
// (23.3) — leaves the old `customers:<areaId>` room (if any) and joins the
// new one. No-op for admins (their room comes from the JWT's areaId claim,
// not a client-chosen pin).
//
// newAreaId is client-supplied and unverifiable against the customer's real
// pin at this layer (no pin exists here at all, H7) — but it must still name
// a REAL, active area (bug fix, multi-area audit finding #13). Without this,
// any connected customer could join any area's `customers:<areaId>` room by
// guessing an id, regardless of where they actually are. Cheap: getAreaById
// reads through areaScope's 60s TTL cache, not a DB round trip per event.
const rejoinAreaRoom = async (socket, newAreaId) => {
  const auth = socket.data.auth;
  if (!auth || auth.role !== 'customer' || !newAreaId) return;

  const area = await getAreaById(newAreaId);
  if (!area || !area.active) return;

  if (socket.data.areaId && socket.data.areaId !== newAreaId) {
    socket.leave(`customers:${socket.data.areaId}`);
  }
  socket.data.areaId = newAreaId;
  socket.join(`customers:${newAreaId}`);
};

const joinRoleRoom = (socket) => {
  const auth = socket.data.auth;
  if (!auth) return;

  if (auth.role === 'customer') {
    socket.join(`customer:${auth.id}`);
    return;
  }
};

const initRealtime = (server) => {
  if (io) return io;

  io = new Server(server, {
    cors: {
      origin: parseAllowedOrigins(),
      methods: ['GET', 'POST'],
    },
    // Compresses each Socket.IO frame (60–80% smaller payloads). Clients
    // negotiate automatically via the permessage-deflate extension. No
    // behavior change — just lower bandwidth.
    perMessageDeflate: {
      threshold: 1024,
    },
  });

  io.use(authenticateSocket);

  // Live analytics presence tracker — in-memory Map of online customers,
  // emits `analytics.live` to the admin room every 5s. Fire-and-forget: a Mongo
  // outage never affects socket connection handling (sessionStore swallows).
  presenceTracker = createPresenceTracker({ sessionStore, emitToAdmins });

  io.on('connection', (socket) => {
    joinRoleRoom(socket);

    // Analytics presence — customers only (admin sockets are never counted).
    const auth = socket.data.auth;
    if (auth && auth.role === 'customer') {
      const platform = socket.handshake.auth?.platform || null;
      const appVersion = socket.handshake.auth?.appVersion || null;
      // joinAreaRoom already resolves+caches the same lookup on socket.data.areaId
      // (guarded by the same NODE_ENV!=='test' check) — reuse it here instead of
      // querying users.last_area_id twice per connection.
      joinAreaRoom(socket)
        .then(() => presenceTracker.addPresence(socket.id, {
          userId: auth.id,
          role: auth.role,
          platform,
          appVersion,
          areaId: socket.data.areaId || null,
        }))
        .catch(() => {});
    } else {
      joinAreaRoom(socket).catch(() => {});
    }

    // Screen-change events from the customer app (analyticsClient.trackScreen).
    socket.on('analytics:screen', (data) => {
      if (presenceTracker && data && typeof data.screen === 'string') {
        presenceTracker.updateScreen(socket.id, data.screen);
      }
    });

    // Client-pushed rejoin when the app's own area pin changes mid-connection
    // (23.3) — e.g. the customer manually switches their delivery address into
    // a different area after the socket already connected.
    socket.on('area:changed', (data) => {
      const newAreaId = data && Number(data.areaId);
      if (newAreaId) rejoinAreaRoom(socket, newAreaId).catch(() => {});
    });

    socket.on('disconnect', () => {
      if (presenceTracker) {
        presenceTracker.removePresence(socket.id).catch(() => {});
      }
    });
  });

  console.log('Realtime socket server initialized');
  return io;
};

const closeRealtime = async () => {
  if (!io) return;

  if (presenceTracker) {
    presenceTracker.stop();
    presenceTracker = null;
  }

  await new Promise((resolve) => {
    io.close(resolve);
  });
  io = null;
  console.log('Realtime socket server closed');
};

// Bug fix (multi-area audit finding #15): joinAreaRoom's super_admin branch
// only ever runs at connect time, against whichever areas existed then — a
// super_admin already connected when a NEW area is created never joins its
// admin:<areaId> room, and misses every one of that area's admin broadcasts
// until they reconnect. Called by areaController.js's createArea right
// after the area is committed, so every already-connected super_admin
// socket (flagged by joinAreaRoom, socket.data.allAdminAreas) picks up the
// new room immediately, with zero change to how a socket joins at connect
// time.
const joinNewAreaForConnectedSuperAdmins = (areaId) => {
  if (!io) return;
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data?.allAdminAreas) {
      socket.join(`admin:${areaId}`);
    }
  }
};

const emitToRoom = (room, eventName, payload) => {
  if (!io) return false;

  try {
    io.to(room).emit(eventName, payload);
    return true;
  } catch (error) {
    console.error('Realtime emit failed:', error.message);
    return false;
  }
};

const emitToCustomer = (customerId, eventName, payload) => {
  if (!customerId) return false;
  return emitToRoom(`customer:${customerId}`, eventName, payload);
};

// areaId is required (§3.5/23.2) — every call site resolves one from the
// order/shop/rider/req context that triggered the event. Event names and
// payload fields are unchanged (23.6); only the target room changes.
const emitToAdmins = (areaId, eventName, payload) => emitToRoom(`admin:${areaId}`, eventName, payload);

const emitToAllCustomers = (areaId, eventName, payload) => emitToRoom(`customers:${areaId}`, eventName, payload);

const getRealtimeStatus = () => ({
  enabled: Boolean(io),
  connectedSockets: io?.engine?.clientsCount || 0,
});

module.exports = {
  closeRealtime,
  emitToAdmins,
  emitToAllCustomers,
  emitToCustomer,
  getRealtimeStatus,
  initRealtime,
  joinNewAreaForConnectedSuperAdmins,
  // Exported for unit testing only — the NODE_ENV guard around its one real
  // call site (above) is what keeps the e2e socket tests DB-free.
  resolveAreaIdForSocketUser,
  // Exported for unit testing only — joinAreaRoom's super_admin branch calls
  // areaScope.listAreas() (a real DB read), guarded the same way, for the
  // same reason (realtime.test.js runs real socket.io connections with no
  // db/mysql mock).
  joinAreaRoom,
  // Exported for unit testing only — validates the client-supplied areaId
  // against a real DB-backed lookup (bug fix, multi-area audit finding #13).
  rejoinAreaRoom,
};
