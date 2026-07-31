const { pool } = require('../db/mysql');
const microCache = require('../utils/microCache');
const { parseBoundary, polygonAreaKm2, areaEquivalentRadiusKm, polygonSelfIntersects } = require('../utils/deliveryPricing');
const { emitToAllCustomers } = require('../realtime/socket');

// Admin CRUD for polygon delivery zones (delivery_zones table). Each row is
// its own irregular boundary (array of {lat,lng} vertices) and may nest
// inside another zone via parent_zone_id — e.g. a big "village" zone with
// small "sub-village" zones carved out of it. See deliveryPricing.js for how
// nesting affects which zone a customer's point resolves to. Pricing reads
// go straight to the table (no settings cache involvement), so no cache
// invalidation is needed for correctness — the dashboard micro-cache bust
// below just keeps admin views consistent.

const MIN_VERTICES = 3;
const MAX_VERTICES = 200;
const MAX_ETA_MINUTES = 24 * 60 - 1;
// `name` is VARCHAR(255) — reject over-length up front rather than letting
// MySQL raise ER_DATA_TOO_LONG (a 500) or silently truncate in loose mode.
const MAX_NAME_LENGTH = 255;
// A polygon smaller than this is almost certainly a mis-click (duplicate or
// near-identical vertices). It would also win every smallest-area tiebreak in
// matchZone while matching essentially nothing.
const MIN_AREA_KM2 = 0.0001; // ~10m x 10m

const toBool01 = (v) => (v === true || v === 'true' || v === 1 || v === '1') ? 1 : 0;
const hasValue = (v) => v !== undefined && v !== null && v !== '';
const roundTo = (value, decimals) => {
  const factor = Math.pow(10, decimals);
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

// Pulls a zone field from the request body accepting both casings.
const pick = (body, snake, camel) => (body[snake] !== undefined ? body[snake] : body[camel]);

const validationError = (res, message) => res.status(400).json({ code: 'VALIDATION_ERROR', message });

const normalizeBoundary = (boundary) => boundary.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }));

const isValidBoundary = (boundary) => {
  if (!Array.isArray(boundary) || boundary.length < MIN_VERTICES || boundary.length > MAX_VERTICES) return false;
  return boundary.every((p) => {
    const lat = Number(p?.lat);
    const lng = Number(p?.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  });
};

const zoneJson = (row) => {
  const boundary = parseBoundary(row.boundary);
  const areaKm2 = polygonAreaKm2(boundary);
  const extentKm = roundTo(areaEquivalentRadiusKm(areaKm2), 2);
  return {
    id: row.id,
    name: row.name || null,
    boundary,
    parentZoneId: row.parent_zone_id != null ? row.parent_zone_id : null,
    parent_zone_id: row.parent_zone_id != null ? row.parent_zone_id : null,
    areaKm2: roundTo(areaKm2, 4),
    area_km2: roundTo(areaKm2, 4),
    // Radius of an equal-area circle — kept as a single human-readable "km"
    // figure for old call sites/UI copy that used to show a shape's extent.
    extentKm,
    extent_km: extentKm,
    normalCharge: Number(row.normal_charge),
    normal_charge: Number(row.normal_charge),
    fastCharge: Number(row.fast_charge),
    fast_charge: Number(row.fast_charge),
    normalEtaMinutes: Number(row.normal_eta_minutes),
    normal_eta_minutes: Number(row.normal_eta_minutes),
    fastEtaMinutes: Number(row.fast_eta_minutes),
    fast_eta_minutes: Number(row.fast_eta_minutes),
    nightCharge: Number(row.night_charge),
    night_charge: Number(row.night_charge),
    codEnabled: Boolean(Number(row.cod_enabled)),
    cod_enabled: Boolean(Number(row.cod_enabled)),
    active: Boolean(Number(row.active)),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
};

// Validates the EFFECTIVE zone values (existing row merged with the incoming
// partial) so a PATCH can't sneak fast_charge below normal_charge or save an
// unusable boundary.
const validateZoneValues = ({ boundary, name, normalCharge, fastCharge, normalEta, fastEta, nightCharge }) => {
  if (!isValidBoundary(boundary)) {
    return `Boundary must be a list of ${MIN_VERTICES}-${MAX_VERTICES} points, each a valid {lat, lng}`;
  }
  // The admin map already blocks self-intersecting shapes (leaflet-draw's
  // allowIntersection: false), but the API is reachable directly — and a
  // bowtie polygon makes the ray-casting containment test in matchZone report
  // nonsense (the crossed lobe reads as outside).
  if (polygonSelfIntersects(boundary)) {
    return 'Boundary edges cross each other — draw a simple shape without self-intersections';
  }
  if (polygonAreaKm2(boundary) < MIN_AREA_KM2) {
    return 'Boundary encloses no meaningful area — the points are identical or in a straight line';
  }
  if (name != null && String(name).length > MAX_NAME_LENGTH) {
    return `Zone name must be ${MAX_NAME_LENGTH} characters or fewer`;
  }
  for (const [value, label] of [
    [normalCharge, 'Normal delivery charge'],
    [fastCharge, 'Fast delivery charge'],
    [nightCharge, 'Night surcharge'],
  ]) {
    if (!Number.isFinite(value) || value < 0) return `${label} cannot be negative`;
  }
  for (const [value, label] of [[normalEta, 'Normal delivery time'], [fastEta, 'Fast delivery time']]) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_ETA_MINUTES) {
      return `${label} must be a whole number between 1 and ${MAX_ETA_MINUTES} minutes`;
    }
  }
  // Coupon engine detects Fast via deliveryCharge > standardDeliveryCharge; a
  // zone with fast cheaper than normal would let free-delivery coupons waive
  // the fast fee. Enforce here instead of touching coupons.js.
  if (fastCharge < normalCharge) {
    return 'Fast delivery charge must be greater than or equal to the normal delivery charge';
  }
  return null;
};

