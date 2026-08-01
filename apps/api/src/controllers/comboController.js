const { pool } = require('../db/mysql');
const { validatePagination } = require('../validators');
const { isPositiveInteger } = require('../validators');
const { normalizeStoreType } = require('../utils/storeMode');
const { cleanupOrphanedImage } = require('./imageController');
const microCache = require('../utils/microCache');

// Hardcoded to area 1 for now (TASK 11 makes combos area-scoped); the
// cache bust plumbing is area-shaped already.
const COMBO_CACHE_AREA_ID_STOPGAP = 1;
const bustDashboardCache = () => {
  microCache.bust('dashboard', COMBO_CACHE_AREA_ID_STOPGAP);
};

const resolveImageUrls = async (rows) => {
  const imageIds = rows
    .map(r => r.image_id)
    .filter(id => id && /^\d+$/.test(String(id)));

  if (imageIds.length === 0) return;

  const [images] = await pool.query('SELECT id, url, thumb_url FROM images WHERE id IN (?)', [imageIds]);
  const imageMap = {};
  images.forEach(img => {
    imageMap[String(img.id)] = { url: img.url, thumb_url: img.thumb_url || null };
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
};

const getComboItemsByComboIds = async (comboIds = []) => {
  const ids = comboIds.filter(Boolean);
  if (ids.length === 0) return {};

  const [rows] = await pool.query(
    `SELECT
      ci.combo_id,
      ci.product_id,
      ci.quantity,
      ci.display_order,
      p.id,
      p.name,
      p.price,
      p.unit,
      p.description,
      p.image_id,
      p.available,
      p.is_combo,
      p.featured,
      p.original_price,
      p.discount_label,
      p.category_id,
      c.name as category_name,
      c.type as category_type
    FROM combo_items ci
    JOIN products p ON p.id = ci.product_id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE ci.combo_id IN (?) AND p.deleted = 0
    ORDER BY ci.combo_id ASC, ci.display_order ASC, ci.id ASC`,
    [ids]
  );

  await resolveImageUrls(rows);

  return rows.reduce((map, row) => {
    const comboId = row.combo_id;
    if (!map[comboId]) map[comboId] = [];
    map[comboId].push({
      ...row,
      productId: row.product_id,
      product_id: row.product_id,
      quantity: Number(row.quantity) || 1,
    });
    return map;
  }, {});
};

const attachComboItems = async (combos = []) => {
  const comboIds = combos.map(combo => combo.id);
  const comboItemsMap = await getComboItemsByComboIds(comboIds);

  combos.forEach(combo => {
    const comboItems = comboItemsMap[combo.id] || [];
    combo.combo_items = comboItems;
    combo.comboItems = comboItems;
    combo.combo_count = comboItems.length;
  });
};

const createValidationError = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'VALIDATION_ERROR';
  return error;
};

const saveComboItems = async (comboId, comboItems, connection = pool, comboStoreType = null) => {
  if (!Array.isArray(comboItems)) return;

  await connection.query('DELETE FROM combo_items WHERE combo_id = ?', [comboId]);

  const rows = await validateComboItems(comboItems, comboStoreType);

  if (rows.length === 0) return;

  await connection.query(
    `INSERT INTO combo_items (combo_id, product_id, quantity, display_order)
     VALUES ?`,
    [rows.map(item => [comboId, item.product_id, item.quantity, item.display_order])]
  );
};

const validateComboItems = async (comboItems, comboStoreType, { required = true } = {}) => {
  if (!Array.isArray(comboItems)) {
    if (required) {
      throw createValidationError('Please add at least one product to the combo.');
    }
    return [];
  }

  const rows = comboItems
    .map((item, index) => ({
      product_id: Number(item.product_id || item.productId || item.id),
      quantity: Number(item.quantity !== undefined ? item.quantity : (item.qty !== undefined ? item.qty : 1)),
      display_order: Number(item.display_order || item.displayOrder || index),
    }))
    .filter(item => item.product_id);

  if (rows.length === 0) {
    throw createValidationError('Please add at least one product to the combo.');
  }

  const seen = new Set();
  for (const row of rows) {
    if (!isPositiveInteger(row.quantity)) {
      throw createValidationError('Combo item quantity must be a whole number between 1 and 999.');
    }
    if (seen.has(row.product_id)) {
      throw createValidationError('This product is already in the combo. Increase quantity instead.');
    }
    seen.add(row.product_id);
  }

  const [products] = await pool.query(
    'SELECT p.id, p.name, p.is_combo, p.deleted, p.available, c.type as category_type FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.id IN (?)',
    [rows.map(row => row.product_id)]
  );
  const productById = new Map(products.map(product => [Number(product.id), product]));

  for (const row of rows) {
    const product = productById.get(row.product_id);
    if (!product || product.deleted) {
      throw createValidationError(`Product ID ${row.product_id} does not exist or has been deleted.`);
    }
    if (product.available === 0 || product.available === false) {
      throw createValidationError(`Product ID ${row.product_id} (${product.name}) is currently unavailable.`);
    }
    if (product.is_combo) {
      throw createValidationError(`Combo cannot include another combo: ${product.name}.`);
    }
    if (comboStoreType && product.category_type !== comboStoreType) {
      throw createValidationError(`Cannot add ${product.name} (mode: ${product.category_type}) to a combo with mode: ${comboStoreType}.`);
    }
  }

  return rows;
};

const getAdminCombos = async (req, res) => {
  const { search, available, featured, store_type, storeType, page, limit } = req.query;
  const finalStoreType = store_type || storeType;
  const pagination = validatePagination(page, limit);

  let whereClause = "WHERE deleted = 0";
  const params = [];

  if (finalStoreType) {
    const normalizedStoreType = await normalizeStoreType(finalStoreType, { allowAll: true });
    if (normalizedStoreType !== 'all') {
      whereClause += ' AND store_type = ?';
      params.push(normalizedStoreType);
    }
  }

  if (search) {
    whereClause += ' AND name LIKE ?';
    params.push(`%${search}%`);
  }

  if (available !== undefined) {
    whereClause += ' AND available = ?';
    params.push(available === 'true' || available === '1' ? 1 : 0);
  }

  if (featured !== undefined) {
    whereClause += ' AND featured = ?';
    params.push(featured === 'true' || featured === '1' ? 1 : 0);
  }

  const [countRows] = await pool.query(`SELECT COUNT(*) as total FROM combos ${whereClause}`, params);
  const total = countRows[0].total;
  const totalPages = Math.ceil(total / pagination.limit);

  const query = `
    SELECT * FROM combos 
    ${whereClause} 
    ORDER BY display_order ASC, id DESC
    LIMIT ? OFFSET ?
  `;

  params.push(pagination.limit, (pagination.page - 1) * pagination.limit);

  const [rows] = await pool.query(query, params);

  await resolveImageUrls(rows);
  await attachComboItems(rows);

  res.status(200).json({ 
    data: { products: rows }, 
    products: rows,
    pagination: {
      page: pagination.page,
      limit: pagination.limit,
      total,
      totalPages
    }
  });
};

const getAdminComboById = async (req, res) => {
  const { id } = req.params;
  const [rows] = await pool.query(`
    SELECT * 
    FROM combos 
    WHERE id = ? AND deleted = 0
  `, [id]);
  
  if (rows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Combo not found' });
  }

  const combo = rows[0];
  await resolveImageUrls([combo]);
  await attachComboItems([combo]);

  res.status(200).json({ data: combo });
};

const createCombo = async (req, res) => {
  const { name, price, unit, description, image_id, available, featured, display_order, original_price, discount_label, combo_items, store_type: rawStoreType } = req.validatedData;
  let store_type;
  try {
    store_type = await normalizeStoreType(rawStoreType, { fallback: false });
  } catch (e) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: e.message });
  }
  const finalDisplayOrder = display_order !== undefined ? display_order : 0;
  const validatedComboItems = await validateComboItems(combo_items, store_type);

  if (finalDisplayOrder > 0) {
    const [existing] = await pool.query('SELECT name FROM combos WHERE display_order = ? AND store_type = ? AND deleted = 0 LIMIT 1', [finalDisplayOrder, store_type]);
    if (existing.length > 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Display order ${finalDisplayOrder} is already used by ${existing[0].name} in this mode.` });
    }
  }

  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    const [result] = await connection.query(
      'INSERT INTO combos (name, price, unit, description, image_id, available, featured, display_order, original_price, discount_label, store_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        name, price, unit, description, image_id, 
        available !== undefined ? available : true,
        featured !== undefined ? featured : false,
        finalDisplayOrder,
        original_price || null,
        discount_label || null,
        store_type
      ]
    );
    await saveComboItems(result.insertId, validatedComboItems, connection, store_type);
    await connection.commit();
    bustDashboardCache();
    res.status(201).json({ message: 'Combo created', id: result.insertId });
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

const updateCombo = async (req, res) => {
  const { id } = req.params;
  const { name, price, unit, description, image_id, available, featured, display_order, original_price, discount_label, combo_items, store_type: rawStoreType } = req.validatedData;
  let store_type;
  if (rawStoreType) {
    try {
      store_type = await normalizeStoreType(rawStoreType, { fallback: false });
    } catch (e) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: e.message });
    }
  }

  const [existing] = await pool.query('SELECT id, store_type, image_id FROM combos WHERE id = ? AND deleted = 0', [id]);
  if (existing.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Combo not found' });
  }

  const existingCombo = existing[0];
  const previousImageId = existingCombo.image_id;
  const targetStoreType = store_type || existingCombo.store_type;
  const validatedComboItems = await validateComboItems(combo_items, targetStoreType, { required: combo_items !== undefined });

  if (combo_items === undefined && targetStoreType !== existingCombo.store_type) {
    const [existingItems] = await pool.query(
      'SELECT product_id, quantity, display_order FROM combo_items WHERE combo_id = ? ORDER BY display_order ASC, id ASC',
      [id]
    );
    await validateComboItems(existingItems, targetStoreType, { required: existingItems.length > 0 });
  }

  const finalDisplayOrder = display_order !== undefined ? display_order : 0;
  if (finalDisplayOrder > 0) {
    const [orderExisting] = await pool.query('SELECT name FROM combos WHERE display_order = ? AND store_type = ? AND id != ? AND deleted = 0 LIMIT 1', [finalDisplayOrder, targetStoreType, id]);
    if (orderExisting.length > 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Display order ${finalDisplayOrder} is already used by ${orderExisting[0].name} in this mode.` });
    }
  }

  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    await connection.query(
      'UPDATE combos SET name = ?, price = ?, unit = ?, description = ?, image_id = ?, available = ?, featured = ?, display_order = ?, original_price = ?, discount_label = ?, store_type = ? WHERE id = ?',
      [
        name, price, unit, description, image_id, 
        available !== undefined ? available : true,
        featured !== undefined ? featured : false,
        finalDisplayOrder,
        original_price || null,
        discount_label || null,
        targetStoreType,
        id
      ]
    );
    if (combo_items !== undefined) {
      await saveComboItems(id, validatedComboItems, connection, targetStoreType);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  if (previousImageId && String(previousImageId) !== String(image_id)) {
    await cleanupOrphanedImage(previousImageId);
  }

  bustDashboardCache();
  res.status(200).json({ message: 'Combo updated' });
};

