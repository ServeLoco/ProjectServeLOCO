// Super-admin endpoints: area CRUD, clone-area, admin account CRUD (§2.12,
// §6.6, §6.8). Every route here is mounted requireAdmin + requireSuperAdmin
// (adminRoutes.js) — an area_admin never reaches this file.
const bcrypt = require('bcrypt');
const { pool } = require('../db/mysql');
const {
  listAreas: listAreasFromScope,
  getAreaById,
  invalidateAreasCache,
  seedSystemStoreModes,
} = require('../utils/areaScope');
const { materializeToArea } = require('../utils/productLibrary');

const shapeArea = (row) => ({
  id: row.id,
  code: row.code,
  name: row.name,
  active: Boolean(row.active),
  isDefault: Boolean(row.is_default),
  is_default: Boolean(row.is_default),
  timezone: row.timezone,
  brandColor: row.brand_color,
  brand_color: row.brand_color,
  logoImageId: row.logo_image_id,
  logo_image_id: row.logo_image_id,
  features: row.features || null,
  catalogVersion: row.catalog_version,
  catalog_version: row.catalog_version,
  createdAt: row.created_at,
  created_at: row.created_at,
});

const shapeAdmin = (row) => ({
  id: row.id,
  username: row.username,
  role: row.role,
  areaId: row.area_id,
  area_id: row.area_id,
  areaCode: row.area_code || null,
  area_code: row.area_code || null,
  displayName: row.display_name,
  display_name: row.display_name,
  active: Boolean(row.active),
  createdAt: row.created_at,
  created_at: row.created_at,
});

// ── Areas ────────────────────────────────────────────────────────────────

const getAdminAreas = async (req, res) => {
  const areas = await listAreasFromScope();
  res.status(200).json({ data: areas.map(shapeArea) });
};

const createArea = async (req, res) => {
  const [flagRows] = await pool.query('SELECT areas_sweep_complete FROM platform_flags WHERE id = 1');
  const sweepComplete = Boolean(flagRows[0]?.areas_sweep_complete);
  // §6.6 — the single most important rule in this spec. Only TASK 30 flips
  // this, after its cross-area isolation E2E passes. Never bypass it here.
  if (!sweepComplete) {
    return res.status(409).json({
      code: 'AREAS_SWEEP_INCOMPLETE',
      message: 'Cannot create a new area until the multi-area isolation sweep is complete.',
    });
  }

  const { code, name, timezone, brandColor, brand_color: brandColorSnake, features } = req.body || {};
  const finalCode = typeof code === 'string' ? code.trim().toUpperCase() : '';
  const finalName = typeof name === 'string' ? name.trim() : '';
  if (!finalCode || !finalName) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'code and name are required' });
  }

  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    const [existing] = await connection.query('SELECT id FROM areas WHERE code = ?', [finalCode]);
    if (existing.length > 0) {
      await connection.rollback();
      connection.release();
      return res.status(409).json({ code: 'CONFLICT', message: `Area code "${finalCode}" is already in use` });
    }

    const [result] = await connection.query(
      `INSERT INTO areas (code, name, timezone, brand_color, features, active, is_default)
       VALUES (?, ?, ?, ?, ?, 1, 0)`,
      [
        finalCode,
        finalName,
        timezone || 'Asia/Kolkata',
        brandColor || brandColorSnake || null,
        features ? JSON.stringify(features) : null,
      ]
    );
    const areaId = result.insertId;

    // Every area needs exactly one settings row, and the two is_system store
    // modes — in the same transaction as the area itself (24.1), so a new
    // area is never left half-created if either write fails.
    const { createSettingsForArea } = require('./settingsController');
    await createSettingsForArea(areaId, connection);
    await seedSystemStoreModes(areaId, connection);

    await connection.commit();
    connection.release();
    invalidateAreasCache();

    const area = await getAreaById(areaId);
    res.status(201).json({ message: 'Area created', data: shapeArea(area) });
  } catch (error) {
    await connection.rollback();
    connection.release();
    throw error;
  }
};