// Resolves and validates a parent zone reference: must exist, can't be the
// zone itself, and can't create a parent/child cycle (walks the candidate
// parent's own ancestor chain looking for `selfId`). selfId is null on create.
const resolveParentZoneId = async (rawParentZoneId, selfId) => {
  if (!hasValue(rawParentZoneId)) return { parentZoneId: null };
  const parentZoneId = Number(rawParentZoneId);
  if (!Number.isInteger(parentZoneId) || parentZoneId < 1) {
    return { error: 'Parent zone id must be a valid zone id' };
  }
  if (selfId != null && parentZoneId === selfId) {
    return { error: 'A zone cannot be its own parent' };
  }
  const [rows] = await pool.query('SELECT id, parent_zone_id FROM delivery_zones WHERE id = ?', [parentZoneId]);
  if (rows.length === 0) {
    return { error: 'Parent zone not found' };
  }
  let cursor = rows[0];
  const visited = new Set([parentZoneId]);
  while (cursor?.parent_zone_id != null) {
    if (selfId != null && cursor.parent_zone_id === selfId) {
      return { error: 'That parent would create a zone nesting cycle' };
    }
    if (visited.has(cursor.parent_zone_id)) break; // defensive: existing cycle, stop walking
    visited.add(cursor.parent_zone_id);
    const [next] = await pool.query('SELECT id, parent_zone_id FROM delivery_zones WHERE id = ?', [cursor.parent_zone_id]);
    cursor = next[0];
  }
  return { parentZoneId };
};

const listZones = async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM delivery_zones ORDER BY id ASC');
  const zones = rows.map(zoneJson).sort((a, b) => a.areaKm2 - b.areaKm2);
  res.status(200).json({ data: zones });
};

// Public, read-only, geometry-only zone list for the customer app's checkout
// map overlay ("shift your pin into a shaded area to get delivery") — no
// pricing/ETA/COD fields, just enough to draw the shapes.
//
// Unauthenticated and hit by every app that opens the map, so it goes through
// the micro-cache instead of a table scan per request. Busted by every zone
// mutation below, so an admin edit still shows up immediately.
const PUBLIC_ZONES_CACHE_KEY = 'delivery-zones:public';
const PUBLIC_ZONES_CACHE_TTL_MS = 60 * 1000;

const listActiveZonesPublic = async (req, res) => {
  const cached = microCache.get(PUBLIC_ZONES_CACHE_KEY);
  if (cached) return res.status(200).json({ data: cached });

  const [rows] = await pool.query(
    'SELECT id, name, boundary, parent_zone_id FROM delivery_zones WHERE active = 1'
  );
  const zones = rows.map((row) => ({
    id: row.id,
    name: row.name || null,
    boundary: parseBoundary(row.boundary),
    parentZoneId: row.parent_zone_id != null ? row.parent_zone_id : null,
    parent_zone_id: row.parent_zone_id != null ? row.parent_zone_id : null,
  }));
  microCache.set(PUBLIC_ZONES_CACHE_KEY, zones, PUBLIC_ZONES_CACHE_TTL_MS);
  res.status(200).json({ data: zones });
};

