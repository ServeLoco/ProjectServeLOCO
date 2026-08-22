const { pool } = require('../db/mysql');
const { riderShape, syncDeliveryAvailabilityFromRiders } = require('../utils/riders');
const assignment = require('../services/riderAssignment');
const notificationService = require('../utils/notificationService');
const realtimeEvents = require('../realtime/orderEvents');
const { emitToCustomer, emitToAdmins } = require('../realtime/socket');
const { validateCoordinates } = require('../validators');

const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const shapeOrderSummary = (o) => {
  if (!o) return null;
  const lat = numOrNull(o.latitude);
  const lng = numOrNull(o.longitude);
  return {
    id: o.id,
    orderNumber: o.order_number,
    order_number: o.order_number,
    status: o.status,
    address: o.address,
    latitude: lat,
    longitude: lng,
    lat,
    lng,
    phone: o.phone,
    customerName: o.customer_name,
    customer_name: o.customer_name,
    paymentMethod: o.payment_method,
    payment_method: o.payment_method,
    paymentStatus: o.payment_status,
    payment_status: o.payment_status,
    total: o.total,
    deliveryType: o.delivery_type,
    delivery_type: o.delivery_type,
    note: o.note,
    riderId: o.rider_id,
    rider_id: o.rider_id,
    riderAssignedAt: o.rider_assigned_at,
    rider_assigned_at: o.rider_assigned_at,
    riderPickedUpAt: o.rider_picked_up_at,
    rider_picked_up_at: o.rider_picked_up_at,
    riderAssignmentStatus: o.rider_assignment_status,
    rider_assignment_status: o.rider_assignment_status,
    createdAt: o.created_at,
    created_at: o.created_at,
  };
};

const shapeShopPin = (row) => ({
  id: row.id,
  name: row.name,
  latitude: numOrNull(row.latitude),
  longitude: numOrNull(row.longitude),
  lat: numOrNull(row.latitude),
  lng: numOrNull(row.longitude),
});

const shapeItemRow = (it, shopName = it.shop_name || null) => ({
  id: it.id,
  productName: it.product_name,
  product_name: it.product_name,
  quantity: it.quantity,
  variantLabel: it.variant_label,
  variant_label: it.variant_label,
  shopId: it.shop_id,
  shop_id: it.shop_id,
  shopName,
  shop_name: shopName,
  unitPrice: it.unit_price,
  unit_price: it.unit_price,
  lineTotal: it.line_total,
  line_total: it.line_total,
  // A shop's reject/confirm is all-or-nothing per shop (shopOrderActions),
  // so these mirror straight off this item's own timestamps.
  accepted: Boolean(it.shop_confirmed_at),
  rejected: Boolean(it.shop_rejected_at),
});

/**
 * Attach shops + items to a batch of order rows in two queries total
 * (IN (...) on order_id) instead of two queries per order — the multi-order
 * list endpoints can return up to 20 active jobs.
 */
