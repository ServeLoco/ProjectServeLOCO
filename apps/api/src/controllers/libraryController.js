// Product library admin endpoints (TASK 19, §4.5). Identity (name,
// description, image, unit, variant labels) is authored here once and
// shared; price/availability/category/shop placement are per-area, written
// only through productLibrary.js's materializeToArea.
const { pool } = require('../db/mysql');
const { validatePagination } = require('../validators');
const { requestAreaId, bustAreaCaches } = require('../utils/areaScope');
const { materializeToArea, syncLibraryVariants, propagateLibraryEdit, promoteToLibrary, LibraryError } = require('../utils/productLibrary');
const { decideSearchMode } = require('../utils/search');

// add-to-area targets exactly one area — an area_admin's own (resolveAdminArea
// already pins that), or a super_admin's explicit X-Area-Id. Never 'all': a
// single add-to-area call materializing into every area at once would be the
// bulk fan-out endpoint's job (add-to-areas), not this one's.
const requireOneArea = (req, res) => {
  const areaId = requestAreaId(req);
  if (areaId === null) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'X-Area-Id is required for this action' });
    return null;
  }
  if (areaId === 'all') {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'This action cannot target "all" areas at once — use add-to-areas' });
    return null;
  }
  return areaId;
};

const libraryRowShape = (row) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  imageId: row.image_id, image_id: row.image_id,
  unitId: row.unit_id, unit_id: row.unit_id,
  variantPrompt: row.variant_prompt, variant_prompt: row.variant_prompt,
  defaultStoreType: row.default_store_type, default_store_type: row.default_store_type,
  defaultCategorySlug: row.default_category_slug, default_category_slug: row.default_category_slug,
  suggestedPrice: row.suggested_price != null ? Number(row.suggested_price) : null,
  suggested_price: row.suggested_price != null ? Number(row.suggested_price) : null,
  status: row.status,
  archived: Boolean(row.archived),
  createdAt: row.created_at, created_at: row.created_at,
  updatedAt: row.updated_at, updated_at: row.updated_at,
});

