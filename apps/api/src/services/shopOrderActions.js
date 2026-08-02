/**
 * Shared shop-order lifecycle actions used by:
 *   - shop owner routes (PATCH /api/shop/orders/:orderId/{confirm,reject,ready})
 *   - admin routes (PATCH /api/admin/shops/:shopId/orders/:orderId/{confirm,reject,ready})
 *
 * Same DB writes + side effects either way so admin "Confirm" dismisses the
 * shop-owner Accept popup (shop.order.updated → refetch).
 */
const { pool } = require('../db/mysql');
const { maybeAutoCancelOrderWhenAllShopsRejected } = require('../utils/shops');
const { emitToAdmins, emitToCustomer } = require('../realtime/socket');
const notificationService = require('../utils/notificationService');
const realtimeEvents = require('../realtime/orderEvents');

const ACTIVE_ORDER_STATUSES = ['Accepted', 'Preparing'];

/** Notify the shop owner (if any) so their app can refresh queue/popup. */
async function notifyShopOwnerOrderUpdated(shopId, orderId, action) {
  try {
    const [rows] = await pool.query(
      'SELECT owner_user_id FROM shops WHERE id = ? AND active = 1 AND owner_user_id IS NOT NULL LIMIT 1',
      [shopId]
    );
    if (rows.length === 0 || !rows[0].owner_user_id) return;
    emitToCustomer(rows[0].owner_user_id, 'shop.order.updated', {
      orderId: Number(orderId),
      shopId: Number(shopId),
      action,
    });
  } catch (e) {
    console.error('[shop-order] notifyShopOwnerOrderUpdated failed:', e.message);
  }
}

/** List Accepted/Preparing orders that include items for this shop. */
async function listShopActiveOrders(shopId) {
  const [orders] = await pool.query(
    `SELECT DISTINCT o.id, o.order_number, o.status, o.note, o.created_at, o.delivery_type
     FROM orders o JOIN order_items oi ON oi.order_id = o.id
     WHERE oi.shop_id = ? AND o.status IN ('Accepted','Preparing')
     ORDER BY o.created_at ASC`,
    [shopId]
  );

  if (orders.length === 0) {
    return [];
  }

  // stopgap area 1 (TASK 13 scopes shop order actions by area)
  const [settingsRows] = await pool.query(
    'SELECT standard_delivery_minutes, fast_delivery_minutes FROM settings WHERE area_id = 1 LIMIT 1'
  );
  const settings = settingsRows[0] || {};

  const orderIds = orders.map((o) => o.id);
  const [items] = await pool.query(
    `SELECT id, order_id, product_name, quantity, variant_label, shop_line_total,
            shop_confirmed_at, shop_rejected_at, shop_ready_at
     FROM order_items WHERE shop_id = ? AND order_id IN (?)`,
    [shopId, orderIds]
  );

  const itemsByOrder = items.reduce((map, it) => {
    if (!map[it.order_id]) map[it.order_id] = [];
    map[it.order_id].push(it);
    return map;
  }, {});

  return orders.map((o) => {
    const myItems = itemsByOrder[o.id] || [];
    const confirmed = myItems.length > 0 && myItems.every((it) => it.shop_confirmed_at !== null);
    const rejected = myItems.length > 0 && myItems.every((it) => it.shop_rejected_at !== null);
    const ready = myItems.length > 0 && myItems.every((it) => it.shop_ready_at !== null);
    const expectedMinutes = o.delivery_type === 'fast'
      ? settings.fast_delivery_minutes
      : settings.standard_delivery_minutes;
    // What VillKro owes this shop for this order — items the shop already
    // rejected don't count (they were never fulfilled). Sums only lines with
    // a configured shop price; unconfigured lines are silently excluded
    // rather than treated as free, same NULL-means-unset rule as the column.
    const shopTotal = myItems
      .filter((it) => it.shop_rejected_at === null && it.shop_line_total !== null && it.shop_line_total !== undefined)
      .reduce((sum, it) => sum + Number(it.shop_line_total), 0);
    return {
      id: o.id,
      orderNumber: o.order_number,
      order_number: o.order_number,
      status: o.status,
      note: o.note,
      createdAt: o.created_at,
      created_at: o.created_at,
      deliveryType: o.delivery_type,
      delivery_type: o.delivery_type,
      expectedMinutes,
      expected_minutes: expectedMinutes,
      confirmed,
      rejected,
      ready,
      shopTotal,
      shop_total: shopTotal,
      items: myItems.map((it) => ({
        id: it.id,
        productName: it.product_name,
        product_name: it.product_name,
        quantity: it.quantity,
        variantLabel: it.variant_label,
        variant_label: it.variant_label,
        shopLineTotal: it.shop_line_total !== null ? Number(it.shop_line_total) : null,
        shop_line_total: it.shop_line_total !== null ? Number(it.shop_line_total) : null,
      })),
    };
  });
}

/**
 * Confirm this shop's items on an order.
 * @returns {{ ok: true } | { ok: false, status: number, code: string, message: string }}
 */
