export function getRealtimeOrderId(payload = {}) {
  const id = payload.orderId || payload.order_id || payload.id;
  return id === undefined || id === null ? null : String(id);
}

export function getRealtimeOrderKey(eventName, payload = {}) {
  return [
    eventName,
    getRealtimeOrderId(payload),
    payload.status || '',
    payload.paymentStatus || payload.payment_status || '',
    payload.updatedAt || payload.updated_at || '',
  ].join(':');
}

export function isRecentRealtimeEvent(cacheRef, key, windowMs = 500) {
  if (!key) return false;

  const now = Date.now();
  const cache = cacheRef.current || {};
  cacheRef.current = cache;

  Object.keys(cache).forEach(cacheKey => {
    if (now - cache[cacheKey] > windowMs) {
      delete cache[cacheKey];
    }
  });

  if (cache[key] && now - cache[key] <= windowMs) {
    return true;
  }

  cache[key] = now;
  return false;
}

/**
 * When the whole order is Cancelled, item-level shop_confirmed_* flags are
 * stale — mark every shop confirmation as order-cancelled so the drawer
 * badges update live without an HTTP refetch.
 */
function applyOrderCancelledToShopConfirmations(shopConfirmations) {
  if (!Array.isArray(shopConfirmations) || shopConfirmations.length === 0) {
    return shopConfirmations;
  }
  return shopConfirmations.map((sc) => ({
    ...sc,
    confirmed: false,
    confirmedAt: null,
    confirmed_at: null,
    ready: false,
    readyAt: null,
    ready_at: null,
    rejected: true,
    orderCancelled: true,
    order_cancelled: true,
  }));
}

export function mergeAdminOrderPatch(order, payload = {}) {
  if (!order) return order;

  const next = { ...order };
  const status = payload.status;
  const paymentStatus = payload.paymentStatus || payload.payment_status;
  const updatedAt = payload.updatedAt || payload.updated_at;

  if (status !== undefined && status !== null) {
    next.status = status;
  }

  if (paymentStatus !== undefined && paymentStatus !== null) {
    next.payment_status = paymentStatus;
    next.paymentStatus = paymentStatus;
  }

  if (payload.total !== undefined && payload.total !== null) {
    next.total = payload.total;
  }

  if (payload.subtotal !== undefined && payload.subtotal !== null) {
    next.subtotal = payload.subtotal;
  }

  // admin.order.item_replaced — swap the matching order_items row in place
  // so the drawer's item list reflects the new product without a refetch.
  if (payload.itemId != null && payload.newProduct && Array.isArray(next.items)) {
    const itemId = Number(payload.itemId);
    next.items = next.items.map((it) => (
      Number(it.id) === itemId
        ? {
          ...it,
          product_id: payload.newProduct.productId,
          product_name: payload.newProduct.productName,
          unit_price: payload.newProduct.unitPrice,
          line_total: payload.newProduct.lineTotal,
        }
        : it
    ));
  }

  if (payload.cancel_reason !== undefined || payload.cancelReason !== undefined) {
    next.cancel_reason = payload.cancel_reason ?? payload.cancelReason ?? next.cancel_reason;
  }

  if (payload.admin_remark !== undefined || payload.adminRemark !== undefined) {
    next.admin_remark = payload.admin_remark ?? payload.adminRemark ?? null;
    next.adminRemark = next.admin_remark;
  }

  if (updatedAt) {
    next.updated_at = updatedAt;
    next.updatedAt = updatedAt;
  }

  if (payload.orderNumber && !next.order_number) {
    next.order_number = payload.orderNumber;
  }

  // Live badge update: admin cancel must not leave "⏳ Waiting" on shops.
  if (status === 'Cancelled' || status === 'Canceled') {
    next.shopConfirmations = applyOrderCancelledToShopConfirmations(
      next.shopConfirmations || next.shop_confirmations
    );
  }

  // Per-shop confirm/ready from admin.order.shop_* events (payload has shopId).
  const shopId = payload.shopId ?? payload.shop_id;
  if (shopId != null && Array.isArray(next.shopConfirmations)) {
    const sid = Number(shopId);
    if (payload.action === 'confirmed' || payload.confirmed === true) {
      next.shopConfirmations = next.shopConfirmations.map((sc) => (
        Number(sc.shopId ?? sc.shop_id) === sid
          ? { ...sc, confirmed: true, rejected: false }
          : sc
      ));
    }
    if (payload.action === 'ready' || payload.ready === true) {
      next.shopConfirmations = next.shopConfirmations.map((sc) => (
        Number(sc.shopId ?? sc.shop_id) === sid
          ? { ...sc, ready: true, confirmed: true, rejected: false }
          : sc
      ));
    }
    if (payload.action === 'rejected' || payload.rejected === true) {
      next.shopConfirmations = next.shopConfirmations.map((sc) => (
        Number(sc.shopId ?? sc.shop_id) === sid
          ? { ...sc, rejected: true, confirmed: false, ready: false }
          : sc
      ));
    }
    if (payload.action === 'resent') {
      next.shopConfirmations = next.shopConfirmations.map((sc) => (
        Number(sc.shopId ?? sc.shop_id) === sid
          ? { ...sc, rejected: false, confirmed: false, ready: false }
          : sc
      ));
    }
  }

  return next;
}

/** Same-tab bridge: Orders cancel → Shops panel without waiting on socket. */
export const ADMIN_ORDER_STATUS_EVENT = 'admin:order-status';

export function broadcastAdminOrderStatus({ orderId, status, shopId, cancelReason } = {}) {
  if (typeof window === 'undefined' || orderId == null || !status) return;
  try {
    window.dispatchEvent(new CustomEvent(ADMIN_ORDER_STATUS_EVENT, {
      detail: {
        orderId: Number(orderId),
        status,
        shopId: shopId != null ? Number(shopId) : null,
        cancelReason: cancelReason || null,
      },
    }));
  } catch (_) { /* noop */ }
}
