const { pool } = require('../db/mysql');
const { syncDeliveryAvailabilityFromRiders } = require('../utils/riders');
const { isActiveMobileAdminPhone } = require('../utils/mobileAdmins');
const assignment = require('../services/riderAssignment');
const notificationService = require('../utils/notificationService');
const realtimeEvents = require('../realtime/orderEvents');
const { emitToCustomer, emitToAdmins } = require('../realtime/socket');
const { requestAreaId } = require('../utils/areaScope');

// riders carries a real area_id column (TASK 3). Rejects null (super_admin,
// no X-Area-Id) and 'all' the same way shopAdminController's shops CRUD does.
const requireOneArea = (req, res) => {
  const areaId = requestAreaId(req);
  if (areaId === null) {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'X-Area-Id is required for this action' });
    return null;
  }
  if (areaId === 'all') {
    res.status(400).json({ code: 'VALIDATION_ERROR', message: 'This action cannot target "all" areas at once — pick one area' });
    return null;
  }
  return areaId;
};

const mapRiderRow = (row) => {
  const isOnline = Boolean(row.is_online);
  return {
    id: row.id,
    userId: row.user_id,
    user_id: row.user_id,
    displayName: row.display_name,
    display_name: row.display_name,
    phone: row.phone || row.user_phone || null,
    userPhone: row.user_phone || null,
    user_phone: row.user_phone || null,
    userName: row.user_name || null,
    user_name: row.user_name || null,
    active: Boolean(row.active),
    isOnline,
    is_online: isOnline,
    createdAt: row.created_at,
    created_at: row.created_at,
  };
};

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
    total: o.total,
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
    orderNumber: row.order_number,
    order_number: row.order_number,
    address: row.address || null,
    customerName: row.customer_name || null,
    customer_name: row.customer_name || null,
    total: row.total != null ? row.total : null,
    note: row.note || null,
  };
};

const loadRiderOr404 = async (id, areaId) => {
  const params = [id];
  let where = 'r.id = ?';
  if (areaId !== undefined) {
    where += ' AND r.area_id = ?';
    params.push(areaId);
  }
  const [rows] = await pool.query(
    `SELECT r.*, u.name AS user_name, u.phone AS user_phone
     FROM riders r JOIN users u ON u.id = r.user_id WHERE ${where}`,
    params
  );
  return rows[0] || null;
};

/**
 * Attach shops + items to a batch of order rows in two queries total
 * (IN (...) on order_id) instead of two queries per order — the dispatch
 * panel can list up to 20 active jobs per rider.
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
    `SELECT id, order_id, product_name, quantity, variant_label, shop_id, shop_line_total, shop_rejected_at
     FROM order_items WHERE order_id IN (?)`,
    [orderIds]
  );

  const shopsByOrder = new Map();
  for (const row of shopRows) {
    if (!shopsByOrder.has(row.order_id)) shopsByOrder.set(row.order_id, []);
    shopsByOrder.get(row.order_id).push({
      id: row.id,
      name: row.name,
      latitude: numOrNull(row.latitude),
      longitude: numOrNull(row.longitude),
      lat: numOrNull(row.latitude),
      lng: numOrNull(row.longitude),
    });
  }
  const itemsByOrder = new Map();
  for (const row of itemRows) {
    if (!itemsByOrder.has(row.order_id)) itemsByOrder.set(row.order_id, []);
    itemsByOrder.get(row.order_id).push({
      id: row.id,
      productName: row.product_name,
      product_name: row.product_name,
      quantity: row.quantity,
      variantLabel: row.variant_label,
      variant_label: row.variant_label,
      shopId: row.shop_id,
      shop_id: row.shop_id,
      shopLineTotal: row.shop_line_total !== null ? Number(row.shop_line_total) : null,
      shop_line_total: row.shop_line_total !== null ? Number(row.shop_line_total) : null,
      shopRejectedAt: row.shop_rejected_at,
      shop_rejected_at: row.shop_rejected_at,
    });
  }

  return orderRows.map((orderRow) => {
    const order = shapeOrderSummary(orderRow);
    const orderItems = itemsByOrder.get(orderRow.id) || [];
    const orderCancelled = orderRow.status === 'Cancelled';
    // What VillKro owes each pickup shop for this order — same rule as the
    // shop-owner app and admin Orders drawer: a rejected line or a cancelled
    // order never counts, and lines with no configured shop price (NULL)
    // are silently excluded rather than treated as free. Surfaced here so a
    // dispatcher can see it at pickup time without opening the order drawer.
    order.shops = (shopsByOrder.get(orderRow.id) || []).map((shop) => {
      const shopTotal = orderCancelled ? 0 : orderItems
        .filter((it) => it.shop_id === shop.id && it.shop_rejected_at === null && it.shop_line_total !== null)
        .reduce((sum, it) => sum + it.shop_line_total, 0);
      return { ...shop, shopTotal, shop_total: shopTotal };
    });
    order.items = orderItems;
    return order;
  });
};

const notifyRiderUser = async (riderRow, event, payload) => {
  try {
    if (riderRow?.user_id) {
      emitToCustomer(riderRow.user_id, event, payload);
    }
  } catch (_) { /* best-effort */ }
};

