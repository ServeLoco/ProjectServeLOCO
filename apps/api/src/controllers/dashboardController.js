const { pool } = require('../db/mysql');
const { normalizeStoreType, getActiveStoreModeSlugs, isSystemModeSlug } = require('../utils/storeMode');
const config = require('../config/env');
const { attachVariants } = require('./productController');
const microCache = require('../utils/microCache');
const { requestAreaId, bustAreaCaches } = require('../utils/areaScope');
const DASHBOARD_TTL_MS = 30_000;

// Admin write/single-item endpoints reject null (super_admin, no
// X-Area-Id) and 'all' — dashboard management always targets exactly one
// area.
const requireOneArea = (req, res) => {
  const areaId = requestAreaId(req);
  if (areaId === null) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'X-Area-Id is required to manage the dashboard' });
    return null;
  }
  if (areaId === 'all') {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Dashboard sections cannot be managed for "all" areas at once — pick one area' });
    return null;
  }
  return areaId;
};

const SECTION_TYPES = ['offer_banner', 'category_grid', 'product_block', 'combo_block'];
const SECTION_ITEM_TYPES = {
  offer_banner: 'offer',
  category_grid: 'category',
  product_block: 'product',
  combo_block: 'combo',
};
// Slug suffix must be URL-hyphenated; mode slugs use underscores (e.g. fast_food).
const offerBannerSlugSuffix = (storeType) => storeType.replace(/_/g, '-');

const getExpectedStoreType = async (storeType, areaId) => {
  if (!storeType) return 'all';
  // A client can hold a stale/deactivated mode slug (e.g. web's
  // localStorage-persisted storeType) after an admin deactivates a custom
  // mode — fall back to 'all' instead of erroring the whole dashboard fetch.
  try {
    return await normalizeStoreType(storeType, { fallback: 'all', allowAll: true, areaId });
  } catch {
    return 'all';
  }
};

const getStoredImageUrl = (image) => image?.url ||
  image?.imageUrl ||
  image?.image_url ||
  (image?.filename ? `${config.PUBLIC_BASE_URL}${config.STATIC_UPLOAD_PATH}/${image.filename}` : null);

const isInvalidDateValue = (value) => value && Number.isNaN(new Date(value).getTime());

const validateVisibilityWindow = (startsAt, endsAt) => {
  if (isInvalidDateValue(startsAt) || isInvalidDateValue(endsAt)) {
    return 'Schedule dates must be valid date/time values';
  }
  if (startsAt && endsAt && new Date(endsAt) < new Date(startsAt)) {
    return 'End time must be after start time';
  }
  return null;
};

const asPositiveInteger = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
};

const asNonNegativeInteger = (value, fallback = 0) => {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
};

const validateSectionPayload = async ({ title, slug, section_type, store_type, display_order, max_visible_items, starts_at, ends_at }, { partial = false } = {}) => {
  if (!partial && (!slug || !section_type)) {
    return 'Slug and section type are required';
  }
  // Category grid cards carry their own name — the section title above the
  // grid is purely optional real estate, unlike other block types where it's
  // the only label the customer sees.
  if (!partial && !title && section_type !== 'category_grid') {
    return 'Title, slug, and section type are required';
  }
  if (section_type !== undefined && !SECTION_TYPES.includes(section_type)) {
    return 'Invalid dashboard section type';
  }
  if (store_type !== undefined && store_type !== 'all' && !isSystemModeSlug(store_type)) {
    const activeSlugs = await getActiveStoreModeSlugs();
    if (!activeSlugs.includes(store_type)) {
      return 'Invalid store visibility';
    }
  }
  if (slug !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(slug))) {
    return 'Slug must use lowercase letters, numbers, and hyphens only';
  }
  if (display_order !== undefined && asNonNegativeInteger(display_order) === null) {
    return 'Display order must be a whole number greater than or equal to 0';
  }
  if (max_visible_items !== undefined && asPositiveInteger(max_visible_items, 6) === null) {
    return 'Max visible items must be a positive whole number';
  }
  return validateVisibilityWindow(starts_at, ends_at);
};

const getLinkedItemInfo = async (itemType, itemId, areaId) => {
  if (itemType === 'product') {
    const [rows] = await pool.query(
      `SELECT p.id, p.is_combo, p.available, c.type as store_type
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.id = ? AND p.deleted = 0 AND p.area_id = ?`,
      [itemId, areaId]
    );
    if (rows.length === 0) return { error: 'Product does not exist' };
    if (rows[0].is_combo) return { error: 'Combos cannot be added to a standard product block.' };
    if (rows[0].available !== undefined && !rows[0].available) return { error: 'Only available products can be added to dashboard blocks.' };
    return { storeType: rows[0].store_type };
  }

  if (itemType === 'category') {
    const [rows] = await pool.query('SELECT id, type as store_type, active FROM categories WHERE id = ? AND deleted = 0 AND area_id = ?', [itemId, areaId]);
    if (rows.length === 0) return { error: 'Category does not exist' };
    if (rows[0].active !== undefined && !rows[0].active) return { error: 'Only active categories can be added to the dashboard.' };
    return { storeType: rows[0].store_type };
  }

  if (itemType === 'combo') {
    const [rows] = await pool.query(
      `SELECT p.id, p.available, p.store_type,
        (SELECT COUNT(*) FROM combo_items ci
         JOIN products child ON child.id = ci.product_id
         WHERE ci.combo_id = p.id AND child.deleted = 0 AND child.available = 1) as child_count
       FROM combos p
       WHERE p.id = ? AND p.deleted = 0 AND p.area_id = ?`,
      [itemId, areaId]
    );
    if (rows.length === 0) return { error: 'Combo product does not exist' };
    if (rows[0].available !== undefined && !rows[0].available) return { error: 'Only available combos can be added to dashboard blocks.' };
    if (Number(rows[0].child_count) === 0) return { error: 'Combo must include at least one available product.' };
    return { storeType: rows[0].store_type };
  }

  if (itemType === 'offer') {
    const [rows] = await pool.query('SELECT id, active, store_type FROM offers WHERE id = ? AND deleted = 0 AND area_id = ?', [itemId, areaId]);
    if (rows.length === 0) return { error: 'Offer does not exist' };
    if (rows[0].active !== undefined && !rows[0].active) return { error: 'Only active offers can be added to dashboard banners.' };
    return { storeType: rows[0].store_type };
  }

  return { error: 'Invalid item type' };
};

const ensureUniqueSectionSlug = async (baseSlug, storeType, sourceSectionId, areaId) => {
  let slug = baseSlug;
  let counter = 2;

  for (;;) {
    const [existing] = await pool.query(
      'SELECT id FROM dashboard_sections WHERE slug = ? AND store_type = ? AND deleted_at IS NULL AND id != ? AND area_id = ? LIMIT 1',
      [slug, storeType, sourceSectionId, areaId]
    );
    if (existing.length === 0) return slug;
    slug = `${baseSlug}-${counter}`;
    counter += 1;
  }
};

