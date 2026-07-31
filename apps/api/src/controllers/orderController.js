const { pool } = require('../db/mysql');

const notificationService = require('../utils/notificationService');
const realtimeEvents = require('../realtime/orderEvents');
const adminInbox = require('../utils/adminNotifications');
const orderAutoAccept = require('../realtime/orderAutoAccept');
const { roundMoney, toMoney } = require('../utils/money');
const { isCodBlockedDuringNight } = require('../utils/nightDelivery');
const { calculateRainCharge } = require('../utils/rainCharge');
const { resolveDeliveryPricing, loadActiveZones, loadActiveExclusionZones } = require('../utils/deliveryPricing');
const { validateCoupon, validateCouponById, pickBestAutoApply } = require('../utils/coupons');

// Expected business failures → 400. clientCode lets specific failures carry a
// distinct machine-readable code (e.g. OUT_OF_DELIVERY_RANGE) while everything
// else keeps the legacy VALIDATION_ERROR.
class OrderError extends Error {
  constructor(message, clientCode) {
    super(message);
    this.clientCode = clientCode;
  }
}

const generateOrderNumber = async (connection) => {
  const date = new Date();
  const istDate = date.toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).split(',')[0];
  const dateStr = istDate.replace(/-/g, '');
  const prefix = `OD-${dateStr}-`;

  if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) {
    return `${prefix}TEST`;
  }

  // Atomically reserve the next sequence for this date. LAST_INSERT_ID is
  // per-connection, so two concurrent checkouts on separate connections can
  // never collide — the INSERT ... ON DUPLICATE KEY UPDATE serializes on the
  // PRIMARY KEY, and SELECT LAST_INSERT_ID() returns the new seq value.
  await connection.query(
    `INSERT INTO daily_order_counters (counter_date, seq) VALUES (?, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE seq = LAST_INSERT_ID(seq + 1)`,
    [istDate]
  );
  const [rows] = await connection.query(`SELECT LAST_INSERT_ID() AS seq`);
  const nextSeq = (rows[0].seq).toString().padStart(4, '0');
  return `${prefix}${nextSeq}`;
};

const getCancelledPaymentStatus = (paymentMethod) => (
  paymentMethod === 'UPI' ? 'Refunded' : 'Failed'
);

// Build the idempotent-replay response from a real orders row. Used by both
// the pre-check path (SELECT inside the transaction) and the ER_DUP_ENTRY
// race path (concurrent INSERT lost to a unique-index conflict). Real
// subtotal/total/status/payment_status come from the row so the client
// sees the current order state, not the placeholder values it had on
// first response (e.g. an order that was Accepted between two retries).
const buildReplayOrderJson = (existing, itemsRows, couponSnap, req) => {
  const paymentMethod = req.validatedData?.payment_method;
  const address = req.validatedData?.address;
  const deliveryType = req.validatedData?.delivery_type || 'standard';
  const replayOrder = {
    id: existing.id,
    orderId: existing.id,
    orderNumber: existing.order_number,
    order_number: existing.order_number,
    address: address || null,
    subtotal: Number(existing.subtotal),
    deliveryCharge: null,
    nightCharge: null,
    rainCharge: null,
    fastDeliveryFee: null,
    discount: Number(couponSnap.discount_amount) || 0,
    freeDeliveryWaiver: Number(couponSnap.free_delivery_waiver_amount) || 0,
    itemDiscount: roundMoney((Number(couponSnap.discount_amount) || 0) - (Number(couponSnap.free_delivery_waiver_amount) || 0)),
    total: Number(existing.total),
    paymentMethod: paymentMethod,
    payment_method: paymentMethod,
    paymentStatus: existing.payment_status,
    payment_status: existing.payment_status,
    status: existing.status,
    created_at: existing.idempotency_key_created_at,
    createdAt: existing.idempotency_key_created_at
      ? new Date(existing.idempotency_key_created_at).toISOString()
      : null,
    deliveryType: deliveryType,
    delivery_type: deliveryType,
    couponId: couponSnap.coupon_id || null,
    couponCode: couponSnap.coupon_code || null,
    couponTitle: couponSnap.coupon_title || null,
    items: itemsRows.map(item => ({
      productId: item.product_id,
      variantId: item.variant_id, variant_id: item.variant_id,
      variantLabel: item.variant_label, variant_label: item.variant_label,
      name: item.product_name,
      quantity: item.quantity,
      unitPrice: item.unit_price,
      lineTotal: item.line_total,
      type: item.item_type
    }))
  };
  return {
    message: 'Order already exists (idempotent replay)',
    orderId: existing.id,
    orderNumber: existing.order_number,
    order: replayOrder,
    data: replayOrder,
    idempotent: true,
  };
};