// GET /api/admin/riders
const listRiders = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;
  const [rows] = await pool.query(
    `SELECT r.*, u.name AS user_name, u.phone AS user_phone
     FROM riders r
     JOIN users u ON u.id = r.user_id
     WHERE r.area_id = ?
     ORDER BY r.id ASC`,
    [areaId]
  );
  res.status(200).json({ riders: rows.map(mapRiderRow) });
};

// POST /api/admin/riders — body { phone, displayName? } or { userId, displayName? }
const createRider = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;
  const { phone, userId, displayName, display_name } = req.body || {};
  let uid = userId != null ? Number(userId) : null;
  let userRow = null;

  if (uid) {
    const [rows] = await pool.query('SELECT id, name, phone FROM users WHERE id = ?', [uid]);
    if (rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'User not found' });
    }
    userRow = rows[0];
  } else if (phone && String(phone).trim()) {
    const p = String(phone).trim();
    const [rows] = await pool.query('SELECT id, name, phone FROM users WHERE phone = ?', [p]);
    if (rows.length === 0) {
      return res.status(404).json({
        code: 'USER_NOT_FOUND',
        message: 'No user with that phone. Ask them to log in to the app once (OTP), then create the rider.',
      });
    }
    userRow = rows[0];
    uid = userRow.id;
  } else {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'phone or userId is required',
    });
  }

  // D2: cannot be shop owner
  const [shops] = await pool.query(
    'SELECT id FROM shops WHERE owner_user_id = ? AND active = 1 LIMIT 1',
    [uid]
  );
  if (shops.length > 0) {
    return res.status(409).json({
      code: 'ROLE_CONFLICT',
      message: 'That user already owns a shop. One phone can be shop owner OR rider, not both.',
    });
  }

  // Symmetric with admin's own exclusivity check (mobileAdminController).
  if (userRow.phone && await isActiveMobileAdminPhone(userRow.phone)) {
    return res.status(409).json({
      code: 'ROLE_CONFLICT',
      message: 'That phone is already assigned as a mobile admin. Remove or deactivate that role first.',
    });
  }

  const [existing] = await pool.query('SELECT id FROM riders WHERE user_id = ? LIMIT 1', [uid]);
  if (existing.length > 0) {
    return res.status(409).json({
      code: 'ALREADY_RIDER',
      message: 'That user is already a rider.',
    });
  }

  const name = String(displayName || display_name || userRow.name || 'Rider').trim() || 'Rider';
  let result;
  try {
    [result] = await pool.query(
      `INSERT INTO riders (area_id, user_id, display_name, phone, active, is_online)
       VALUES (?, ?, ?, ?, 1, 0)`,
      [areaId, uid, name, userRow.phone || null]
    );
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ code: 'ALREADY_RIDER', message: 'That user is already a rider.' });
    }
    throw e;
  }

  const [rows] = await pool.query(
    `SELECT r.*, u.name AS user_name, u.phone AS user_phone
     FROM riders r JOIN users u ON u.id = r.user_id WHERE r.id = ?`,
    [result.insertId]
  );
  res.status(201).json({ rider: mapRiderRow(rows[0]) });
};

