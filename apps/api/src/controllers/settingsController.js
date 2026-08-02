const { pool } = require('../db/mysql');
const { normalizeStoreType } = require('../utils/storeMode');
const { createTtlCache } = require('../utils/ttlCache');
const config = require('../config/env');
const { cleanupOrphanedImage } = require('./imageController');
const { syncGlobalShopOpenState } = require('../utils/shops');
const { requestAreaId, getDefaultArea, bustAreaCaches } = require('../utils/areaScope');

// Settings is a singleton (1 row) today, read by every app open and every
// public endpoint. 15-second cache eliminates most SELECTs while keeping
// settings fresh. Invalidated on PATCH.
//
// Key is already area-shaped (`settings:<areaId>`) even though `settings`
// itself is still a single global row — TASK 9 makes it one row per area;
// this plumbing means that swap only needs to replace the hardcoded `1`
// below with a real req.areaId, not touch the cache key format.
const settingsCache = createTtlCache({ ttlMs: 15_000 });
const SETTINGS_AREA_ID_STOPGAP = 1;
const settingsKey = (areaId) => `settings:${areaId}`;

const hasValue = (value) => value !== undefined && value !== null && value !== '';
const getStoredImageUrl = (image) => image?.url ||
  image?.imageUrl ||
  image?.image_url ||
  (image?.filename ? `${config.PUBLIC_BASE_URL}${config.STATIC_UPLOAD_PATH}/${image.filename}` : null);

const validateNonNegativeNumber = (value, message) => {
  if (!hasValue(value)) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return { code: 'VALIDATION_ERROR', message };
  }
  return null;
};

const MAX_DELIVERY_MINUTES = 24 * 60 - 1;
const validatePositiveInt = (value, fieldLabel) => {
  if (!hasValue(value)) return null;
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > MAX_DELIVERY_MINUTES) {
    return {
      code: 'VALIDATION_ERROR',
      message: `${fieldLabel} must be a whole number between 1 and ${MAX_DELIVERY_MINUTES} minutes`,
    };
  }
  return null;
};

const attachSettingsImageUrls = async (settings) => {
  if (!settings) return settings;

  settings.upi_qr_image_url = null;
  settings.upiQrImageUrl = null;

  const imageId = settings.upi_qr_image_id;
  if (!imageId || !/^\d+$/.test(String(imageId))) {
    return settings;
  }

  const [imageRows] = await pool.query('SELECT id, url FROM images WHERE id = ?', [imageId]);
  const imageUrl = getStoredImageUrl(imageRows[0]);

  if (imageUrl) {
    settings.upi_qr_image_url = imageUrl;
    settings.upiQrImageUrl = imageUrl;
  }

  return settings;
};

const attachOfferImageUrls = async (offers) => {
  const rows = Array.isArray(offers) ? offers : [offers].filter(Boolean);
  const imageIds = rows
    .map(row => row.image_id)
    .filter(id => id && /^\d+$/.test(String(id)));

  if (imageIds.length === 0) return offers;

  const [images] = await pool.query('SELECT id, url FROM images WHERE id IN (?)', [imageIds]);
  const imageMap = {};
  images.forEach(image => {
    imageMap[String(image.id)] = getStoredImageUrl(image);
  });

  rows.forEach(row => {
    if (row.image_id && imageMap[row.image_id]) {
      row.imageUrl = imageMap[row.image_id];
      row.image_url = imageMap[row.image_id];
    }
    if (row.is_clickable !== undefined) {
      row.isClickable = Boolean(row.is_clickable);
      row.is_clickable = Boolean(row.is_clickable);
    }
  });

  return offers;
};

const attachOfferProductImageUrls = async (products) => {
  const rows = Array.isArray(products) ? products : [products].filter(Boolean);
  const imageIds = rows
    .map(row => row.image_id)
    .filter(id => id && /^\d+$/.test(String(id)));

  if (imageIds.length === 0) return products;

  const [images] = await pool.query('SELECT id, url FROM images WHERE id IN (?)', [imageIds]);
  const imageMap = {};
  images.forEach(image => {
    imageMap[String(image.id)] = getStoredImageUrl(image);
  });

  rows.forEach(row => {
    if (row.image_id && imageMap[row.image_id]) {
      row.imageUrl = imageMap[row.image_id];
      row.image_url = imageMap[row.image_id];
    }
  });

  return products;
};