const ensureModeSpecificOfferBannerSections = async (areaId) => {
  const [sharedSections] = await pool.query(
    `SELECT *
     FROM dashboard_sections
     WHERE section_type = 'offer_banner'
       AND store_type = 'all'
       AND deleted_at IS NULL
       AND area_id = ?`,
    [areaId]
  );

  if (sharedSections.length === 0) return;

  const storeSpecificTypes = await getActiveStoreModeSlugs(areaId);

  for (const section of sharedSections) {
    const targetSectionIds = {};

    for (const storeType of storeSpecificTypes) {
      const baseSlug = `${section.slug}-${offerBannerSlugSuffix(storeType)}`;
      const [existingTargets] = await pool.query(
        `SELECT id
         FROM dashboard_sections
         WHERE section_type = 'offer_banner'
           AND store_type = ?
           AND deleted_at IS NULL
           AND slug = ?
           AND area_id = ?
         ORDER BY id ASC
         LIMIT 1`,
        [storeType, baseSlug, areaId]
      );

      if (existingTargets.length > 0) {
        targetSectionIds[storeType] = existingTargets[0].id;
        continue;
      }

      const slug = await ensureUniqueSectionSlug(baseSlug, storeType, section.id, areaId);
      const [insertResult] = await pool.query(
        `INSERT INTO dashboard_sections (
          area_id, title, slug, section_type, store_type, active, display_order,
          max_visible_items, show_see_all, show_hot_badge, section_icon, linked_category_id, linked_offer_id,
          starts_at, ends_at, version
        ) VALUES (?, ?, ?, 'offer_banner', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [
          areaId,
          section.title,
          slug,
          storeType,
          section.active,
          section.display_order,
          section.max_visible_items,
          section.show_see_all,
          section.show_hot_badge,
          section.section_icon,
          section.linked_category_id,
          section.linked_offer_id,
          section.starts_at,
          section.ends_at,
        ]
      );
      targetSectionIds[storeType] = insertResult.insertId;
    }

    const [items] = await pool.query(
      `SELECT dsi.*, o.store_type as offer_store_type
       FROM dashboard_section_items dsi
       JOIN offers o ON o.id = dsi.item_id
       WHERE dsi.section_id = ?
         AND dsi.item_type = 'offer'
         AND dsi.deleted_at IS NULL
         AND o.area_id = ?`,
      [section.id, areaId]
    );

    for (const item of items) {
      const targetSectionId = targetSectionIds[item.offer_store_type];
      if (!targetSectionId) continue;

      const [existingItem] = await pool.query(
        `SELECT id
         FROM dashboard_section_items
         WHERE section_id = ?
           AND item_type = 'offer'
           AND item_id = ?
           AND deleted_at IS NULL
         LIMIT 1`,
        [targetSectionId, item.item_id]
      );
      if (existingItem.length > 0) continue;

      await pool.query(
        `INSERT INTO dashboard_section_items (
          section_id, item_type, item_id, display_order, active, starts_at, ends_at
        ) VALUES (?, 'offer', ?, ?, ?, ?, ?)`,
        [
          targetSectionId,
          item.item_id,
          item.display_order,
          item.active,
          item.starts_at,
          item.ends_at,
        ]
      );
    }

    await pool.query(
      'UPDATE dashboard_sections SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL',
      [section.id]
    );
  }
};

// Helper to resolve image URLs from the MySQL images table
const resolveImageUrls = async (rows) => {
  const imageIds = rows
    .map(r => r.image_id)
    .filter(id => id && /^\d+$/.test(String(id)));

  if (imageIds.length === 0) return;

  const [images] = await pool.query('SELECT id, url, thumb_url, filename FROM images WHERE id IN (?)', [imageIds]);
  const imageMap = {};
  images.forEach(img => {
    imageMap[String(img.id)] = {
      url: getStoredImageUrl(img),
      thumb_url: img.thumb_url || null,
    };
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

// Helper to fetch combo child items
const getComboItemsByComboIds = async (comboIds = []) => {
  const ids = comboIds.filter(Boolean);
  if (ids.length === 0) return {};

  const [rows] = await pool.query(
    `SELECT
      ci.combo_id as combo_product_id,
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
    WHERE ci.combo_id IN (?) AND p.deleted = 0 AND p.available = 1
    ORDER BY ci.combo_id ASC, ci.display_order ASC, p.id ASC`,
    [ids]
  );

  await resolveImageUrls(rows);

  return rows.reduce((map, row) => {
    const comboId = row.combo_product_id;
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

// Helper to attach combo child items to parent products
const attachComboItems = async (products = []) => {
  const comboIds = products.filter(product => product.is_combo || product.isCombo).map(product => product.id);
  const comboItemsMap = await getComboItemsByComboIds(comboIds);

  products.forEach(product => {
    const comboItems = comboItemsMap[product.id] || [];
    product.combo_items = comboItems;
    product.comboItems = comboItems;
    product.combo_count = comboItems.length;
  });
};

const mapCategoryRows = (rows) => rows.map(r => ({
  id: r.id,
  sectionItemId: r.section_item_id,
  name: r.name,
  slug: r.slug,
  type: r.type,
  imageUrl: r.imageUrl || r.image_url,
  image_id: r.image_id,
  active: r.active,
  displayOrder: r.display_order
}));

const mapProductRows = (rows) => rows.map(r => ({
  id: r.id,
  sectionItemId: r.section_item_id,
  name: r.name,
  price: r.price,
  unit: r.unit,
  description: r.description,
  imageUrl: r.imageUrl || r.image_url,
  image_id: r.image_id,
  available: r.available,
  featured: r.featured,
  originalPrice: r.original_price,
  discountLabel: r.discount_label,
  categoryId: r.category_id,
  categoryName: r.category_name,
  categoryType: r.category_type,
  comboItems: r.combo_items || [],
  isCombo: r.is_combo || r.isCombo || false,
  variants: r.variants || [],
  hasVariants: r.hasVariants || r.has_variants || false,
  has_variants: r.hasVariants || r.has_variants || false,
  minPrice: r.minPrice ?? r.min_price ?? r.price,
  min_price: r.minPrice ?? r.min_price ?? r.price,
  variantPrompt: r.variantPrompt ?? r.variant_prompt ?? null,
  shopId: r.shop_id ?? null,
  shopIsOpen: r.shop_is_open === undefined ? 1 : r.shop_is_open,
  shop_is_open: r.shop_is_open === undefined ? 1 : r.shop_is_open,
}));

const mapOfferRows = (rows) => rows
  .filter(r => r.imageUrl || r.image_url)
  .map(r => ({
    id: r.id,
    sectionItemId: r.section_item_id,
    title: r.title,
    description: r.description,
    imageUrl: r.imageUrl || r.image_url,
    image_id: r.image_id,
    active: r.active,
    storeType: r.store_type,
    store_type: r.store_type,
    isClickable: Boolean(r.is_clickable),
    is_clickable: Boolean(r.is_clickable)
  }));


/**
 * Public endpoint: GET /api/dashboard
 * Loads active sections & their items based on storeType.
 */
const getDashboard = async (req, res) => {
  // Catalog data (§2.4): a pin outside every zone (null areaId) gets an
  // empty dashboard, same rule as getProducts/getCategories — never
  // another area's sections.
  const areaId = requestAreaId(req);
  if (areaId === null || areaId === 'all') {
    return res.status(200).json({ data: { sections: [] } });
  }

  // Dashboard category grid is derived from categories.
  const { storeType = 'packed' } = req.query;
  const includeClosedShops = ['1', 'true'].includes(
    String(req.query.includeClosedShops ?? req.query.include_closed_shops ?? '').toLowerCase()
  );
  const expectedStoreType = await getExpectedStoreType(storeType, areaId);
  const cacheKey = `dashboard:${areaId}:${expectedStoreType}:closed=${includeClosedShops ? 1 : 0}`;
  const cached = microCache.get(cacheKey);
  if (cached) {
    return res.status(200).json(cached);
  }

  const shopOpenWhere = includeClosedShops
    ? '(p.shop_id IS NULL OR EXISTS (SELECT 1 FROM shops s WHERE s.id = p.shop_id AND s.active = 1))'
    : '(p.shop_id IS NULL OR EXISTS (SELECT 1 FROM shops s WHERE s.id = p.shop_id AND s.is_open = 1 AND s.active = 1))';
  const shopIsOpenSelect = 'IF(p.shop_id IS NULL OR (sh.is_open = 1 AND sh.active = 1), 1, 0) AS shop_is_open';
  const shopJoin = 'LEFT JOIN shops sh ON sh.id = p.shop_id';
  // Same opt-in flag as shopOpenWhere: a product the shop owner toggled off
  // is still returned (with available: 0) so the client renders it as a
  // greyed-out "Temporarily Unavailable" card instead of it just vanishing.
  const availableWhere = includeClosedShops ? '1=1' : 'p.available = 1';

  try {
    let query = `
      SELECT id, title, slug, section_type, store_type, active, display_order, max_visible_items, show_see_all, show_hot_badge, section_icon, linked_category_id, linked_offer_id, starts_at, ends_at, version, created_at, updated_at
      FROM dashboard_sections
      WHERE active = 1 AND deleted_at IS NULL AND area_id = ?
        AND (starts_at IS NULL OR starts_at <= NOW())
        AND (ends_at IS NULL OR ends_at >= NOW())
    `;
    const params = [areaId];

    if (expectedStoreType && expectedStoreType !== 'all') {
      query += ' AND store_type = ?';
      params.push(expectedStoreType);
    }

    query += ' ORDER BY display_order ASC, id ASC';

    const [sections] = await pool.query(query, params);

    // Build each section's items in parallel (Promise.all preserves input order).
    const buildSection = async (section) => {
      let items = [];

      if (section.section_type === 'offer_banner') {
        const offerStoreFilter = (expectedStoreType && expectedStoreType !== 'all') ? 'AND o.store_type = ?' : '';
        const itemParams = (expectedStoreType && expectedStoreType !== 'all') ? [section.id, areaId, expectedStoreType] : [section.id, areaId];
        const [rows] = await pool.query(
          `SELECT dsi.id as section_item_id, dsi.display_order, o.*
           FROM dashboard_section_items dsi
           JOIN offers o ON o.id = dsi.item_id
           WHERE dsi.section_id = ? AND dsi.item_type = 'offer' AND dsi.active = 1 AND dsi.deleted_at IS NULL
             AND o.active = 1 AND o.deleted = 0 AND o.area_id = ?
             ${offerStoreFilter}
             AND (dsi.starts_at IS NULL OR dsi.starts_at <= NOW())
             AND (dsi.ends_at IS NULL OR dsi.ends_at >= NOW())
           ORDER BY dsi.display_order ASC, dsi.id ASC`,
          itemParams
        );
        await resolveImageUrls(rows);
        items = mapOfferRows(rows);
      } else if (section.section_type === 'category_grid') {
        const [rows] = await pool.query(
          `SELECT dsi.id as section_item_id, dsi.display_order, c.*
           FROM dashboard_section_items dsi
           JOIN categories c ON c.id = dsi.item_id
           WHERE dsi.section_id = ? AND dsi.item_type = 'category' AND dsi.active = 1 AND dsi.deleted_at IS NULL
             AND c.active = 1 AND c.deleted = 0 AND c.area_id = ?
             AND (dsi.starts_at IS NULL OR dsi.starts_at <= NOW())
             AND (dsi.ends_at IS NULL OR dsi.ends_at >= NOW())
           ORDER BY dsi.display_order ASC, dsi.id ASC
           LIMIT ?`,
          [section.id, areaId, section.max_visible_items || 8]
        );
        await resolveImageUrls(rows);

        let filteredRows = rows;
        if (expectedStoreType && expectedStoreType !== 'all') {
          filteredRows = rows.filter(r => r.type === expectedStoreType);
        }

        items = mapCategoryRows(filteredRows);
      } else if (section.section_type === 'product_block') {
        const [rows] = await pool.query(
          `SELECT dsi.id as section_item_id, dsi.display_order, p.*, cat.name as category_name, cat.type as category_type, ${shopIsOpenSelect}
           FROM dashboard_section_items dsi
           JOIN products p ON p.id = dsi.item_id
           LEFT JOIN categories cat ON p.category_id = cat.id
           ${shopJoin}
           WHERE dsi.section_id = ? AND dsi.item_type = 'product' AND dsi.active = 1 AND dsi.deleted_at IS NULL
             AND ${availableWhere} AND p.deleted = 0 AND p.is_combo = 0 AND p.area_id = ? AND ${shopOpenWhere} AND (p.group_id IS NULL OR EXISTS (SELECT 1 FROM product_groups g WHERE g.id = p.group_id AND g.active = 1 AND g.area_id = p.area_id))
             AND (dsi.starts_at IS NULL OR dsi.starts_at <= NOW())
             AND (dsi.ends_at IS NULL OR dsi.ends_at >= NOW())
           ORDER BY dsi.display_order ASC, dsi.id ASC`,
          [section.id, areaId]
        );
        await resolveImageUrls(rows);
        await attachComboItems(rows);
        await attachVariants(rows);

        let filteredRows = rows;
        if (expectedStoreType && expectedStoreType !== 'all') {
          filteredRows = rows.filter(r => r.category_type === expectedStoreType);
        }

        items = mapProductRows(filteredRows);
      } else if (section.section_type === 'combo_block') {
        const comboStoreFilter = (expectedStoreType && expectedStoreType !== 'all') ? 'AND p.store_type = ?' : '';
        const itemParams = (expectedStoreType && expectedStoreType !== 'all') ? [section.id, areaId, expectedStoreType] : [section.id, areaId];
        const [rows] = await pool.query(
          `SELECT dsi.id as section_item_id, dsi.display_order, p.*, 1 as is_combo, p.store_type as category_type
           FROM dashboard_section_items dsi
           JOIN combos p ON p.id = dsi.item_id
           WHERE dsi.section_id = ? AND dsi.item_type = 'combo' AND dsi.active = 1 AND dsi.deleted_at IS NULL
             AND p.available = 1 AND p.deleted = 0 AND p.area_id = ?
             ${comboStoreFilter}
             AND (dsi.starts_at IS NULL OR dsi.starts_at <= NOW())
             AND (dsi.ends_at IS NULL OR dsi.ends_at >= NOW())
           ORDER BY dsi.display_order ASC, dsi.id ASC`,
          itemParams
        );
        await resolveImageUrls(rows);
        await attachComboItems(rows);

        let filteredRows = rows;
        items = mapProductRows(filteredRows);
      }

      const maxVisible = section.section_type === 'offer_banner'
        ? Math.max(Number(section.max_visible_items || 0), items.length)
        : section.max_visible_items || 6;
      const visibleItems = items.slice(0, maxVisible);
      const totalItems = items.length;

      // Hide empty sections by default
      if (visibleItems.length === 0) return null;

      return {
        id: section.id,
        title: section.title,
        slug: section.slug,
        sectionType: section.section_type,
        storeType: section.store_type,
        displayOrder: section.display_order,
        maxVisibleItems: section.max_visible_items,
        showSeeAll: section.show_see_all === 1 || section.show_see_all === true,
        showHotBadge: section.show_hot_badge === 1 || section.show_hot_badge === true,
        sectionIcon: section.section_icon || null,
        totalItems,
        hasMore: totalItems > visibleItems.length,
        items: visibleItems
      };
    };

    const built = await Promise.all(sections.map(buildSection));
    const resultSections = built.filter(Boolean);
    // Stable display order (also matches original sections order from SQL).
    resultSections.sort((a, b) => Number(a.displayOrder || 0) - Number(b.displayOrder || 0));

    const body = {
      data: {
        sections: resultSections
      }
    };
    microCache.set(cacheKey, body, DASHBOARD_TTL_MS);
    res.status(200).json(body);
  } catch (error) {
    res.status(500).json({ code: 'SERVER_ERROR', message: error.message });
  }
};

/**
 * Public endpoint: GET /api/dashboard/sections/:slug/items
 * Loads full items list for a specific section (useful for See All flow).
 */
const getSectionItems = async (req, res) => {
  // Same §2.4 catalog rule as getDashboard — null areaId means no service.
  const areaId = requestAreaId(req);
  if (areaId === null || areaId === 'all') {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard section not found' });
  }

  const { slug } = req.params;
  const { storeType = 'packed', page = 1, limit = 50 } = req.query;
  const includeClosedShops = ['1', 'true'].includes(
    String(req.query.includeClosedShops ?? req.query.include_closed_shops ?? '').toLowerCase()
  );
  const expectedStoreType = await getExpectedStoreType(storeType, areaId);

  const shopOpenWhere = includeClosedShops
    ? '(p.shop_id IS NULL OR EXISTS (SELECT 1 FROM shops s WHERE s.id = p.shop_id AND s.active = 1))'
    : '(p.shop_id IS NULL OR EXISTS (SELECT 1 FROM shops s WHERE s.id = p.shop_id AND s.is_open = 1 AND s.active = 1))';
  const shopIsOpenSelect = 'IF(p.shop_id IS NULL OR (sh.is_open = 1 AND sh.active = 1), 1, 0) AS shop_is_open';
  const shopJoin = 'LEFT JOIN shops sh ON sh.id = p.shop_id';
  // Same opt-in flag as shopOpenWhere — see getDashboard for the rationale.
  const availableWhere = includeClosedShops ? '1=1' : 'p.available = 1';
  const pageNumber = Math.max(1, Number(page) || 1);
  const limitNumber = Math.min(100, Math.max(1, Number(limit) || 50));
  const offset = (pageNumber - 1) * limitNumber;

  try {
    let sectionQuery = `
      SELECT id, title, slug, section_type, store_type, active, display_order, max_visible_items, show_see_all, show_hot_badge, section_icon, linked_category_id, linked_offer_id, starts_at, ends_at, version, created_at, updated_at
      FROM dashboard_sections
      WHERE slug = ? AND active = 1 AND deleted_at IS NULL AND area_id = ?
        AND (starts_at IS NULL OR starts_at <= NOW())
        AND (ends_at IS NULL OR ends_at >= NOW())
    `;
    const sectionParams = [slug, areaId];
    if (expectedStoreType && expectedStoreType !== 'all') {
      sectionQuery += ' AND store_type = ?';
      sectionParams.push(expectedStoreType);
    }
    sectionQuery += ' ORDER BY id DESC LIMIT 1';

    const [sections] = await pool.query(sectionQuery, sectionParams);

    if (sections.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Dashboard section not found' });
    }

    const section = sections[0];
    let items = [];

    if (section.section_type === 'offer_banner') {
      const offerStoreFilter = (expectedStoreType && expectedStoreType !== 'all') ? 'AND o.store_type = ?' : '';
      const params = (expectedStoreType && expectedStoreType !== 'all') ? [section.id, areaId, expectedStoreType, limitNumber, offset] : [section.id, areaId, limitNumber, offset];
      const [rows] = await pool.query(
        `SELECT dsi.id as section_item_id, dsi.display_order, o.*
         FROM dashboard_section_items dsi
         JOIN offers o ON o.id = dsi.item_id
         WHERE dsi.section_id = ? AND dsi.item_type = 'offer' AND dsi.active = 1 AND dsi.deleted_at IS NULL
           AND o.active = 1 AND o.deleted = 0 AND o.area_id = ?
           ${offerStoreFilter}
           AND (dsi.starts_at IS NULL OR dsi.starts_at <= NOW())
           AND (dsi.ends_at IS NULL OR dsi.ends_at >= NOW())
         ORDER BY dsi.display_order ASC, dsi.id ASC
         LIMIT ? OFFSET ?`,
        params
      );
      await resolveImageUrls(rows);
      items = mapOfferRows(rows);
    } else if (section.section_type === 'category_grid') {
      const [rows] = await pool.query(
        `SELECT dsi.id as section_item_id, dsi.display_order, c.*
         FROM dashboard_section_items dsi
         JOIN categories c ON c.id = dsi.item_id
         WHERE dsi.section_id = ? AND dsi.item_type = 'category' AND dsi.active = 1 AND dsi.deleted_at IS NULL
           AND c.active = 1 AND c.deleted = 0 AND c.area_id = ?
           AND (dsi.starts_at IS NULL OR dsi.starts_at <= NOW())
           AND (dsi.ends_at IS NULL OR dsi.ends_at >= NOW())
         ORDER BY dsi.display_order ASC, dsi.id ASC
         LIMIT ? OFFSET ?`,
        [section.id, areaId, limitNumber, offset]
      );
      await resolveImageUrls(rows);

      let filteredRows = rows;
      if (expectedStoreType && expectedStoreType !== 'all') {
        filteredRows = rows.filter(r => r.type === expectedStoreType);
      }

      items = mapCategoryRows(filteredRows);
    } else if (section.section_type === 'product_block') {
      const productStoreFilter = (expectedStoreType && expectedStoreType !== 'all') ? 'AND cat.type = ?' : '';
      const params = (expectedStoreType && expectedStoreType !== 'all') ? [section.id, areaId, expectedStoreType, limitNumber, offset] : [section.id, areaId, limitNumber, offset];
      const [rows] = await pool.query(
        `SELECT dsi.id as section_item_id, dsi.display_order, p.*, cat.name as category_name, cat.type as category_type, ${shopIsOpenSelect}
         FROM dashboard_section_items dsi
         JOIN products p ON p.id = dsi.item_id
         LEFT JOIN categories cat ON p.category_id = cat.id
         ${shopJoin}
         WHERE dsi.section_id = ? AND dsi.item_type = 'product' AND dsi.active = 1 AND dsi.deleted_at IS NULL
           AND ${availableWhere} AND p.deleted = 0 AND p.is_combo = 0 AND p.area_id = ? AND ${shopOpenWhere} AND (p.group_id IS NULL OR EXISTS (SELECT 1 FROM product_groups g WHERE g.id = p.group_id AND g.active = 1 AND g.area_id = p.area_id))
           ${productStoreFilter}
           AND (dsi.starts_at IS NULL OR dsi.starts_at <= NOW())
           AND (dsi.ends_at IS NULL OR dsi.ends_at >= NOW())
         ORDER BY dsi.display_order ASC, dsi.id ASC
         LIMIT ? OFFSET ?`,
        params
      );
      await resolveImageUrls(rows);
      await attachComboItems(rows);
      await attachVariants(rows);

      items = rows.map(r => ({
        id: r.id,
        sectionItemId: r.section_item_id,
        name: r.name,
        price: r.price,
        unit: r.unit,
        description: r.description,
        imageUrl: r.imageUrl || r.image_url,
        image_id: r.image_id,
        available: r.available,
        isCombo: r.is_combo,
        featured: r.featured,
        originalPrice: r.original_price,
        discountLabel: r.discount_label,
        categoryId: r.category_id,
        categoryName: r.category_name,
        categoryType: r.category_type,
        comboItems: r.combo_items || [],
        variants: r.variants || [],
        hasVariants: r.hasVariants || r.has_variants || false,
        has_variants: r.hasVariants || r.has_variants || false,
        minPrice: r.minPrice ?? r.min_price ?? r.price,
        min_price: r.minPrice ?? r.min_price ?? r.price,
        variantPrompt: r.variantPrompt ?? r.variant_prompt ?? null,
        shopId: r.shop_id ?? null,
        shopIsOpen: r.shop_is_open === undefined ? 1 : r.shop_is_open,
        shop_is_open: r.shop_is_open === undefined ? 1 : r.shop_is_open,
      }));
    } else if (section.section_type === 'combo_block') {
      const comboStoreFilter = (expectedStoreType && expectedStoreType !== 'all') ? 'AND p.store_type = ?' : '';
      const params = (expectedStoreType && expectedStoreType !== 'all') ? [section.id, areaId, expectedStoreType, limitNumber, offset] : [section.id, areaId, limitNumber, offset];
      const [rows] = await pool.query(
        `SELECT dsi.id as section_item_id, dsi.display_order, p.*, 1 as is_combo, p.store_type as category_type
         FROM dashboard_section_items dsi
         JOIN combos p ON p.id = dsi.item_id
         WHERE dsi.section_id = ? AND dsi.item_type = 'combo' AND dsi.active = 1 AND dsi.deleted_at IS NULL
           AND p.available = 1 AND p.deleted = 0 AND p.area_id = ?
           ${comboStoreFilter}
           AND (dsi.starts_at IS NULL OR dsi.starts_at <= NOW())
           AND (dsi.ends_at IS NULL OR dsi.ends_at >= NOW())
         ORDER BY dsi.display_order ASC, dsi.id ASC
         LIMIT ? OFFSET ?`,
        params
      );
      await resolveImageUrls(rows);
      await attachComboItems(rows);

      const filteredRows = rows.filter(r => (r.combo_items || []).length > 0);

      items = filteredRows.map(r => ({
        id: r.id,
        sectionItemId: r.section_item_id,
        name: r.name,
        price: r.price,
        unit: r.unit,
        description: r.description,
        imageUrl: r.imageUrl || r.image_url,
        image_id: r.image_id,
        available: r.available,
        isCombo: r.is_combo,
        featured: r.featured,
        originalPrice: r.original_price,
        discountLabel: r.discount_label,
        categoryId: r.category_id,
        categoryName: r.category_name,
        categoryType: r.category_type,
        comboItems: r.combo_items || []
      }));
    }

    res.status(200).json({
      data: {
        section: {
          id: section.id,
          title: section.title,
          slug: section.slug,
          sectionType: section.section_type,
          storeType: section.store_type,
          showHotBadge: section.show_hot_badge === 1 || section.show_hot_badge === true,
          sectionIcon: section.section_icon || null
        },
        items
      }
    });
  } catch (error) {
    res.status(500).json({ code: 'SERVER_ERROR', message: error.message });
  }
};

/**
 * Admin: GET /api/admin/dashboard-sections
 */
const getAdminSections = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const { store_type } = req.query;
  try {
    if (store_type && store_type !== 'all') {
      await ensureModeSpecificOfferBannerSections(areaId);
    }

    let query = 'SELECT id, title, slug, section_type, store_type, active, display_order, max_visible_items, show_see_all, show_hot_badge, section_icon, linked_category_id, linked_offer_id, starts_at, ends_at, version, created_at, updated_at FROM dashboard_sections WHERE deleted_at IS NULL AND area_id = ?';
    const params = [areaId];
    if (store_type) {
      query += ' AND (store_type = ? OR (store_type = "all" AND section_type != "offer_banner"))';
      params.push(store_type);
    }
    query += ' ORDER BY display_order ASC, id ASC';
    const [rows] = await pool.query(query, params);
    res.status(200).json({ data: rows });
  } catch (error) {
    res.status(500).json({ code: 'SERVER_ERROR', message: error.message });
  }
};

// Attaches the product/category/combo/offer row an item points to. Shared by
// getAdminSectionById (hydrates a whole section's items in parallel) and
// addAdminSectionItem (hydrates just the one item it created), so adding an
// item doesn't have to pay for a full section refetch to show it.
const hydrateSectionItem = async (item, areaId) => {
  let details = null;
  if (item.item_type === 'product') {
    const [prods] = await pool.query(
      'SELECT p.*, s.name AS shop_name FROM products p LEFT JOIN shops s ON s.id = p.shop_id WHERE p.id = ? AND p.area_id = ?',
      [item.item_id, areaId]
    );
    if (prods.length > 0) {
      details = prods[0];
      await resolveImageUrls([details]);
    }
  } else if (item.item_type === 'category') {
    const [cats] = await pool.query('SELECT * FROM categories WHERE id = ? AND area_id = ?', [item.item_id, areaId]);
    if (cats.length > 0) {
      details = cats[0];
      await resolveImageUrls([details]);
    }
  } else if (item.item_type === 'combo') {
    const [combos] = await pool.query('SELECT *, 1 as is_combo FROM combos WHERE id = ? AND area_id = ?', [item.item_id, areaId]);
    if (combos.length > 0) {
      details = combos[0];
      await resolveImageUrls([details]);
      await attachComboItems([details]);
    }
  } else if (item.item_type === 'offer') {
    const [offers] = await pool.query('SELECT * FROM offers WHERE id = ? AND area_id = ?', [item.item_id, areaId]);
    if (offers.length > 0) {
      details = offers[0];
      await resolveImageUrls([details]);
    }
  }
  return { ...item, details };
};

/**
 * Admin: GET /api/admin/dashboard-sections/:id
 */
const getAdminSectionById = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const { id } = req.params;
  try {
    // area_id in the WHERE, not just id: without this, an area_admin could
    // read another area's section by guessing its (globally sequential)
    // numeric id.
    const [sections] = await pool.query(
      'SELECT id, title, slug, section_type, store_type, active, display_order, max_visible_items, show_see_all, show_hot_badge, section_icon, linked_category_id, linked_offer_id, starts_at, ends_at, version, created_at, updated_at FROM dashboard_sections WHERE id = ? AND deleted_at IS NULL AND area_id = ?',
      [id, areaId]
    );
    if (sections.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Section not found' });
    }
    const section = sections[0];

    const [items] = await pool.query(
      'SELECT id, section_id, item_type, item_id, display_order, active, starts_at, ends_at, created_at, updated_at FROM dashboard_section_items WHERE section_id = ? AND deleted_at IS NULL ORDER BY display_order ASC, id ASC',
      [id]
    );

    // Hydrate every item's details in parallel instead of one DB round-trip
    // per item in sequence — a section with 10+ items was previously paying
    // 10+ awaited queries back-to-back, which is what made opening a section
    // feel like a multi-second freeze, worse still on a production DB where
    // each round-trip carries real network latency instead of localhost's ~0.
    const hydratedItems = await Promise.all(items.map((item) => hydrateSectionItem(item, areaId)));

    res.status(200).json({ data: { ...section, items: hydratedItems } });
  } catch (error) {
    res.status(500).json({ code: 'SERVER_ERROR', message: error.message });
  }
};

/**
 * Admin: POST /api/admin/dashboard-sections
 */
const createAdminSection = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const { title, slug, section_type, store_type, active, display_order, max_visible_items, show_see_all, show_hot_badge, section_icon, linked_category_id, linked_offer_id, starts_at, ends_at } = req.body;

  if (store_type === 'all' || !store_type) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Store type must be an explicit store mode slug for new sections. "all" is not allowed.' });
  }

  const validationError = await validateSectionPayload(req.body);
  if (validationError) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: validationError });
  }
  const maxVisibleItems = asPositiveInteger(max_visible_items, 6);

  try {
    const targetStoreType = store_type || 'all';
    const [existing] = await pool.query(
      'SELECT id FROM dashboard_sections WHERE slug = ? AND store_type = ? AND deleted_at IS NULL AND area_id = ? LIMIT 1',
      [slug, targetStoreType, areaId]
    );
    if (existing.length > 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Section slug "${slug}" already exists for this store mode.` });
    }

    const finalDisplayOrder = asNonNegativeInteger(display_order, 0);
    if (finalDisplayOrder > 0) {
      const [orderExisting] = await pool.query(
        'SELECT title FROM dashboard_sections WHERE store_type = ? AND display_order = ? AND deleted_at IS NULL AND area_id = ? LIMIT 1',
        [store_type, finalDisplayOrder, areaId]
      );
      if (orderExisting.length > 0) {
        return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Display order ${finalDisplayOrder} is already used by "${orderExisting[0].title}".` });
      }
    }

    const [result] = await pool.query(
      `INSERT INTO dashboard_sections (
        area_id, title, slug, section_type, store_type, active, display_order,
        max_visible_items, show_see_all, show_hot_badge, section_icon,
        linked_category_id, linked_offer_id, starts_at, ends_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        areaId, title, slug, section_type, store_type,
        active !== undefined ? active : 1,
        finalDisplayOrder,
        maxVisibleItems,
        show_see_all !== undefined ? show_see_all : 1,
        show_hot_badge !== undefined ? (show_hot_badge ? 1 : 0) : 0,
        section_icon || null,
        linked_category_id || null,
        linked_offer_id || null,
        starts_at || null,
        ends_at || null
      ]
    );

    await bustAreaCaches(areaId);
    res.status(201).json({ message: 'Dashboard section created', id: result.insertId });
  } catch (error) {
    res.status(500).json({ code: 'SERVER_ERROR', message: error.message });
  }
};

