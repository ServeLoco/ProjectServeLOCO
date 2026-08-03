// Category library admin endpoints (TASK 26 — the create/browse/edit side;
// propagateCategoryLibraryEdit already existed since TASK 21 for the
// edit-sync direction). Same identity-vs-placement split as the product
// library (§2.5): name/slug/type/image are authored once and shared;
// active/display_order/which area carries it stay per-area.
const { pool } = require('../db/mysql');
const { bustAreaCaches } = require('../utils/areaScope');
const { materializeCategoryToArea, propagateCategoryLibraryEdit, LibraryError } = require('../utils/productLibrary');
const { requireOneArea } = require('./libraryShared');

const shape = (row) => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  type: row.type,
  imageId: row.image_id, image_id: row.image_id,
  archived: Boolean(row.archived),
  createdAt: row.created_at, created_at: row.created_at,
  updatedAt: row.updated_at, updated_at: row.updated_at,
});

// GET /admin/category-library?search=&archived= — any admin may browse.
const getCategoryLibrary = async (req, res) => {
  const { search, archived } = req.query;
  const where = [];
  const params = [];
  if (search) {
    where.push('name LIKE ?');
    params.push(`%${search}%`);
  }
  if (archived !== undefined) {
    where.push('archived = ?');
    params.push(archived === 'true' || archived === '1' ? 1 : 0);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const [rows] = await pool.query(`SELECT * FROM category_library ${whereClause} ORDER BY updated_at DESC`, params);

  const libraryIds = rows.map((r) => r.id);
  const areasByLibraryId = new Map();
  if (libraryIds.length > 0) {
    const [areaRows] = await pool.query(
      `SELECT DISTINCT library_category_id, area_id FROM categories
       WHERE library_category_id IN (?) AND deleted = 0`,
      [libraryIds]
    );
    for (const row of areaRows) {
      if (!areasByLibraryId.has(row.library_category_id)) areasByLibraryId.set(row.library_category_id, []);
      areasByLibraryId.get(row.library_category_id).push(row.area_id);
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

// POST /admin/category-library — requireSuperAdmin (route-level gate).
const createCategoryLibraryItem = async (req, res) => {
  const { name, slug, type, imageId, image_id } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'name is required' });
  }
  if (!type || !String(type).trim()) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'type is required' });
  }
  const finalSlug = (slug && String(slug).trim()) || String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  const [existing] = await pool.query('SELECT id FROM category_library WHERE slug = ?', [finalSlug]);
  if (existing.length > 0) {
    return res.status(409).json({ code: 'CONFLICT', message: `Library category slug "${finalSlug}" is already in use` });
  }

  const [result] = await pool.query(
    'INSERT INTO category_library (name, slug, type, image_id) VALUES (?, ?, ?, ?)',
    [String(name).trim(), finalSlug, String(type).trim(), imageId ?? image_id ?? null]
  );
  const [rows] = await pool.query('SELECT * FROM category_library WHERE id = ?', [result.insertId]);
  res.status(201).json({ message: 'Library category created', data: shape(rows[0]) });
};

// PATCH /admin/category-library/:id — requireSuperAdmin. Every change fans
// out to every area that carries this item via propagateCategoryLibraryEdit,
// in the same transaction as the write (§3.7/§6.7).
const updateCategoryLibraryItem = async (req, res) => {
  const libraryCategoryId = Number(req.params.id);
  const { name, slug, type, imageId, image_id, archived } = req.body || {};

  const fieldMap = { name: 'name', slug: 'slug', type: 'type', imageId: 'image_id', image_id: 'image_id' };
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
    const [existing] = await connection.query('SELECT id FROM category_library WHERE id = ? FOR UPDATE', [libraryCategoryId]);
    if (existing.length === 0) {
      await connection.rollback();
      connection.release();
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Library category not found' });
    }
    await connection.query(`UPDATE category_library SET ${sets.join(', ')} WHERE id = ?`, [...values, libraryCategoryId]);
    // Identity propagation only makes sense for identity fields — archiving
    // alone doesn't touch per-area rows (matches product library's own
    // archive semantics, §2.5), so only propagate when a real identity
    // field changed.
    if (name !== undefined || slug !== undefined || type !== undefined || imageId !== undefined || image_id !== undefined) {
      propagation = await propagateCategoryLibraryEdit(connection, libraryCategoryId);
    }
    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }

  const [rows] = await pool.query('SELECT * FROM category_library WHERE id = ?', [libraryCategoryId]);
  res.status(200).json({ message: 'Library category updated', data: shape(rows[0]) });

  if (propagation) {
    Promise.all(propagation.areaIds.map((areaId) => bustAreaCaches(areaId)))
      .catch((err) => console.error('[categoryLibrary] post-propagation cache bust failed:', err.message));
  }
};

// POST /admin/category-library/:id/archive — requireSuperAdmin.
const archiveCategoryLibraryItem = async (req, res) => {
  const [result] = await pool.query('UPDATE category_library SET archived = 1 WHERE id = ?', [req.params.id]);
  if (result.affectedRows === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Library category not found' });
  }
  const [rows] = await pool.query('SELECT * FROM category_library WHERE id = ?', [req.params.id]);
  res.status(200).json({ message: 'Library category archived', data: shape(rows[0]) });
};

const materializeErrorStatus = (code) => {
  if (code === 'NOT_FOUND') return 404;
  if (code === 'ARCHIVED' || code === 'VALIDATION_ERROR') return 400;
  return 500;
};

// POST /admin/category-library/:id/add-to-area — any admin, for their own area.
const addCategoryLibraryItemToArea = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;
  const libraryCategoryId = Number(req.params.id);
  const { active, displayOrder, display_order } = req.body || {};

  const connection = await pool.getConnection();
  let outcome;
  try {
    await connection.beginTransaction();
    outcome = await materializeCategoryToArea(connection, {
      libraryCategoryId,
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
  const [categoryRows] = await pool.query('SELECT * FROM categories WHERE id = ?', [outcome.categoryId]);
  res.status(outcome.alreadyLinked ? 200 : 201).json({
    message: outcome.alreadyLinked ? 'Already linked to this area' : 'Added to area',
    alreadyLinked: outcome.alreadyLinked, already_linked: outcome.alreadyLinked,
    data: categoryRows[0],
  });
};

module.exports = {
  getCategoryLibrary,
  createCategoryLibraryItem,
  updateCategoryLibraryItem,
  archiveCategoryLibraryItem,
  addCategoryLibraryItemToArea,
};