// PATCH /api/admin/riders/:id — active, displayName
const updateRider = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;
  const { id } = req.params;
  const { active, displayName, display_name } = req.body || {};

  const [existing] = await pool.query('SELECT * FROM riders WHERE id = ? AND area_id = ?', [id, areaId]);
  if (existing.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Rider not found' });
  }

  const sets = [];
  const values = [];
  if (displayName !== undefined || display_name !== undefined) {
    const name = String(displayName ?? display_name ?? '').trim();
    if (!name) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'displayName cannot be empty' });
    }
    sets.push('display_name = ?');
    values.push(name);
  }
  if (active !== undefined) {
    sets.push('active = ?');
    values.push(active ? 1 : 0);
    if (!active) {
      // Force offline when deactivated
      sets.push('is_online = 0');
    }
  }

  if (sets.length > 0) {
    values.push(id, areaId);
    await pool.query(`UPDATE riders SET ${sets.join(', ')} WHERE id = ? AND area_id = ?`, values);
  }

  if (active !== undefined) {
    await syncDeliveryAvailabilityFromRiders(areaId);
  }

  const [rows] = await pool.query(
    `SELECT r.*, u.name AS user_name, u.phone AS user_phone
     FROM riders r JOIN users u ON u.id = r.user_id WHERE r.id = ?`,
    [id]
  );
  const rider = mapRiderRow(rows[0]);

  try {
    emitToAdmins(areaId, 'admin.rider.updated', {
      ...rider,
      reason: active !== undefined ? (active ? 'activated' : 'deactivated') : 'updated',
    });
  } catch (_) { /* best-effort */ }

  // Deactivate → same phone becomes customer mode (getRiderForUser requires active=1).
  // Tell the open app so RootNavigator leaves RiderNavigator without re-login.
  if (active !== undefined && !active && existing[0]?.user_id) {
    try {
      emitToCustomer(existing[0].user_id, 'auth.role.updated', {
        rider: null,
        reason: 'rider_deactivated',
      });
    } catch (_) { /* best-effort */ }
  }

  res.status(200).json({ rider, message: 'Rider updated' });
};

// DELETE /api/admin/riders/:id — remove rider role so the phone is a normal customer again.
// Hard-deletes the riders row (offers cascade). Blocks if they still have active deliveries.
const deleteRider = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;
  const { id } = req.params;
  const riderId = Number(id);
  if (!Number.isFinite(riderId) || riderId <= 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid rider id' });
  }

  const [existing] = await pool.query(
    `SELECT r.*, u.phone AS user_phone
     FROM riders r
     LEFT JOIN users u ON u.id = r.user_id
     WHERE r.id = ? AND r.area_id = ?`,
    [riderId, areaId]
  );
  if (existing.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Rider not found' });
  }
  const row = existing[0];
  const userId = row.user_id;

  // Active jobs: assigned but not finished/cancelled.
  const [[activeJobs]] = await pool.query(
    `SELECT COUNT(*) AS cnt
     FROM orders
     WHERE rider_id = ?
       AND status NOT IN ('Delivered', 'Cancelled', 'Canceled')`,
    [riderId]
  );
  if (Number(activeJobs?.cnt || 0) > 0) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Cannot delete rider while they still have active deliveries. Finish or reassign them first.',
    });
  }

  // Pending offers cascade via FK ON DELETE CASCADE; expire them first for clean sockets.
  try {
    await pool.query(
      `UPDATE rider_order_offers
       SET status = 'expired', responded_at = COALESCE(responded_at, NOW())
       WHERE rider_id = ? AND status = 'pending'`,
      [riderId]
    );
  } catch (_) { /* table may be mid-migrate */ }

  await pool.query('DELETE FROM riders WHERE id = ? AND area_id = ?', [riderId, areaId]);
  await syncDeliveryAvailabilityFromRiders(areaId);

  try {
    emitToAdmins(areaId, 'admin.rider.updated', {
      id: riderId,
      userId,
      user_id: userId,
      phone: row.phone || row.user_phone || null,
      active: false,
      isOnline: false,
      is_online: false,
      reason: 'deleted',
    });
  } catch (_) { /* best-effort */ }

  // Same phone → customer shell (no shop/rider row on /auth/me).
  if (userId) {
    try {
      emitToCustomer(userId, 'auth.role.updated', {
        rider: null,
        reason: 'rider_deleted',
      });
      emitToCustomer(userId, 'rider.status.updated', {
        isOnline: false,
        is_online: false,
        active: false,
        reason: 'deleted',
      });
    } catch (_) { /* best-effort */ }
  }

  res.status(200).json({
    message: 'Rider deleted',
    riderId,
    rider_id: riderId,
    userId,
    user_id: userId,
    // Phone is a normal customer again after this.
    becomesCustomer: true,
    becomes_customer: true,
  });
};