/**
 * Admin: PATCH /api/admin/dashboard-sections/:id
 */
const updateAdminSection = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const { id } = req.params;
  const { title, slug, store_type, active, display_order, max_visible_items, show_see_all, show_hot_badge, section_icon, linked_category_id, linked_offer_id, starts_at, ends_at, version } = req.body;

  if (store_type === 'all') {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Store type must be an explicit store mode slug. "all" is no longer allowed.' });
  }

  const validationError = await validateSectionPayload(req.body, { partial: true });
  if (validationError) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: validationError });
  }

  try {
    // area_id in the WHERE, not just id: without this, an area_admin could
    // PATCH another area's section by guessing its numeric id.
    const [sections] = await pool.query(
      'SELECT * FROM dashboard_sections WHERE id = ? AND deleted_at IS NULL AND area_id = ?',
      [id, areaId]
    );
    if (sections.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Section not found' });
    }

    const existingSection = sections[0];
    if (version !== undefined && Number(version) !== existingSection.version) {
      return res.status(409).json({
        code: 'CONCURRENCY_CONFLICT',
        message: 'This section was updated by another administrator. Please reload and try again.'
      });
    }

    const targetStoreType = store_type !== undefined ? store_type : existingSection.store_type;
    if (slug && (slug !== existingSection.slug || targetStoreType !== existingSection.store_type)) {
      const [existingSlug] = await pool.query(
        'SELECT id FROM dashboard_sections WHERE slug = ? AND store_type = ? AND deleted_at IS NULL AND id != ? AND area_id = ? LIMIT 1',
        [slug, targetStoreType, id, areaId]
      );
      if (existingSlug.length > 0) {
        return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Section slug "${slug}" already exists for this store mode.` });
      }
    }

    const finalDisplayOrder = asNonNegativeInteger(display_order, 0);
    if (finalDisplayOrder > 0) {
      const targetStoreType = store_type !== undefined ? store_type : existingSection.store_type;
      const [orderExisting] = await pool.query(
        'SELECT title FROM dashboard_sections WHERE store_type = ? AND display_order = ? AND id != ? AND deleted_at IS NULL AND area_id = ? LIMIT 1',
        [targetStoreType, finalDisplayOrder, id, areaId]
      );
      if (orderExisting.length > 0) {
        return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Display order ${finalDisplayOrder} is already used by "${orderExisting[0].title}".` });
      }
    }

    const nextVersion = existingSection.version + 1;

    await pool.query(
      `UPDATE dashboard_sections SET
        title = ?, slug = ?, store_type = ?, active = ?, display_order = ?,
        max_visible_items = ?, show_see_all = ?, show_hot_badge = ?, section_icon = ?,
        linked_category_id = ?, linked_offer_id = ?,
        starts_at = ?, ends_at = ?, version = ?
       WHERE id = ? AND area_id = ?`,
      [
        title !== undefined ? title : existingSection.title,
        slug !== undefined ? slug : existingSection.slug,
        store_type !== undefined ? store_type : existingSection.store_type,
        active !== undefined ? active : existingSection.active,
        display_order !== undefined ? finalDisplayOrder : existingSection.display_order,
        max_visible_items !== undefined ? asPositiveInteger(max_visible_items, existingSection.max_visible_items) : existingSection.max_visible_items,
        show_see_all !== undefined ? show_see_all : existingSection.show_see_all,
        show_hot_badge !== undefined ? (show_hot_badge ? 1 : 0) : existingSection.show_hot_badge,
        section_icon !== undefined ? section_icon : existingSection.section_icon,
        linked_category_id !== undefined ? linked_category_id : existingSection.linked_category_id,
        linked_offer_id !== undefined ? linked_offer_id : existingSection.linked_offer_id,
        starts_at !== undefined ? starts_at : existingSection.starts_at,
        ends_at !== undefined ? ends_at : existingSection.ends_at,
        nextVersion,
        id, areaId
      ]
    );

    await bustAreaCaches(areaId);
    res.status(200).json({ message: 'Dashboard section updated', version: nextVersion });
  } catch (error) {
    res.status(500).json({ code: 'SERVER_ERROR', message: error.message });
  }
};

