/**
 * Shop-owner alert reliability sweeper.
 *
 * Fixes the "shop owner's phone has weak signal" gap: notifyShopsForOrder
 * (utils/shops.js) fires exactly once when an order is Accepted. If that one
 * socket emit + FCM/Expo push doesn't land (dead socket, FCM stuck in Doze,
 * a data-only message dropped by the carrier), the order just sits waiting
 * for a shop that never heard about it — no retry, no admin visibility.
 *
 * Two passes per tick, same shape as riderOfferSweeper.js:
 *  1. remindPendingShopOrders — re-push the alarm to any shop that still
 *     hasn't confirmed/rejected, throttled by SHOP_ALERT_REMIND_MS so a
 *     bursty weak connection gets caught by a later retry.
 *  2. timeoutRejectStaleShopOrders — after SHOP_RESPONSE_TIMEOUT_MS of total
 *     silence from a shop, auto-reject that shop's items (same effect as the
 *     owner pressing Reject) so the order stops stalling indefinitely.
 *
 * DB is source of truth (orders.accepted_at, order_items.shop_last_notified_at)
 * — no in-memory timer state, so this is safe across restarts and multiple
 * API instances, same rationale as riderOfferSweeper.
 */

const { pool } = require('../db/mysql');
const config = require('../config/env');
const { remindShopOrderOwner } = require('../utils/shops');

const SHOP_ALERT_SWEEP_MS = config.SHOP_ALERT_SWEEP_MS || 5000;
const SHOP_ALERT_REMIND_MS = config.SHOP_ALERT_REMIND_MS || 25000;
const SHOP_ALERT_REMIND_ACKED_MS = config.SHOP_ALERT_REMIND_ACKED_MS || 60000;
const SHOP_RESPONSE_TIMEOUT_MS = config.SHOP_RESPONSE_TIMEOUT_MS || 600000;

let timer = null;
let running = false;
let missingColumnLogged = false;

/**
 * Re-push the alarm to any shop with unconfirmed/unrejected items on an
 * Accepted/Preparing order, throttled per (order, shop) by SHOP_ALERT_REMIND_MS.
 * Skips rows already past SHOP_RESPONSE_TIMEOUT_MS — timeoutRejectStaleShopOrders
 * handles those in the same tick, a reminder for them would be pointless.
 */
const remindPendingShopOrders = async () => {
  // All elapsed-time filtering happens in SQL (o.accepted_at / shop_last_notified_at
  // are TIMESTAMPs written by MySQL's own clock) rather than by parsing them into a
  // JS Date and comparing against Date.now() — mixing a server clock with a driver-
  // parsed client clock is exactly the kind of thing a timezone/driver config
  // mismatch silently breaks, which is what made this pass never fire in practice.
  const [rows] = await pool.query(
    `SELECT oi.order_id, oi.shop_id, o.order_number,
            s.owner_user_id, s.name AS shop_name
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN shops s ON s.id = oi.shop_id AND s.active = 1
     WHERE o.status IN ('Accepted', 'Preparing')
       AND oi.shop_confirmed_at IS NULL
       AND oi.shop_rejected_at IS NULL
       AND s.owner_user_id IS NOT NULL
       AND o.accepted_at IS NOT NULL
       AND o.accepted_at > (NOW() - INTERVAL ? SECOND)
     GROUP BY oi.order_id, oi.shop_id, o.order_number, s.owner_user_id, s.name
     HAVING MIN(oi.shop_last_notified_at) IS NULL
         OR MIN(oi.shop_last_notified_at) <= NOW() - INTERVAL (CASE WHEN MIN(oi.shop_alert_acked_at) IS NULL THEN ? ELSE ? END) SECOND`,
    [
      Math.ceil(SHOP_RESPONSE_TIMEOUT_MS / 1000),
      Math.ceil(SHOP_ALERT_REMIND_MS / 1000),
      Math.ceil(SHOP_ALERT_REMIND_ACKED_MS / 1000),
    ]
  );

  for (const row of rows) {
    try {
      await remindShopOrderOwner(
        { id: row.order_id, order_number: row.order_number },
        row.shop_id,
        row.owner_user_id
      );
      await pool.query(
        `UPDATE order_items SET shop_last_notified_at = NOW(), shop_notify_count = shop_notify_count + 1
         WHERE order_id = ? AND shop_id = ? AND shop_confirmed_at IS NULL AND shop_rejected_at IS NULL`,
        [row.order_id, row.shop_id]
      );
    } catch (e) {
      console.error('[shop-alert] remind failed for order', row.order_id, 'shop', row.shop_id, e.message);
    }
  }
};