// GET /admin/library?search=&status=&archived=&page=&limit=
// Read-only browse — any admin (area or super) may see the whole library;
// writes are the restricted part (19.3). search hits product_library — one
// global FULLTEXT index instead of N per-area copies (TASK 22.4, §3.11):
// this is admin's "find a product to add" lookup.
const getLibrary = async (req, res) => {
  const { search, status, archived } = req.query;
  const pagination = validatePagination(req.query.page, req.query.limit);
  const offset = (pagination.page - 1) * pagination.limit;

  const where = [];
  const params = [];
  if (search) {
    const decision = decideSearchMode(search);
    if (decision.mode === 'none') {
      where.push('1=0');
    } else if (decision.mode === 'like') {
      where.push('name LIKE ?');
      params.push(`%${decision.term}%`);
    } else {
      where.push('MATCH(name) AGAINST (? IN BOOLEAN MODE)');
      params.push(decision.term);
    }
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  if (archived !== undefined) {
    where.push('archived = ?');
    params.push(archived === 'true' || archived === '1' ? 1 : 0);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const [rows] = await pool.query(
    `SELECT * FROM product_library ${whereClause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    [...params, pagination.limit, offset]
  );
  const [[countRow]] = await pool.query(`SELECT COUNT(*) AS total FROM product_library ${whereClause}`, params);

  const libraryIds = rows.map((r) => r.id);
  const areasByLibraryId = new Map();
  const variantsByLibraryId = new Map();
  if (libraryIds.length > 0) {
    const [areaRows] = await pool.query(
      `SELECT DISTINCT library_product_id, area_id FROM products
       WHERE library_product_id IN (?) AND deleted = 0`,
      [libraryIds]
    );
    for (const row of areaRows) {
      if (!areasByLibraryId.has(row.library_product_id)) areasByLibraryId.set(row.library_product_id, []);
      areasByLibraryId.get(row.library_product_id).push(row.area_id);
    }

    // Edit drawer needs existing variant rows to prefill (bug fix — it was
    // always opening empty since this list response never carried them).
    const [variantRows] = await pool.query(
      `SELECT id, library_product_id, label, display_order, is_default FROM library_variants
       WHERE library_product_id IN (?) ORDER BY display_order ASC, id ASC`,
      [libraryIds]
    );
    for (const v of variantRows) {
      if (!variantsByLibraryId.has(v.library_product_id)) variantsByLibraryId.set(v.library_product_id, []);
      variantsByLibraryId.get(v.library_product_id).push({
        id: v.id,
        label: v.label,
        displayOrder: v.display_order, display_order: v.display_order,
        isDefault: Boolean(v.is_default), is_default: Boolean(v.is_default),
      });
    }
  }

  const data = rows.map((row) => ({
    ...libraryRowShape(row),
    areaIds: areasByLibraryId.get(row.id) || [],
    area_ids: areasByLibraryId.get(row.id) || [],
    variants: variantsByLibraryId.get(row.id) || [],
  }));

  res.status(200).json({
    data,
    pagination: {
      page: pagination.page,
      limit: pagination.limit,
      total: countRow.total,
      totalPages: Math.max(1, Math.ceil(countRow.total / pagination.limit)),
    },
  });
};

// POST /admin/library — requireSuperAdmin (route-level gate).
const createLibraryProduct = async (req, res) => {
  const {
    name, description, imageId, image_id, unitId, unit_id, variantPrompt, variant_prompt,
    defaultStoreType, default_store_type, defaultCategorySlug, default_category_slug,
    suggestedPrice, suggested_price, status, variants,
  } = req.body || {};

  if (!name || !String(name).trim()) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'name is required' });
  }
  const finalStatus = status === 'published' ? 'published' : 'draft';

  const connection = await pool.getConnection();
  let insertId;
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO product_library
        (name, description, image_id, unit_id, variant_prompt, default_store_type, default_category_slug, suggested_price, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(name).trim(),
        description || null,
        imageId ?? image_id ?? null,
        unitId ?? unit_id ?? null,
        variantPrompt ?? variant_prompt ?? null,
        defaultStoreType ?? default_store_type ?? null,
        defaultCategorySlug ?? default_category_slug ?? null,
        (suggestedPrice ?? suggested_price) || null,
        finalStatus,
      ]
    );
    insertId = result.insertId;

    if (Array.isArray(variants)) {
      for (let i = 0; i < variants.length; i++) {
        const v = variants[i];
        if (!v?.label) continue;
        await connection.query(
          'INSERT INTO library_variants (library_product_id, label, display_order, is_default) VALUES (?, ?, ?, ?)',
          [insertId, v.label, v.displayOrder ?? v.display_order ?? i, v.isDefault || v.is_default ? 1 : 0]
        );
      }
    }
    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }

  const [rows] = await pool.query('SELECT * FROM product_library WHERE id = ?', [insertId]);
  res.status(201).json({ message: 'Library product created', data: libraryRowShape(rows[0]) });
};

// PATCH /admin/library/:id — requireSuperAdmin. Identity fields only; the
// actual per-area propagation of an edit is TASK 20's job (propagateLibraryEdit).
// PATCH /admin/library/:id — requireSuperAdmin. Scalar identity fields and/or
// a `variants` array (upsert-by-id, hard-delete-missing at the library level
// — see syncLibraryVariants). Every change here fans out to every area that
// carries this item via propagateLibraryEdit (TASK 20, §3.7/§6.7) in the
// SAME transaction as the write, so an admin can never see the library say
// one thing while an area's products still say another.
const updateLibraryProduct = async (req, res) => {
  const { id } = req.params;
  const libraryProductId = Number(id);
  const { variants } = req.body || {};

  const fieldMap = {
    name: 'name', description: 'description',
    imageId: 'image_id', image_id: 'image_id',
    unitId: 'unit_id', unit_id: 'unit_id',
    variantPrompt: 'variant_prompt', variant_prompt: 'variant_prompt',
    defaultStoreType: 'default_store_type', default_store_type: 'default_store_type',
    defaultCategorySlug: 'default_category_slug', default_category_slug: 'default_category_slug',
    suggestedPrice: 'suggested_price', suggested_price: 'suggested_price',
    status: 'status',
  };
  const sets = [];
  const values = [];
  const seenColumns = new Set();
  for (const [key, column] of Object.entries(fieldMap)) {
    if (req.body?.[key] === undefined || seenColumns.has(column)) continue;
    seenColumns.add(column);
    sets.push(`${column} = ?`);
    values.push(req.body[key]);
  }
  if (sets.length === 0 && variants === undefined) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'No fields to update' });
  }

  const connection = await pool.getConnection();
  let propagation;
  try {
    await connection.beginTransaction();

    const [existing] = await connection.query('SELECT id FROM product_library WHERE id = ? FOR UPDATE', [libraryProductId]);
    if (existing.length === 0) {
      await connection.rollback();
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Library product not found' });
    }

    if (sets.length > 0) {
      await connection.query(`UPDATE product_library SET ${sets.join(', ')} WHERE id = ?`, [...values, libraryProductId]);
    }
    if (variants !== undefined) {
      await syncLibraryVariants(connection, libraryProductId, variants);
    }
    propagation = await propagateLibraryEdit(connection, libraryProductId);

    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }

  const [rows] = await pool.query('SELECT * FROM product_library WHERE id = ?', [libraryProductId]);
  res.status(200).json({ message: 'Library product updated', data: libraryRowShape(rows[0]) });

  // 20.4: bust every affected area's caches AFTER the response is sent —
  // never make the admin wait on N cache busts for an edit that already
  // committed.
  Promise.all(propagation.areaIds.map((areaId) => bustAreaCaches(areaId)))
    .catch((err) => console.error('[library] post-propagation cache bust failed:', err.message));
};

// POST /admin/library/:id/archive — requireSuperAdmin. Archiving never
// touches area rows (§2.5) — area products stay exactly as they are and
// simply become un-addable to further areas.
const archiveLibraryProduct = async (req, res) => {
  const { id } = req.params;
  const [result] = await pool.query('UPDATE product_library SET archived = 1 WHERE id = ?', [id]);
  if (result.affectedRows === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Library product not found' });
  }
  const [rows] = await pool.query('SELECT * FROM product_library WHERE id = ?', [id]);
  res.status(200).json({ message: 'Library product archived', data: libraryRowShape(rows[0]) });
};

const materializeErrorStatus = (code) => {
  if (code === 'NOT_FOUND') return 404;
  if (code === 'ARCHIVED' || code === 'VALIDATION_ERROR') return 400;
  return 500;
};

// POST /admin/library/:id/add-to-area — any admin, for their own area.
const addLibraryProductToArea = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;
  const libraryProductId = Number(req.params.id);
  const { categoryId, category_id, price, shopId, shop_id, shopPrice, shop_price, available, displayOrder, display_order, variantPrices, variant_prices } = req.body || {};
  const finalCategoryId = categoryId ?? category_id;
  if (!Number.isInteger(finalCategoryId)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'categoryId is required' });
  }

  const connection = await pool.getConnection();
  let outcome;
  try {
    await connection.beginTransaction();
    outcome = await materializeToArea(connection, {
      libraryProductId,
      areaId,
      categoryId: finalCategoryId,
      price,
      shopId: shopId ?? shop_id ?? null,
      shopPrice: shopPrice ?? shop_price ?? null,
      available: available !== undefined ? available : true,
      displayOrder: displayOrder ?? display_order ?? 0,
      variantPrices: variantPrices ?? variant_prices ?? {},
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
  const [productRows] = await pool.query('SELECT * FROM products WHERE id = ?', [outcome.productId]);
  res.status(outcome.alreadyLinked ? 200 : 201).json({
    message: outcome.alreadyLinked ? 'Already linked to this area' : 'Added to area',
    alreadyLinked: outcome.alreadyLinked, already_linked: outcome.alreadyLinked,
    data: productRows[0],
  });
};

// POST /admin/library/:id/add-to-areas — requireSuperAdmin (only a super
// admin has cross-area reach). Fan out to many areas in ONE transaction —
// { areaId: { categoryId, price, ... } } per area.
const addLibraryProductToAreas = async (req, res) => {
  const libraryProductId = Number(req.params.id);
  const { areas } = req.body || {};
  if (!areas || typeof areas !== 'object' || Array.isArray(areas) || Object.keys(areas).length === 0) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'areas must be an object keyed by areaId, e.g. { "2": { "categoryId": 5, "price": 40 } }',
    });
  }

  const connection = await pool.getConnection();
  const results = [];
  try {
    await connection.beginTransaction();
    for (const [areaIdKey, config] of Object.entries(areas)) {
      const areaId = Number(areaIdKey);
      const finalCategoryId = config?.categoryId ?? config?.category_id;
      if (!Number.isInteger(areaId) || areaId <= 0 || !Number.isInteger(finalCategoryId)) {
        throw new LibraryError('VALIDATION_ERROR', `areas.${areaIdKey} requires a valid areaId and categoryId`);
      }
      const outcome = await materializeToArea(connection, {
        libraryProductId,
        areaId,
        categoryId: finalCategoryId,
        price: config.price,
        shopId: config.shopId ?? config.shop_id ?? null,
        shopPrice: config.shopPrice ?? config.shop_price ?? null,
        available: config.available !== undefined ? config.available : true,
        displayOrder: config.displayOrder ?? config.display_order ?? 0,
        variantPrices: config.variantPrices ?? config.variant_prices ?? {},
      });
      results.push({ areaId, ...outcome });
    }
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

  await Promise.all(results.map((r) => bustAreaCaches(r.areaId)));
  res.status(200).json({ message: 'Fan-out complete', results });
};

// POST /admin/products/:id/promote-to-library — requireSuperAdmin. Lifts
// name/image/variant labels from ONE existing area product into a brand new
// library item, then links that same product back to it. Touches no other
// area's rows — a promotion only ever creates new global rows plus one
// UPDATE on the source product/variants.
const promoteProductToLibrary = async (req, res) => {
  const productId = Number(req.params.id);

  const connection = await pool.getConnection();
  let libraryProductId;
  try {
    await connection.beginTransaction();
    ({ libraryProductId } = await promoteToLibrary(connection, productId));
    await connection.commit();
  } catch (err) {
    await connection.rollback();
    if (err instanceof LibraryError) {
      return res.status(err.code === 'NOT_FOUND' ? 404 : 409).json({ code: err.code, message: err.message });
    }
    throw err;
  } finally {
    connection.release();
  }

  const [libRows] = await pool.query('SELECT * FROM product_library WHERE id = ?', [libraryProductId]);
  res.status(201).json({ message: 'Promoted to library', data: libraryRowShape(libRows[0]) });
};

module.exports = {
  getLibrary,
  createLibraryProduct,
  updateLibraryProduct,
  archiveLibraryProduct,
  addLibraryProductToArea,
  addLibraryProductToAreas,
  promoteProductToLibrary,
};