/**
 * Admin: DELETE /api/admin/dashboard-sections/:id
 */
const deleteAdminSection = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const { id } = req.params;
  try {
    const [existing] = await pool.query(
      'SELECT id FROM dashboard_sections WHERE id = ? AND deleted_at IS NULL AND area_id = ? LIMIT 1',
      [id, areaId]
    );
    if (existing.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Section not found' });
    }

    // Soft-delete the section, then soft-delete any items still pointing at it
    // so the category/product/offer they reference is no longer considered
    // "assigned to the mobile dashboard".
    await pool.query(
      'UPDATE dashboard_sections SET deleted_at = NOW() WHERE id = ? AND area_id = ?',
      [id, areaId]
    );
    await pool.query(
      'UPDATE dashboard_section_items SET deleted_at = NOW() WHERE section_id = ? AND deleted_at IS NULL',
      [id]
    );

    await bustAreaCaches(areaId);
    res.status(200).json({ message: 'Dashboard section deleted' });
  } catch (error) {
    res.status(500).json({ code: 'SERVER_ERROR', message: error.message });
  }
};

/**
 * Admin: POST /api/admin/dashboard-sections/:id/items
 */
const addAdminSectionItem = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const { id } = req.params;
  const { item_type, item_id, display_order, active, starts_at, ends_at } = req.body;

  if (!item_type || !item_id) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Item type and item ID are required' });
  }

  const finalDisplayOrder = asNonNegativeInteger(display_order, 0);
  if (finalDisplayOrder === null) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Display order must be a whole number greater than or equal to 0' });
  }

  const scheduleError = validateVisibilityWindow(starts_at, ends_at);
  if (scheduleError) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: scheduleError });
  }

  try {
    const [sections] = await pool.query(
      'SELECT id, title, slug, section_type, store_type, active, display_order, max_visible_items, show_see_all, show_hot_badge, section_icon, linked_category_id, linked_offer_id, starts_at, ends_at, version, created_at, updated_at FROM dashboard_sections WHERE id = ? AND deleted_at IS NULL AND area_id = ?',
      [id, areaId]
    );
    if (sections.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Section not found' });
    }
    const section = sections[0];

    if (SECTION_ITEM_TYPES[section.section_type] !== item_type) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: `Item type "${item_type}" is not compatible with section type "${section.section_type}"`
      });
    }

    const itemInfo = await getLinkedItemInfo(item_type, item_id, areaId);
    if (itemInfo.error) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: itemInfo.error });
    }

    if (section.store_type !== 'all' && itemInfo.storeType && itemInfo.storeType !== section.store_type) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: `This item belongs to "${itemInfo.storeType}" and cannot be added to a "${section.store_type}" section.`
      });
    }

    const [duplicate] = await pool.query(
      'SELECT id FROM dashboard_section_items WHERE section_id = ? AND item_type = ? AND item_id = ? AND deleted_at IS NULL LIMIT 1',
      [id, item_type, item_id]
    );
    if (duplicate.length > 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'This item is already assigned to this section.' });
    }

    if (finalDisplayOrder > 0) {
      const [orderExisting] = await pool.query(
        'SELECT id FROM dashboard_section_items WHERE section_id = ? AND display_order = ? AND deleted_at IS NULL LIMIT 1',
        [id, finalDisplayOrder]
      );
      if (orderExisting.length > 0) {
        return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Display order ${finalDisplayOrder} is already used in this section.` });
      }
    }

    const [result] = await pool.query(
      `INSERT INTO dashboard_section_items (
        section_id, item_type, item_id, display_order, active, starts_at, ends_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id, item_type, item_id,
        finalDisplayOrder,
        active !== undefined ? active : 1,
        starts_at || null,
        ends_at || null
      ]
    );

    await bustAreaCaches(areaId);

    // Return the new item already hydrated with its product/category/combo/offer
    // details so the admin UI can append it locally instead of re-fetching (and
    // re-hydrating) the entire section just to show one new row. The insert has
    // already committed at this point — a hydration failure must not turn the
    // response into a 500 (the client would report a failure for an item that
    // was actually added); it degrades to data: null, which the admin UI
    // already handles by refetching the section.
    let hydratedItem = null;
    try {
      hydratedItem = await hydrateSectionItem({
        id: result.insertId,
        section_id: Number(id),
        item_type,
        item_id,
        display_order: finalDisplayOrder,
        active: active !== undefined ? active : 1,
        starts_at: starts_at || null,
        ends_at: ends_at || null
      }, areaId);
    } catch (hydrateError) {
      console.error('[dashboard] hydrate after add failed for item', result.insertId, hydrateError.message);
    }

    res.status(201).json({ message: 'Dashboard section item added', id: result.insertId, data: hydratedItem });
  } catch (error) {
    res.status(500).json({ code: 'SERVER_ERROR', message: error.message });
  }
};

