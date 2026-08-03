const { pool } = require('../db/mysql');
const { normalizeStoreType } = require('../utils/storeMode');
const { validatePagination, isNumericAmount } = require('../validators');
const { cleanupOrphanedImage } = require('./imageController');
const { requestAreaId, bustAreaCaches } = require('../utils/areaScope');
const { decideSearchMode } = require('../utils/search');

// Admin write/single-item endpoints reject null (super_admin, no
// X-Area-Id) and 'all' — product management always targets exactly one
// area.
const requireOneArea = (req, res) => {
  const areaId = requestAreaId(req);
  if (areaId === null) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'X-Area-Id is required to manage products' });
    return null;
  }
  if (areaId === 'all') {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Products cannot be managed for "all" areas at once — pick one area' });
    return null;
  }
  return areaId;
};

const isWithinTimeWindow = (from, until) => {
  // Both null means always available in the time sense.
  if (!from || !until) return true;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const [fh, fm] = String(from).split(':').map(Number);
  const [uh, um] = String(until).split(':').map(Number);
  const start = fh * 60 + (fm || 0);
  const end = uh * 60 + (um || 0);
  if (start === end) return true; // no real window
  if (start < end) {
    return cur >= start && cur < end;
  }
  // Window crosses midnight (e.g. 22:00 -> 02:00)
  return cur >= start || cur < end;
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
    WHERE ci.combo_id IN (?) AND p.deleted = 0
    ORDER BY ci.combo_id ASC, ci.display_order ASC, ci.id ASC`,
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

const attachComboItems = async (products = []) => {
  const comboIds = products.filter(product => product.is_combo).map(product => product.id);
  const comboItemsMap = await getComboItemsByComboIds(comboIds);

  products.forEach(product => {
    const comboItems = comboItemsMap[product.id] || [];
    product.combo_items = comboItems;
    product.comboItems = comboItems;
    product.combo_count = comboItems.length;
  });
};

// Embed purchasable variants (sizes/types) into a page of product responses.
// Models on attachComboItems: ONE batch query for all product ids, then attach.
// Only real products (not combos) can have variants — combos live in the
// `combos` table whose ids share a namespace with `products`, so filtering
// them out avoids accidental product_variants.product_id collisions.
// Returns available = 0 variants too (client shows them disabled as "Out");
// filters ONLY deleted = 1.
const attachVariants = async (products = []) => {
  const productIds = products
    .filter(p => !p.is_combo)
    .map(p => p.id)
    .filter(Boolean);

  const variantsMap = {};
  if (productIds.length > 0) {
    const [rows] = await pool.query(
      `SELECT id, product_id, label, price, shop_price, original_price, available, is_default, display_order
       FROM product_variants
       WHERE product_id IN (?) AND deleted = 0
       ORDER BY display_order ASC, id ASC`,
      [productIds]
    );
    rows.forEach(v => {
      if (!variantsMap[v.product_id]) variantsMap[v.product_id] = [];
      variantsMap[v.product_id].push(v);
    });
  }

  products.forEach(product => {
    const variantRows = variantsMap[product.id] || [];
    product.variants = variantRows.map(v => ({
      id: v.id,
      productId: v.product_id, product_id: v.product_id,
      label: v.label,
      price: Number(v.price),
      // NULL stays NULL (not 0) — "no shop price configured" is a distinct
      // state the admin grid renders as "—".
      shopPrice: v.shop_price === null || v.shop_price === undefined ? null : Number(v.shop_price),
      shop_price: v.shop_price === null || v.shop_price === undefined ? null : Number(v.shop_price),
      originalPrice: v.original_price, original_price: v.original_price,
      available: Boolean(v.available),
      isDefault: Boolean(v.is_default), is_default: Boolean(v.is_default),
      displayOrder: v.display_order, display_order: v.display_order,
    }));
    product.hasVariants = product.has_variants = product.variants.length > 0;
    product.minPrice = product.min_price = product.variants.length
      ? Math.min(...product.variants.map(v => v.price))
      : Number(product.price);
    product.variantPrompt = product.variant_prompt ?? null;
  });
};

// Variant upsert + products.price re-sync. Called on the SAME connection
// and transaction as the caller's product INSERT/UPDATE (never opens its
// own transaction) so a variant-sync failure rolls back the product write
// too — otherwise a partial failure could commit a product row whose price
// disagrees with its default variant, or leave a variantless product behind
// on a 500. `variants === undefined` and `variantPrompt === undefined` mean
// "not sent" → leave untouched (partial-update safety). UPSERT by id (never
// delete-and-reinsert — live carts and order snapshots reference variant
// ids). The products.price sync is the load-bearing backward-compat
// invariant: products.price must ALWAYS equal the default variant's price.
const syncProductVariants = async (connection, productId, variants, variantPrompt) => {
  if (variants === undefined && variantPrompt === undefined) return;

  if (variantPrompt !== undefined) {
    await connection.query(
      'UPDATE products SET variant_prompt = ? WHERE id = ?',
      [variantPrompt || null, productId]
    );
  }

  if (variants !== undefined) {
    const payloadIds = new Set();
    for (const v of variants) {
      // shop_price is the one field that is NOT full-replace here: a payload
      // that omits the key keeps whatever is stored. The product drawer and
      // older clients don't send it, and silently nulling it would erase what
      // we owe the shop. Sending an explicit null still clears it.
      const sendsShopPrice = v.shop_price !== undefined;
      // library_variant_id is the same story, for the same reason: the
      // normal product editor never sends it (it's an internal library
      // linkage field, not user-editable there) — only materializeToArea
      // (TASK 19) passes it, when stamping a newly-materialized variant's
      // link back to its library_variants row. Omitting it must leave an
      // existing link untouched, not silently clear it on every unrelated edit.
      const sendsLibraryVariantId = v.library_variant_id !== undefined;
      if (v.id) {
        payloadIds.add(Number(v.id));
        // AND product_id = ? prevents cross-product id abuse.
        await connection.query(
          `UPDATE product_variants SET label = ?, price = ?, ${sendsShopPrice ? 'shop_price = ?, ' : ''}original_price = ?, available = ?, is_default = ?, display_order = ?, ${sendsLibraryVariantId ? 'library_variant_id = ?, ' : ''}deleted = 0 WHERE id = ? AND product_id = ?`,
          [
            v.label, v.price,
            ...(sendsShopPrice ? [v.shop_price] : []),
            v.original_price, v.available ? 1 : 0, v.is_default ? 1 : 0, v.display_order,
            ...(sendsLibraryVariantId ? [v.library_variant_id] : []),
            v.id, productId,
          ]
        );
      } else {
        const [insertResult] = await connection.query(
          'INSERT INTO product_variants (product_id, label, price, shop_price, original_price, available, is_default, display_order, library_variant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [productId, v.label, v.price, sendsShopPrice ? v.shop_price : null, v.original_price, v.available ? 1 : 0, v.is_default ? 1 : 0, v.display_order, v.library_variant_id ?? null]
        );
        payloadIds.add(Number(insertResult.insertId));
      }
    }

    // Soft-delete existing non-deleted variants NOT in the payload.
    if (payloadIds.size > 0) {
      await connection.query(
        'UPDATE product_variants SET deleted = 1 WHERE product_id = ? AND deleted = 0 AND id NOT IN (?)',
        [productId, [...payloadIds]]
      );
    } else {
      await connection.query(
        'UPDATE product_variants SET deleted = 1 WHERE product_id = ? AND deleted = 0',
        [productId]
      );
    }

    // THE LOAD-BEARING SYNC: products.price = default variant's price.
    if (variants.length > 0) {
      const defaultVariant = variants.find(v => v.is_default) || variants[0];
      await connection.query('UPDATE products SET price = ? WHERE id = ?', [defaultVariant.price, productId]);
      // Same invariant for the shop-cost mirror, but re-read from the row
      // instead of the payload — after the upsert above the DB holds the
      // truth whether shop_price was sent, preserved, or explicitly cleared.
      await syncProductFromDefaultVariant(connection, productId);
    }
  }
};

// products.{price,shop_price} := the default (or first) live variant's
// values. Mirrors the products.price invariant so anything reading the
// product row alone (reports, cart fallback) still sees numbers consistent
// with what the variant actually charges / costs. Reads from the DB rather
// than a payload so any caller that already wrote the variant row (variant
// upsert above, or the standalone pricing endpoint) can call this after.
const syncProductFromDefaultVariant = async (connection, productId) => {
  const [rows] = await connection.query(
    `SELECT price, shop_price FROM product_variants
     WHERE product_id = ? AND deleted = 0
     ORDER BY is_default DESC, display_order ASC, id ASC
     LIMIT 1`,
    [productId]
  );
  if (rows.length === 0) return;
  await connection.query('UPDATE products SET price = ?, shop_price = ? WHERE id = ?', [rows[0].price, rows[0].shop_price, productId]);
};

const getProducts = async (req, res) => {
  // Catalog data (§2.4): a pin outside every zone (null areaId) gets an
  // empty list, same as deliveryZonesController.listActiveZonesPublic and
  // categoryController.getCategories — never another area's products.
  const areaId = requestAreaId(req);
  const { categoryId, category_id, search, type, storeType, store_type, isCombo, is_combo, featured, limit, offset, offerId, offer_id } = req.query;
  const requestedType = type || storeType || store_type;
  // Pagination: limit+1 trick for hasMore (SQL page size, not post time-window filter length).
  const limitNum = limit !== undefined && Number.isInteger(Number(limit)) && Number(limit) > 0
    ? Number(limit)
    : null;
  const offsetNum = offset !== undefined && Number.isInteger(Number(offset)) && Number(offset) >= 0
    ? Number(offset)
    : 0;

  const paginateRows = (rows) => {
    if (limitNum == null) {
      return { pageRows: rows, hasMore: false };
    }
    const hasMore = rows.length > limitNum;
    return { pageRows: hasMore ? rows.slice(0, limitNum) : rows, hasMore };
  };

  const productsResponse = (products, hasMore) => ({
    data: { products, hasMore, has_more: hasMore },
    products,
    hasMore,
    has_more: hasMore,
  });

  if (areaId === null || areaId === 'all') {
    return res.status(200).json(productsResponse([], false));
  }

  // A client can hold a stale/deactivated mode slug (e.g. web's
  // localStorage-persisted storeType) after an admin deactivates a custom
  // mode — fall back to 'all' instead of erroring the whole product list.
  let normalizedType = 'all';
  if (requestedType) {
    try {
      normalizedType = await normalizeStoreType(requestedType, { allowAll: true, areaId });
    } catch {
      normalizedType = 'all';
    }
  }
  const finalCategoryId = categoryId || category_id;
  let finalIsCombo = isCombo !== undefined ? isCombo : is_combo;
  const finalOfferId = offerId || offer_id;

  // Customer app can request that products from closed shops are included
  // in the list (they are rendered as disabled cards rather than hidden).
  // Cart/order checkout still refuses them; this just surfaces the flag.
  const includeClosedShops = ['1', 'true'].includes(
    String(req.query.includeClosedShops ?? req.query.include_closed_shops ?? '').toLowerCase()
  );
  const shopOpenClause = includeClosedShops
    ? '(p.shop_id IS NULL OR EXISTS (SELECT 1 FROM shops s WHERE s.id = p.shop_id AND s.active = 1))'
    : '(p.shop_id IS NULL OR EXISTS (SELECT 1 FROM shops s WHERE s.id = p.shop_id AND s.is_open = 1 AND s.active = 1))';
  const shopIsOpenProjection = 'IF(p.shop_id IS NULL OR (sh.is_open = 1 AND sh.active = 1), 1, 0) AS shop_is_open';
  // Same opt-in flag as shopOpenClause: a product the shop owner toggled off
  // is still returned (with available: 0) so the client renders it as a
  // greyed-out "Temporarily Unavailable" card instead of it just vanishing.
  const availableClause = includeClosedShops ? '1=1' : 'p.available = 1';

  if (finalOfferId) {
    // 1. Validate the offer, scoped to this area — an offerId from another
    // area must 404 the same as one that doesn't exist at all.
    const [offers] = await pool.query('SELECT store_type, active, deleted, is_clickable FROM offers WHERE id = ? AND area_id = ?', [finalOfferId, areaId]);
    if (offers.length === 0 || offers[0].deleted || !offers[0].active || !offers[0].is_clickable) {
      return res.status(200).json(productsResponse([], false));
    }
    if (normalizedType !== 'all' && offers[0].store_type !== normalizedType) {
      return res.status(200).json(productsResponse([], false));
    }

    // 2. Fetch products attached to offer
    let query = `
      SELECT p.id, p.name, p.price, p.unit, p.description, p.image_id, p.available, p.is_combo, p.featured, p.original_price, p.discount_label, p.available_from_time, p.available_until_time, p.category_id, c.name as category_name, c.type as category_type, c.display_order as cat_display_order, p.display_order as item_display_order, p.variant_prompt, p.shop_id, ${shopIsOpenProjection}
      FROM offer_products op
      JOIN products p ON op.product_id = p.id
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN shops sh ON sh.id = p.shop_id
      WHERE op.offer_id = ? AND op.active = 1 AND ${availableClause} AND p.deleted = 0 AND p.is_combo = 0 AND p.area_id = ? AND ${shopOpenClause} AND (p.group_id IS NULL OR EXISTS (SELECT 1 FROM product_groups g WHERE g.id = p.group_id AND g.active = 1 AND g.area_id = p.area_id))
    `;
    const params = [finalOfferId, areaId];

    if (normalizedType !== 'all') {
      query += ` AND c.type = ?`;
      params.push(normalizedType);
    }

    query += ' ORDER BY op.display_order ASC, item_display_order ASC, p.id ASC';

    if (limitNum != null) {
      query += ' LIMIT ? OFFSET ?';
      params.push(limitNum + 1, offsetNum);
    }

    const [rows] = await pool.query(query, params);
    const { pageRows, hasMore } = paginateRows(rows);
    await resolveImageUrls(pageRows);
    await attachVariants(pageRows);
    // Time-window filter may shrink the page; hasMore still comes from SQL page size.
    const filteredRows = pageRows.filter(r => isWithinTimeWindow(r.available_from_time, r.available_until_time));
    filteredRows.forEach(r => {
      r.shopId = r.shop_id ?? null;
      r.shopIsOpen = r.shop_is_open === undefined ? 1 : r.shop_is_open;
    });
    return res.status(200).json(productsResponse(filteredRows, hasMore));
  }

  // If filtering by category/categoryType/categoryId and isCombo isn't explicitly set, default to false (exclude combos)
  if (finalIsCombo === undefined && (finalCategoryId || (requestedType && requestedType !== 'all'))) {
    finalIsCombo = 'false';
  }

  const productQuery = `SELECT p.id, p.name, p.price, p.unit, p.description, p.image_id, p.available, p.is_combo, p.featured, p.original_price, p.discount_label, p.available_from_time, p.available_until_time, p.category_id, c.name as category_name, c.type as category_type, c.display_order as cat_display_order, p.display_order as item_display_order, p.variant_prompt, p.shop_id, sh.name as shop_name, ${shopIsOpenProjection}
    FROM products p LEFT JOIN categories c ON p.category_id = c.id
    LEFT JOIN shops sh ON sh.id = p.shop_id
    WHERE ${availableClause} AND p.deleted = 0 AND p.is_combo = 0 AND p.area_id = ${Number(areaId)} AND ${shopOpenClause} AND (p.group_id IS NULL OR EXISTS (SELECT 1 FROM product_groups g WHERE g.id = p.group_id AND g.active = 1 AND g.area_id = p.area_id))`;

  const comboQuery = `SELECT p.id, p.name, p.price, p.unit, p.description, p.image_id, p.available, 1 as is_combo, p.featured, p.original_price, p.discount_label, NULL as category_id, NULL as category_name, p.store_type as category_type, 999 as cat_display_order, p.display_order as item_display_order
    FROM combos p
    WHERE p.available = 1 AND p.deleted = 0 AND p.area_id = ${Number(areaId)}`;

  let finalQuery = '';
  const finalParams = [];

  // products has a FULLTEXT index (TASK 22, §3.11); combos does not, so
  // combos search stays on LIKE regardless of term length — same fallback
  // path, just permanent for that subquery rather than short-term-only.
  const buildSearchClause = (rawTerm, isComboType) => {
    if (isComboType) return ` AND p.name LIKE ${pool.escape('%' + String(rawTerm).trim() + '%')}`;
    const decision = decideSearchMode(rawTerm);
    if (decision.mode === 'none') return ' AND 1=0';
    if (decision.mode === 'like') return ` AND p.name LIKE ${pool.escape('%' + decision.term + '%')}`;
    return ` AND MATCH(p.name) AGAINST (${pool.escape(decision.term)} IN BOOLEAN MODE)`;
  };

  const buildSubQuery = (baseQuery, isComboType) => {
    let q = baseQuery;
    if (finalCategoryId && !isComboType) q += ` AND p.category_id = ${pool.escape(finalCategoryId)}`;
    if (normalizedType !== 'all' && !isComboType) q += ` AND c.type = ${pool.escape(normalizedType)}`;
    if (normalizedType !== 'all' && isComboType) q += ` AND p.store_type = ${pool.escape(normalizedType)}`;
    if (search) q += buildSearchClause(search, isComboType);
    if (featured !== undefined) q += ` AND p.featured = ${featured === 'true' || featured === '1' ? 1 : 0}`;
    return q;
  };

  if (finalIsCombo === true || finalIsCombo === '1' || finalIsCombo === 'true') {
    finalQuery = buildSubQuery(comboQuery, true);
  } else if (finalIsCombo === false || finalIsCombo === '0' || finalIsCombo === 'false') {
    finalQuery = buildSubQuery(productQuery, false);
  } else {
    // Public product lists default to real products only. Combos are shown through
    // dashboard combo sections or when explicitly requested with isCombo=true.
    finalQuery = buildSubQuery(productQuery, false);
  }

  finalQuery += ' ORDER BY cat_display_order ASC, item_display_order ASC, id ASC';
  if (limitNum != null) {
    finalQuery += ' LIMIT ? OFFSET ?';
    finalParams.push(limitNum + 1, offsetNum);
  }

  const [rows] = await pool.query(finalQuery, finalParams);
  const { pageRows, hasMore } = paginateRows(rows);

  await resolveImageUrls(pageRows);
  await attachComboItems(pageRows);
  await attachVariants(pageRows);

  // Time-window filter may shrink the page; hasMore still comes from SQL page size.
  const filteredRows = pageRows.filter(r => isWithinTimeWindow(r.available_from_time, r.available_until_time));

  filteredRows.forEach(r => {
    r.shopId = r.shop_id ?? null;
    r.shopName = r.shop_name ?? null;
    r.shopIsOpen = r.shop_is_open === undefined ? 1 : r.shop_is_open;
  });

  res.status(200).json(productsResponse(filteredRows, hasMore));
};

// Deliberately NOT area-scoped: unlike getProducts (a listing that could
// enumerate another area's catalog), this is an id-scoped deep link used
// from order history, cart, and push notifications — a customer whose pin
// now resolves to Area 2 must still be able to open a product from an
// Area 1 order they placed earlier. Product ids are globally unique, so
// this never returns the wrong row, only possibly a row outside the
// caller's current area, which the UI already treats as a normal
// unavailable/out-of-area state.
const getProductById = async (req, res) => {
  const { id } = req.params;
  const requestedCombo = req.query.type === 'combo' || req.query.isCombo === 'true' || req.query.is_combo === '1';

  // Catalog data (§2.4): scoped like every other customer catalog route —
  // never fetchable across areas, including by a guessed/crafted id (bug
  // fix, multi-area audit finding #4). A pin outside every zone (null) or
  // 'all' (not a real customer-route value, defensive only) can't resolve a
  // single area to check against, so treat it the same as "not found" —
  // never fall back to leaking whichever area the id happens to belong to.
  const areaId = requestAreaId(req);
  if (areaId === null || areaId === 'all') {
    return res.status(404).json({ code: 'NOT_FOUND', message: requestedCombo ? 'Combo not found' : 'Product not found' });
  }

  const loadCombo = async () => {
    const [comboRows] = await pool.query(
      "SELECT p.*, 1 as is_combo, NULL as category_name, p.store_type as category_type FROM combos p WHERE p.id = ? AND p.deleted = 0 AND p.area_id = ?",
      [id, areaId]
    );
    if (comboRows.length === 0) return null;
    const combo = comboRows[0];
    await resolveImageUrls([combo]);
    await attachComboItems([combo]);
    return combo;
  };

  if (requestedCombo) {
    const combo = await loadCombo();
    if (!combo) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Combo not found' });
    }
    return res.status(200).json({ data: combo });
  }

  const [rows] = await pool.query(
    'SELECT p.*, c.name as category_name, c.type as category_type FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.id = ? AND p.deleted = 0 AND p.area_id = ?',
    [id, areaId]
  );

  if (rows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Product not found' });
  }

  const product = rows[0];
  await resolveImageUrls([product]);
  await attachComboItems([product]);
  await attachVariants([product]);

  // Annotate the response with whether the product is in its daily time window.
  // The product is still returned so the customer app can show an
  // "available from 09:00 to 18:00" hint instead of a hard 404.
  product.in_time_window = isWithinTimeWindow(product.available_from_time, product.available_until_time);

  // Shop visibility: a product whose shop is closed (is_open = 0) or
  // deactivated (active = 0) behaves like available = 0 for customers. The
  // product is still returned so deep-linked detail pages (e.g. from order
  // history) can render, but it shows as unavailable. House products
  // (shop_id IS NULL) are unaffected. Mirrors the in_time_window pattern above.
  if (product.shop_id) {
    const [shopRows] = await pool.query(
      'SELECT is_open, active FROM shops WHERE id = ? LIMIT 1',
      [product.shop_id]
    );
    const shop = shopRows[0];
    if (!shop || !shop.is_open || !shop.active) {
      product.available = 0;
    }
  }

  res.status(200).json({ data: product });
};

const createProduct = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  // Normal products require category. Combos are bundles and do not require category.
  const { name, price, shop_price, category_id, unit, description, image_id, available, featured, display_order, original_price, discount_label, available_from_time, available_until_time, variants, variant_prompt, shop_id } = req.validatedData;

  const finalDisplayOrder = display_order !== undefined ? display_order : 0;
  if (finalDisplayOrder > 0) {
    const [existing] = await pool.query('SELECT name FROM products WHERE category_id = ? AND display_order = ? AND deleted = 0 AND area_id = ? LIMIT 1', [category_id, finalDisplayOrder, areaId]);
    if (existing.length > 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Display order ${finalDisplayOrder} is already used by ${existing[0].name} in this category.` });
    }
  }

  if (shop_id !== undefined && shop_id !== null) {
    const [shopRows] = await pool.query('SELECT id FROM shops WHERE id = ? AND area_id = ?', [shop_id, areaId]);
    if (shopRows.length === 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Unknown shop_id' });
    }
  }

  // Product row + variant sync run on one connection/transaction so a
  // variant-sync failure rolls back the product row too, instead of leaving
  // a committed product whose price disagrees with its default variant.
  const connection = await pool.getConnection();
  let insertId;
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      'INSERT INTO products (area_id, name, price, shop_price, category_id, unit, description, image_id, available, is_combo, featured, display_order, original_price, discount_label, available_from_time, available_until_time, shop_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        areaId, name, price, shop_price === undefined ? null : shop_price, category_id, unit, description, image_id,
        available !== undefined ? available : true,
        false,
        featured !== undefined ? featured : false,
        finalDisplayOrder,
        original_price || null,
        discount_label || null,
        available_from_time || null,
        available_until_time || null,
        shop_id || null
      ]
    );
    insertId = result.insertId;
    await syncProductVariants(connection, insertId, variants, variant_prompt);
    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
  await bustAreaCaches(areaId);
  res.status(201).json({ message: 'Product created', id: insertId });
};