const updateArea = async (req, res) => {
  const areaId = Number(req.params.id);
  if (!Number.isFinite(areaId) || areaId <= 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid area id' });
  }
  const existing = await getAreaById(areaId);
  if (!existing) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Area not found' });
  }

  const { name, active, timezone, brandColor, brand_color: brandColorSnake, logoImageId, logo_image_id: logoImageIdSnake, features } = req.body || {};
  const sets = [];
  const values = [];
  if (name !== undefined) { sets.push('name = ?'); values.push(String(name).trim()); }
  if (active !== undefined) { sets.push('active = ?'); values.push(active ? 1 : 0); }
  if (timezone !== undefined) { sets.push('timezone = ?'); values.push(timezone); }
  const finalBrandColor = brandColor !== undefined ? brandColor : brandColorSnake;
  if (finalBrandColor !== undefined) { sets.push('brand_color = ?'); values.push(finalBrandColor); }
  const finalLogoImageId = logoImageId !== undefined ? logoImageId : logoImageIdSnake;
  if (finalLogoImageId !== undefined) { sets.push('logo_image_id = ?'); values.push(finalLogoImageId); }
  if (features !== undefined) { sets.push('features = ?'); values.push(features ? JSON.stringify(features) : null); }

  if (sets.length === 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'No fields to update' });
  }

  values.push(areaId);
  await pool.query(`UPDATE areas SET ${sets.join(', ')} WHERE id = ?`, values);
  invalidateAreasCache();

  const updated = await getAreaById(areaId);
  res.status(200).json({ message: 'Area updated', data: shapeArea(updated) });
};

// §6.8 — area delete is never supported, deactivate only. A real DELETE
// route exists purely so this is discoverable/explicit instead of a 404.
const deleteArea = async (_req, res) => {
  res.status(405).json({
    code: 'NOT_SUPPORTED',
    message: 'Area deletion is not supported. PATCH the area with { active: false } to deactivate it instead.',
  });
};

// ── Clone area ───────────────────────────────────────────────────────────