/**
 * Admin: PATCH /api/admin/dashboard-sections/:id/items/:itemId
 */
const updateAdminSectionItem = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const { id, itemId } = req.params;
  const { display_order, active, starts_at, ends_at } = req.body;

  const parsedDisplayOrder = asNonNegativeInteger(display_order, null);
  if (display_order !== undefined && parsedDisplayOrder === null) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Display order must be a whole number greater than or equal to 0' });
  }

  const scheduleError = validateVisibilityWindow(starts_at, ends_at);
  if (scheduleError) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: scheduleError });
  }

  try {
    // dashboard_section_items has no area_id of its own (a child of
    // dashboard_sections) — the JOIN's ds.area_id is the cross-tenant
    // guard: without it, an area_admin could PATCH another area's section
    // item by guessing its (globally sequential) numeric id + section id.
    const [items] = await pool.query(
      `SELECT dsi.id, dsi.section_id, dsi.item_type, dsi.item_id, dsi.display_order, dsi.active, dsi.starts_at, dsi.ends_at, dsi.created_at, dsi.updated_at
       FROM dashboard_section_items dsi
       JOIN dashboard_sections ds ON ds.id = dsi.section_id
       WHERE dsi.id = ? AND dsi.section_id = ? AND dsi.deleted_at IS NULL AND ds.area_id = ?`,
      [itemId, id, areaId]
    );
    if (items.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Section item not found' });
    }

    const existingItem = items[0];

    const finalDisplayOrder = display_order !== undefined ? parsedDisplayOrder : existingItem.display_order;
    if (finalDisplayOrder > 0) {
      const [orderExisting] = await pool.query(
        'SELECT id FROM dashboard_section_items WHERE section_id = ? AND display_order = ? AND id != ? AND deleted_at IS NULL LIMIT 1',
        [id, finalDisplayOrder, itemId]
      );
      if (orderExisting.length > 0) {
        return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Display order ${finalDisplayOrder} is already used in this section.` });
      }
    }

    await pool.query(
      `UPDATE dashboard_section_items SET
        display_order = ?, active = ?, starts_at = ?, ends_at = ?
       WHERE id = ?`,
      [
        finalDisplayOrder,
        active !== undefined ? active : existingItem.active,
        starts_at !== undefined ? starts_at : existingItem.starts_at,
        ends_at !== undefined ? ends_at : existingItem.ends_at,
        itemId
      ]
    );

    await bustAreaCaches(areaId);
    res.status(200).json({ message: 'Section item updated' });
  } catch (error) {
    res.status(500).json({ code: 'SERVER_ERROR', message: error.message });
  }
};

/**
 * Admin: DELETE /api/admin/dashboard-sections/:id/items/:itemId
 */
const deleteAdminSectionItem = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const { id, itemId } = req.params;
  try {
    const [items] = await pool.query(
      `SELECT dsi.id
       FROM dashboard_section_items dsi
       JOIN dashboard_sections ds ON ds.id = dsi.section_id
       WHERE dsi.id = ? AND dsi.section_id = ? AND dsi.deleted_at IS NULL AND ds.area_id = ?
       LIMIT 1`,
      [itemId, id, areaId]
    );
    if (items.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Section item not found' });
    }

    await pool.query(
      'UPDATE dashboard_section_items SET deleted_at = NOW() WHERE id = ?',
      [itemId]
    );
    await bustAreaCaches(areaId);
    res.status(200).json({ message: 'Section item removed' });
  } catch (error) {
    res.status(500).json({ code: 'SERVER_ERROR', message: error.message });
  }
};

/**
 * Admin: PATCH /api/admin/dashboard-sections/reorder
 */
const reorderAdminSections = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const { sectionIds } = req.body;
  if (!Array.isArray(sectionIds)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'sectionIds array is required' });
  }

  const connection = await pool.getConnection();
  await connection.beginTransaction();

  try {
    for (let i = 0; i < sectionIds.length; i++) {
      const sectionId = sectionIds[i];
      // area_id in the WHERE: without it, a section id belonging to another
      // area could have its display_order silently rewritten.
      await connection.query(
        'UPDATE dashboard_sections SET display_order = ? WHERE id = ? AND deleted_at IS NULL AND area_id = ?',
        [i, sectionId, areaId]
      );
    }
    await connection.commit();
    connection.release();
    await bustAreaCaches(areaId);
    res.status(200).json({ message: 'Sections reordered successfully' });
  } catch (error) {
    await connection.rollback();
    connection.release();
    res.status(500).json({ code: 'SERVER_ERROR', message: error.message });
  }
};

/**
 * Admin: PATCH /api/admin/dashboard-sections/:id/items/reorder
 */
const reorderAdminSectionItems = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const { id } = req.params;
  const { itemIds } = req.body;
  if (!Array.isArray(itemIds)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'itemIds array is required' });
  }

  // dashboard_section_items has no area_id of its own — verify the parent
  // section belongs to the caller's area once, up front, so an area_admin
  // can't reorder another area's section's items by guessing its id.
  const [sections] = await pool.query(
    'SELECT id FROM dashboard_sections WHERE id = ? AND deleted_at IS NULL AND area_id = ? LIMIT 1',
    [id, areaId]
  );
  if (sections.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Section not found' });
  }

  const connection = await pool.getConnection();
  await connection.beginTransaction();

  try {
    for (let i = 0; i < itemIds.length; i++) {
      const itemId = itemIds[i];
      await connection.query(
        'UPDATE dashboard_section_items SET display_order = ? WHERE id = ? AND section_id = ? AND deleted_at IS NULL',
        [i, itemId, id]
      );
    }
    await connection.commit();
    connection.release();
    await bustAreaCaches(areaId);
    res.status(200).json({ message: 'Section items reordered successfully' });
  } catch (error) {
    await connection.rollback();
    connection.release();
    res.status(500).json({ code: 'SERVER_ERROR', message: error.message });
  }
};

module.exports = {
  getDashboard,
  getSectionItems,
  getAdminSections,
  getAdminSectionById,
  createAdminSection,
  updateAdminSection,
  deleteAdminSection,
  addAdminSectionItem,
  updateAdminSectionItem,
  deleteAdminSectionItem,
  reorderAdminSections,
  reorderAdminSectionItems
};