// Re-checks per-user and global usage limits AFTER the coupon row has been
// locked (SELECT ... FOR UPDATE) inside the order transaction, so two
// concurrent checkouts on the same coupon serialize. Returns a reason string
// when a limit is hit, or null when the coupon is still usable.
const recheckUsageUnderLock = async (connection, coupon, userId) => {
  if (coupon.per_user_usage_limit !== null && coupon.per_user_usage_limit !== undefined && coupon.per_user_usage_limit > 0) {
    const [userRedeemRows] = await connection.query(
      "SELECT COUNT(*) as count FROM coupon_redemptions WHERE coupon_id = ? AND user_id = ? AND status = 'active'",
      [coupon.id, userId]
    );
    const userUsed = Number(userRedeemRows[0]?.count) || 0;
    if (userUsed >= coupon.per_user_usage_limit) {
      return `You've already used this coupon ${userUsed} time(s) (limit: ${coupon.per_user_usage_limit})`;
    }
  }
  if (coupon.total_usage_limit !== null && coupon.total_usage_limit !== undefined) {
    const [globalRedeemRows] = await connection.query(
      "SELECT COUNT(*) as count FROM coupon_redemptions WHERE coupon_id = ? AND status = 'active'",
      [coupon.id]
    );
    const globalUsed = Number(globalRedeemRows[0]?.count) || 0;
    if (globalUsed >= coupon.total_usage_limit) {
      return 'This coupon has reached its maximum usage limit';
    }
  }
  return null;
};

