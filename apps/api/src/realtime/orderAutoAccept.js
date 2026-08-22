const { pool } = require('../db/mysql');
const realtimeEvents = require('./orderEvents');
const notificationService = require('../utils/notificationService');
const { notifyShopsForOrder } = require('../utils/shops');

const AUTO_ACCEPT_MS = 120_000;

// In-memory map of orderId → Node Timeout handle. Cleared on cancel/completion.
const timers = new Map();

// In-memory map of orderId → absolute epoch ms the auto-accept fires at.
// Lets extend() add time without re-deriving delay from a stale start point.
const deadlines = new Map();

// Process-wide shutdown flag. Once set, any in-flight timer callback skips
// its DB write (the pool may already be closed during graceful shutdown).
let shuttingDown = false;

// Orders claimed by THIS process via schedule(). The rehydrate path skips
// them so a restart doesn't double-emit admin.order.auto_accepted events.
const claimedOrders = new Set();

/**
 * Apply Accepted + fan-out (shops, customer, house rider start).
 * Compare-and-set on Pending so concurrent admin accept is safe.
 * @returns {Promise<object|null>} updated order row or null if not accepted
 */
const acceptPendingOrder = async (orderId, orderNumber, logTag = 'auto-accept') => {
  const [result] = await pool.query(
    "UPDATE orders SET status = 'Accepted', accepted_at = NOW() WHERE id = ? AND status = 'Pending'",
    [orderId]
  );
  if (!result || result.affectedRows === 0) return null;

  const [updated] = await pool.query('SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = updated[0];
  if (!order) return null;

  realtimeEvents.emitOrderAutoAccepted(order);
  notifyShopsForOrder(order);

  // House-only orders (no shop items) start rider assignment immediately.
  try {
    const { startAssignmentIfHouseOnly } = require('../services/riderAssignment');
    startAssignmentIfHouseOnly(order.id).catch((e) =>
      console.error('[rider-assign] house start on auto-accept failed:', e.message)
    );
  } catch (e) {
    console.error('[rider-assign] house start on auto-accept failed:', e.message);
  }

  notificationService.createOrderNotification({
    userId: order.customer_id,
    order,
    event: 'status_accepted',
  }).then((resultNotif) =>
    realtimeEvents.emitNotificationCreated(order.customer_id, resultNotif)
  ).catch(() => {});

  console.log(
    `[${logTag}] order #${orderNumber || order.order_number} (id=${orderId}) auto-accepted`
  );
  return order;
};

// Fires when an order's auto-accept window elapses. Shared by schedule()'s
// initial timer and extend()'s rescheduled one so the accept logic lives once.
const fire = async (id, orderNumber) => {
  timers.delete(id);
  deadlines.delete(id);
  if (shuttingDown) return; // pool may be closed; skip silently

  try {
    // orders has no soft-delete column — only status gates accept.
    const [rows] = await pool.query(
      'SELECT id, status, order_number FROM orders WHERE id = ?',
      [id]
    );
    if (rows.length === 0) return;
    if (rows[0].status !== 'Pending') return; // admin already acted

    await acceptPendingOrder(id, orderNumber || rows[0].order_number, 'auto-accept');
  } catch (e) {
    console.error('[auto-accept] failed for order', id, e.message);
  } finally {
    claimedOrders.delete(id);
  }
};

const armTimer = (id, orderNumber, wait) => {
  const t = setTimeout(() => fire(id, orderNumber), wait);
  // Unref so a lone timer does not keep the process alive during tests/shutdown.
  if (typeof t.unref === 'function') t.unref();
  timers.set(id, t);
};

/**
 * Schedule an auto-accept for a newly created order. If no admin accepts
 * (or cancels) within delayMs (default AUTO_ACCEPT_MS), the order moves to
 * 'Accepted' and a Socket.IO event is emitted so all admin clients refresh.
 */
const schedule = (orderId, orderNumber, delayMs = AUTO_ACCEPT_MS) => {
  if (!Number.isFinite(Number(orderId))) return;
  const id = Number(orderId);
  cancel(id); // ensure no duplicate
  claimedOrders.add(id);

  const wait = Math.max(0, Number(delayMs) || AUTO_ACCEPT_MS);
  deadlines.set(id, { deadline: Date.now() + wait, orderNumber });
  armTimer(id, orderNumber, wait);
};

/**
 * Push an order's auto-accept deadline back by extraMs (admin "+30s" button).
 * No-op if the order has no live auto-accept timer (already accepted/cancelled,
 * or never scheduled in this process). Returns the new deadline (epoch ms), or
 * null if there was nothing to extend.
 */
const extend = (orderId, extraMs = 30_000) => {
  const id = Number(orderId);
  const meta = deadlines.get(id);
  const t = timers.get(id);
  if (!meta || !t) return null;

  clearTimeout(t);
  const newDeadline = meta.deadline + Math.max(0, Number(extraMs) || 0);
  const newWait = Math.max(0, newDeadline - Date.now());
  deadlines.set(id, { deadline: newDeadline, orderNumber: meta.orderNumber });
  armTimer(id, meta.orderNumber, newWait);
  return newDeadline;
};

const getDeadline = (orderId) => {
  const meta = deadlines.get(Number(orderId));
  return meta ? meta.deadline : null;
};

const cancel = (orderId) => {
  const id = Number(orderId);
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
  deadlines.delete(id);
  claimedOrders.delete(id);
};

const clearAll = () => {
  shuttingDown = true;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  deadlines.clear();
  claimedOrders.clear();
};

/**
 * On API startup:
 *  - Pending older than AUTO_ACCEPT_MS → accept now
 *  - Pending still inside the window → re-schedule with remaining delay
 *    (live setTimeout was lost on restart)
 */
const rehydratePendingOrders = async () => {
  try {
    const windowSec = Math.ceil(AUTO_ACCEPT_MS / 1000);
    const [rows] = await pool.query(
      `SELECT id, order_number, created_at,
              TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age_sec
         FROM orders
        WHERE status = 'Pending'`
    );

    for (const r of rows) {
      if (claimedOrders.has(r.id)) continue;

      const ageSec = Number(r.age_sec) || 0;
      if (ageSec >= windowSec) {
        try {
          await acceptPendingOrder(r.id, r.order_number, 'auto-accept-rehydrate');
        } catch (e) {
          console.error('[auto-accept] rehydrate accept failed for', r.id, e.message);
        }
      } else {
        const remainingMs = Math.max(0, AUTO_ACCEPT_MS - ageSec * 1000);
        schedule(r.id, r.order_number, remainingMs);
        console.log(
          `[auto-accept] re-scheduled order id=${r.id} in ${Math.ceil(remainingMs / 1000)}s`
        );
      }
    }
  } catch (e) {
    console.error('[auto-accept] rehydrate failed:', e.message);
  }
};

module.exports = {
  AUTO_ACCEPT_MS,
  schedule,
  extend,
  getDeadline,
  cancel,
  clearAll,
  rehydratePendingOrders,
  acceptPendingOrder, // for tests
};