// ── Admin dispatch (same actions as rider app) ───────────────────────────

// GET /api/admin/riders/:id/dispatch — online state + pending offer + active jobs
const getRiderDispatch = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;
  const riderRow = await loadRiderOr404(req.params.id, areaId);
  if (!riderRow) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Rider not found' });
  }
  const rider = mapRiderRow(riderRow);

  const [offerRows] = await pool.query(
    `SELECT o.*, ord.order_number, ord.address, ord.phone, ord.customer_name, ord.note, ord.total
     FROM rider_order_offers o
     JOIN orders ord ON ord.id = o.order_id
     WHERE o.rider_id = ? AND o.status = 'pending' AND o.expires_at > NOW()
     ORDER BY o.id DESC
     LIMIT 1`,
    [riderRow.id]
  );
  let activeOffer = shapeOffer(offerRows[0] || null);
  if (activeOffer) {
    const [shops] = await pool.query(
      `SELECT DISTINCT s.id, s.name
       FROM order_items oi
       JOIN shops s ON s.id = oi.shop_id
       WHERE oi.order_id = ? AND oi.shop_id IS NOT NULL`,
      [offerRows[0].order_id]
    );
    activeOffer.shops = shops;
  }

  const [assignRows] = await pool.query(
    `SELECT * FROM orders
     WHERE rider_id = ? AND status NOT IN ('Delivered', 'Cancelled')
     ORDER BY rider_assigned_at DESC, id DESC
     LIMIT 20`,
    [riderRow.id]
  );
  const orders = await loadAssignmentExtrasBatch(assignRows);

  res.status(200).json({
    rider,
    activeOffer,
    active_offer: activeOffer,
    orders,
    currentAssignment: orders[0] || null,
    current_assignment: orders[0] || null,
  });
};