const getSettings = async (req, res) => {
  // resolveCustomerArea (mounted on this route) resolves req.areaId: a real
  // area id when the pin matched a zone (or there was no pin, falling back
  // to the customer's last area / the platform default), or null when a
  // supplied pin fell outside every zone. Settings is lightweight, mostly
  // non-delivery info (app version gate, support contact) — falling back to
  // the default area here rather than erroring is deliberately more lenient
  // than the catalog/dashboard endpoints, which must show "we don't deliver
  // here" for that same null (§2.4). getSettings never does.
  let areaId = requestAreaId(req);
  if (typeof areaId !== 'number') {
    const defaultArea = await getDefaultArea();
    areaId = defaultArea ? defaultArea.id : 1;
  }

  const settings = await settingsCache.wrap(settingsKey(areaId), async () => {
    const [rows] = await pool.query('SELECT * FROM settings WHERE area_id = ? LIMIT 1', [areaId]);
    const s = rows[0] || {
      shop_open: 1,
      minimum_order_amount: 50,
      delivery_charge: 10,
      night_charge: 0,
      rain_charge_enabled: 0,
      rain_charge: 0,
      support_phone: '',
      support_whatsapp: '',
      shop_latitude: null,
      shop_longitude: null,
      delivery_radius_km: 8.00,
      delivery_cost_per_km: 0.00,
      below_threshold_delivery_charge: 20.00,
      free_delivery_above_minimum_active: 1,
      free_delivery_offer_active: 0,
      upi_qr_image_id: null,
      minimum_version: null,
      current_version: null,
    };
    return attachSettingsImageUrls(s);
  });

  res.status(200).json({ data: settings });
};

const getActiveOffer = async (req, res) => {
  const { store_type, storeType } = req.query;
  const finalStoreType = store_type || storeType || 'packed';
  let query = 'SELECT * FROM offers WHERE active = 1 AND deleted = 0';
  const params = [];

  if (finalStoreType) {
    // A client can hold a stale/deactivated mode slug — fall back to 'all'
    // instead of erroring the public active-offer endpoint.
    let normalizedStoreType = 'all';
    try {
      normalizedStoreType = await normalizeStoreType(finalStoreType, { allowAll: true });
    } catch {
      normalizedStoreType = 'all';
    }
    if (normalizedStoreType !== 'all') {
      query += ' AND store_type = ?';
      params.push(normalizedStoreType);
    }
  }

  query += ' ORDER BY id DESC LIMIT 1';
  const [rows] = await pool.query(query, params);
  
  if (rows.length === 0) {
    return res.status(200).json({ data: null });
  }

  await attachOfferImageUrls(rows[0]);
  res.status(200).json({ data: rows[0] });
};