const loadAssignmentExtrasBatch = async (orderRows) => {
  if (!orderRows.length) return [];
  const orderIds = orderRows.map((o) => o.id);

  const [shopRows] = await pool.query(
    `SELECT DISTINCT oi.order_id, s.id, s.name, s.latitude, s.longitude
     FROM order_items oi
     JOIN shops s ON s.id = oi.shop_id
     WHERE oi.order_id IN (?) AND oi.shop_id IS NOT NULL`,
    [orderIds]
  );
  const [itemRows] = await pool.query(
    `SELECT id, order_id, product_name, quantity, variant_label, shop_id, unit_price, line_total,
            shop_confirmed_at, shop_rejected_at
     FROM order_items WHERE order_id IN (?)`,
    [orderIds]
  );

  const shopsByOrder = new Map();
  const shopNameById = new Map();
  for (const row of shopRows) {
    if (!shopsByOrder.has(row.order_id)) shopsByOrder.set(row.order_id, []);
    shopsByOrder.get(row.order_id).push(shapeShopPin(row));
    shopNameById.set(row.id, row.name);
  }
  const itemsByOrder = new Map();
  // Per order, per shop: the shaped items plus the raw decision timestamps
  // needed to roll a shop-level accepted/rejected/pending status up from
  // its (all-or-nothing) items — mirrors adminController's shopConfirmations
  // logic, but scoped to what the rider view needs (status + item list).
  const shopEntriesByOrder = new Map();
  for (const row of itemRows) {
    if (!itemsByOrder.has(row.order_id)) itemsByOrder.set(row.order_id, []);
    const shapedItem = shapeItemRow(row, shopNameById.get(row.shop_id) || null);
    itemsByOrder.get(row.order_id).push(shapedItem);

    if (row.shop_id != null) {
      if (!shopEntriesByOrder.has(row.order_id)) shopEntriesByOrder.set(row.order_id, new Map());
      const byShop = shopEntriesByOrder.get(row.order_id);
      if (!byShop.has(row.shop_id)) byShop.set(row.shop_id, []);
      byShop.get(row.shop_id).push({
        item: shapedItem,
        confirmed: row.shop_confirmed_at != null,
        rejected: row.shop_rejected_at != null,
      });
    }
  }

  return orderRows.map((orderRow) => {
    const order = shapeOrderSummary(orderRow);
    const shopPins = shopsByOrder.get(orderRow.id) || [];
    const byShop = shopEntriesByOrder.get(orderRow.id) || new Map();
    // Shop pins carry a status ('accepted' | 'rejected' | 'pending') and
    // their own item list, so the rider app can render "Shop A accepted: 2
    // items, Shop B rejected: 1 item" without a second lookup — this is the
    // breakdown a rider sees once shops make mixed decisions on a
    // multi-shop order (maybeStartRiderAssignment now offers the order as
    // soon as at least one shop confirms, instead of requiring all of them).
    order.shops = shopPins.map((shop) => {
      const entries = byShop.get(shop.id) || [];
      const accepted = entries.length > 0 && entries.every((e) => e.confirmed);
      const rejected = entries.length > 0 && entries.every((e) => e.rejected);
      const status = rejected ? 'rejected' : (accepted ? 'accepted' : 'pending');
      return {
        ...shop,
        status,
        accepted,
        rejected,
        items: entries.map((e) => e.item),
      };
    });
    order.items = itemsByOrder.get(orderRow.id) || [];
    return order;
  });
};

const loadAssignmentExtras = async (orderRow) => {
  const [order] = await loadAssignmentExtrasBatch([orderRow]);
  return order;
};

const shapeOffer = (row) => {
  if (!row) return null;
  const expiresAt = row.expires_at;
  const expiresMs = expiresAt ? new Date(expiresAt).getTime() : 0;
  const secondsRemaining = Math.max(0, Math.floor((expiresMs - Date.now()) / 1000));
  return {
    id: row.id,
    offerId: row.id,
    orderId: row.order_id,
    order_id: row.order_id,
    status: row.status,
    expiresAt,
    expires_at: expiresAt,
    secondsRemaining,
    seconds_remaining: secondsRemaining,
    // Lets the popup's progress bar scale to the real timeout instead of a
    // hardcoded client constant that would silently drift if
    // RIDER_OFFER_TIMEOUT_SEC is ever overridden via env.
    offerTimeoutSec: assignment.RIDER_OFFER_TIMEOUT_SEC,
    offer_timeout_sec: assignment.RIDER_OFFER_TIMEOUT_SEC,
    orderNumber: row.order_number,
    order_number: row.order_number,
    total: row.total,
    deliveryType: row.delivery_type,
    delivery_type: row.delivery_type,
    // Address is needed for the accept/reject decision; customer phone is
    // withheld until the rider actually accepts (see shapeOrderSummary).
    address: row.address || null,
    customerName: row.customer_name || null,
    customer_name: row.customer_name || null,
  };
};

// GET /api/rider/me — this rider's profile + online state + active assignments.
const getMe = async (req, res) => {
  const rider = riderShape(req.rider);
  const [assignRows] = await pool.query(
    `SELECT * FROM orders
     WHERE rider_id = ? AND status NOT IN ('Delivered', 'Cancelled')
     ORDER BY rider_assigned_at DESC, id DESC
     LIMIT 20`,
    [req.rider.id]
  );
  const [offerRows] = await pool.query(
    `SELECT o.*, ord.order_number, ord.address, ord.phone, ord.customer_name
     FROM rider_order_offers o
     JOIN orders ord ON ord.id = o.order_id
     WHERE o.rider_id = ? AND o.status = 'pending' AND o.expires_at > NOW()
     ORDER BY o.id ASC
     LIMIT 10`,
    [req.rider.id]
  );

  const assignments = await loadAssignmentExtrasBatch(assignRows);
  const pendingOffers = offerRows.map(shapeOffer);
  res.status(200).json({
    rider,
    isOnline: rider.isOnline,
    is_online: rider.is_online,
    // Primary/latest for backward compat; full list for multi-order.
    currentAssignment: assignments[0] || null,
    current_assignment: assignments[0] || null,
    currentAssignments: assignments,
    current_assignments: assignments,
    // Offer queue (oldest first) — popup shows one at a time, then next.
    activeOffer: pendingOffers[0] || null,
    active_offer: pendingOffers[0] || null,
    activeOffers: pendingOffers,
    active_offers: pendingOffers,
  });
};