async function confirmShopOrder(shopId, orderId, { shopName } = {}) {
  const [countRows] = await pool.query(
    `SELECT COUNT(*) as cnt, MAX(o.status) as order_status FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE oi.order_id = ? AND oi.shop_id = ? AND o.status IN ('Accepted', 'Preparing')`,
    [orderId, shopId]
  );
  if (countRows[0].cnt === 0) {
    return {
      ok: false,
      status: 404,
      code: 'NOT_FOUND',
      message: 'Order has no items for this shop',
    };
  }

  await pool.query(
    'UPDATE order_items SET shop_confirmed_at = NOW() WHERE order_id = ? AND shop_id = ? AND shop_confirmed_at IS NULL',
    [orderId, shopId]
  );

  emitToAdmins('admin.order.shop_confirmed', {
    orderId: Number(orderId),
    shopId: Number(shopId),
    shopName: shopName || null,
    action: 'confirmed',
    confirmed: true,
  });

  if (countRows[0].order_status === 'Accepted') {
    const [upd] = await pool.query(
      "UPDATE orders SET status = 'Preparing' WHERE id = ? AND status = 'Accepted'",
      [orderId]
    );
    if (upd.affectedRows > 0) {
      const [freshRows] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
      const updatedOrder = freshRows[0];
      notificationService.createOrderNotification({
        userId: updatedOrder.customer_id,
        order: updatedOrder,
        event: 'status_preparing',
      }).then((result) => realtimeEvents.emitNotificationCreated(updatedOrder.customer_id, result))
        .catch((e) => console.error('[notify]', e.message));
      realtimeEvents.emitOrderStatusUpdated(updatedOrder);
    }
  }

  const { maybeStartRiderAssignment } = require('./riderAssignment');
  maybeStartRiderAssignment(Number(orderId)).catch((e) =>
    console.error('[rider-assign] maybeStart after shop confirm failed:', e.message)
  );

  await notifyShopOwnerOrderUpdated(shopId, orderId, 'confirmed');

  return { ok: true, message: 'Order confirmed' };
}

/**
 * Reject / cancel this shop's items (informational; may auto-cancel order).
 */
async function rejectShopOrder(shopId, orderId, { shopName } = {}) {
  const [countRows] = await pool.query(
    `SELECT COUNT(*) as cnt FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE oi.order_id = ? AND oi.shop_id = ? AND o.status IN ('Accepted', 'Preparing')`,
    [orderId, shopId]
  );
  if (countRows[0].cnt === 0) {
    return {
      ok: false,
      status: 404,
      code: 'NOT_FOUND',
      message: 'Order has no items for this shop',
    };
  }

  await pool.query(
    'UPDATE order_items SET shop_rejected_at = NOW() WHERE order_id = ? AND shop_id = ? AND shop_rejected_at IS NULL',
    [orderId, shopId]
  );

  emitToAdmins('admin.order.updated', {
    orderId: Number(orderId),
    shopId: Number(shopId),
    shopName: shopName || null,
    action: 'rejected',
    rejected: true,
  });

  const adminInbox = require('../utils/adminNotifications');
  await adminInbox.createAdminNotification({
    type: adminInbox.TYPES.SHOP_REJECTED,
    title: `${shopName || 'Shop'} can't fulfill order #${orderId}`,
    body: `${shopName || 'A shop'} rejected their items on order #${orderId}. Review and take action (cancel, reassign, contact customer).`,
    relatedUrl: `/orders?id=${orderId}`,
    relatedId: String(orderId),
  });

  await maybeAutoCancelOrderWhenAllShopsRejected(orderId);
  await notifyShopOwnerOrderUpdated(shopId, orderId, 'rejected');

  return { ok: true, message: 'Order rejected' };
}

/**
 * Mark this shop's items ready for pickup (requires prior confirm).
 */
async function readyShopOrder(shopId, orderId, { shopName } = {}) {
  const [countRows] = await pool.query(
    `SELECT COUNT(*) as cnt FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE oi.order_id = ? AND oi.shop_id = ? AND o.status IN ('Accepted', 'Preparing') AND oi.shop_confirmed_at IS NOT NULL`,
    [orderId, shopId]
  );
  if (countRows[0].cnt === 0) {
    return {
      ok: false,
      status: 404,
      code: 'NOT_FOUND',
      message: 'Order has no confirmed items for this shop',
    };
  }

  await pool.query(
    'UPDATE order_items SET shop_ready_at = NOW() WHERE order_id = ? AND shop_id = ? AND shop_ready_at IS NULL',
    [orderId, shopId]
  );

  emitToAdmins('admin.order.shop_ready', {
    orderId: Number(orderId),
    shopId: Number(shopId),
    shopName: shopName || null,
    action: 'ready',
    ready: true,
  });

  await notifyShopOwnerOrderUpdated(shopId, orderId, 'ready');

  return { ok: true, message: 'Order marked ready' };
}

module.exports = {
  ACTIVE_ORDER_STATUSES,
  listShopActiveOrders,
  confirmShopOrder,
  rejectShopOrder,
  readyShopOrder,
  notifyShopOwnerOrderUpdated,
};