const updateSettings = async (req, res) => {
  // req.areaId is set by resolveAdminArea, chained inside requireAdmin
  // (TASK 8): a real number for an area_admin (always their own area) or a
  // super_admin who picked one via X-Area-Id. This is a write targeting
  // exactly one area's settings, so — unlike getSettings — null (no header)
  // and 'all' are both rejected outright rather than guessed at (§2.10:
  // Settings is one of the endpoints that must refuse 'all').
  const areaId = requestAreaId(req);
  if (areaId === null) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'X-Area-Id is required to update settings' });
  }
  if (areaId === 'all') {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Settings cannot be updated for "all" areas at once — pick one area' });
  }

  const fields = [
    'shop_open', 'delivery_available', 'minimum_order_amount', 'delivery_charge',
    'night_charge', 'night_charge_start', 'night_charge_end',
    'rain_charge_enabled', 'rain_charge',
    'whatsapp_number', 'support_phone', 'upi_id', 'upi_qr_image_id',
    'below_threshold_delivery_charge', 'free_delivery_above_minimum_active',
    'free_delivery_offer_active', 'fast_delivery_enabled', 'fast_delivery_charge',
    'standard_delivery_minutes', 'fast_delivery_minutes',
    'minimum_version',
    'current_version',
    // Radius-zone pricing: master switch + center pin (revived for zone mode)
    'radius_pricing_active', 'shop_latitude', 'shop_longitude',
    // DEPRECATED (no longer used): free_delivery_above,
    // delivery_radius_km, delivery_cost_per_km
  ];

  const body = req.body;

  const moneyFields = [
    ['minimum_order_amount', 'Minimum order amount cannot be negative'],
    ['delivery_charge', 'Standard delivery charge cannot be negative'],
    ['night_charge', 'Night delivery surcharge cannot be negative'],
    ['rain_charge', 'Rain charge cannot be negative'],
    ['below_threshold_delivery_charge', 'Below-threshold delivery charge cannot be negative'],
    ['fast_delivery_charge', 'Fast delivery charge cannot be negative']
  ];

  for (const [field, message] of moneyFields) {
    const error = validateNonNegativeNumber(body[field], message);
    if (error) return res.status(400).json(error);
  }

  const intFields = [
    ['standard_delivery_minutes', 'Standard delivery time'],
    ['fast_delivery_minutes', 'Fast delivery time'],
  ];
  for (const [field, label] of intFields) {
    const error = validatePositiveInt(body[field], label);
    if (error) return res.status(400).json(error);
  }

  // Validate night charge window requires an actual charge
  if (hasValue(body.night_charge_start) && hasValue(body.night_charge_end)) {
    const nightCharge = Number(body.night_charge);
    if (!Number.isFinite(nightCharge) || nightCharge <= 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Night delivery surcharge must be > 0 if start and end times are set' });
    }
  }

  // Validate coordinates when provided
  if (hasValue(body.shop_latitude)) {
    const lat = Number(body.shop_latitude);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Latitude must be between -90 and 90' });
    }
  }
  if (hasValue(body.shop_longitude)) {
    const lng = Number(body.shop_longitude);
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Longitude must be between -180 and 180' });
    }
  }

  // Prevent negative values for delivery radius and per-km cost
  if (hasValue(body.delivery_radius_km)) {
    const radius = Number(body.delivery_radius_km);
    if (!Number.isFinite(radius) || radius < 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Delivery radius cannot be negative' });
    }
  }
  if (hasValue(body.delivery_cost_per_km)) {
    const cost = Number(body.delivery_cost_per_km);
    if (!Number.isFinite(cost) || cost < 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Delivery cost per km cannot be negative' });
    }
  }

  // Turning zone pricing ON requires at least one active zone — each zone is
  // now its own self-contained polygon, so there's no shared center pin to
  // require. This guard is load-bearing, not cosmetic: the resolver fails
  // CLOSED once the flag is on, so enabling it with zero zones would refuse
  // delivery to every customer instead of degrading to flat pricing.
  if (hasValue(body.radius_pricing_active)) {
    const wantsRadiusPricing = body.radius_pricing_active === true || body.radius_pricing_active === 'true'
      || body.radius_pricing_active === 1 || body.radius_pricing_active === '1';
    if (wantsRadiusPricing) {
      // area_id here matters for real: without it, area 1's admin could
      // enable radius pricing believing zones exist, when the count was
      // actually coming from a DIFFERENT area's zones.
      const [zoneRows] = await pool.query('SELECT COUNT(*) AS count FROM delivery_zones WHERE active = 1 AND area_id = ?', [areaId]);
      if (Number(zoneRows[0]?.count) === 0) {
        return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Add at least one active delivery zone before enabling radius pricing' });
      }
    }
  }

  // App version strings — column is VARCHAR(20); reject anything that
  // wouldn't fit or isn't a plausible version (digits/dots, e.g. "1.2.3").
  for (const field of ['minimum_version', 'current_version']) {
    if (hasValue(body[field]) && !/^[0-9]+(\.[0-9]+){0,3}$/.test(String(body[field]))) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: `${field} must be a version string like 1.2.3 (max 20 characters)` });
    }
  }

  // Master gate: delivery_available off means the business isn't
  // delivering, full stop — shop_open can't be open alongside it. (The
  // auto-open/auto-close side of this rule, triggered by individual shops
  // opening/closing, lives in syncGlobalShopOpenState.)
  if (hasValue(body.shop_open)) {
    const wantsOpen = body.shop_open === true || body.shop_open === 'true' || body.shop_open === 1 || body.shop_open === '1';
    if (wantsOpen) {
      if (hasValue(body.delivery_available)) {
        // Same request carries both fields (the Settings page "save all"
        // sends the whole form). If delivery is being turned off, silently
        // coerce shop_open closed instead of rejecting — the admin's intent
        // is clearly "delivery off", and the post-write sync would force
        // shop_open to 0 anyway.
        const deliveryAvailable = body.delivery_available === true || body.delivery_available === 'true' || body.delivery_available === 1 || body.delivery_available === '1';
        if (!deliveryAvailable) {
          body.shop_open = 0;
        }
      } else {
        // shop_open-only request (the Dashboard's standalone toggle) — an
        // explicit attempt to open while delivery is off gets a clear error.
        const [currentRows] = await pool.query('SELECT delivery_available FROM settings WHERE area_id = ? LIMIT 1', [areaId]);
        const deliveryAvailable = currentRows.length > 0 ? Boolean(currentRows[0].delivery_available) : true;
        if (!deliveryAvailable) {
          return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Cannot open Shop Status while delivery is turned off.' });
        }
      }
    }
  }

  const updates = [];
  const params = [];

  for (const field of fields) {
    if (body[field] !== undefined) {
      updates.push(`${field} = ?`);
      let val = body[field];
      if (['shop_open', 'delivery_available', 'free_delivery_offer_active', 'free_delivery_above_minimum_active', 'rain_charge_enabled', 'radius_pricing_active'].includes(field)) {
        val = (val === true || val === 'true' || val === 1 || val === '1') ? 1 : 0;
      } else if ([
        'minimum_order_amount',
        'delivery_charge',
        'night_charge',
        'rain_charge',
        'below_threshold_delivery_charge',
        'shop_latitude',
        'shop_longitude'
        // DEPRECATED: free_delivery_above,
        // delivery_radius_km, delivery_cost_per_km — no longer stored
      ].includes(field)) {
        val = (val === null || val === '') ? null : Number(val);
      }
      params.push(val);
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'No valid fields provided' });
  }

  const [rows] = await pool.query('SELECT id, upi_qr_image_id FROM settings WHERE area_id = ? LIMIT 1', [areaId]);
  let settingsId = rows[0]?.id;
  const previousImageId = rows[0]?.upi_qr_image_id;
  if (rows.length === 0) {
    // Should be unreachable once TASK 24's area-creation endpoint calls
    // createSettingsForArea (below) for every new area — kept as a safety
    // net, not the primary path.
    const [insertResult] = await pool.query('INSERT INTO settings (area_id, shop_open) VALUES (?, 1)', [areaId]);
    settingsId = insertResult?.insertId;
  }

  // area_id in the WHERE is redundant with id (already a unique per-row
  // key) — kept anyway as a defense-in-depth guard against settingsId ever
  // resolving to the wrong area's row.
  await pool.query(`UPDATE settings SET ${updates.join(', ')} WHERE id = ? AND area_id = ?`, [...params, settingsId, areaId]);
  settingsCache.del(settingsKey(areaId));
  // delivery_available just changed — re-derive shop_open from it (forces
  // closed if delivery just went off, or auto-opens if it just came back on
  // and some shop is open).
  if (body.delivery_available !== undefined) {
    await syncGlobalShopOpenState();
    settingsCache.del(settingsKey(areaId));
  }
  if (
    body.upi_qr_image_id !== undefined &&
    previousImageId &&
    String(previousImageId) !== String(body.upi_qr_image_id)
  ) {
    await cleanupOrphanedImage(previousImageId);
  }
  const [updatedRows] = await pool.query('SELECT * FROM settings WHERE area_id = ? LIMIT 1', [areaId]);
  const updatedSettings = await attachSettingsImageUrls(updatedRows[0]);

  // Manual admin flip of the global banner (or a delivery_available change
  // that re-derived it above) — push the final value to customer apps so
  // their "shop closed" banner updates without waiting for a settings poll.
  if (body.shop_open !== undefined || body.delivery_available !== undefined) {
    const { emitToAllCustomers } = require('../realtime/socket');
    const finalOpen = Boolean(updatedSettings?.shop_open);
    emitToAllCustomers('settings.shop_open.updated', { shopOpen: finalOpen, shop_open: finalOpen });
  }

  await bustAreaCaches(areaId);
  res.status(200).json({ message: 'Settings updated successfully', data: updatedSettings });
};