// PATCH /api/rider/me/online — body { isOnline | is_online: boolean }.
// Sets is_online, then syncs settings.delivery_available from active rider count.
// Going offline is blocked while the rider still has undelivered assignments.
const setOnline = async (req, res) => {
  const raw = req.body.isOnline !== undefined ? req.body.isOnline : req.body.is_online;
  if (typeof raw !== 'boolean') {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'isOnline (boolean) is required',
    });
  }

  if (raw) {
    await pool.query(
      'UPDATE riders SET is_online = 1 WHERE id = ?',
      [req.rider.id]
    );
  } else {
    const [[active]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM orders
       WHERE rider_id = ? AND status NOT IN ('Delivered', 'Cancelled')`,
      [req.rider.id]
    );
    const activeCount = Number(active?.cnt || 0);
    if (activeCount > 0) {
      return res.status(400).json({
        code: 'ACTIVE_ASSIGNMENTS',
        message: activeCount === 1
          ? 'Deliver your active order before going offline or signing out.'
          : `Deliver all ${activeCount} active orders before going offline or signing out.`,
        activeCount,
        active_count: activeCount,
      });
    }
    await pool.query(
      'UPDATE riders SET is_online = 0 WHERE id = ?',
      [req.rider.id]
    );
  }

  const [rows] = await pool.query(
    `SELECT id, user_id, area_id, display_name, phone, active, is_online
     FROM riders WHERE id = ?`,
    [req.rider.id]
  );
  req.rider = rows[0];

  // Fire-and-await so the response reflects the new delivery gate; never throws.
  await syncDeliveryAvailabilityFromRiders(req.rider.area_id);

  const rider = riderShape(req.rider);

  // Realtime fan-out so admin Riders page updates without refresh.
  try {
    const { emitToAdmins } = require('../realtime/socket');
    emitToAdmins(req.rider.area_id, 'admin.rider.updated', {
      ...rider,
      reason: raw ? 'online' : 'offline',
    });
  } catch (_) { /* best-effort */ }

  res.status(200).json({
    message: 'Rider online status updated',
    rider,
    isOnline: rider.isOnline,
    is_online: rider.is_online,
  });
};

// POST /api/rider/me/location — latest GPS while assigned (mutable columns; no trail).
// Persists always; emits rider.location.updated to the customer only when an
// active assignment exists (status NOT IN Delivered/Cancelled — same as getCurrentAssignment).
const updateLocation = async (req, res) => {
  const body = req.body || {};
  const lat = body.lat ?? body.latitude;
  const lng = body.lng ?? body.longitude;

  if (!validateCoordinates(lat, lng)) {
    return res.status(400).json({
      code: 'INVALID_COORDINATES',
      message: 'Invalid latitude/longitude',
    });
  }

  const latitude = Number(lat);
  const longitude = Number(lng);

  await pool.query(
    'UPDATE riders SET last_lat = ?, last_lng = ?, last_location_at = NOW() WHERE id = ?',
    [latitude, longitude, req.rider.id]
  );

  // Fan out to every active delivery for this rider (multi-order), not only
  // the latest — otherwise other customers' track maps never move.
  const [orderRows] = await pool.query(
    `SELECT id, customer_id FROM orders
     WHERE rider_id = ? AND status NOT IN ('Delivered', 'Cancelled')
     ORDER BY rider_assigned_at DESC, id DESC`,
    [req.rider.id]
  );

  if (orderRows.length > 0) {
    const at = new Date().toISOString();
    for (const order of orderRows) {
      if (order.customer_id == null) continue;
      try {
        emitToCustomer(order.customer_id, 'rider.location.updated', {
          orderId: order.id,
          order_id: order.id,
          riderId: req.rider.id,
          rider_id: req.rider.id,
          lat: latitude,
          lng: longitude,
          latitude,
          longitude,
          at,
        });
      } catch (_) { /* best-effort */ }
    }
  }

  res.status(200).json({ ok: true });
};

// GET /api/rider/offers/active — primary offer + full pending queue
const getActiveOffer = async (req, res) => {
  const [rows] = await pool.query(
    `SELECT o.*, ord.order_number, ord.address, ord.phone, ord.customer_name, ord.note, ord.total, ord.delivery_type
     FROM rider_order_offers o
     JOIN orders ord ON ord.id = o.order_id
     WHERE o.rider_id = ? AND o.status = 'pending' AND o.expires_at > NOW()
     ORDER BY o.id ASC
     LIMIT 10`,
    [req.rider.id]
  );
  if (rows.length === 0) {
    return res.status(200).json({ offer: null, offers: [] });
  }

  const offers = [];
  for (const row of rows) {
    const offer = shapeOffer(row);
    const [shops] = await pool.query(
      `SELECT DISTINCT s.id, s.name
       FROM order_items oi
       JOIN shops s ON s.id = oi.shop_id
       WHERE oi.order_id = ? AND oi.shop_id IS NOT NULL`,
      [row.order_id]
    );
    offer.shops = shops;
    const shopNameById = new Map(shops.map((s) => [s.id, s.name]));
    const [items] = await pool.query(
      `SELECT id, product_name, quantity, variant_label, shop_id, unit_price, line_total
       FROM order_items WHERE order_id = ?`,
      [row.order_id]
    );
    offer.items = items.map((it) => shapeItemRow(it, shopNameById.get(it.shop_id) || null));
    offers.push(offer);
  }

  res.status(200).json({
    offer: offers[0] || null,
    offers,
  });
};

// POST /api/rider/offers/:offerId/accept
const acceptOfferHttp = async (req, res) => {
  const offerId = Number(req.params.offerId);
  if (!Number.isFinite(offerId)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid offer id' });
  }
  const result = await assignment.acceptOffer(offerId, req.rider.id);
  if (!result.ok) {
    const status = result.status || (result.code === 'NOT_FOUND' ? 404 : result.code === 'FORBIDDEN' ? 403 : 400);
    return res.status(status).json({ code: result.code || 'ERROR', message: result.message || 'Accept failed' });
  }
  res.status(200).json({
    message: 'Offer accepted',
    order: shapeOrderSummary(result.order),
  });
};

// POST /api/rider/offers/:offerId/reject
const rejectOfferHttp = async (req, res) => {
  const offerId = Number(req.params.offerId);
  if (!Number.isFinite(offerId)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid offer id' });
  }
  const result = await assignment.rejectOffer(offerId, req.rider.id, 'manual');
  if (!result.ok) {
    const status = result.status || (result.code === 'NOT_FOUND' ? 404 : result.code === 'FORBIDDEN' ? 403 : 400);
    return res.status(status).json({ code: result.code || 'ERROR', message: result.message || 'Reject failed' });
  }
  res.status(200).json({ message: 'Offer rejected', continued: result.continued || null });
};

// GET /api/rider/assignments/current — all active jobs (multi-order allowed)
const getCurrentAssignment = async (req, res) => {
  const [rows] = await pool.query(
    `SELECT * FROM orders
     WHERE rider_id = ? AND status NOT IN ('Delivered', 'Cancelled')
     ORDER BY rider_assigned_at DESC, id DESC
     LIMIT 20`,
    [req.rider.id]
  );
  if (rows.length === 0) {
    return res.status(200).json({ order: null, orders: [] });
  }
  const orders = await loadAssignmentExtrasBatch(rows);
  res.status(200).json({
    order: orders[0],
    orders,
  });
};

// GET /api/rider/assignments/:orderId — map + delivery detail for active job
const getAssignmentById = async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isFinite(orderId)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid order id' });
  }
  const [rows] = await pool.query(
    'SELECT * FROM orders WHERE id = ? AND rider_id = ?',
    [orderId, req.rider.id]
  );
  if (rows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Assignment not found' });
  }
  const order = await loadAssignmentExtras(rows[0]);
  res.status(200).json({ order });
};

// GET /api/rider/assignments/history?page=1&limit=20
const getAssignmentHistory = async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = (page - 1) * limit;
  const { date } = req.query;

  let where = `rider_id = ? AND status IN ('Delivered', 'Cancelled')`;
  const baseParams = [req.rider.id];
  if (date) {
    where += ' AND DATE(updated_at) = ?';
    baseParams.push(date);
  }

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM orders WHERE ${where}`,
    baseParams
  );
  const total = Number(countRows[0]?.cnt) || 0;

  const [rows] = await pool.query(
    `SELECT id, order_number, status, address, total, rider_assigned_at, rider_picked_up_at, created_at, updated_at
     FROM orders
     WHERE ${where}
     ORDER BY updated_at DESC
     LIMIT ? OFFSET ?`,
    [...baseParams, limit, offset]
  );

  res.status(200).json({
    orders: rows.map(shapeOrderSummary),
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit) || 0,
  });
};