// §2.8/§6.8 — copies categories, store modes, dashboard sections, offers and
// library-linked products as independent rows with no ongoing link to the
// source. Never orders, customers, riders, shops or coupons (24.6). Refuses
// to run against a target that already has categories or products (24.7),
// so a double click can't duplicate a catalog.
const cloneArea = async (req, res) => {
  const targetAreaId = Number(req.params.id);
  const sourceAreaId = Number(req.params.sourceId);
  if (!Number.isFinite(targetAreaId) || !Number.isFinite(sourceAreaId)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid area id' });
  }
  if (targetAreaId === sourceAreaId) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Source and target area must differ' });
  }

  const [targetArea, sourceArea] = await Promise.all([getAreaById(targetAreaId), getAreaById(sourceAreaId)]);
  if (!targetArea) return res.status(404).json({ code: 'NOT_FOUND', message: 'Target area not found' });
  if (!sourceArea) return res.status(404).json({ code: 'NOT_FOUND', message: 'Source area not found' });

  const priceMultiplier = req.body?.priceMultiplier !== undefined
    ? Number(req.body.priceMultiplier)
    : (req.body?.price_multiplier !== undefined ? Number(req.body.price_multiplier) : 1);
  if (!Number.isFinite(priceMultiplier) || priceMultiplier <= 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'priceMultiplier must be a positive number' });
  }
  const applyMultiplier = (price) => Math.round(Number(price) * priceMultiplier * 100) / 100;

  const connection = await pool.getConnection();
  await connection.beginTransaction();
  try {
    const [[existingCategory]] = await connection.query('SELECT COUNT(*) AS cnt FROM categories WHERE area_id = ?', [targetAreaId]);
    const [[existingProduct]] = await connection.query('SELECT COUNT(*) AS cnt FROM products WHERE area_id = ?', [targetAreaId]);
    if (Number(existingCategory.cnt) > 0 || Number(existingProduct.cnt) > 0) {
      await connection.rollback();
      connection.release();
      return res.status(409).json({
        code: 'CONFLICT',
        message: 'Target area already has categories or products. Clone refuses to run against a non-empty catalog.',
      });
    }

    // ---- categories ------------------------------------------------
    const [sourceCategories] = await connection.query('SELECT * FROM categories WHERE area_id = ? AND deleted = 0', [sourceAreaId]);
    const categoryIdMap = new Map();
    for (const cat of sourceCategories) {
      const [insertResult] = await connection.query(
        `INSERT INTO categories (area_id, name, slug, type, image_id, active, display_order, library_category_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [targetAreaId, cat.name, cat.slug, cat.type, cat.image_id, cat.active, cat.display_order, cat.library_category_id]
      );
      categoryIdMap.set(cat.id, insertResult.insertId);
    }

    // ---- store modes -------------------------------------------------
    // is_system rows (packed/fast_food) already exist on the target from
    // its own creation (createArea) — INSERT IGNORE against
    // uniq_store_modes_area_slug no-ops on those and only adds custom ones.
    const [sourceStoreModes] = await connection.query('SELECT * FROM store_modes WHERE area_id = ?', [sourceAreaId]);
    for (const mode of sourceStoreModes) {
      await connection.query(
        `INSERT IGNORE INTO store_modes (area_id, slug, label, display_order, active, is_system, icon_image_id, is_default, library_store_mode_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [targetAreaId, mode.slug, mode.label, mode.display_order, mode.active, mode.is_system, mode.icon_image_id, false, mode.library_store_mode_id]
      );
    }

    // ---- library-linked products + variants ---------------------------
    // materializeToArea (src/utils/productLibrary.js) is the ONLY writer of
    // products.library_product_id (§4.5 — "one library→area materializer",
    // do not invent a second one) — reused here exactly as add-from-library
    // and bulk-add-to-areas already do, so identity fields (name,
    // description, image, unit, variant labels) come from the CURRENT
    // library row rather than a frozen snapshot of the source area's copy,
    // and the products.price <-> default-variant mirror invariant is
    // enforced in the one place that already owns it (syncProductVariants).
    // shop_id/group_id are never passed — cloned products start unassigned
    // (shops/groups are never cloned, §2.8).
    const [sourceProducts] = await connection.query(
      'SELECT * FROM products WHERE area_id = ? AND deleted = 0 AND library_product_id IS NOT NULL',
      [sourceAreaId]
    );
    const productIdMap = new Map();
    for (const prod of sourceProducts) {
      const newCategoryId = categoryIdMap.get(prod.category_id);
      if (!newCategoryId) continue; // category wasn't cloned (deleted at source) — skip, never dangling FK

      const [sourceVariants] = await connection.query(
        'SELECT * FROM product_variants WHERE product_id = ? AND deleted = 0', [prod.id]
      );
      const variantPrices = {};
      for (const variant of sourceVariants) {
        // materializeToArea only creates one variant row per CURRENT
        // library_variants row — a local-only variant with no
        // library_variant_id has nothing to key an override price by, so it
        // is not (and cannot be) carried over.
        if (variant.library_variant_id != null) {
          variantPrices[variant.library_variant_id] = applyMultiplier(variant.price);
        }
      }

      const { productId: newProductId } = await materializeToArea(connection, {
        libraryProductId: prod.library_product_id,
        areaId: targetAreaId,
        categoryId: newCategoryId,
        price: applyMultiplier(prod.price),
        shopPrice: prod.shop_price != null ? applyMultiplier(prod.shop_price) : null,
        available: Boolean(prod.available),
        displayOrder: prod.display_order,
        variantPrices,
      });

      // original_price/discount_label/featured are area-owned display
      // fields materializeToArea doesn't manage (it only sets identity +
      // the fields it's explicitly given) — a plain follow-up UPDATE keeps
      // materializeToArea the sole INSERT/variant-sync path while still
      // giving this a genuine flat copy of the source's promotional state.
      if (prod.original_price != null || prod.discount_label != null || prod.featured) {
        await connection.query(
          'UPDATE products SET original_price = ?, discount_label = ?, featured = ? WHERE id = ?',
          [
            prod.original_price != null ? applyMultiplier(prod.original_price) : null,
            prod.discount_label,
            Boolean(prod.featured),
            newProductId,
          ]
        );
      }

      productIdMap.set(prod.id, newProductId);
    }

    // ---- offers + offer_products ---------------------------------------
    const [sourceOffers] = await connection.query('SELECT * FROM offers WHERE area_id = ? AND deleted = 0', [sourceAreaId]);
    const offerIdMap = new Map();
    for (const offer of sourceOffers) {
      const [insertResult] = await connection.query(
        `INSERT INTO offers (area_id, title, description, image_id, active, store_type, is_clickable)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [targetAreaId, offer.title, offer.description, offer.image_id, offer.active, offer.store_type, offer.is_clickable]
      );
      offerIdMap.set(offer.id, insertResult.insertId);
    }
    for (const [oldOfferId, newOfferId] of offerIdMap) {
      const [offerProducts] = await connection.query('SELECT * FROM offer_products WHERE offer_id = ?', [oldOfferId]);
      for (const op of offerProducts) {
        const newProductId = productIdMap.get(op.product_id);
        if (!newProductId) continue; // source product wasn't library-linked — nothing to point at in the target
        await connection.query(
          `INSERT IGNORE INTO offer_products (offer_id, product_id, display_order, active)
           VALUES (?, ?, ?, ?)`,
          [newOfferId, newProductId, op.display_order, op.active]
        );
      }
    }

    // ---- dashboard sections + items -------------------------------------
    const [sourceSections] = await connection.query('SELECT * FROM dashboard_sections WHERE area_id = ? AND deleted_at IS NULL', [sourceAreaId]);
    const sectionIdMap = new Map();
    for (const section of sourceSections) {
      const newLinkedCategoryId = section.linked_category_id != null ? (categoryIdMap.get(section.linked_category_id) || null) : null;
      const newLinkedOfferId = section.linked_offer_id != null ? (offerIdMap.get(section.linked_offer_id) || null) : null;
      const [insertResult] = await connection.query(
        `INSERT INTO dashboard_sections (area_id, title, slug, section_type, store_type, active, display_order,
           max_visible_items, show_see_all, show_hot_badge, section_icon, linked_category_id, linked_offer_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          targetAreaId, section.title, section.slug, section.section_type, section.store_type, section.active,
          section.display_order, section.max_visible_items, section.show_see_all, section.show_hot_badge,
          section.section_icon, newLinkedCategoryId, newLinkedOfferId,
        ]
      );
      sectionIdMap.set(section.id, insertResult.insertId);
    }
    const idMapByItemType = { category: categoryIdMap, product: productIdMap, offer: offerIdMap };
    for (const [oldSectionId, newSectionId] of sectionIdMap) {
      const [items] = await connection.query('SELECT * FROM dashboard_section_items WHERE section_id = ? AND deleted_at IS NULL', [oldSectionId]);
      for (const item of items) {
        // combo items are never cloned (combos aren't in this task's copy
        // scope) — skip rather than point at a combo id that doesn't exist
        // in the target area.
        const map = idMapByItemType[item.item_type];
        const newItemId = map ? map.get(item.item_id) : null;
        if (!newItemId) continue;
        await connection.query(
          `INSERT IGNORE INTO dashboard_section_items (section_id, item_type, item_id, display_order, active)
           VALUES (?, ?, ?, ?, ?)`,
          [newSectionId, item.item_type, newItemId, item.display_order, item.active]
        );
      }
    }

    await connection.commit();
    connection.release();

    const { bustAreaCaches } = require('../utils/areaScope');
    await bustAreaCaches(targetAreaId);

    res.status(201).json({
      message: 'Area cloned',
      categoriesCloned: categoryIdMap.size,
      storeModesCloned: sourceStoreModes.length,
      productsCloned: productIdMap.size,
      offersCloned: offerIdMap.size,
      dashboardSectionsCloned: sectionIdMap.size,
    });
  } catch (error) {
    await connection.rollback();
    connection.release();
    throw error;
  }
};