const createOffer = async (req, res) => {
  const { title, description, active, image_id, imageId, store_type, storeType, is_clickable, isClickable } = req.body;
  const finalImageId = image_id || imageId || null;
  const finalStoreType = await normalizeStoreType(store_type || storeType);
  const clickableInput = is_clickable !== undefined ? is_clickable : isClickable;
  const finalIsClickable = (clickableInput === true || clickableInput === 'true' || clickableInput === 1 || clickableInput === '1') ? 1 : 0;

  if (!title) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Title is required' });
  }

  const isActive = (active === true || active === 'true' || active === 1 || active === '1') ? 1 : 0;
  if (isActive && !finalImageId) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'An active offer must have an image.' });
  }

  const [result] = await pool.query(
    'INSERT INTO offers (title, description, active, image_id, store_type, is_clickable) VALUES (?, ?, ?, ?, ?, ?)',
    [title, description || '', isActive, finalImageId, finalStoreType, finalIsClickable]
  );

  // offers isn't area-scoped yet (TASK 12) — stopgap area 1, same pattern as TASK 4.
  await bustAreaCaches(1);
  res.status(201).json({ message: 'Offer created', id: result.insertId });
};

const updateOffer = async (req, res) => {
  const { id } = req.params;
  const { title, description, active, image_id, imageId, is_clickable, isClickable } = req.body;

  const [existingRows] = await pool.query('SELECT * FROM offers WHERE id = ? AND deleted = 0', [id]);
  if (existingRows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Offer not found' });
  }
  const existingOffer = existingRows[0];
  const previousImageId = existingOffer.image_id;

  const updates = [];
  const params = [];

  if (title !== undefined) {
    updates.push('title = ?');
    params.push(title);
  }

  if (description !== undefined) {
    updates.push('description = ?');
    params.push(description);
  }

  const clickableInput = is_clickable !== undefined ? is_clickable : isClickable;
  if (clickableInput !== undefined) {
    updates.push('is_clickable = ?');
    params.push((clickableInput === true || clickableInput === 'true' || clickableInput === 1 || clickableInput === '1') ? 1 : 0);
  }

  const finalImageId = image_id !== undefined ? image_id : (imageId !== undefined ? imageId : undefined);
  if (finalImageId !== undefined) {
    updates.push('image_id = ?');
    params.push(finalImageId);
  }

  const nextActive = active !== undefined
    ? (active === true || active === 'true' || active === 1 || active === '1')
    : (existingOffer.active === true || existingOffer.active === 1 || existingOffer.active === '1' || existingOffer.active === 'true');

  const nextImageId = finalImageId !== undefined ? finalImageId : existingOffer.image_id;
  if (nextActive && !nextImageId) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'An active offer must have an image.' });
  }

  if (active !== undefined) {
    updates.push('active = ?');
    params.push(nextActive ? 1 : 0);
  }

  const finalStoreTypeInput = req.body.store_type || req.body.storeType;
  const targetStoreType = finalStoreTypeInput !== undefined
    ? await normalizeStoreType(finalStoreTypeInput)
    : existingOffer.store_type;
  if (finalStoreTypeInput !== undefined) {
    updates.push('store_type = ?');
    params.push(targetStoreType);
  }

  if (updates.length === 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'No valid fields provided' });
  }

  params.push(id);
  await pool.query(`UPDATE offers SET ${updates.join(', ')} WHERE id = ?`, params);

  if (previousImageId && finalImageId !== undefined && String(previousImageId) !== String(finalImageId)) {
    await cleanupOrphanedImage(previousImageId);
  }

  await bustAreaCaches(1); // offers isn't area-scoped yet (TASK 12) — stopgap area 1.
  res.status(200).json({ message: 'Offer updated' });
};