// POST /api/rider/assignments/:orderId/cancel
const cancelAssignmentHttp = async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isFinite(orderId)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid order id' });
  }
  const result = await assignment.cancelAssignmentByRider(orderId, req.rider.id);
  if (!result.ok) {
    return res.status(result.status || 400).json({
      code: result.code || 'ERROR',
      message: result.message || 'Cancel failed',
    });
  }
  res.status(200).json({ message: 'Assignment cancelled', continued: result.continued || null });
};

// POST /api/rider/assignments/:orderId/picked-up
const markPickedUp = async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isFinite(orderId)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid order id' });
  }

  const [rows] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (rows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Order not found' });
  }
  const order = rows[0];
  if (Number(order.rider_id) !== Number(req.rider.id)) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Not your assignment' });
  }
  if (order.status === 'Cancelled' || order.status === 'Delivered') {
    return res.status(409).json({ code: 'CONFLICT', message: 'Order is terminal' });
  }

  if (!order.rider_picked_up_at) {
    await pool.query(
      'UPDATE orders SET rider_picked_up_at = NOW() WHERE id = ? AND rider_id = ? AND rider_picked_up_at IS NULL',
      [orderId, req.rider.id]
    );
  }

  const [updatedRows] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
  const updated = updatedRows[0];

  notificationService.createOrderNotification({
    userId: updated.customer_id,
    order: updated,
    event: 'rider_picked_up',
  })
    .then((result) => realtimeEvents.emitNotificationCreated(updated.customer_id, result))
    .catch(() => {});

  const summary = shapeOrderSummary(updated);
  try {
    emitToCustomer(updated.customer_id, 'rider.assignment.updated', {
      orderId, status: 'picked_up', riderId: req.rider.id, order: summary,
    });
    // Rider's own app (dashboard + map) listens on their user room.
    if (req.rider.user_id) {
      emitToCustomer(req.rider.user_id, 'rider.assignment.updated', {
        orderId, status: 'picked_up', riderId: req.rider.id, order: summary,
      });
    }
    emitToAdmins(updated.area_id, 'admin.order.rider_updated', {
      orderId, status: 'picked_up', riderId: req.rider.id,
    });
  } catch (_) { /* best-effort */ }

  res.status(200).json({
    message: 'Order marked picked up',
    order: summary,
  });
};