// Every zone write goes through here so the admin cache bust, the public
// geometry cache bust and the customer push stay in lockstep.
const notifyZonesChanged = (reason, zoneId) => {
  microCache.bust('dashboard');
  microCache.bust('delivery-zones');
  // Push so any customer mid-checkout gets the new pricing without waiting
  // for their next pin move — see realtimeClient.js's delivery_zones.updated.
  emitToAllCustomers('delivery_zones.updated', { reason, zoneId });
};

// Zone pricing with zero active zones blocks delivery for EVERYONE — the
// resolver fails closed on purpose (see resolveDeliveryPricing), so an admin
// deleting or deactivating their last zone would take the whole shop offline
// rather than quietly reverting to flat pricing. Refuse the write and tell
// them to turn zone pricing off first.
const wouldLeaveNoActiveZones = async (excludedZoneId) => {
  const [settingsRows] = await pool.query('SELECT radius_pricing_active FROM settings LIMIT 1');
  const zonePricingOn = Number(settingsRows[0]?.radius_pricing_active) === 1;
  if (!zonePricingOn) return false;
  const [zoneRows] = await pool.query(
    'SELECT COUNT(*) AS count FROM delivery_zones WHERE active = 1 AND id != ?',
    [excludedZoneId]
  );
  return Number(zoneRows[0]?.count) === 0;
};

const LAST_ACTIVE_ZONE_MESSAGE = 'This is the only active zone and zone pricing is ON. '
  + 'Turn zone pricing off first, or add another active zone.';