const createOrder = async (req, res) => {
  const userId = req.user.id;
  const { address, latitude, longitude, map_url, payment_method, note, items, delivery_type } = req.validatedData;

  const headers = (req && req.headers) || {};
  const idempotencyKey =
    headers['idempotency-key'] ||
    headers['Idempotency-Key'] ||
    null;

  const connection = await pool.getConnection();
  await connection.beginTransaction();

  // The ER_DUP_ENTRY replay path releases the connection early and then
  // queries via the pool; if one of those queries throws, the outer catch
  // must not rollback/release a second time — mysql2 raises on double
  // release, which would mask the real error.
  let connectionReleased = false;
  const releaseConnection = () => {
    if (connectionReleased) return;
    connectionReleased = true;
    connection.release();
  };

  try {
    if (idempotencyKey) {
      const [existingRows] = await connection.query(
        `SELECT id, order_number, idempotency_key_created_at,
                subtotal, total, status, payment_status,
                TIMESTAMPDIFF(SECOND, idempotency_key_created_at, NOW()) AS age_seconds
         FROM orders
         WHERE customer_id = ? AND idempotency_key = ? AND idempotency_key_created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
         ORDER BY id DESC LIMIT 1
         FOR UPDATE`,
        [userId, idempotencyKey]
      );
      if (Array.isArray(existingRows) && existingRows.length > 0) {
        const existing = existingRows[0];
        const [itemsRows] = await connection.query(
          'SELECT product_id, variant_id, variant_label, item_type, product_name, quantity, unit_price, line_total FROM order_items WHERE order_id = ?',
          [existing.id]
        );
        const [couponRows] = await connection.query(
          'SELECT coupon_id, coupon_code, coupon_title, discount_amount, free_delivery_waiver_amount FROM orders WHERE id = ?',
          [existing.id]
        );
        const couponSnap = couponRows[0] || {};
        await connection.commit();
        releaseConnection();
        return res.status(200).json(buildReplayOrderJson(existing, itemsRows, couponSnap, req));
      }
    }

    const [userRows] = await connection.query('SELECT id, name, phone, whatsapp_number, address, blocked FROM users WHERE id = ?', [userId]);
    const user = userRows[0];
    if (!user) {
      await connection.rollback();
      releaseConnection();
      return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Session is no longer valid. Please log in again.' });
    }
    if (user.blocked) {
      await connection.rollback();
      releaseConnection();
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Your account is blocked' });
    }

    const [settingRows] = await connection.query('SELECT shop_open, delivery_available, delivery_charge, night_charge, night_charge_start, night_charge_end, rain_charge_enabled, rain_charge, fast_delivery_enabled, fast_delivery_charge, standard_delivery_minutes, fast_delivery_minutes, shop_latitude, shop_longitude, radius_pricing_active FROM settings LIMIT 1');
    const settings = settingRows[0];

    if (settings.shop_open === 0 || settings.shop_open === false) throw new OrderError('Shop is currently closed');
    if (settings.delivery_available === 0 || settings.delivery_available === false) throw new OrderError('Delivery is currently unavailable');

    if (isCodBlockedDuringNight(settings) && payment_method === 'Cash') {
      throw new OrderError('Cash on Delivery is not available during night delivery hours. Please choose UPI.');
    }

    if (items.length > 100) throw new OrderError('Too many items in one order (max 100).');

    let subtotal = 0;
    const orderItems = [];

    const productEntries = [];
    const comboEntries = [];
    for (const item of items) {
      const isCombo = item.type === 'combo' || item.isCombo || item.is_combo;
      const productId = item.product_id || item.productId;
      if (isCombo) comboEntries.push({ item, productId });
      else productEntries.push({ item, productId });
    }

    const productById = new Map();
    const comboById = new Map();

    if (productEntries.length > 0) {
      const productIds = productEntries.map(e => e.productId);
      const [prodRows] = await connection.query(
        'SELECT id, name, price, shop_price, shop_id FROM products WHERE id IN (?) AND available = 1 AND deleted = 0 AND (shop_id IS NULL OR EXISTS (SELECT 1 FROM shops s WHERE s.id = products.shop_id AND s.is_open = 1 AND s.active = 1)) AND (group_id IS NULL OR EXISTS (SELECT 1 FROM product_groups g WHERE g.id = products.group_id AND g.active = 1))',
        [productIds]
      );
      for (const row of prodRows) productById.set(Number(row.id), row);
    }

    if (comboEntries.length > 0) {
      const comboIds = comboEntries.map(e => e.productId);
      const [comboRows] = await connection.query(
        'SELECT id, name, price FROM combos WHERE id IN (?) AND available = 1 AND deleted = 0',
        [comboIds]
      );
      for (const row of comboRows) comboById.set(Number(row.id), row);
    }

    // Batch fetch variants referenced by the order items (one query for all
    // distinct non-null variant ids). Combos never carry a variant.
    const variantById = new Map();
    const variantIdsInOrder = [...new Set(
      items
        .filter(it => {
          const isCombo = it.type === 'combo' || it.isCombo || it.is_combo;
          const vid = it.variant_id || it.variantId || null;
          return vid !== null && vid !== undefined && !isCombo;
        })
        .map(it => Number(it.variant_id || it.variantId))
    )];
    if (variantIdsInOrder.length > 0) {
      const [variantRows] = await connection.query(
        'SELECT id, product_id, label, price, shop_price, available, deleted FROM product_variants WHERE id IN (?)',
        [variantIdsInOrder]
      );
      for (const row of variantRows) variantById.set(Number(row.id), row);
    }

    for (const item of items) {
      const isCombo = item.type === 'combo' || item.isCombo || item.is_combo;
      const productId = item.product_id || item.productId;
      const product = isCombo ? comboById.get(Number(productId)) : productById.get(Number(productId));

      if (!product) throw new OrderError(`${isCombo ? 'Combo' : 'Product'} ID ${productId} is unavailable or does not exist`);

      const quantity = Number(item.quantity);
      const rawVariantId = item.variant_id || item.variantId || null;
      const variantId = rawVariantId !== null && rawVariantId !== undefined ? Number(rawVariantId) : null;
      let unitPrice;
      // Shop-cost snapshot (VillKro's payable to the shop for this line).
      // NULL when the item has no shop price configured, or is a combo
      // (combos never carry a shop_id either — see effectiveVariantId below).
      let shopUnitPrice = null;
      let productName = product.name;
      let variantLabel = null;

      if (variantId !== null && !isCombo) {
        // Server-authoritative variant pricing — independent of the cart path.
        // ALL four conditions must hold (blocks forged cross-product variant ids).
        const variant = variantById.get(variantId);
        if (!variant || variant.deleted || !variant.available || Number(variant.product_id) !== Number(productId)) {
          throw new OrderError('Selected option is unavailable or does not exist');
        }
        unitPrice = toMoney(variant.price);
        shopUnitPrice = variant.shop_price !== null && variant.shop_price !== undefined ? toMoney(variant.shop_price) : null;
        variantLabel = variant.label;
        productName = `${product.name} (${variant.label})`;
      } else {
        unitPrice = toMoney(product.price);
        shopUnitPrice = !isCombo && product.shop_price !== null && product.shop_price !== undefined ? toMoney(product.shop_price) : null;
      }

      const lineTotal = roundMoney(unitPrice * quantity);
      const shopLineTotal = shopUnitPrice !== null ? roundMoney(shopUnitPrice * quantity) : null;

      subtotal += lineTotal;
      // Combos never carry a variant — force null so an unvalidated
      // client-sent variantId is never persisted as if it had been checked.
      const effectiveVariantId = isCombo ? null : variantId;
      const effectiveVariantLabel = isCombo ? null : variantLabel;
      orderItems.push({
        product_id: product.id,
        variant_id: effectiveVariantId,
        variant_label: effectiveVariantLabel,
        shop_id: isCombo ? null : (product.shop_id || null),
        product_name: productName,
        quantity,
        unit_price: unitPrice,
        line_total: lineTotal,
        shop_unit_price: shopUnitPrice,
        shop_line_total: shopLineTotal,
        item_type: isCombo ? 'combo' : 'product'
      });
    }

    subtotal = roundMoney(subtotal);

    // Radius-zone pricing (server-authoritative — never trusts the preview the
    // client saw). Read + pure compute inside the existing transaction; the
    // resolver falls back to legacy flat pricing when zone mode isn't fully
    // configured or the order has no coordinates ("Enter Manually").
    const zones = settings.radius_pricing_active ? await loadActiveZones(connection) : [];
    // Exclusion squares block delivery regardless of zone/flat pricing mode.
    const exclusionZones = await loadActiveExclusionZones(connection);
    const pricing = resolveDeliveryPricing({
      customerLat: latitude,
      customerLng: longitude,
      deliveryType: delivery_type,
      settings,
      zones,
      exclusionZones,
    });

    if (pricing.outOfRange) {
      throw new OrderError(
        'Delivery is not available at this location. Please choose a closer address.',
        'OUT_OF_DELIVERY_RANGE'
      );
    }
    if (pricing.excluded) {
      throw new OrderError(
        pricing.exclusionMessage || 'Delivery is not available at this location.',
        'DELIVERY_EXCLUDED'
      );
    }
    if (payment_method === 'Cash' && !pricing.codAllowed) {
      throw new OrderError(
        'Cash on Delivery is not available at your location. Please pay via UPI.',
        'COD_NOT_AVAILABLE'
      );
    }

    // Fast delivery is an ADD-ON, not a replacement: `deliveryCharge` stays
    // the STANDARD fee (zone-aware via the resolver) even on fast orders,
    // including for every coupon-engine call, so free-delivery coupons keep
    // waiving the standard fee exactly as on a standard order (see
    // cartController for the full rationale). The fast fee is never passed
    // into the engine, so it's never discounted.
    const deliveryCharge = roundMoney(toMoney(pricing.standardDeliveryCharge));
    const standardDeliveryCharge = deliveryCharge;

    const fastEnabled = Boolean(settings.fast_delivery_enabled);
    const isFastDelivery = delivery_type === 'fast' && fastEnabled;
    // Additive fast-delivery fee actually charged on this order.
    const fastDeliveryFee = isFastDelivery ? roundMoney(toMoney(pricing.fastDeliveryCharge)) : 0;
    const finalDeliveryType = isFastDelivery ? 'fast' : 'standard';

    let nightCharge = pricing.nightCharge > 0 ? toMoney(pricing.nightCharge) : 0;

    let rainCharge = 0;
    if (settings.rain_charge_enabled) {
      const raw = calculateRainCharge(settings);
      if (raw > 0) rainCharge = toMoney(raw);
    }

    // ───────────────────────────────────────────────────────────────────
    // Coupon / offer application (server-side re-validation, race-safe).
    // Only ONE coupon applies per order (no stacking). If the user sent a
    // coupon_code, validate it inside this transaction. Otherwise, try
    // auto-apply. The per-user and global usage limits are enforced with
    // SELECT ... FOR UPDATE on the coupon row so two concurrent
    // checkouts can't both consume a one-time coupon.
    // ───────────────────────────────────────────────────────────────────
    const couponCode = req.validatedData.coupon_code || req.validatedData.couponCode || (req.body && (req.body.coupon_code || req.body.couponCode)) || null;
    // Identifies a specific no-code offer the user tapped in the cart (see
    // cartController for why code alone isn't enough to identify these).
    const couponId = req.validatedData.coupon_id || req.validatedData.couponId || (req.body && (req.body.coupon_id || req.body.couponId)) || null;
    // Set once the user explicitly removed their applied coupon in the cart —
    // must not silently auto-apply a different coupon's discount at checkout.
    const noAutoApply = req.validatedData.no_auto_apply === true || req.validatedData.noAutoApply === true
      || (req.body && (req.body.no_auto_apply === true || req.body.noAutoApply === true));
    // True when the coupon on this order was AUTO-applied by the cart rather
    // than typed or tapped by the user. Owner decision (2026-07-04): if an
    // auto-applied coupon lapsed between cart and checkout, place the order
    // without the discount; only a user-chosen coupon should hard-error.
    const couponAutoApplied = req.validatedData.coupon_auto_applied === true || req.validatedData.couponAutoApplied === true
      || (req.body && (req.body.coupon_auto_applied === true || req.body.couponAutoApplied === true));
    let discount = 0;
    let freeDeliveryWaiver = 0;
    let appliedCoupon = null;
    let couponDropped = false;

    const zoneId = pricing.zone ? pricing.zone.id : null;

    if (couponCode || couponId) {
      const result = couponCode
        ? await validateCoupon({ code: couponCode, subtotal, deliveryCharge, standardDeliveryCharge, userId, zoneId, connection })
        : await validateCouponById({ couponId, subtotal, deliveryCharge, standardDeliveryCharge, userId, zoneId, connection });
      let failReason = result.ok ? null : (result.reason || 'Coupon is not valid');
      if (!failReason) {
        await connection.query('SELECT id FROM coupons WHERE id = ? FOR UPDATE', [result.coupon.id]);
        failReason = await recheckUsageUnderLock(connection, result.coupon, userId);
      }
      if (failReason) {
        if (!couponAutoApplied) {
          throw new OrderError(failReason);
        }
        couponDropped = true;
      } else {
        discount = roundMoney(result.discount);
        freeDeliveryWaiver = result.freeDeliveryWaiver !== undefined
          ? roundMoney(result.freeDeliveryWaiver)
          : (result.coupon.discount_type === 'free_delivery' ? discount : 0);
        appliedCoupon = result.coupon;
      }
    } else if (!noAutoApply) {
      let best = await pickBestAutoApply({ subtotal, deliveryCharge, standardDeliveryCharge, userId, zoneId, connection });
      if (best) {
        await connection.query('SELECT id FROM coupons WHERE id = ? FOR UPDATE', [best.coupon.id]);
        const failReason = await recheckUsageUnderLock(connection, best.coupon, userId);
        if (failReason) {
          best = null;
        }
        if (best) {
          discount = roundMoney(best.discount);
          freeDeliveryWaiver = best.freeDeliveryWaiver !== undefined
            ? roundMoney(best.freeDeliveryWaiver)
            : (best.coupon.discount_type === 'free_delivery' ? discount : 0);
          appliedCoupon = best.coupon;
        }
      }
    }

    const total = roundMoney(Math.max(0, subtotal + standardDeliveryCharge + fastDeliveryFee + nightCharge + rainCharge - discount));
    const orderNumber = await generateOrderNumber(connection);

    const finalAddress = address || user.address;
    if (!finalAddress) throw new OrderError('Address is required');

    let orderId;
    try {
      const [orderResult] = await connection.query(
        `INSERT INTO orders (
          order_number, customer_id, customer_name, phone, whatsapp_number, address,
          latitude, longitude, map_url, subtotal, delivery_charge, night_charge, rain_charge, fast_delivery_charge, total,
          payment_method, payment_status, status, note,
          delivery_distance_km, delivery_radius_km_snapshot, delivery_cost_per_km_snapshot,
          free_delivery_offer_snapshot, delivery_zone_id, delivery_eta_minutes_snapshot, delivery_type,
          idempotency_key, idempotency_key_created_at,
          coupon_id, coupon_code, coupon_title, discount_amount, free_delivery_waiver_amount
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', 'Pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          orderNumber, userId, user.name, user.phone, user.whatsapp_number, finalAddress,
          latitude || null, longitude || null, map_url || null,
          subtotal, standardDeliveryCharge, nightCharge, rainCharge, fastDeliveryFee, total,
          payment_method, note || null,
          pricing.distanceKm, pricing.zone ? pricing.zoneExtentKm : null, null,
          null,
          pricing.zone ? pricing.zone.id : null,
          pricing.etaMinutes,
          finalDeliveryType,
          idempotencyKey, idempotencyKey ? new Date() : null,
          appliedCoupon ? appliedCoupon.id : null,
          appliedCoupon ? appliedCoupon.code : null,
          appliedCoupon ? appliedCoupon.title : null,
          discount,
          freeDeliveryWaiver,
        ]
      );
      orderId = orderResult.insertId;
    } catch (insertErr) {
      // Race-safe replay: a concurrent request with the same idempotency
      // key beat us to the INSERT and the unique index rejected ours. Roll
      // back our transaction, re-fetch the existing order via the pool
      // (our connection is no longer usable for the read after rollback),
      // and return the same replay shape as the pre-check path. Any other
      // ER_DUP_ENTRY (e.g. order_number collision) keeps its existing
      // behavior — let it propagate to the global handler.
      if (
        idempotencyKey &&
        (insertErr.code === 'ER_DUP_ENTRY' || insertErr.errno === 1062) &&
        typeof insertErr.message === 'string' &&
        insertErr.message.includes('idx_orders_idempotency')
      ) {
        await connection.rollback();
        releaseConnection();
        const [existingRows2] = await pool.query(
          `SELECT id, order_number, idempotency_key_created_at,
                  subtotal, total, status, payment_status
           FROM orders
           WHERE customer_id = ? AND idempotency_key = ?
           ORDER BY id DESC LIMIT 1`,
          [userId, idempotencyKey]
        );
        if (existingRows2.length === 0) {
          // Should be unreachable — the unique-index violation proved a row
          // exists. Surface the original error instead of inventing a fake
          // replay so the client can retry if needed.
          throw insertErr;
        }
        const existing2 = existingRows2[0];
        const [itemsRows2] = await pool.query(
          'SELECT product_id, variant_id, variant_label, item_type, product_name, quantity, unit_price, line_total FROM order_items WHERE order_id = ?',
          [existing2.id]
        );
        const [couponRows2] = await pool.query(
          'SELECT coupon_id, coupon_code, coupon_title, discount_amount, free_delivery_waiver_amount FROM orders WHERE id = ?',
          [existing2.id]
        );
        const couponSnap2 = couponRows2[0] || {};
        return res.status(200).json(buildReplayOrderJson(existing2, itemsRows2, couponSnap2, req));
      }
      throw insertErr;
    }

    if (orderItems.length > 0) {
      const placeholders = orderItems.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
      const values = [];
      for (const oi of orderItems) {
        values.push(
          orderId, oi.product_id, oi.variant_id || null, oi.variant_label || null, oi.shop_id || null,
          oi.item_type || 'product', oi.product_name, oi.quantity, oi.unit_price, oi.line_total,
          oi.shop_unit_price ?? null, oi.shop_line_total ?? null
        );
      }
      await connection.query(
        `INSERT INTO order_items (order_id, product_id, variant_id, variant_label, shop_id, item_type, product_name, quantity, unit_price, line_total, shop_unit_price, shop_line_total) VALUES ${placeholders}`,
        values
      );
    }

    if (appliedCoupon && discount > 0) {
      await connection.query(
        'INSERT INTO coupon_redemptions (coupon_id, user_id, order_id, discount_amount) VALUES (?, ?, ?, ?)',
        [appliedCoupon.id, userId, orderId, discount]
      );
    }

    await connection.commit();
    releaseConnection();

    const order = {
      id: orderId,
      orderId,
      customerId: userId,
      customerName: user.name,
      customer_name: user.name,
      customerPhone: user.phone,
      phone: user.phone,
      orderNumber,
      order_number: orderNumber,
      address: finalAddress,
      latitude: latitude || null,
      longitude: longitude || null,
      map_url: map_url || null,
      mapUrl: map_url || null,
      subtotal,
      deliveryCharge: standardDeliveryCharge,
      nightCharge,
      rainCharge,
      fastDeliveryFee,
      discount,
      freeDeliveryWaiver,
      itemDiscount: roundMoney(discount - freeDeliveryWaiver),
      total,
      paymentMethod: payment_method,
      payment_method,
      paymentStatus: 'Pending',
      payment_status: 'Pending',
      status: 'Pending',
      created_at: new Date(),
      createdAt: new Date().toISOString(),
      deliveryDistanceKm: pricing.distanceKm,
      deliveryRadiusKmSnapshot: pricing.zone ? pricing.zoneExtentKm : null,
      deliveryCostPerKmSnapshot: null,
      freeDeliveryOfferSnapshot: null,
      deliveryZoneId: pricing.zone ? pricing.zone.id : null,
      delivery_zone_id: pricing.zone ? pricing.zone.id : null,
      deliveryEtaMinutes: pricing.etaMinutes,
      delivery_eta_minutes: pricing.etaMinutes,
      deliveryType: finalDeliveryType,
      deliveryMessage: freeDeliveryWaiver > 0
        ? 'Free delivery unlocked!'
        : `₹${standardDeliveryCharge} delivery applied.`,
      couponId: appliedCoupon ? appliedCoupon.id : null,
      couponCode: appliedCoupon ? appliedCoupon.code : null,
      couponTitle: appliedCoupon ? appliedCoupon.title : null,
      // True when an auto-applied offer lapsed between cart and checkout and
      // the order was placed at regular price instead (see coupon block above).
      couponDropped,
      items: orderItems.map(item => ({
        productId: item.product_id,
        variantId: item.variant_id, variant_id: item.variant_id,
        variantLabel: item.variant_label, variant_label: item.variant_label,
        name: item.product_name,
        quantity: item.quantity,
        unitPrice: item.unit_price,
        lineTotal: item.line_total,
        type: item.item_type
      }))
    };

    notificationService.createOrderNotification({ userId, order, event: 'order_placed' })
      .then(result => realtimeEvents.emitNotificationCreated(userId, result))
      .catch(err => console.error('[notify]', err.message));

    realtimeEvents.emitOrderCreated(order);

    adminInbox.createAdminNotification({
      type: adminInbox.TYPES.NEW_ORDER,
      title: `New order #${orderNumber}`,
      body: `${order.customer_name || 'Customer'} placed an order — ₹${Number(order.total).toFixed(0)}`,
      relatedUrl: `/orders?id=${orderId}`,
      relatedId: String(orderId),
    });

    orderAutoAccept.schedule(orderId, orderNumber);

    res.status(201).json({
      message: 'Order placed successfully',
      orderId,
      orderNumber,
      order,
      data: order
    });
  } catch (error) {
    if (!connectionReleased) {
      try {
        await connection.rollback();
      } finally {
        releaseConnection();
      }
    }
    if (error instanceof OrderError) {
      return res.status(400).json({ code: error.clientCode || 'VALIDATION_ERROR', message: error.message });
    }
    throw error;
  }
};

