const { verifyToken } = require('../utils/auth');
const { pool } = require('../db/mysql');

const extractToken = (req) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7, authHeader.length);
  }
  return null;
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
  }

  req.admin = { id: payload.sub || payload.id, role: payload.role };
  next();
};

module.exports = {
  requireCustomer,
  requireAdmin
};
