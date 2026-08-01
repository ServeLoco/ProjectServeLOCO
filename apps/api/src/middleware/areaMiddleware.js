/**
 * Sets req.areaId. See plans/multi-area.md §4.2 and src/utils/areaScope.js.
 *
 * Not mounted anywhere yet (TASK 8 wires resolveAdminArea after
 * requireAdmin; customer routes pick up resolveCustomerArea starting
 * Phase C). Built now so its own behavior — especially the area_admin
 * cross-area 403 — is unit-tested independent of the Phase C sweep.
 */
const { pool } = require('../db/mysql');
const { resolveAreaForPoint, getDefaultArea } = require('../utils/areaScope');

const extractPin = (source) => {
  if (!source) return { lat: undefined, lng: undefined };
  const { latitude, longitude, lat, lng } = source;
  const rawLat = latitude !== undefined ? latitude : lat;
  const rawLng = longitude !== undefined ? longitude : lng;
  return { lat: rawLat, lng: rawLng };
};

/**
 * area_admin -> their own area, always (an X-Area-Id header from them is
 * rejected, not silently overridden — honoring it would be a cross-area
 * leak dressed up as a convenience).
 * super_admin -> X-Area-Id header: a positive integer, the literal string
 * 'all', or (header absent) null. Callers that can't operate cross-area
 * (Settings, Delivery Zones, Store Modes — see spec §2.10) reject 'all'
 * themselves; this middleware only parses the header.
 * Anything else (adminRole not set — pre-TASK-7 admin, or no admin at
 * all) leaves req.areaId untouched; requestAreaId() throws if something
 * downstream tries to read it without it ever being resolved.
 */
const resolveAdminArea = (req, res, next) => {
  const admin = req.admin;
  if (!admin || !admin.adminRole) return next();

  const header = req.headers['x-area-id'];

  if (admin.adminRole === 'area_admin') {
    if (header !== undefined) {
      return res.status(403).json({
        code: 'FORBIDDEN',
        message: 'area_admin may not set X-Area-Id',
      });
    }
    req.areaId = admin.areaId;
    return next();
  }

  if (admin.adminRole === 'super_admin') {
    if (header === undefined) {
      req.areaId = null;
      return next();
    }
    if (header === 'all') {
      req.areaId = 'all';
      return next();
    }
    const parsed = Number(header);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'X-Area-Id must be a positive integer or "all"',
      });
    }
    req.areaId = parsed;
    return next();
  }

  next();
};

/**
 * Resolution order (§4.2, §2.4):
 *   1. a pin on this request (body or query) -> zone -> area
 *   2. the customer's users.last_area_id (their most recent order's area)
 *   3. the default area, ONLY when no pin was supplied at all
 * A supplied pin that resolves to no zone yields req.areaId = null and
 * req.zoneId = null — the caller must treat that as "we don't deliver
 * here yet", never silently fall back to the default area.
 */
const resolveCustomerArea = async (req, res, next) => {
  try {
    const bodyPin = extractPin(req.body);
    const queryPin = extractPin(req.query);
    const lat = bodyPin.lat !== undefined ? bodyPin.lat : queryPin.lat;
    const lng = bodyPin.lng !== undefined ? bodyPin.lng : queryPin.lng;
    const hasPin = lat !== undefined && lng !== undefined && lat !== null && lng !== null && lat !== '' && lng !== '';

    if (hasPin) {
      const resolved = await resolveAreaForPoint(lat, lng);
      req.areaId = resolved ? resolved.areaId : null;
      req.zoneId = resolved ? resolved.zoneId : null;
      return next();
    }

    if (req.user && req.user.id) {
      const [rows] = await pool.query('SELECT last_area_id FROM users WHERE id = ?', [req.user.id]);
      if (rows[0] && rows[0].last_area_id) {
        req.areaId = rows[0].last_area_id;
        req.zoneId = null;
        return next();
      }
    }

    const defaultArea = await getDefaultArea();
    req.areaId = defaultArea ? defaultArea.id : null;
    req.zoneId = null;
    next();
  } catch (error) {
    next(error);
  }
};

module.exports = {
  resolveAdminArea,
  resolveCustomerArea,
};
