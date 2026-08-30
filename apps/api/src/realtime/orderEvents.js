const notificationService = require('../utils/notificationService');
const { pool } = require('../db/mysql');
const { emitToAdmins, emitToCustomer } = require('./socket');

const toOrderEventPayload = (order = {}) => ({
  orderId: order.id || order.orderId,
  orderNumber: order.order_number || order.orderNumber,
  customerId: order.customer_id || order.customerId,
  customerName: order.customer_name || order.customerName,
  customerPhone: order.customer_phone || order.customerPhone || order.phone,
  address: order.address,
  latitude: order.latitude,
  longitude: order.longitude,
  mapUrl: order.map_url || order.mapUrl || null,
  map_url: order.map_url || order.mapUrl || null,
  paymentMethod: order.payment_method || order.paymentMethod,
  status: order.status,
  paymentStatus: order.payment_status || order.paymentStatus,
  cancelReason: order.cancel_reason || order.cancelReason || null,
  cancel_reason: order.cancel_reason || order.cancelReason || null,
  total: order.total,
  items: order.items,
  createdAt: order.created_at || order.createdAt || new Date().toISOString(),
  updatedAt: order.updated_at || order.updatedAt || new Date().toISOString(),
});

const safeParseActionPayload = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
};

const normalizeNotification = (notification = {}) => {
  const actionPayload = notification.action_payload || notification.actionPayload || null;

  return {
    id: notification.id,
    title: notification.title,
    body: notification.body,
    type: notification.type,
    sourceType: notification.source_type || notification.sourceType,
    sourceId: notification.source_id || notification.sourceId,
    actionType: notification.action_type || notification.actionType,
    actionPayload: safeParseActionPayload(actionPayload),
    createdAt: notification.created_at || notification.createdAt || new Date().toISOString(),
  };
};

const emitOrderToCustomer = (order, eventName) => {
  const payload = toOrderEventPayload(order);
  emitToCustomer(payload.customerId, eventName, payload);
  emitToCustomer(payload.customerId, 'order.updated', payload);
  return payload;
};

// An order entering or leaving the active set moves this area's rider
// capacity, which gates checkout for every other customer in it. Routed
// through the three emitters below rather than each controller so no future
// status path can forget it. Fire-and-forget by design — it never throws, and
// the order event itself must not wait on a capacity query.
const { broadcastCapacityIfChanged } = require('./riderCapacityBroadcast');

const emitOrderCreated = (order) => {
  const payload = emitOrderToCustomer(order, 'order.created');
  emitToAdmins(order.area_id || order.areaId, 'admin.order.created', payload);
  // A new order can be the one that tips the area over.
  broadcastCapacityIfChanged(order.area_id || order.areaId);
  return payload;
};

const emitOrderCancelled = (order) => {
  const payload = emitOrderToCustomer(order, 'order.cancelled');
  emitToCustomer(payload.customerId, 'order.status.updated', payload);
  emitToAdmins(order.area_id || order.areaId, 'admin.order.updated', payload);
  // Cancelling always frees a slot.
  broadcastCapacityIfChanged(order.area_id || order.areaId);
  return payload;
};

const emitOrderStatusUpdated = (order) => {
  const payload = emitOrderToCustomer(order, 'order.status.updated');
  emitToAdmins(order.area_id || order.areaId, 'admin.order.updated', payload);
  // Only terminal transitions change the active-order count — Accepted ->
  // Preparing -> Out for Delivery all stay inside ACTIVE_ORDER_STATUSES, so
  // checking on those would just be a query per status tap for no change.
  const status = order.status || order.orderStatus;
  if (status === 'Delivered' || status === 'Cancelled') {
    broadcastCapacityIfChanged(order.area_id || order.areaId);
  }
  return payload;
};

const emitOrderPaymentUpdated = (order) => {
  const payload = emitOrderToCustomer(order, 'order.payment.updated');
  emitToAdmins(order.area_id || order.areaId, 'admin.order.updated', payload);
  return payload;
};

const emitOrderItemReplaced = (order, itemId, oldProduct, newProduct) => {
  const payload = {
    orderId: order.id,
    itemId,
    oldProduct,
    newProduct,
    subtotal: order.subtotal,
    total: order.total,
    updatedAt: order.updated_at || order.updatedAt || new Date().toISOString(),
  };
  emitToCustomer(order.customer_id, 'order.item.replaced', payload);
  emitToCustomer(order.customer_id, 'order.updated', payload);
  emitToAdmins(order.area_id || order.areaId, 'admin.order.item_replaced', payload);
  return payload;
};

const emitOrderAutoAccepted = (order) => {
  const payload = toOrderEventPayload(order);
  const areaId = order.area_id || order.areaId;
  // Notify the customer so the tracking screen updates without a manual refresh.
  emitToCustomer(payload.customerId, 'order.status.updated', payload);
  emitToCustomer(payload.customerId, 'order.updated', payload);
  emitToAdmins(areaId, 'admin.order.updated', payload);
  emitToAdmins(areaId, 'admin.order.auto_accepted', payload);
  return payload;
};

const emitNotificationCreated = async (userId, notificationResult) => {
  if (!userId || !notificationResult?.insertId) return null;

  try {
    const [rows] = await pool.query(
      'SELECT * FROM notifications WHERE id = ? AND user_id = ?',
      [notificationResult.insertId, userId]
    );

    if (rows.length === 0) return null;
    return emitNotificationRow(userId, rows[0]);
  } catch (error) {
    console.error('Realtime notification emit failed:', error.message);
  }

  return null;
};

const emitUnreadCountUpdated = async (userId) => {
  if (!userId) return;
  try {
    const unreadCount = await notificationService.getUnreadCount(userId);
    emitToCustomer(userId, 'notification.unread_count.updated', { unreadCount });
  } catch (error) {
    console.error('Realtime unread count emit failed:', error.message);
  }
};

const emitNotificationRow = async (userId, notification) => {
  if (!userId || !notification) return null;

  const payload = normalizeNotification(notification);
  emitToCustomer(userId, 'notification.created', payload);
  await emitUnreadCountUpdated(userId);

  return payload;
};

module.exports = {
  emitNotificationCreated,
  emitNotificationRow,
  emitUnreadCountUpdated,
  emitOrderCancelled,
  emitOrderCreated,
  emitOrderPaymentUpdated,
  emitOrderStatusUpdated,
  emitOrderItemReplaced,
  emitOrderAutoAccepted,
  toOrderEventPayload,
};
