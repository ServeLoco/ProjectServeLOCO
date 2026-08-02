const { pool } = require('../db/mysql');
const { invalidateStoreModeCache } = require('../utils/storeMode');
const { requestAreaId } = require('../utils/areaScope');

const RESERVED_SLUGS = new Set(['all']);
const SLUG_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;

// `??` treats an explicit `null` as absent and falls through to the alias —
// wrong here, since `icon_image_id: null` is a meaningful "clear it" value.
const pickImageIdField = (body) =>
  Object.prototype.hasOwnProperty.call(body, 'icon_image_id') ? body.icon_image_id : body.iconImageId;
// SegmentedControl on the customer/web capsule only renders 2-5 options —
// more active modes than that makes the capsule disappear entirely.
const MAX_ACTIVE_MODES = 5;

// Adds the camelCase duplicates + strips the raw join column, per house
// response-shape convention (fields duplicated in both casings).
const withIconUrl = (row) => {
  const { icon_image_url, is_default, ...rest } = row;
  const isDefault = Boolean(is_default);
  return {
    ...rest,
    icon_image_url: icon_image_url || null,
    iconImageUrl: icon_image_url || null,
    is_default: isDefault,
    isDefault,
  };
};

// Rejects null (super_admin, no X-Area-Id) and 'all' — store mode
// management always targets exactly one area (§2.10).
const requireOneArea = (req, res) => {
  const areaId = requestAreaId(req);
  if (areaId === null) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'X-Area-Id is required to manage store modes' });
    return null;
  }
  if (areaId === 'all') {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Store modes cannot be managed for "all" areas at once — pick one area' });
    return null;
  }
  return areaId;
};

// Public endpoint: GET /api/store-modes — active modes for the customer/web capsule.
const getStoreModes = async (req, res) => {
  // Store modes gate which dashboard/products a customer can even reach,
  // so this is catalog data, not settings metadata (§2.4) — a pin outside
  // every zone (null) gets an empty list, same as listActiveZonesPublic,
  // not a fallback to the default area's modes. Only a cold app open with
  // no pin yet resolves to a real area via resolveCustomerArea's own
  // default-area fallback.
  const areaId = requestAreaId(req);
  if (areaId === null || areaId === 'all') {
    return res.status(200).json({ data: [], storeModes: [] });
  }

  const [rows] = await pool.query(
    `SELECT sm.id, sm.slug, sm.label, sm.display_order, sm.is_default, i.url AS icon_image_url
     FROM store_modes sm
     LEFT JOIN images i ON i.id = sm.icon_image_id
     WHERE sm.active = TRUE AND sm.area_id = ?
     ORDER BY sm.display_order ASC, sm.id ASC`,
    [areaId]
  );
  const data = rows.map(withIconUrl);
  res.status(200).json({ data, storeModes: data });
};

// Admin endpoint: GET /api/admin/store-modes — all modes including inactive.
const getAdminStoreModes = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const [rows] = await pool.query(
    `SELECT sm.*, i.url AS icon_image_url
     FROM store_modes sm
     LEFT JOIN images i ON i.id = sm.icon_image_id
     WHERE sm.area_id = ?
     ORDER BY sm.display_order ASC, sm.id ASC`,
    [areaId]
  );
  res.status(200).json({ data: rows.map(withIconUrl) });
};

const isValidImageId = (id) => /^\d+$/.test(String(id));