/**
 * Auto-reject a shop's items once SHOP_RESPONSE_TIMEOUT_MS has elapsed since
 * the order was accepted with no confirm/reject from that shop. Reuses
 * rejectShopOrder (shopOrderActions.js) so this has the exact same side
 * effects as the owner pressing Reject — including auto-cancelling the whole
 * order via maybeAutoCancelOrderWhenAllShopsRejected if every shop bucket on
 * the order is now rejected.
 *
 * When the reject does NOT auto-cancel the order (another shop already
 * confirmed, or is still within its own window), the order would otherwise
 * silently stall forever — maybeStartRiderAssignment requires every shop
 * confirmed, and nothing else is watching. Files a SHOP_TIMEOUT_PARTIAL admin
 * notification in that case so a human can resend to the shop or cancel.
 */
const timeoutRejectStaleShopOrders = async () => {
  const timeoutSec = Math.ceil(SHOP_RESPONSE_TIMEOUT_MS / 1000);
  const [rows] = await pool.query(
    `SELECT DISTINCT oi.order_id, oi.shop_id, o.order_number, o.area_id, s.name AS shop_name
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     JOIN shops s ON s.id = oi.shop_id
     WHERE o.status IN ('Accepted', 'Preparing')
       AND oi.shop_confirmed_at IS NULL
       AND oi.shop_rejected_at IS NULL
       AND o.accepted_at IS NOT NULL
       AND o.accepted_at <= (NOW() - INTERVAL ? SECOND)`,
    [timeoutSec]
  );

  if (rows.length === 0) return;

  const { rejectShopOrder } = require('../services/shopOrderActions');
  const adminInbox = require('../utils/adminNotifications');

  for (const row of rows) {
    try {
      const result = await rejectShopOrder(row.shop_id, row.order_id, {
        shopName: row.shop_name,
        source: 'timeout',
      });
      if (!result.ok) continue;

      console.log(
        `[shop-alert] timeout-reject order=${row.order_id} shop=${row.shop_id} waited=${timeoutSec}s`
      );

      const [orderRows] = await pool.query('SELECT status FROM orders WHERE id = ?', [row.order_id]);
      const stillActive = orderRows[0] && ['Accepted', 'Preparing'].includes(orderRows[0].status);
      if (!stillActive) continue; // auto-cancelled — that path already notified admin

      await adminInbox.createAdminNotification({
        type: adminInbox.TYPES.SHOP_TIMEOUT_PARTIAL,
        title: `Order #${row.order_number || row.order_id} still needs attention`,
        body: `${row.shop_name || 'A shop'} did not respond in time and was auto-rejected, but this order has other shops still active. Resend to the shop or cancel the order.`,
        relatedUrl: `/orders?id=${row.order_id}`,
        relatedId: `${row.order_id}-${row.shop_id}`,
        areaId: row.area_id,
      });
    } catch (e) {
      // Missing-column/table detection lives solely in tick()'s outer catch,
      // which wraps this function's own initial SELECT (the query that would
      // actually throw ER_BAD_FIELD_ERROR/ER_NO_SUCH_TABLE for a schema that
      // hasn't migrated yet). Duplicating that check here raced with it: this
      // branch set missingColumnLogged = true and returned normally — no
      // exception reached tick()'s catch — so tick()'s own
      // `missingColumnLogged = false` ran immediately after and undid the
      // suppression on every single tick, defeating "further ticks suppressed".
      console.error('[shop-alert] timeout-reject failed for order', row.order_id, 'shop', row.shop_id, e.message);
    }
  }
};

const tick = async () => {
  if (running) return;
  running = true;
  try {
    await remindPendingShopOrders();
    await timeoutRejectStaleShopOrders();
    missingColumnLogged = false;
  } catch (e) {
    const missing = e && (e.code === 'ER_BAD_FIELD_ERROR' || e.code === 'ER_NO_SUCH_TABLE'
      || e.errno === 1146 || /doesn't exist|Unknown column/i.test(e.message || ''));
    if (missing) {
      if (!missingColumnLogged) {
        console.error('[shop-alert] required columns missing — run npm run db:migrate:dev once. Further ticks suppressed until fixed.');
        missingColumnLogged = true;
      }
    } else {
      console.error('[shop-alert] tick failed:', e.message);
    }
  } finally {
    running = false;
  }
};

const startShopAlertSweeper = () => {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch(() => {});
  }, SHOP_ALERT_SWEEP_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[shop-alert] started (interval=${SHOP_ALERT_SWEEP_MS}ms, remind=${SHOP_ALERT_REMIND_MS}ms, timeout=${SHOP_RESPONSE_TIMEOUT_MS}ms)`);
};

const stopShopAlertSweeper = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

module.exports = {
  startShopAlertSweeper,
  stopShopAlertSweeper,
  tick,
  remindPendingShopOrders,
  timeoutRejectStaleShopOrders,
  SHOP_ALERT_SWEEP_MS,
  SHOP_ALERT_REMIND_MS,
  SHOP_ALERT_REMIND_ACKED_MS,
  SHOP_RESPONSE_TIMEOUT_MS,
};