const getAdminOffers = async (req, res) => {
  const { store_type, storeType } = req.query;
  const finalStoreType = store_type || storeType;
  let query = 'SELECT * FROM offers WHERE deleted = 0';
  const params = [];

  if (finalStoreType) {
    const normalizedStoreType = await normalizeStoreType(finalStoreType, { allowAll: true });
    if (normalizedStoreType !== 'all') {
      query += ' AND store_type = ?';
      params.push(normalizedStoreType);
    }
  }

  query += ' ORDER BY id DESC';
  const [rows] = await pool.query(query, params);
  await attachOfferImageUrls(rows);
  res.status(200).json({ data: rows });
};

const deleteOffer = async (req, res) => {
  const { id } = req.params;
  const [rows] = await pool.query('SELECT id, image_id FROM offers WHERE id = ? AND deleted = 0', [id]);
  if (rows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Offer not found' });
  }
  await pool.query('UPDATE offers SET deleted = 1 WHERE id = ? AND deleted = 0', [id]);
  await cleanupOrphanedImage(rows[0].image_id);
  await bustAreaCaches(1); // offers isn't area-scoped yet (TASK 12) — stopgap area 1.
  res.status(200).json({ message: 'Offer soft deleted' });
};


const getOfferProducts = async (req, res) => {
  const { id } = req.params;
  const [rows] = await pool.query(`
    SELECT op.id as offer_product_id, op.offer_id, op.product_id, op.display_order as op_display_order, op.active as op_active,
           p.*, c.name as category_name, c.type as category_type
    FROM offer_products op
    JOIN products p ON op.product_id = p.id
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE op.offer_id = ?
    ORDER BY op.display_order ASC, p.display_order ASC, p.id ASC
  `, [id]);

  await attachOfferProductImageUrls(rows);

  res.status(200).json({ data: rows });
};