const updateProduct = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  // Normal products require category. Combos are bundles and do not require category.
  const { id } = req.params;
  const { name, price, shop_price, category_id, unit, description, image_id, available, featured, display_order, original_price, discount_label, available_from_time, available_until_time, variants, variant_prompt, shop_id } = req.validatedData;

  // area_id in the WHERE, not just id: without this, an area_admin could
  // PATCH another area's product by guessing its (globally sequential)
  // numeric id.
  const [existing] = await pool.query('SELECT id, image_id, shop_id, shop_price FROM products WHERE id = ? AND deleted = 0 AND area_id = ?', [id, areaId]);
  if (existing.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Product not found' });
  }
  const previousImageId = existing[0].image_id;
  // shop_id is a full-replace field like the rest of this endpoint, but a
  // caller that omits the key entirely (vs. sending shop_id: null to clear
  // it) must not silently wipe an existing assignment.
  const finalShopId = shop_id !== undefined ? shop_id : existing[0].shop_id;
  // Same hazard for shop_price: the product edit drawer doesn't manage this
  // field (the pricing grid does), so a plain PUT must not silently wipe a
  // price the grid set. Omit the key to preserve; send null to clear.
  const finalShopPrice = shop_price !== undefined ? shop_price : existing[0].shop_price;

  const finalDisplayOrder = display_order !== undefined ? display_order : 0;
  if (finalDisplayOrder > 0) {
    const [orderExisting] = await pool.query('SELECT name FROM products WHERE category_id = ? AND display_order = ? AND id != ? AND deleted = 0 AND area_id = ? LIMIT 1', [category_id, finalDisplayOrder, id, areaId]);
    if (orderExisting.length > 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Display order ${finalDisplayOrder} is already used by ${orderExisting[0].name} in this category.` });
    }
  }

  if (finalShopId !== undefined && finalShopId !== null) {
    const [shopRows] = await pool.query('SELECT id FROM shops WHERE id = ? AND area_id = ?', [finalShopId, areaId]);
    if (shopRows.length === 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Unknown shop_id' });
    }
  }

  await pool.query('DELETE FROM product_combo_items WHERE combo_product_id = ?', [id]);

  // Product row + variant sync run on one connection/transaction so a
  // variant-sync failure rolls back the product row update too, instead of
  // leaving products.price out of sync with its default variant.
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      'UPDATE products SET name = ?, price = ?, shop_price = ?, category_id = ?, unit = ?, description = ?, image_id = ?, available = ?, is_combo = ?, featured = ?, display_order = ?, original_price = ?, discount_label = ?, available_from_time = ?, available_until_time = ?, shop_id = ? WHERE id = ? AND area_id = ?',
      [
        name, price, finalShopPrice, category_id, unit, description, image_id, available,
        false,
        featured !== undefined ? featured : false,
        finalDisplayOrder,
        original_price || null,
        discount_label || null,
        available_from_time || null,
        available_until_time || null,
        finalShopId || null,
        id, areaId
      ]
    );
    await syncProductVariants(connection, Number(id), variants, variant_prompt);
    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }

  if (previousImageId && String(previousImageId) !== String(image_id)) {
    await cleanupOrphanedImage(previousImageId);
  }
  await bustAreaCaches(areaId);
  res.status(200).json({ message: 'Product updated' });
};

const getAdminProducts = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const { categoryId, category_id, search, available, isCombo, is_combo, featured, type, page, limit, shopId, shop_id } = req.query;
  const finalCategoryId = categoryId || category_id;
  const finalShopId = shopId || shop_id;
  const finalIsCombo = isCombo !== undefined ? isCombo : is_combo;
  const normalizedType = type ? await normalizeStoreType(type, { allowAll: true, areaId }) : null;
  const pagination = validatePagination(page, limit);

  let whereClause = 'WHERE p.deleted = 0 AND p.area_id = ?';
  const params = [areaId];

  if (finalCategoryId) {
    whereClause += ' AND p.category_id = ?';
    params.push(finalCategoryId);
  }

  // shop_id = numeric id → that shop's products; 'none' → house products
  // (no shop assigned). Anything non-numeric other than 'none' is ignored.
  if (finalShopId !== undefined && finalShopId !== '') {
    if (finalShopId === 'none') {
      whereClause += ' AND p.shop_id IS NULL';
    } else if (Number.isInteger(Number(finalShopId)) && Number(finalShopId) > 0) {
      whereClause += ' AND p.shop_id = ?';
      params.push(Number(finalShopId));
    }
  }

  if (search) {
    const decision = decideSearchMode(search);
    if (decision.mode === 'none') {
      whereClause += ' AND 1=0';
    } else if (decision.mode === 'like') {
      whereClause += ' AND p.name LIKE ?';
      params.push(`%${decision.term}%`);
    } else {
      whereClause += ' AND MATCH(p.name) AGAINST (? IN BOOLEAN MODE)';
      params.push(decision.term);
    }
  }

  if (normalizedType && normalizedType !== 'all') {
    whereClause += ' AND c.type = ?';
    params.push(normalizedType);
  }

  if (available !== undefined) {
    whereClause += ' AND p.available = ?';
    params.push(available === 'true' || available === '1' ? 1 : 0);
  }

  if (finalIsCombo !== undefined) {
    whereClause += ' AND p.is_combo = ?';
    params.push(finalIsCombo === 'true' || finalIsCombo === '1' ? 1 : 0);
  }

  if (featured !== undefined) {
    whereClause += ' AND p.featured = ?';
    params.push(featured === 'true' || featured === '1' ? 1 : 0);
  }

  const [countRows] = await pool.query(
    `SELECT COUNT(*) as total FROM products p LEFT JOIN categories c ON p.category_id = c.id ${whereClause}`,
    params
  );
  const total = countRows[0].total;
  const totalPages = Math.ceil(total / pagination.limit);

  const query = `
    SELECT p.*, c.name as category_name, c.type as category_type, p.shop_id, s.name as shop_name 
    FROM products p 
    LEFT JOIN categories c ON p.category_id = c.id 
    LEFT JOIN shops s ON s.id = p.shop_id 
    ${whereClause}
    ORDER BY p.display_order ASC, p.id DESC
    LIMIT ? OFFSET ?
  `;
  
  params.push(pagination.limit, (pagination.page - 1) * pagination.limit);

  const [rows] = await pool.query(query, params);

  await resolveImageUrls(rows);
  await attachVariants(rows);
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

const getAdminProductById = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const { id } = req.params;
  const [rows] = await pool.query(`
    SELECT p.*, c.name as category_name, p.shop_id, s.name as shop_name
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    LEFT JOIN shops s ON s.id = p.shop_id
    WHERE p.id = ? AND p.area_id = ?
  `, [id, areaId]);

  if (rows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Product not found' });
  }

  const product = rows[0];
  await resolveImageUrls([product]);
  await attachVariants([product]);
  res.status(200).json({ data: product });
};

const deleteProduct = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const { id } = req.params;
  const [rows] = await pool.query('SELECT id, image_id FROM products WHERE id = ? AND deleted = 0 AND area_id = ?', [id, areaId]);
  if (rows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Product not found' });
  }

  await pool.query('UPDATE products SET deleted = 1 WHERE id = ? AND area_id = ?', [id, areaId]);
  await cleanupOrphanedImage(rows[0].image_id);
  await bustAreaCaches(areaId);
  res.status(200).json({ message: 'Product soft deleted' });
};

const updateProductAvailability = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const { id } = req.params;
  const finalAvail = req.validatedData?.available;
  if (finalAvail === undefined) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Availability status required' });
  }

  const normalizedAvailable = finalAvail === true || finalAvail === 'true' || finalAvail === 1 || finalAvail === '1';
  const [result] = await pool.query('UPDATE products SET available = ? WHERE id = ? AND deleted = 0 AND area_id = ?', [normalizedAvailable ? 1 : 0, id, areaId]);
  if (result.affectedRows === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Product not found' });
  }

  const [updatedRows] = await pool.query('SELECT * FROM products WHERE id = ?', [id]);
  await bustAreaCaches(areaId);
  try {
    const { emitToAllCustomers } = require('../realtime/socket');
    const row = updatedRows[0] || {};
    const productId = Number(row.id || id);
    emitToAllCustomers(areaId, 'product.availability.updated', {
      productId,
      id: productId,
      available: Boolean(normalizedAvailable),
      shopId: row.shop_id != null ? Number(row.shop_id) : null,
    });
  } catch (_) {
    // Realtime is best-effort — availability is already persisted.
  }
  res.status(200).json({ message: 'Product availability updated', product: updatedRows[0] });
};

// Mirrors updateProductAvailability but scoped to one variant row, so turning
// a size/pack off only hides that variant (VariantSheet already renders
// variant.available === false as an "Out" pill) instead of the whole product.
// product_variants has no area_id of its own (a child of products, scoped
// through the FK like combo_items/offer_products) — the EXISTS clause below
// is the cross-tenant guard: it makes sure `id`'s parent product actually
// belongs to the caller's area before touching the variant.
const updateVariantAvailability = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const { id, variantId } = req.params;
  const finalAvail = req.validatedData?.available;
  if (finalAvail === undefined) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Availability status required' });
  }

  const normalizedAvailable = finalAvail === true || finalAvail === 'true' || finalAvail === 1 || finalAvail === '1';
  const [result] = await pool.query(
    `UPDATE product_variants SET available = ? WHERE id = ? AND product_id = ? AND deleted = 0
     AND EXISTS (SELECT 1 FROM products WHERE products.id = product_variants.product_id AND products.area_id = ?)`,
    [normalizedAvailable ? 1 : 0, variantId, id, areaId],
  );
  if (result.affectedRows === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Variant not found' });
  }

  await bustAreaCaches(areaId);
  try {
    const { emitToAllCustomers } = require('../realtime/socket');
    // Same event name product-availability listeners already invalidate the
    // customer app's product/catalog caches on — no new subscription needed.
    emitToAllCustomers(areaId, 'product.availability.updated', {
      productId: Number(id),
      id: Number(id),
      variantId: Number(variantId),
      available: Boolean(normalizedAvailable),
    });
  } catch (_) {
    // Realtime is best-effort — availability is already persisted.
  }
  res.status(200).json({ message: 'Variant availability updated', variantId: Number(variantId), available: normalizedAvailable });
};

const updateProductImage = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const { id } = req.params;
  const { imageId, image_id } = req.body;
  const finalImageId = imageId || image_id;

  if (!finalImageId) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Image ID required' });
  }

  const [existing] = await pool.query('SELECT id, image_id FROM products WHERE id = ? AND deleted = 0 AND area_id = ?', [id, areaId]);
  if (existing.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Product not found' });
  }
  const previousImageId = existing[0].image_id;

  await pool.query('UPDATE products SET image_id = ? WHERE id = ? AND area_id = ?', [finalImageId, id, areaId]);
  if (previousImageId && String(previousImageId) !== String(finalImageId)) {
    await cleanupOrphanedImage(previousImageId);
  }

  const [updatedRows] = await pool.query('SELECT * FROM products WHERE id = ?', [id]);
  await bustAreaCaches(areaId);
  res.status(200).json({ message: 'Product image updated', product: updatedRows[0] });
};

module.exports = {
  getProducts,
  getProductById,
  createProduct,
  updateProduct,
  getAdminProducts,
  getAdminProductById,
  deleteProduct,
  updateProductAvailability,
  updateVariantAvailability,
  updateProductImage,
  attachVariants,
  // Exported for productLibrary.js's materializeToArea (TASK 19, §4.5) — the
  // ONLY other caller allowed to reuse this, so the products.price <->
  // default-variant mirror invariant is enforced in exactly one place.
  syncProductVariants,
};

const bulkUpdateProducts = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const { ids, updates } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: '`ids` must be a non-empty array of product IDs.' });
  }
  const numericIds = ids.map(id => parseInt(id, 10)).filter(id => Number.isFinite(id) && id > 0);
  if (numericIds.length === 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'No valid numeric product IDs provided.' });
  }

  const ALLOWED = ['available', 'featured', 'category_id', 'shop_id'];
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: '`updates` object is required.' });
  }
  // shop_id: 0 is a valid sentinel meaning "clear assignment" — allow it through unlike other null-ish values
  const updateKeys = Object.keys(updates).filter(k => {
    if (k === 'shop_id' && updates[k] === 0) return true;
    return updates[k] !== undefined && updates[k] !== null && updates[k] !== '';
  });
  const disallowed = updateKeys.filter(k => !ALLOWED.includes(k));
  if (disallowed.length > 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Unsupported update fields: ${disallowed.join(', ')}. Allowed: ${ALLOWED.join(', ')}.` });
  }
  const validKeys = updateKeys.filter(k => ALLOWED.includes(k));
  if (validKeys.length === 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'At least one update field is required (available, featured, category_id, or shop_id).' });
  }

  if (updates.category_id !== undefined) {
    const catId = parseInt(updates.category_id, 10);
    if (!Number.isFinite(catId) || catId <= 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: '`category_id` must be a valid positive integer.' });
    }
    const [cats] = await pool.query('SELECT id FROM categories WHERE id = ? AND deleted = 0 AND area_id = ?', [catId, areaId]);
    if (cats.length === 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Category ID ${catId} does not exist or has been deleted.` });
    }
    updates.category_id = catId;
  }

  if (validKeys.includes('shop_id')) {
    const rawShopId = parseInt(updates.shop_id, 10);
    if (!Number.isFinite(rawShopId) || rawShopId < 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: '`shop_id` must be a non-negative integer (0 clears the assignment).' });
    }
    if (rawShopId > 0) {
      const [shopRows] = await pool.query('SELECT id FROM shops WHERE id = ? AND area_id = ?', [rawShopId, areaId]);
      if (shopRows.length === 0) {
        return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Shop ID ${rawShopId} does not exist.` });
      }
    }
    updates.shop_id = rawShopId;
  }

  const [existing] = await pool.query('SELECT id FROM products WHERE id IN (?) AND deleted = 0 AND area_id = ?', [numericIds, areaId]);
  const validIds = existing.map(r => r.id);
  const skipped = numericIds.length - validIds.length;

  if (validIds.length === 0) {
    return res.status(200).json({ updated: 0, skipped: numericIds.length, errors: [] });
  }

  const setClauses = [];
  const setValues = [];

  if (validKeys.includes('available')) {
    setClauses.push('available = ?');
    setValues.push(updates.available === true || updates.available === 'true' || updates.available === 1 ? 1 : 0);
  }
  if (validKeys.includes('featured')) {
    setClauses.push('featured = ?');
    setValues.push(updates.featured === true || updates.featured === 'true' || updates.featured === 1 ? 1 : 0);
  }
  if (validKeys.includes('category_id')) {
    setClauses.push('category_id = ?');
    setValues.push(updates.category_id);
  }
  if (validKeys.includes('shop_id')) {
    setClauses.push('shop_id = ?');
    setValues.push(updates.shop_id === 0 ? null : updates.shop_id);
  }

  setValues.push(validIds, areaId);
  await pool.query(`UPDATE products SET ${setClauses.join(', ')} WHERE id IN (?) AND area_id = ?`, setValues);

  await bustAreaCaches(areaId);
  return res.status(200).json({ updated: validIds.length, skipped, errors: [] });
};

