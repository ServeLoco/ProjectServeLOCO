const { verifyToken } = require('../utils/auth');
const { pool } = require('../db/mysql');
const { resolveAdminArea } = require('./areaMiddleware');

const extractToken = (req) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7, authHeader.length);
  }
  return null;
};

// Shared by requireAdmin (HTTP) and socket.js's connection auth (realtime) —
// both need the same "is this admin still valid, right now" answer, not
// whatever role/area a JWT up to ADMIN_JWT_EXPIRES_IN (12h) old happened to
// carry. Returns:
//   null        — nothing to re-check (no adminRole claim, a mobile-admin
//                 session, or an envFallback bootstrap login) — caller keeps
//                 the JWT's claims as-is.
//   'revoked'   — the admins row is gone or inactive — caller must treat
//                 the session as dead.
//   {role, area_id} — the live row: caller overwrites its stale claims.
const getLiveAdminState = async (payload) => {
  if (payload.adminRole === undefined || payload.envFallback) return null;
  const adminIdRaw = payload.sub || payload.id;
  if (!/^\d+$/.test(String(adminIdRaw))) return null;

  const [adminRows] = await pool.query('SELECT role, area_id, active FROM admins WHERE id = ?', [Number(adminIdRaw)]);
  const adminRow = adminRows[0];
  if (!adminRow || !adminRow.active) return 'revoked';
  return adminRow;
};

const requireCustomer = async (req, res, next) => {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Authentication token missing' });
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch (error) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
  }

  if (payload.role !== 'customer') {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Forbidden role' });
  }

  const userId = payload.sub || payload.id;

  // A DB failure here (connection blip, pool exhaustion) is a server error,
  // not proof the token is bad — surfacing it as 401 would bounce the user
  // to the login screen on transient infra hiccups. Let the global error
  // handler turn it into a 500 instead.
  if (process.env.NODE_ENV !== 'test') {
    let rows;
    try {
      [rows] = await pool.query('SELECT blocked FROM users WHERE id = ?', [userId]);
    } catch (error) {
      // Hand off to the global error handler and stop — returning a 401 here
      // too would be a second response on the same request.
      return next(error);
    }
    if (rows.length === 0) {
      return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Session is no longer valid. Please log in again.' });
    }
    if (rows[0].blocked) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Your account is blocked' });
    }
  }

  req.user = { id: userId, role: payload.role };
  next();
};

const requireAdmin = async (req, res, next) => {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Authentication token missing' });
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch (error) {
    return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
  }

  if (payload.role !== 'admin') {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Forbidden role' });
  }

  // Same reasoning as requireCustomer above: a DB failure is a server error,
  // not an invalid session.
  //
  // revoked_before is still read from the single admin_auth_state row
  // (id=1) regardless of which admin is authenticating — it was never
  // restructured into one row per admin (TASK 2 only added a nullable
  // admin_id column to the existing singleton, for audit purposes; see
  // adminController.js login and plans/multi-area-tasks.md TASK 7/8 notes).
  // A real per-admin revocation store is a schema change beyond this
  // task's scope; today's shared kill-switch still does its job (any token
  // issued before a revoke stops working) for every admin, super or area.
  if (process.env.NODE_ENV !== 'test') {
    let rows;
    try {
      [rows] = await pool.query('SELECT revoked_before FROM admin_auth_state WHERE id = 1');
    } catch (error) {
      return next(error);
    }
    const revokedBefore = rows[0]?.revoked_before;
    if (revokedBefore && payload.iat && payload.iat * 1000 < new Date(revokedBefore).getTime()) {
      return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Session is no longer valid. Please log in again.' });
    }

    // Live re-check against `admins` for a real admins-table session (bug
    // fix, multi-area audit finding #5). Without this, deactivating an
    // admin or reassigning their role/area only takes effect once their
    // JWT expires (up to ADMIN_JWT_EXPIRES_IN, 12h) — a deactivated admin
    // keeps working, and a reassigned area_admin keeps writing to their OLD
    // area for the rest of the token's life. The one shared
    // admin_auth_state kill-switch above is deliberately platform-wide
    // (§H10) and can't express "just this one admin", so this is separate.
    // Excludes mobile-admin sessions (sub is "mobile:<id>", not numeric —
    // they're mobile_admins rows, not admins rows) and the legacy env-
    // password bootstrap super_admin (payload.envFallback — see
    // utils/auth.js's signAdminToken) — neither has an admins-table row to
    // re-check. envFallback is an explicit claim, not inferred from
    // whether `sub` looks numeric: ADMIN_OWNER_ID has no format
    // requirement, and a numeric value used to make this branch 401 every
    // env-fallback login forever (the emergency recovery path breaking
    // exactly when it's needed).
    try {
      const liveState = await getLiveAdminState(payload);
      if (liveState === 'revoked') {
        return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Session is no longer valid. Please log in again.' });
      }
      if (liveState) {
        // The live row wins over the (up to 12h stale) JWT claim — a
        // demoted/reassigned admin must not keep acting under their old
        // role/area for the rest of the token's life.
        payload.adminRole = liveState.role;
        payload.areaId = liveState.area_id;
      }
    } catch (error) {
      return next(error);
    }
  }

  // adminRole/areaId are undefined on tokens minted before this deploy
  // (self-heals within ADMIN_JWT_EXPIRES_IN, 12h) and on mobile-admin
  // tokens (a separate, unrelated admin concept — see utils/auth.js).
  // resolveAdminArea below already no-ops when adminRole is unset, leaving
  // req.areaId unset rather than guessing — an area-aware endpoint reading
  // it via requestAreaId() gets a clean 401 there (areaScope.js), not an
  // opaque 500 (multi-area audit finding #2). Routes that never touch area
  // (e.g. /me) keep working exactly as this passthrough already intends.
  req.admin = {
    id: payload.sub || payload.id,
    role: payload.role,
    adminRole: payload.adminRole,
    areaId: payload.areaId !== undefined ? payload.areaId : null,
  };

  // Chained here, rather than mounted as router-level middleware, because
  // requireAdmin itself is applied per-route (113 call sites in
  // adminRoutes.js, not a single router.use()) — a router.use(resolveAdminArea)
  // placed before those routes would run before req.admin exists, and one
  // placed after would never run at all for a route that already sent a
  // response. Chaining internally reaches every one of those 113 call
  // sites from this single edit, with zero changes to adminRoutes.js.
  return resolveAdminArea(req, res, next);
};

/** Mount AFTER requireAdmin. 403s anyone but a super_admin. */
const requireSuperAdmin = (req, res, next) => {
  if (!req.admin || req.admin.adminRole !== 'super_admin') {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Super admin access required' });
  }
  next();
};

module.exports = {
  requireCustomer,
  requireAdmin,
  requireSuperAdmin,
  getLiveAdminState,
};