// PATCH /api/rider/assignments/:orderId/status — body { status: 'Out for Delivery' | 'Delivered' }
const updateAssignmentStatus = async (req, res) => {
  const orderId = Number(req.params.orderId);
  let { status } = req.body || {};
  if (status === 'Out for delivery') status = 'Out for Delivery';

  if (!Number.isFinite(orderId)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid order id' });
  }
  const allowed = ['Out for Delivery', 'Delivered'];
  if (!allowed.includes(status)) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: `status must be one of: ${allowed.join(', ')}`,
    });
  }

  const [rows] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (rows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Order not found' });
  }
  const order = rows[0];
  if (Number(order.rider_id) !== Number(req.rider.id)) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Not your assignment' });
  }
  if (order.status === 'Cancelled' || order.status === 'Delivered') {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Cannot change terminal order' });
  }

  // Forward-only among allowed progression for riders
  const progression = ['Accepted', 'Preparing', 'Out for Delivery', 'Delivered'];
  const curIdx = progression.indexOf(order.status);
  const newIdx = progression.indexOf(status);
  if (newIdx === -1 || (curIdx !== -1 && newIdx <= curIdx)) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: `Cannot move order from '${order.status}' to '${status}'`,
    });
  }
  // Rider should pick up before out for delivery (soft: auto-set if missing)
  if (status === 'Out for Delivery' && !order.rider_picked_up_at) {
    await pool.query(
      'UPDATE orders SET rider_picked_up_at = NOW() WHERE id = ? AND rider_picked_up_at IS NULL',
      [orderId]
    );
  }

  const setDeliveredAt = status === 'Delivered' ? ', delivered_at = NOW()' : '';
  // Same auto-success rule as the admin panel's status update — don't leave
  // payment at 'Pending' once delivered, but don't clobber a manual override.
  const setPaymentSuccess = (status === 'Delivered' && order.payment_status === 'Pending')
    ? ', payment_status = "Success"'
    : '';
  const [updateResult] = await pool.query(
    `UPDATE orders SET status = ?${setDeliveredAt}${setPaymentSuccess} WHERE id = ? AND status = ? AND rider_id = ?`,
    [status, orderId, order.status, req.rider.id]
  );
  if (updateResult.affectedRows === 0) {
    const [fresh] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    return res.status(409).json({
      code: 'CONCURRENCY_CONFLICT',
      message: 'Order was updated by someone else.',
      order: shapeOrderSummary(fresh[0]),
    });
  }

  const [updatedRows] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
  const updated = updatedRows[0];

  const eventName = status === 'Out for Delivery' ? 'status_out_for_delivery' : 'status_delivered';
  notificationService.createOrderNotification({
    userId: updated.customer_id,
    order: updated,
    event: eventName,
  })
    .then((result) => realtimeEvents.emitNotificationCreated(updated.customer_id, result))
    .catch(() => {});

  realtimeEvents.emitOrderStatusUpdated(updated);
  // Drop order from shop-owner "Active" list as soon as it leaves Preparing
  // (Out for Delivery / Delivered) — otherwise dashboard needs a manual refresh.
  try {
    const { notifyShopsOrderStatusChanged } = require('../utils/shops');
    notifyShopsOrderStatusChanged(updated);
  } catch (_) { /* best-effort */ }

  const summary = shapeOrderSummary(updated);
  try {
    emitToCustomer(updated.customer_id, 'rider.assignment.updated', {
      orderId, status, riderId: req.rider.id, order: summary,
    });
    // Keep rider dashboard + map screen in sync when status changes.
    if (req.rider.user_id) {
      emitToCustomer(req.rider.user_id, 'rider.assignment.updated', {
        orderId, status, riderId: req.rider.id, order: summary,
      });
    }
    emitToAdmins(updated.area_id, 'admin.order.rider_updated', {
      orderId, status, riderId: req.rider.id,
    });
  } catch (_) { /* best-effort */ }

  res.status(200).json({
    message: 'Order status updated',
    order: summary,
  });
};