const createZone = async (req, res) => {
  const body = req.body || {};
  const rawBoundary = body.boundary;
  const rawName = pick(body, 'name', 'name');
  const values = {
    boundary: Array.isArray(rawBoundary) ? normalizeBoundary(rawBoundary) : rawBoundary,
    name: hasValue(rawName) ? String(rawName) : null,
    normalCharge: hasValue(pick(body, 'normal_charge', 'normalCharge')) ? Number(pick(body, 'normal_charge', 'normalCharge')) : 0,
    fastCharge: hasValue(pick(body, 'fast_charge', 'fastCharge')) ? Number(pick(body, 'fast_charge', 'fastCharge')) : 0,
    normalEta: hasValue(pick(body, 'normal_eta_minutes', 'normalEtaMinutes')) ? Number(pick(body, 'normal_eta_minutes', 'normalEtaMinutes')) : 60,
    fastEta: hasValue(pick(body, 'fast_eta_minutes', 'fastEtaMinutes')) ? Number(pick(body, 'fast_eta_minutes', 'fastEtaMinutes')) : 30,
    nightCharge: hasValue(pick(body, 'night_charge', 'nightCharge')) ? Number(pick(body, 'night_charge', 'nightCharge')) : 0,
  };
  const message = validateZoneValues(values);
  if (message) return validationError(res, message);

  const parentResult = await resolveParentZoneId(pick(body, 'parent_zone_id', 'parentZoneId'), null);
  if (parentResult.error) return validationError(res, parentResult.error);

  const codEnabled = pick(body, 'cod_enabled', 'codEnabled');
  const active = pick(body, 'active', 'active');

  const [result] = await pool.query(
    `INSERT INTO delivery_zones
      (name, boundary, parent_zone_id, normal_charge, fast_charge, normal_eta_minutes, fast_eta_minutes, night_charge, cod_enabled, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      values.name,
      JSON.stringify(values.boundary),
      parentResult.parentZoneId,
      values.normalCharge, values.fastCharge,
      values.normalEta, values.fastEta, values.nightCharge,
      codEnabled === undefined ? 1 : toBool01(codEnabled),
      active === undefined ? 1 : toBool01(active),
    ]
  );
  const [rows] = await pool.query('SELECT * FROM delivery_zones WHERE id = ?', [result.insertId]);
  notifyZonesChanged('created', result.insertId);
  res.status(201).json({ message: 'Delivery zone created', id: result.insertId, data: zoneJson(rows[0]) });
};

const updateZone = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return validationError(res, 'Valid zone id is required');

  const [rows] = await pool.query('SELECT * FROM delivery_zones WHERE id = ?', [id]);
  if (rows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Delivery zone not found' });
  }
  const existing = rows[0];
  const body = req.body || {};

  const rawBoundary = body.boundary;
  const boundary = hasValue(rawBoundary)
    ? (Array.isArray(rawBoundary) ? normalizeBoundary(rawBoundary) : rawBoundary)
    : parseBoundary(existing.boundary);

  // Absent (undefined) means "leave it alone"; an explicit null/'' means the
  // admin cleared the field. hasValue() alone can't tell those apart, which
  // is why blanking a name used to silently keep the old one.
  const rawName = pick(body, 'name', 'name');
  const merged = {
    boundary,
    name: rawName === undefined
      ? (existing.name || null)
      : (hasValue(rawName) ? String(rawName) : null),
    normalCharge: hasValue(pick(body, 'normal_charge', 'normalCharge')) ? Number(pick(body, 'normal_charge', 'normalCharge')) : Number(existing.normal_charge),
    fastCharge: hasValue(pick(body, 'fast_charge', 'fastCharge')) ? Number(pick(body, 'fast_charge', 'fastCharge')) : Number(existing.fast_charge),
    normalEta: hasValue(pick(body, 'normal_eta_minutes', 'normalEtaMinutes')) ? Number(pick(body, 'normal_eta_minutes', 'normalEtaMinutes')) : Number(existing.normal_eta_minutes),
    fastEta: hasValue(pick(body, 'fast_eta_minutes', 'fastEtaMinutes')) ? Number(pick(body, 'fast_eta_minutes', 'fastEtaMinutes')) : Number(existing.fast_eta_minutes),
    nightCharge: hasValue(pick(body, 'night_charge', 'nightCharge')) ? Number(pick(body, 'night_charge', 'nightCharge')) : Number(existing.night_charge),
  };
  const message = validateZoneValues(merged);
  if (message) return validationError(res, message);

  // Same absent-vs-explicitly-cleared distinction as `name` above: sending
  // parent_zone_id: null is how the admin UI's "— none (top-level) —" option
  // detaches a zone from its parent, and it must not fall back to the
  // existing value.
  const rawParentZoneId = pick(body, 'parent_zone_id', 'parentZoneId');
  const parentResult = await resolveParentZoneId(
    rawParentZoneId === undefined ? existing.parent_zone_id : rawParentZoneId,
    id
  );
  if (parentResult.error) return validationError(res, parentResult.error);

  const name = merged.name;
  const codEnabled = pick(body, 'cod_enabled', 'codEnabled');
  const active = pick(body, 'active', 'active');

  const nextActive = active === undefined ? Number(existing.active) : toBool01(active);
  if (Number(existing.active) === 1 && nextActive === 0 && await wouldLeaveNoActiveZones(id)) {
    return validationError(res, LAST_ACTIVE_ZONE_MESSAGE);
  }

  await pool.query(
    `UPDATE delivery_zones SET
      name = ?, boundary = ?, parent_zone_id = ?,
      normal_charge = ?, fast_charge = ?,
      normal_eta_minutes = ?, fast_eta_minutes = ?, night_charge = ?,
      cod_enabled = ?, active = ?
     WHERE id = ?`,
    [
      name, JSON.stringify(merged.boundary), parentResult.parentZoneId,
      merged.normalCharge, merged.fastCharge,
      merged.normalEta, merged.fastEta, merged.nightCharge,
      codEnabled === undefined ? existing.cod_enabled : toBool01(codEnabled),
      active === undefined ? existing.active : toBool01(active),
      id,
    ]
  );

  const [updatedRows] = await pool.query('SELECT * FROM delivery_zones WHERE id = ?', [id]);
  notifyZonesChanged('updated', id);
  res.status(200).json({ message: 'Delivery zone updated', data: zoneJson(updatedRows[0]) });
};

const deleteZone = async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return validationError(res, 'Valid zone id is required');

  const [existingRows] = await pool.query('SELECT active FROM delivery_zones WHERE id = ?', [id]);
  if (existingRows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Delivery zone not found' });
  }
  if (Number(existingRows[0].active) === 1 && await wouldLeaveNoActiveZones(id)) {
    return validationError(res, LAST_ACTIVE_ZONE_MESSAGE);
  }

  // Hard delete by design: placed orders snapshot the zone data they were
  // priced with, so zone rows have no referential afterlife. Any child zones
  // (parent_zone_id = this id) fall back to ON DELETE SET NULL — they keep
  // their own boundary and simply stop being nested inside this one.
  const [result] = await pool.query('DELETE FROM delivery_zones WHERE id = ?', [id]);
  if (result.affectedRows === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Delivery zone not found' });
  }
  notifyZonesChanged('deleted', id);
  res.status(200).json({ message: 'Delivery zone deleted' });
};

module.exports = {
  listZones,
  listActiveZonesPublic,
  createZone,
  updateZone,
  deleteZone,
};