const createStoreMode = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const { slug, label } = req.body;
  const iconImageId = pickImageIdField(req.body);
  const cleanSlug = String(slug || '').trim().toLowerCase();
  const cleanLabel = String(label || '').trim();

  if (iconImageId != null && !isValidImageId(iconImageId)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid icon_image_id' });
  }

  if (!SLUG_PATTERN.test(cleanSlug)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Slug must be lowercase letters, numbers, and underscores, starting with a letter (2-31 chars)' });
  }
  if (RESERVED_SLUGS.has(cleanSlug)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: `"${cleanSlug}" is a reserved value and cannot be used as a mode slug` });
  }
  if (!cleanLabel) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Label is required' });
  }

  const [[existing]] = await pool.query('SELECT id FROM store_modes WHERE slug = ? AND area_id = ?', [cleanSlug, areaId]);
  if (existing) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: `A mode with slug "${cleanSlug}" already exists` });
  }

  const [[{ activeCount }]] = await pool.query('SELECT COUNT(*) as activeCount FROM store_modes WHERE active = TRUE AND area_id = ?', [areaId]);
  if (Number(activeCount) >= MAX_ACTIVE_MODES) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Cannot have more than ${MAX_ACTIVE_MODES} active store modes at once. Deactivate one first.` });
  }

  const [[{ maxOrder }]] = await pool.query('SELECT COALESCE(MAX(display_order), 0) as maxOrder FROM store_modes WHERE area_id = ?', [areaId]);

  const [result] = await pool.query(
    'INSERT INTO store_modes (area_id, slug, label, display_order, active, is_system, icon_image_id) VALUES (?, ?, ?, ?, TRUE, FALSE, ?)',
    [areaId, cleanSlug, cleanLabel, Number(maxOrder) + 1, iconImageId != null ? iconImageId : null]
  );
  invalidateStoreModeCache(areaId);
  res.status(201).json({ message: 'Store mode created', id: result.insertId });
};

const updateStoreMode = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const { id } = req.params;
  const { label, display_order, active } = req.body;
  const iconImageId = pickImageIdField(req.body);
  const isDefault = req.body.is_default !== undefined ? req.body.is_default : req.body.isDefault;

  if (iconImageId !== undefined && iconImageId !== null && !isValidImageId(iconImageId)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid icon_image_id' });
  }

  // area_id in the WHERE, not just id: without this, an area_admin could
  // PATCH another area's store mode by guessing its (globally sequential)
  // numeric id.
  const [[existing]] = await pool.query('SELECT * FROM store_modes WHERE id = ? AND area_id = ?', [id, areaId]);
  if (!existing) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Store mode not found' });
  }

  if (isDefault === true && !existing.active && active !== true) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Only an active mode can be set as default' });
  }

  if (existing.is_system && active === false) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: `"${existing.label}" is a system mode and cannot be deactivated` });
  }

  if (active === true && !existing.active) {
    const [[{ activeCount }]] = await pool.query('SELECT COUNT(*) as activeCount FROM store_modes WHERE active = TRUE AND area_id = ?', [areaId]);
    if (Number(activeCount) >= MAX_ACTIVE_MODES) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Cannot have more than ${MAX_ACTIVE_MODES} active store modes at once. Deactivate one first.` });
    }
  }

  if (active === false) {
    const [[usage]] = await pool.query(
      `SELECT
        (SELECT COUNT(*) FROM categories WHERE type = ? AND deleted = 0 AND area_id = ?) +
        (SELECT COUNT(*) FROM combos WHERE store_type = ? AND deleted = 0 AND area_id = ?) +
        (SELECT COUNT(*) FROM offers WHERE store_type = ? AND deleted = 0 AND area_id = ?) as count`,
      [existing.slug, areaId, existing.slug, areaId, existing.slug, areaId]
    );
    if (Number(usage.count) > 0 && !req.body.force) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: `${usage.count} categories/combos/offers still use "${existing.label}". Pass force=true to deactivate anyway (existing items keep their mode; customers will stop seeing this mode).`
      });
    }
  }

  const updates = [];
  const params = [];
  if (label !== undefined) {
    const cleanLabel = String(label).trim();
    if (!cleanLabel) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Label cannot be empty' });
    }
    updates.push('label = ?');
    params.push(cleanLabel);
  }
  if (display_order !== undefined) {
    const order = Number(display_order);
    if (!Number.isInteger(order) || order < 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'display_order must be a non-negative integer' });
    }
    updates.push('display_order = ?');
    params.push(order);
  }
  if (active !== undefined) {
    updates.push('active = ?');
    params.push(active ? 1 : 0);
  }
  if (iconImageId !== undefined) {
    updates.push('icon_image_id = ?');
    params.push(iconImageId === null ? null : iconImageId);
  }
  if (isDefault !== undefined) {
    updates.push('is_default = ?');
    params.push(isDefault ? 1 : 0);
  }

  if (updates.length === 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'No valid fields provided' });
  }

  // Only one mode may be default at a time, WITHIN this area — clear the
  // others first. Scoped by area_id: without it, setting area 2's default
  // would silently clear area 1's default too.
  if (isDefault === true) {
    await pool.query('UPDATE store_modes SET is_default = FALSE WHERE id != ? AND area_id = ?', [id, areaId]);
  }

  params.push(id, areaId);
  await pool.query(`UPDATE store_modes SET ${updates.join(', ')} WHERE id = ? AND area_id = ?`, params);
  invalidateStoreModeCache(areaId);
  res.status(200).json({ message: 'Store mode updated' });
};

module.exports = {
  getStoreModes,
  getAdminStoreModes,
  createStoreMode,
  updateStoreMode
};