// PATCH /api/admin/riders/:id/online — body { isOnline | is_online }
// Same effect as rider PATCH /me/online.
const adminSetRiderOnline = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;
  const raw = req.body.isOnline !== undefined ? req.body.isOnline : req.body.is_online;
  if (typeof raw !== 'boolean') {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'isOnline (boolean) is required',
    });
  }

  const riderRow = await loadRiderOr404(req.params.id, areaId);
  if (!riderRow) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Rider not found' });
  }
  if (!riderRow.active && raw) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Cannot set an inactive rider online. Activate them first.',
    });
  }

  if (raw) {
    await pool.query(
      'UPDATE riders SET is_online = 1 WHERE id = ?',
      [riderRow.id]
    );
  } else {
    await pool.query(
      'UPDATE riders SET is_online = 0 WHERE id = ?',
      [riderRow.id]
    );
  }

  await syncDeliveryAvailabilityFromRiders(areaId);

  const updated = await loadRiderOr404(riderRow.id, areaId);
  const rider = mapRiderRow(updated);

  try {
    emitToAdmins(areaId, 'admin.rider.updated', {
      ...rider,
      reason: raw ? 'online' : 'offline',
      byAdmin: true,
    });
  } catch (_) { /* best-effort */ }

  await notifyRiderUser(updated, 'rider.status.updated', {
    isOnline: Boolean(raw),
    is_online: Boolean(raw),
    riderId: rider.id,
    reason: 'admin',
  });

  // Going online can unblock orders stuck searching for riders.
  if (raw) {
    setImmediate(() => {
      assignment.recoverStuckAssignments().catch((e) =>
        console.error('[admin-riders] recover after online failed:', e.message)
      );
    });
  }

  res.status(200).json({
    message: 'Rider online status updated',
    rider,
    isOnline: rider.isOnline,
    is_online: rider.is_online,
  });
};

// POST /api/admin/riders/:id/offers/:offerId/accept
const adminAcceptOffer = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;
  const riderId = Number(req.params.id);
  const offerId = Number(req.params.offerId);
  if (!Number.isFinite(riderId) || !Number.isFinite(offerId)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid id' });
  }
  const riderRow = await loadRiderOr404(riderId, areaId);
  if (!riderRow) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Rider not found' });
  }

  const result = await assignment.acceptOffer(offerId, riderId);
  if (!result.ok) {
    const status = result.status || (result.code === 'NOT_FOUND' ? 404 : result.code === 'FORBIDDEN' ? 403 : 400);
    return res.status(status).json({ code: result.code || 'ERROR', message: result.message || 'Accept failed' });
  }
  res.status(200).json({
    message: 'Offer accepted',
    order: shapeOrderSummary(result.order),
  });
};

// POST /api/admin/riders/:id/offers/:offerId/reject
const adminRejectOffer = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;
  const riderId = Number(req.params.id);
  const offerId = Number(req.params.offerId);
  if (!Number.isFinite(riderId) || !Number.isFinite(offerId)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid id' });
  }
  const riderRow = await loadRiderOr404(riderId, areaId);
  if (!riderRow) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Rider not found' });
  }

  const result = await assignment.rejectOffer(offerId, riderId, 'admin');
  if (!result.ok) {
    const status = result.status || (result.code === 'NOT_FOUND' ? 404 : result.code === 'FORBIDDEN' ? 403 : 400);
    return res.status(status).json({ code: result.code || 'ERROR', message: result.message || 'Reject failed' });
  }
  res.status(200).json({ message: 'Offer rejected', continued: result.continued || null });
};

