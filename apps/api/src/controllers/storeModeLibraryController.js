// Store-mode library admin endpoints (TASK 26 — same create/browse/edit
// gap as categoryLibraryController.js: propagateStoreModeLibraryEdit
// already existed since TASK 21, this adds the create/browse/materialize
// side). Same identity-vs-placement split (§2.5): slug/label/icon are
// authored once and shared; active/display_order/is_default stay per-area.
const { pool } = require('../db/mysql');
const { bustAreaCaches } = require('../utils/areaScope');
const { materializeStoreModeToArea, propagateStoreModeLibraryEdit, LibraryError } = require('../utils/productLibrary');
const { requireOneArea } = require('./libraryShared');

const shape = (row) => ({
  id: row.id,
  slug: row.slug,
  label: row.label,
  iconImageId: row.icon_image_id, icon_image_id: row.icon_image_id,
  isSystem: Boolean(row.is_system), is_system: Boolean(row.is_system),
  archived: Boolean(row.archived),
  createdAt: row.created_at, created_at: row.created_at,
  updatedAt: row.updated_at, updated_at: row.updated_at,
});

// GET /admin/store-mode-library?search=&archived= — any admin may browse.
const getStoreModeLibrary = async (req, res) => {
  const { search, archived } = req.query;
  const where = [];
  const params = [];
  if (search) {
    where.push('label LIKE ?');
    params.push(`%${search}%`);
  }
  if (archived !== undefined) {
    where.push('archived = ?');
    params.push(archived === 'true' || archived === '1' ? 1 : 0);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const [rows] = await pool.query(`SELECT * FROM store_mode_library ${whereClause} ORDER BY updated_at DESC`, params);

  const libraryIds = rows.map((r) => r.id);
  const areasByLibraryId = new Map();
  if (libraryIds.length > 0) {
    const [areaRows] = await pool.query(
      `SELECT DISTINCT library_store_mode_id, area_id FROM store_modes WHERE library_store_mode_id IN (?)`,
      [libraryIds]
    );
    for (const row of areaRows) {
      if (!areasByLibraryId.has(row.library_store_mode_id)) areasByLibraryId.set(row.library_store_mode_id, []);
      areasByLibraryId.get(row.library_store_mode_id).push(row.area_id);
    }
  }

  res.status(200).json({
    data: rows.map((row) => ({
      ...shape(row),
      areaIds: areasByLibraryId.get(row.id) || [],
      area_ids: areasByLibraryId.get(row.id) || [],
    })),
  });
};

// POST /admin/store-mode-library — requireSuperAdmin (route-level gate).
const createStoreModeLibraryItem = async (req, res) => {
  const { slug, label, iconImageId, icon_image_id } = req.body || {};
  if (!label || !String(label).trim()) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'label is required' });
  }
  const finalSlug = (slug && String(slug).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, ''))
    || String(label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '');
  if (!finalSlug) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'slug is required' });
  }

  const [existing] = await pool.query('SELECT id FROM store_mode_library WHERE slug = ?', [finalSlug]);
  if (existing.length > 0) {
    return res.status(409).json({ code: 'CONFLICT', message: `Library store mode slug "${finalSlug}" is already in use` });
  }

  const [result] = await pool.query(
    'INSERT INTO store_mode_library (slug, label, icon_image_id) VALUES (?, ?, ?)',
    [finalSlug, String(label).trim(), iconImageId ?? icon_image_id ?? null]
  );
  const [rows] = await pool.query('SELECT * FROM store_mode_library WHERE id = ?', [result.insertId]);
  res.status(201).json({ message: 'Library store mode created', data: shape(rows[0]) });
};