const bulkDeleteProducts = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: '`ids` must be a non-empty array of product IDs.' });
  }
  const numericIds = ids.map(id => parseInt(id, 10)).filter(id => Number.isFinite(id) && id > 0);
  if (numericIds.length === 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'No valid numeric product IDs provided.' });
  }

  const [result] = await pool.query('UPDATE products SET deleted = 1 WHERE id IN (?) AND deleted = 0 AND area_id = ?', [numericIds, areaId]);
  const deleted = result.affectedRows;
  const skipped = numericIds.length - deleted;

  // Collect image_ids from rows we actually soft-deleted, then clean up any
  // images that are no longer referenced by any active record.
  if (deleted > 0) {
    try {
      const [softDeleted] = await pool.query(
        'SELECT DISTINCT image_id FROM products WHERE id IN (?) AND image_id IS NOT NULL AND area_id = ?',
        [numericIds, areaId]
      );
      const imageIds = softDeleted.map(r => r.image_id).filter(Boolean);
      for (const imageId of imageIds) {
        await cleanupOrphanedImage(imageId);
      }
    } catch (e) {
      console.error('[bulkDeleteProducts] image cleanup error:', e.message);
    }
  }

  await bustAreaCaches(areaId);
  return res.status(200).json({ deleted, skipped, errors: [] });
};

