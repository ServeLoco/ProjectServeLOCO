const { pool } = require('../db/mysql');
const { normalizeStoreType } = require('../utils/storeMode');
const microCache = require('../utils/microCache');
const { cleanupOrphanedImage } = require('./imageController');
const { requestAreaId, bustAreaCaches } = require('../utils/areaScope');

const CATEGORIES_TTL_MS = 30_000;

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const attachImageUrls = async (rows) => {
  const imageIds = rows
    .map(row => row.image_id)
    .filter(id => id && /^\d+$/.test(String(id)));

  if (imageIds.length === 0) return rows;

  const [images] = await pool.query('SELECT id, url, thumb_url FROM images WHERE id IN (?)', [imageIds]);
  const imageMap = {};
  images.forEach(image => {
    imageMap[String(image.id)] = { url: image.url, thumb_url: image.thumb_url || null };
  });

  rows.forEach(row => {
    const mapped = imageMap[row.image_id];
    if (row.image_id && mapped) {
      row.imageUrl = mapped.url;
      row.image_url = mapped.url;
      row.thumbUrl = mapped.thumb_url;
      row.thumb_url = mapped.thumb_url;
    }
  });

  return rows;
};

// Public endpoint: catalog data, not settings metadata — a pin outside
// every zone (null areaId) gets an empty list, same as
// deliveryZonesController.listActiveZonesPublic, never another area's
// categories (§2.4).
const getCategories = async (req, res) => {
  const areaId = requestAreaId(req);
  if (areaId === null || areaId === 'all') {
    return res.status(200).json({ data: [], categories: [] });
  }

  const type = req.query.type || req.query.storeType || req.query.store_type;
  const normalizedType = type
    ? await normalizeStoreType(type, { allowAll: true, areaId })
    : 'all';
  const cacheKey = `categories:${areaId}:public:${normalizedType}`;
  const cached = microCache.get(cacheKey);
  if (cached) {
    return res.status(200).json(cached);
  }

  const params = [areaId];
  let query = `
    SELECT c.*, (
      SELECT COUNT(*)
      FROM products p
      WHERE p.category_id = c.id AND p.deleted = 0 AND p.is_combo = 0 AND p.area_id = c.area_id
    ) as product_count
    FROM categories c
    WHERE c.active = 1 AND c.deleted = 0 AND c.area_id = ?
  `;

  if (normalizedType !== 'all') {
    query += ' AND c.type = ?';
    params.push(normalizedType);
  }

  query += ' ORDER BY c.display_order ASC, c.id ASC';

  const [rows] = await pool.query(query, params);
  await attachImageUrls(rows);
  const body = { data: rows, categories: rows };
  microCache.set(cacheKey, body, CATEGORIES_TTL_MS);
  res.status(200).json(body);
};

// Admin endpoint: rejects null (super_admin, no X-Area-Id) and 'all' —
// category management always targets exactly one area.
const requireOneArea = (req, res) => {
  const areaId = requestAreaId(req);
  if (areaId === null) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'X-Area-Id is required to manage categories' });
    return null;
  }
  if (areaId === 'all') {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Categories cannot be managed for "all" areas at once — pick one area' });
    return null;
  }
  return areaId;
};

const getAdminCategories = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const type = req.query.type || req.query.storeType || req.query.store_type;
  const normalizedType = type ? await normalizeStoreType(type, { allowAll: true, areaId }) : null;
  const params = [areaId];
  let query = `
    SELECT c.*, (
      SELECT COUNT(*)
      FROM products p
      WHERE p.category_id = c.id AND p.deleted = 0 AND p.is_combo = 0 AND p.area_id = c.area_id
    ) as product_count
    FROM categories c
    WHERE c.deleted = 0 AND c.area_id = ?
  `;

  if (normalizedType && normalizedType !== 'all') {
    query += ' AND c.type = ?';
    params.push(normalizedType);
  }

  query += ' ORDER BY c.display_order ASC, c.id ASC';

  const [rows] = await pool.query(query, params);
  await attachImageUrls(rows);
  res.status(200).json({ data: rows });
};