// POST /api/rider/assignments/:orderId/mark-paid — rider confirms payment (e.g. COD cash) received.
// Compare-and-set from 'Pending' only; never overwrites Success/Failed/Refunded.
const markPaid = async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isFinite(orderId)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid order id' });
  }

  const [rows] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (rows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Order not found' });
  }
  const order = rows[0];
  if (Number(order.rider_id) !== Number(req.rider.id)) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Not your assignment' });
  }
  if (order.status === 'Cancelled') {
    return res.status(409).json({ code: 'CONFLICT', message: 'Order is cancelled' });
  }
  if (order.payment_status !== 'Pending') {
    return res.status(200).json({ message: 'Payment already recorded', order: shapeOrderSummary(order) });
  }

  const [updateResult] = await pool.query(
    'UPDATE orders SET payment_status = "Paid" WHERE id = ? AND payment_status = "Pending" AND rider_id = ?',
    [orderId, req.rider.id]
  );
  if (updateResult.affectedRows === 0) {
    const [fresh] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
    return res.status(409).json({
      code: 'CONCURRENCY_CONFLICT',
      message: 'Payment status was updated by someone else.',
      order: shapeOrderSummary(fresh[0]),
    });
  }

  const [updatedRows] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
  const updated = updatedRows[0];

  notificationService.createOrderNotification({
    userId: updated.customer_id,
    order: updated,
    event: 'payment_paid',
  })
    .then((result) => realtimeEvents.emitNotificationCreated(updated.customer_id, result))
    .catch(() => {});

  realtimeEvents.emitOrderPaymentUpdated(updated);

  const summary = shapeOrderSummary(updated);
  try {
    if (req.rider.user_id) {
      emitToCustomer(req.rider.user_id, 'rider.assignment.updated', {
        orderId, status: updated.status, riderId: req.rider.id, order: summary,
      });
    }
    emitToAdmins(updated.area_id, 'admin.order.rider_updated', {
      orderId, status: updated.status, riderId: req.rider.id,
    });
  } catch (_) { /* best-effort */ }

  res.status(200).json({
    message: 'Payment marked as paid',
    order: summary,
  });
};

module.exports = {
  getMe,
  setOnline,
  updateLocation,
  getActiveOffer,
  acceptOfferHttp,
  rejectOfferHttp,
  getCurrentAssignment,
  getAssignmentById,
  getAssignmentHistory,
  cancelAssignmentHttp,
  markPickedUp,
  updateAssignmentStatus,
  markPaid,
};