// ── Admins ───────────────────────────────────────────────────────────────

const getAdminAdmins = async (req, res) => {
  const [rows] = await pool.query(
    `SELECT a.*, ar.code AS area_code FROM admins a LEFT JOIN areas ar ON ar.id = a.area_id ORDER BY a.id ASC`
  );
  res.status(200).json({ data: rows.map(shapeAdmin) });
};

// §2.9 — super_admin has area_id NULL; area_admin is bound to exactly one
// real, active area. Enforced here, the one place admins are created.
const validateRoleAreaInvariant = async (role, areaId) => {
  if (role === 'super_admin') {
    if (areaId !== undefined && areaId !== null) {
      return 'super_admin must not have an areaId';
    }
    return null;
  }
  if (role === 'area_admin') {
    if (!areaId) return 'area_admin requires an areaId';
    const area = await getAreaById(Number(areaId));
    if (!area) return 'areaId does not reference a real area';
    return null;
  }
  return 'role must be "super_admin" or "area_admin"';
};

const createAdmin = async (req, res) => {
  const { username, password, role, displayName, display_name: displayNameSnake } = req.body || {};
  const areaId = req.body?.areaId !== undefined ? req.body.areaId : req.body?.area_id;
  const finalUsername = typeof username === 'string' ? username.trim() : '';
  if (!finalUsername || !password || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'username and a password of at least 8 characters are required',
    });
  }

  const invariantError = await validateRoleAreaInvariant(role, areaId);
  if (invariantError) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: invariantError });
  }

  const [existing] = await pool.query('SELECT id FROM admins WHERE username = ?', [finalUsername]);
  if (existing.length > 0) {
    return res.status(409).json({ code: 'CONFLICT', message: `Username "${finalUsername}" is already in use` });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const finalAreaId = role === 'super_admin' ? null : Number(areaId);
  const [result] = await pool.query(
    `INSERT INTO admins (username, password_hash, role, area_id, display_name) VALUES (?, ?, ?, ?, ?)`,
    [finalUsername, passwordHash, role, finalAreaId, displayName || displayNameSnake || null]
  );

  const [rows] = await pool.query(
    `SELECT a.*, ar.code AS area_code FROM admins a LEFT JOIN areas ar ON ar.id = a.area_id WHERE a.id = ?`,
    [result.insertId]
  );
  res.status(201).json({ message: 'Admin created', data: shapeAdmin(rows[0]) });
};