const createCategory = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const { name, type: rawType, image_id, active } = req.validatedData;
  let type;
  try {
    type = await normalizeStoreType(rawType, { fallback: false, areaId });
  } catch (e) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: e.message });
  }
  const slug = req.validatedData.slug || slugify(name);
  const displayOrder = req.validatedData.display_order ?? 0;

  if (displayOrder > 0) {
    const [existing] = await pool.query('SELECT name FROM categories WHERE type = ? AND display_order = ? AND deleted = 0 AND area_id = ? LIMIT 1', [type, displayOrder, areaId]);
    if (existing.length > 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Display order ${displayOrder} is already used by ${existing[0].name} in ${type}.` });
    }
  }

  const [result] = await pool.query(
    'INSERT INTO categories (area_id, name, slug, type, image_id, active, display_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [areaId, name, slug, type, image_id, active !== undefined ? active : true, displayOrder]
  );
  await bustAreaCaches(areaId);
  res.status(201).json({ message: 'Category created', id: result.insertId });
};

const updateCategory = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const { id } = req.params;
  const { name, type: rawType, image_id, active } = req.validatedData;
  let type;
  try {
    type = await normalizeStoreType(rawType, { fallback: false, areaId });
  } catch (e) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: e.message });
  }
  const slug = req.validatedData.slug || slugify(name);
  const displayOrder = req.validatedData.display_order ?? 0;

  // area_id in the WHERE, not just id: without this, an area_admin could
  // PATCH another area's category by guessing its (globally sequential)
  // numeric id.
  const [currentRows] = await pool.query('SELECT id, image_id FROM categories WHERE id = ? AND deleted = 0 AND area_id = ?', [id, areaId]);
  if (currentRows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Category not found' });
  }
  const previousImageId = currentRows[0].image_id;

  if (displayOrder > 0) {
    const [existing] = await pool.query('SELECT name FROM categories WHERE type = ? AND display_order = ? AND id != ? AND deleted = 0 AND area_id = ? LIMIT 1', [type, displayOrder, id, areaId]);
    if (existing.length > 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Display order ${displayOrder} is already used by ${existing[0].name} in ${type}.` });
    }
  }

  await pool.query(
    'UPDATE categories SET name = ?, slug = ?, type = ?, image_id = ?, active = ?, display_order = ? WHERE id = ? AND area_id = ?',
    [name, slug, type, image_id, active, displayOrder, id, areaId]
  );
  await bustAreaCaches(areaId);
  if (previousImageId && String(previousImageId) !== String(image_id)) {
    await cleanupOrphanedImage(previousImageId);
  }
  res.status(200).json({ message: 'Category updated' });
};

const deleteCategory = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const { id } = req.params;
  const [currentRows] = await pool.query('SELECT id, image_id FROM categories WHERE id = ? AND deleted = 0 AND area_id = ?', [id, areaId]);
  if (currentRows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Category not found' });
  }

  const [[productUsage]] = await pool.query(
    'SELECT COUNT(*) as count FROM products WHERE category_id = ? AND deleted = 0 AND area_id = ?',
    [id, areaId]
  );
  if (Number(productUsage.count) > 0) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Cannot delete category while active products still use it'
    });
  }

  const [[dashboardUsage]] = await pool.query(
    `SELECT COUNT(*) as count
     FROM dashboard_section_items
     WHERE item_type = 'category' AND item_id = ? AND deleted_at IS NULL`,
    [id]
  );
  if (Number(dashboardUsage.count) > 0) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Cannot delete category while it is assigned to the mobile dashboard'
    });
  }

  await pool.query('UPDATE categories SET deleted = 1 WHERE id = ? AND area_id = ?', [id, areaId]);
  await cleanupOrphanedImage(currentRows[0].image_id);
  await bustAreaCaches(areaId);
  res.status(200).json({ message: 'Category soft deleted' });
};

module.exports = {
  getCategories,
  getAdminCategories,
  createCategory,
  updateCategory,
  deleteCategory
};