const deleteCombo = async (req, res) => {
  const { id } = req.params;
  const [existing] = await pool.query('SELECT id, image_id FROM combos WHERE id = ? AND deleted = 0', [id]);
  if (existing.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Combo not found' });
  }

  await pool.query('UPDATE combos SET deleted = 1 WHERE id = ?', [id]);
  await cleanupOrphanedImage(existing[0].image_id);
  bustDashboardCache();
  res.status(200).json({ message: 'Combo soft deleted' });
};

const updateComboAvailability = async (req, res) => {
  const { id } = req.params;
  const finalAvail = req.validatedData?.available;
  if (finalAvail === undefined) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Availability status required' });
  }

  const normalizedAvailable = finalAvail === true || finalAvail === 'true' || finalAvail === 1 || finalAvail === '1';
  const [result] = await pool.query('UPDATE combos SET available = ? WHERE id = ? AND deleted = 0', [normalizedAvailable ? 1 : 0, id]);
  if (result.affectedRows === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Combo not found' });
  }
  
  const [updatedRows] = await pool.query('SELECT * FROM combos WHERE id = ?', [id]);
  bustDashboardCache();
  res.status(200).json({ message: 'Combo availability updated', combo: updatedRows[0] });
};

module.exports = {
  validateComboItems,
  getAdminCombos,
  getAdminComboById,
  createCombo,
  updateCombo,
  deleteCombo,
  updateComboAvailability
};