const getOrders = async (req, res) => {
  const userId = req.user.id;
  const rawLimit = Number.parseInt(req.query.limit, 10);
  const rawOffset = Number.parseInt(req.query.offset, 10);
  const limit = Math.min(50, Math.max(1, Number.isNaN(rawLimit) ? 20 : rawLimit));
  const offset = Math.max(0, Number.isNaN(rawOffset) ? 0 : rawOffset);
  const { date } = req.query;

  let where = 'o.customer_id = ?';
  const params = [userId];
  if (date) {
    where += ' AND DATE(o.created_at) = ?';
    params.push(date);
  }

  const [rows] = await pool.query(
    `SELECT o.*, (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) as item_count
     FROM orders o WHERE ${where} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM orders o WHERE ${where}`,
    params
  );
  const total = Number(countRows[0].total);
  const orders = rows.map(o => ({ ...o, canCancel: o.status === 'Pending' }));
  res.status(200).json({
    data: orders,
    meta: {
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
    },
  });
};

const getOrderById = async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  const [orderRows] = await pool.query('SELECT * FROM orders WHERE id = ? AND customer_id = ?', [id, userId]);

  if (orderRows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Order not found' });
  }

  const order = orderRows[0];
  const [itemsRows] = await pool.query('SELECT * FROM order_items WHERE order_id = ?', [id]);

  order.items = itemsRows;
  order.canCancel = order.status === 'Pending';

  // Additive per-order shop pins for live tracking. Existing fields untouched.
  // Hidden before the order leaves Pending (per product decision).
  if (order.status !== 'Pending') {
    const [shopRows] = await pool.query(
      `SELECT DISTINCT s.id, s.name, s.latitude, s.longitude
       FROM order_items oi JOIN shops s ON s.id = oi.shop_id
       WHERE oi.order_id = ? AND s.active = 1`,
      [id]
    );
    order.shops = shopRows.map((s) => ({
      id: s.id,
      name: s.name,
      latitude: s.latitude != null ? Number(s.latitude) : null,
      longitude: s.longitude != null ? Number(s.longitude) : null,
    }));
  }

  // Additive rider last-position for live tracking (TASK 4). Existing fields untouched.
  // Phone: riders.phone first, else linked users.phone (for customer "Contact Rider").
  if (order.rider_id) {
    const [riderRows] = await pool.query(
      `SELECT r.id, r.user_id, r.display_name, r.phone AS rider_phone,
              u.phone AS user_phone, r.last_lat, r.last_lng, r.last_location_at
       FROM riders r
       LEFT JOIN users u ON u.id = r.user_id
       WHERE r.id = ?`,
      [order.rider_id]
    );
    if (riderRows.length > 0) {
      const r = riderRows[0];
      const phone = r.rider_phone || r.user_phone || null;
      order.rider = {
        id: r.id,
        userId: r.user_id,
        user_id: r.user_id,
        displayName: r.display_name,
        display_name: r.display_name,
        phone,
        lastLat: r.last_lat != null ? Number(r.last_lat) : null,
        lastLng: r.last_lng != null ? Number(r.last_lng) : null,
        lastLocationAt: r.last_location_at,
        last_lat: r.last_lat != null ? Number(r.last_lat) : null,
        last_lng: r.last_lng != null ? Number(r.last_lng) : null,
        last_location_at: r.last_location_at,
      };
    }
  }

  res.status(200).json({ data: order });
};