const updateAdmin = async (req, res) => {
  const adminId = Number(req.params.id);
  if (!Number.isFinite(adminId) || adminId <= 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid admin id' });
  }
  const [existingRows] = await pool.query('SELECT * FROM admins WHERE id = ?', [adminId]);
  if (existingRows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Admin not found' });
  }
  const existing = existingRows[0];

  const { password, displayName, display_name: displayNameSnake, active, role } = req.body || {};
  const areaId = req.body?.areaId !== undefined ? req.body.areaId : req.body?.area_id;
  const finalRole = role !== undefined ? role : existing.role;
  const finalAreaId = areaId !== undefined ? areaId : existing.area_id;
  if (role !== undefined || areaId !== undefined) {
    const invariantError = await validateRoleAreaInvariant(finalRole, finalAreaId);
    if (invariantError) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: invariantError });
    }
  }

  const sets = [];
  const values = [];
  if (role !== undefined) { sets.push('role = ?'); values.push(role); }
  if (role !== undefined || areaId !== undefined) {
    sets.push('area_id = ?');
    values.push(finalRole === 'super_admin' ? null : Number(finalAreaId));
  }
  if (displayName !== undefined || displayNameSnake !== undefined) {
    sets.push('display_name = ?');
    values.push(displayName !== undefined ? displayName : displayNameSnake);
  }
  if (active !== undefined) { sets.push('active = ?'); values.push(active ? 1 : 0); }
  if (password !== undefined) {
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'password must be at least 8 characters' });
    }
    sets.push('password_hash = ?');
    values.push(await bcrypt.hash(password, 10));
  }

  if (sets.length === 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'No fields to update' });
  }

  values.push(adminId);
  await pool.query(`UPDATE admins SET ${sets.join(', ')} WHERE id = ?`, values);

  const [rows] = await pool.query(
    `SELECT a.*, ar.code AS area_code FROM admins a LEFT JOIN areas ar ON ar.id = a.area_id WHERE a.id = ?`,
    [adminId]
  );
  res.status(200).json({ message: 'Admin updated', data: shapeAdmin(rows[0]) });
};

module.exports = {
  getAdminAreas,
  createArea,
  updateArea,
  deleteArea,
  cloneArea,
  getAdminAdmins,
  createAdmin,
  updateAdmin,
  shapeArea,
  shapeAdmin,
};