// POST /api/admin/riders/:id/assignments/:orderId/picked-up
const adminMarkPickedUp = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;
  const riderId = Number(req.params.id);
  const orderId = Number(req.params.orderId);
  if (!Number.isFinite(riderId) || !Number.isFinite(orderId)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid id' });
  }

  const [rows] = await pool.query('SELECT * FROM orders WHERE id = ? AND area_id = ?', [orderId, areaId]);
  if (rows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Order not found' });
  }
  const order = rows[0];
  if (Number(order.rider_id) !== riderId) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Order is not assigned to this rider' });
  }
  if (order.status === 'Cancelled' || order.status === 'Delivered') {
    return res.status(409).json({ code: 'CONFLICT', message: 'Order is terminal' });
  }

  if (!order.rider_picked_up_at) {
    await pool.query(
      'UPDATE orders SET rider_picked_up_at = NOW() WHERE id = ? AND rider_id = ? AND rider_picked_up_at IS NULL',
      [orderId, riderId]
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

  try {
    emitToCustomer(updated.customer_id, 'rider.assignment.updated', {
      orderId, status: 'picked_up', riderId,
    });
    emitToAdmins(order.area_id, 'admin.order.rider_updated', {
      orderId, status: 'picked_up', riderId,
    });
    const riderRow = await loadRiderOr404(riderId, areaId);
    await notifyRiderUser(riderRow, 'rider.assignment.updated', {
      orderId, status: 'picked_up', riderId,
    });
  } catch (_) { /* best-effort */ }

  res.status(200).json({
    message: 'Order marked picked up',
    order: shapeOrderSummary(updated),
  });
};

// PATCH /api/admin/riders/:id/assignments/:orderId/status — { status: Out for Delivery | Delivered }
const adminUpdateAssignmentStatus = async (req, res) => {
  const areaId = requireOneArea(req, res);
  if (areaId === null) return;
  const riderId = Number(req.params.id);
  const orderId = Number(req.params.orderId);
  let { status } = req.body || {};
  if (status === 'Out for delivery') status = 'Out for Delivery';

  if (!Number.isFinite(riderId) || !Number.isFinite(orderId)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid id' });
  }
  const allowed = ['Out for Delivery', 'Delivered'];
  if (!allowed.includes(status)) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: `status must be one of: ${allowed.join(', ')}`,
    });
  }

  const [rows] = await pool.query('SELECT * FROM orders WHERE id = ? AND area_id = ?', [orderId, areaId]);
  if (rows.length === 0) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Order not found' });
  }
  const order = rows[0];
  if (Number(order.rider_id) !== riderId) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Order is not assigned to this rider' });
  }
  if (order.status === 'Cancelled' || order.status === 'Delivered') {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Cannot change terminal order' });
  }

  const progression = ['Accepted', 'Preparing', 'Out for Delivery', 'Delivered'];
  const curIdx = progression.indexOf(order.status);
  const newIdx = progression.indexOf(status);
  if (newIdx === -1 || (curIdx !== -1 && newIdx <= curIdx)) {
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: `Cannot move order from '${order.status}' to '${status}'`,
    });
  }

  if (status === 'Out for Delivery' && !order.rider_picked_up_at) {
    await pool.query(
      'UPDATE orders SET rider_picked_up_at = NOW() WHERE id = ? AND rider_picked_up_at IS NULL',
      [orderId]
    );
  }

  const setDeliveredAt = status === 'Delivered' ? ', delivered_at = NOW()' : '';
  // Same auto-success rule as the rider/admin status endpoints — don't leave
  // payment at 'Pending' once delivered, but don't clobber a manual override.
  const setPaymentSuccess = (status === 'Delivered' && order.payment_status === 'Pending')
    ? ', payment_status = "Success"'
    : '';
  const [updateResult] = await pool.query(
    `UPDATE orders SET status = ?${setDeliveredAt}${setPaymentSuccess} WHERE id = ? AND status = ? AND rider_id = ?`,
    [status, orderId, order.status, riderId]
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
  // (Out for Delivery / Delivered) — same as the rider-app path in
  // riderController.js, otherwise an admin-driven advance leaves the shop
  // dashboard showing a card that needs a manual refresh to clear.
  try {
    const { notifyShopsOrderStatusChanged } = require('../utils/shops');
    notifyShopsOrderStatusChanged(updated);
  } catch (_) { /* best-effort */ }

  const summary = shapeOrderSummary(updated);
  try {
    emitToAdmins(updated.area_id, 'admin.order.rider_updated', {
      orderId, status, riderId,
    });
    const riderRow = await loadRiderOr404(riderId, areaId);
    await notifyRiderUser(riderRow, 'rider.assignment.updated', {
      orderId, status, riderId, order: summary,
    });
  } catch (_) { /* best-effort */ }

  res.status(200).json({
    message: 'Order status updated',
    order: summary,
  });
};

module.exports = {
  listRiders,
  createRider,
  updateRider,
  deleteRider,
  getRiderDispatch,
  adminSetRiderOnline,
  adminAcceptOffer,
  adminRejectOffer,
  adminMarkPickedUp,
  adminUpdateAssignmentStatus,
};