const cancelOrder = async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;
  const { reason } = req.body;

  if (reason && reason.length > 500) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Reason must not exceed 500 characters' });
  }

  const [orderRows] = await pool.query('SELECT * FROM orders WHERE id = ? AND customer_id = ?', [id, userId]);

  if (orderRows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Order not found' });
  }

  const order = orderRows[0];

  if (order.status === 'Cancelled') {
    return res.status(200).json({ success: true, message: 'Order already cancelled', order, data: order });
  }

  if (order.status !== 'Pending') {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Only pending orders can be cancelled' });
  }

  const cancelledPaymentStatus = getCancelledPaymentStatus(order.payment_method);
  const { resolveCancelReason } = require('../utils/cancelReasons');
  // Prefer customer-facing message; optional free-text reason from body still accepted for audit.
  const cancelReason = (reason && String(reason).trim())
    ? String(reason).trim()
    : resolveCancelReason('customer');
  const [cancelResult] = await pool.query(
    'UPDATE orders SET status = "Cancelled", payment_status = ?, cancel_reason = ? WHERE id = ? AND status = "Pending"',
    [cancelledPaymentStatus, cancelReason, id]
  );

  if (cancelResult.affectedRows === 0) {
    const [freshRows] = await pool.query('SELECT * FROM orders WHERE id = ? AND customer_id = ?', [id, userId]);
    const freshOrder = freshRows[0];
    if (freshOrder && freshOrder.status === 'Cancelled') {
      return res.status(200).json({ success: true, message: 'Order already cancelled', order: freshOrder, data: freshOrder });
    }
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Only pending orders can be cancelled' });
  }

  // Soft-cancel the coupon redemption so one-use coupons can be retried by
  // the customer after a cancellation. Only 'active' rows count toward usage
  // limits, so this restores their quota while keeping an audit trail.
  if (order.coupon_id) {
    await pool.query(
      "UPDATE coupon_redemptions SET status = 'cancelled' WHERE order_id = ? AND coupon_id = ?",
      [id, order.coupon_id]
    );
  }

  const updatedOrder = {
    ...order,
    status: 'Cancelled',
    payment_status: cancelledPaymentStatus,
    cancel_reason: cancelReason,
    cancelReason,
    updated_at: new Date().toISOString(),
  };

  notificationService.createOrderNotification({ userId, order: updatedOrder, event: 'status_cancelled' })
    .then(result => realtimeEvents.emitNotificationCreated(userId, result))
    .catch(err => console.error('[notify]', err.message));

  realtimeEvents.emitOrderCancelled(updatedOrder);

  res.status(200).json({ success: true, message: 'Order cancelled successfully', order: updatedOrder, data: updatedOrder });
};

module.exports = {
  createOrder,
  getOrders,
  getOrderById,
  cancelOrder,
  generateOrderNumber
};