// PATCH /admin/store-mode-library/:id — requireSuperAdmin.
const updateStoreModeLibraryItem = async (req, res) => {
  const libraryStoreModeId = Number(req.params.id);
  const { slug, label, iconImageId, icon_image_id, archived } = req.body || {};

  // slug is deliberately NOT editable after creation (bug fix, multi-area
  // audit finding #7). Unlike category_library.slug (which the per-area
  // categoryController.js already lets `updateCategory` rewrite freely),
  // store_modes.slug IS the canonical `store_type` value that
  // categories.type, combos/offers/coupons/dashboard_sections.store_type
  // all reference by string, in EVERY area at once via
  // propagateStoreModeLibraryEdit's batched UPDATE. Renaming it here would
  // silently orphan that reference everywhere the library item is used,
  // and reusing another mode's slug isn't validated at all — the per-area
  // updateStoreMode (storeModeController.js) already omits slug from its
  // own editable fields for the same reason.
  if (slug !== undefined) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'slug cannot be changed after creation — archive this item and create a new one instead' });
  }

  const fieldMap = { label: 'label', iconImageId: 'icon_image_id', icon_image_id: 'icon_image_id' };
  const sets = [];
  const values = [];
  const seenColumns = new Set();
  for (const [key, column] of Object.entries(fieldMap)) {
    if (req.body?.[key] === undefined || seenColumns.has(column)) continue;
    seenColumns.add(column);
    sets.push(`${column} = ?`);
    values.push(req.body[key]);
  }
  if (archived !== undefined) {
    sets.push('archived = ?');
    values.push(archived ? 1 : 0);
  }
  if (sets.length === 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'No fields to update' });
  }

  const connection = await pool.getConnection();
  let propagation;
  try {
    await connection.beginTransaction();
    const [existing] = await connection.query('SELECT id FROM store_mode_library WHERE id = ? FOR UPDATE', [libraryStoreModeId]);
    if (existing.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Library store mode not found' });
    }
    await connection.query(`UPDATE store_mode_library SET ${sets.join(', ')} WHERE id = ?`, [...values, libraryStoreModeId]);
    if (label !== undefined || iconImageId !== undefined || icon_image_id !== undefined) {
      propagation = await propagateStoreModeLibraryEdit(connection, libraryStoreModeId);
    }
    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }

  const [rows] = await pool.query('SELECT * FROM store_mode_library WHERE id = ?', [libraryStoreModeId]);
  res.status(200).json({ message: 'Library store mode updated', data: shape(rows[0]) });

  if (propagation) {
    Promise.all(propagation.areaIds.map((areaId) => bustAreaCaches(areaId)))
      .catch((err) => console.error('[storeModeLibrary] post-propagation cache bust failed:', err.message));
  }
};

// POST /admin/store-mode-library/:id/archive — requireSuperAdmin.
const archiveStoreModeLibraryItem = async (req, res) => {
  const [result] = await pool.query('UPDATE store_mode_library SET archived = 1 WHERE id = ?', [req.params.id]);
  if (result.affectedRows === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Library store mode not found' });
  }
  const [rows] = await pool.query('SELECT * FROM store_mode_library WHERE id = ?', [req.params.id]);
  res.status(200).json({ message: 'Library store mode archived', data: shape(rows[0]) });
};

const materializeErrorStatus = (code) => {
  if (code === 'NOT_FOUND') return 404;
  if (code === 'ARCHIVED' || code === 'VALIDATION_ERROR') return 400;
  return 500;
};

// POST /admin/store-mode-library/:id/add-to-area — any admin, for their own area.
const addStoreModeLibraryItemToArea = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;
  const libraryStoreModeId = Number(req.params.id);
  const { active, displayOrder, display_order } = req.body || {};

  const connection = await pool.getConnection();
  let outcome;
  try {
    await connection.beginTransaction();
    outcome = await materializeStoreModeToArea(connection, {
      libraryStoreModeId,
      areaId,
      active: active !== undefined ? active : true,
      displayOrder: displayOrder ?? display_order ?? 0,
    });
    await connection.commit();
  } catch (err) {
    await connection.rollback();
    if (err instanceof LibraryError) {
      return res.status(materializeErrorStatus(err.code)).json({ code: err.code, message: err.message });
    }
    throw err;
  } finally {
    connection.release();
  }

  await bustAreaCaches(areaId);
  const [modeRows] = await pool.query('SELECT * FROM store_modes WHERE id = ?', [outcome.storeModeId]);
  res.status(outcome.alreadyLinked ? 200 : 201).json({
    message: outcome.alreadyLinked ? 'Already linked to this area' : 'Added to area',
    alreadyLinked: outcome.alreadyLinked, already_linked: outcome.alreadyLinked,
    data: modeRows[0],
  });
};

module.exports = {
  getStoreModeLibrary,
  createStoreModeLibraryItem,
  updateStoreModeLibraryItem,
  archiveStoreModeLibraryItem,
  addStoreModeLibraryItemToArea,
};