// PATCH /api/admin/products/pricing — grid-style price editing (VARIANTS ARE
// SEPARATE ROWS in the admin UI, per the "treat variants as different
// products" requirement). Unlike PUT /products/:id (full replace of the
// whole product) or PATCH /products/bulk (one value applied to many ids),
// this takes one row per product-or-variant, each with its own price/shopPrice,
// and touches only those two columns. Body: { rows: [{ productId, variantId?,
// price?, shopPrice? }] }, max 200 rows per call (grid page size, not a hard
// product limit). Omitted price/shopPrice on a row leaves that column
// untouched; explicit null clears shopPrice.
const updateProductPricing = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;

  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: '`rows` must be a non-empty array.' });
  }
  if (rows.length > 200) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'At most 200 rows per request.' });
  }

  const errors = [];
  const cleanRows = [];
  rows.forEach((row, index) => {
    const productId = parseInt(row.productId ?? row.product_id, 10);
    if (!Number.isFinite(productId) || productId <= 0) {
      errors.push({ index, message: 'productId is required' });
      return;
    }
    const rawVariantId = row.variantId ?? row.variant_id;
    const variantId = rawVariantId !== undefined && rawVariantId !== null ? parseInt(rawVariantId, 10) : null;
    if (rawVariantId !== undefined && rawVariantId !== null && (!Number.isFinite(variantId) || variantId <= 0)) {
      errors.push({ index, productId, message: 'variantId must be a valid id' });
      return;
    }

    const hasPrice = row.price !== undefined && row.price !== null && row.price !== '';
    if (hasPrice && !isNumericAmount(row.price)) {
      errors.push({ index, productId, message: 'price must be a valid amount' });
      return;
    }
    const rawShopPrice = row.shopPrice !== undefined ? row.shopPrice : row.shop_price;
    const clearsShopPrice = rawShopPrice === null || rawShopPrice === '';
    const hasShopPrice = rawShopPrice !== undefined && !clearsShopPrice;
    if (hasShopPrice && !isNumericAmount(rawShopPrice)) {
      errors.push({ index, productId, message: 'shopPrice must be a valid amount' });
      return;
    }
    if (!hasPrice && !hasShopPrice && !clearsShopPrice) {
      errors.push({ index, productId, message: 'At least one of price or shopPrice is required' });
      return;
    }

    cleanRows.push({
      productId,
      variantId,
      price: hasPrice ? Number(row.price) : undefined,
      shopPrice: hasShopPrice ? Number(rawShopPrice) : (clearsShopPrice ? null : undefined),
    });
  });

  if (cleanRows.length === 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'No valid rows to update.', errors });
  }

  const connection = await pool.getConnection();
  let updated = 0;
  const touchedProductIds = new Set();
  try {
    await connection.beginTransaction();
    for (const row of cleanRows) {
      if (row.variantId) {
        const sets = [];
        const values = [];
        if (row.price !== undefined) { sets.push('price = ?'); values.push(row.price); }
        if (row.shopPrice !== undefined) { sets.push('shop_price = ?'); values.push(row.shopPrice); }
        if (sets.length === 0) continue;
        values.push(row.variantId, row.productId, areaId);
        // AND product_id = ? prevents a variantId from one product silently
        // repricing a different product (cross-product id abuse). The EXISTS
        // clause is the area guard — product_variants has no area_id of its
        // own, so it's enforced through the parent product row.
        const [result] = await connection.query(
          `UPDATE product_variants SET ${sets.join(', ')} WHERE id = ? AND product_id = ? AND deleted = 0
           AND EXISTS (SELECT 1 FROM products WHERE products.id = product_variants.product_id AND products.area_id = ?)`,
          values
        );
        if (result.affectedRows === 0) {
          errors.push({ productId: row.productId, variantId: row.variantId, message: 'Variant not found for this product' });
          continue;
        }
        updated += 1;
        touchedProductIds.add(row.productId);
      } else {
        const sets = [];
        const values = [];
        if (row.price !== undefined) { sets.push('price = ?'); values.push(row.price); }
        if (row.shopPrice !== undefined) { sets.push('shop_price = ?'); values.push(row.shopPrice); }
        if (sets.length === 0) continue;
        values.push(row.productId, areaId);
        const [result] = await connection.query(
          `UPDATE products SET ${sets.join(', ')} WHERE id = ? AND deleted = 0 AND area_id = ?`,
          values
        );
        if (result.affectedRows === 0) {
          errors.push({ productId: row.productId, message: 'Product not found' });
          continue;
        }
        updated += 1;
      }
    }

    // A variant row's price/shop_price may have just diverged from the
    // products.price/shop_price mirror — re-sync each touched product from
    // its (possibly still-default) variant, same invariant as syncProductVariants.
    for (const productId of touchedProductIds) {
      await syncProductFromDefaultVariant(connection, productId);
    }

    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }

  await bustAreaCaches(areaId);
  res.status(200).json({ updated, skipped: cleanRows.length - updated, errors });
};

// Re-export with bulk additions
Object.assign(module.exports, { bulkUpdateProducts, bulkDeleteProducts, updateProductPricing });