const addOfferProduct = async (req, res) => {
  const { id } = req.params;
  const { product_id, productId, display_order } = req.body;
  const finalProductId = product_id || productId;

  if (!finalProductId) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'product_id is required' });
  }

  const [offerRows] = await pool.query('SELECT store_type, deleted FROM offers WHERE id = ?', [id]);
  if (offerRows.length === 0 || offerRows[0].deleted) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Offer not found or deleted' });
  }

  const [productRows] = await pool.query(`
    SELECT p.id, p.deleted, p.available, p.is_combo, c.type as category_type 
    FROM products p 
    LEFT JOIN categories c ON p.category_id = c.id 
    WHERE p.id = ?`, [finalProductId]);
  
  if (productRows.length === 0 || productRows[0].deleted) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Product not found or deleted' });
  }

  const product = productRows[0];
  if (!product.available) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Product is unavailable' });
  }
  if (product.is_combo) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Combos cannot be added to offers directly yet' });
  }
  if (product.category_type !== offerRows[0].store_type) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Product store mode (${product.category_type}) does not match offer mode (${offerRows[0].store_type})` });
  }

  try {
    await pool.query(
      'INSERT INTO offer_products (offer_id, product_id, display_order) VALUES (?, ?, ?)',
      [id, finalProductId, display_order || 0]
    );
    await bustAreaCaches(1); // offers isn't area-scoped yet (TASK 12) — stopgap area 1.
    res.status(201).json({ message: 'Product added to offer' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      await bustAreaCaches(1);
      res.status(200).json({ message: 'Product already attached' });
    } else {
      throw err;
    }
  }
};

const removeOfferProduct = async (req, res) => {
  const { id, productId } = req.params;
  await pool.query('DELETE FROM offer_products WHERE offer_id = ? AND product_id = ?', [id, productId]);
  await bustAreaCaches(1); // offers isn't area-scoped yet (TASK 12) — stopgap area 1.
  res.status(200).json({ message: 'Product removed from offer' });
};

const reorderOfferProducts = async (req, res) => {
  const { id } = req.params;
  const { productIds } = req.body;
  
  if (!Array.isArray(productIds)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'productIds array is required' });
  }

  for (let i = 0; i < productIds.length; i++) {
    await pool.query('UPDATE offer_products SET display_order = ? WHERE offer_id = ? AND product_id = ?', [i, id, productIds[i]]);
  }

  await bustAreaCaches(1); // offers isn't area-scoped yet (TASK 12) — stopgap area 1.
  res.status(200).json({ message: 'Products reordered' });
};

// Every area needs exactly one settings row (§9.3) — called by TASK 24's
// POST /admin/areas inside the same transaction that creates the area
// itself. Not called from anywhere yet; updateSettings's own INSERT above
// is the safety net until TASK 24 lands. Accepts an optional connection so
// the caller can run it inside its own transaction instead of a separate
// pool.query.
const createSettingsForArea = async (areaId, connection = pool) => {
  await connection.query('INSERT IGNORE INTO settings (area_id, shop_open) VALUES (?, 1)', [areaId]);
};

module.exports = {
  getSettings,
  getActiveOffer,
  updateSettings,
  createOffer,
  updateOffer,
  getAdminOffers,
  deleteOffer,
  getOfferProducts,
  addOfferProduct,
  removeOfferProduct,
  reorderOfferProducts,
  createSettingsForArea,
  // For code that writes settings outside this controller (e.g.
  // syncGlobalShopOpenState flipping shop_open) — without this, public
  // /api/settings keeps serving the stale cached value for up to 15s.
  bustSettingsCache: () => settingsCache.del(settingsKey(SETTINGS_AREA_ID_STOPGAP)),
};
