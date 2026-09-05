/**
 * Rider auto-assignment engine.
 * One pending offer per order AND per rider at a time, enforced by the
 * uq_offer_pending_order / uq_offer_pending_rider unique keys (migrate.js)
 * rather than by app-level locking. Riders are picked from expanding
 * rings around the pickup shop(s) (1/2/3 km, all shops at once on multi-shop
 * orders, then distance-blind); inside a ring, free riders (no active order)
 * are offered before busy ones, then least completed deliveries today.
 * 150s offer timer; multi-order allowed; no post-accept cancel by rider.
 * If no eligible riders after shops confirm: wait RIDER_SEARCH_WINDOW_SEC
 * (default 30 min), re-scanning every RIDER_SEARCH_SCAN_SEC (default 30s;
 * the 5s sweeper tick re-checks more often than that, which only helps)
 * before failAssignment (order stays open for admin).
 * See plans/order-lifecycle-all-cases.md and plans/rider-mode-order-assignment.md.
 */

const { pool } = require('../db/mysql');
const config = require('../config/env');
const {
  listEligibleRiders,
  selectEligibleRider,
  syncDeliveryAvailabilityFromRiders,
  countActiveRiders,
} = require('../utils/riders');

const RIDER_OFFER_TIMEOUT_SEC = config.RIDER_OFFER_TIMEOUT_SEC || 300;
const RIDER_SEARCH_WINDOW_SEC = config.RIDER_SEARCH_WINDOW_SEC || 600;
const RIDER_SEARCH_SCAN_SEC = config.RIDER_SEARCH_SCAN_SEC || 30;
const RIDER_OFFER_REMIND_SEC = config.RIDER_OFFER_REMIND_SEC || 15;
const RIDER_OFFER_REMIND_MS = RIDER_OFFER_REMIND_SEC * 1000;

// offerId → last Expo push timestamp (ms). Stops after accept/reject/expire.
const offerLastRemindAt = new Map();

const clearOfferRemind = (offerId) => {
  if (offerId != null) offerLastRemindAt.delete(Number(offerId));
};

const log = (...args) => console.log('[rider-assign]', ...args);

/**
 * Stamp search start once; keep status searching. Uses DB clock.
 */
const markSearching = async (orderId, connection = pool) => {
  await connection.query(
    `UPDATE orders
     SET rider_assignment_status = 'searching',
         rider_search_started_at = COALESCE(rider_search_started_at, NOW())
     WHERE id = ? AND rider_id IS NULL AND status NOT IN ('Delivered', 'Cancelled')`,
    [orderId]
  );
};

/**
 * True while still inside the wait-for-riders window (DB clock).
 * Missing rider_search_started_at is treated as just-opened (stamped first).
 *
 * Reads first and only stamps when the start timestamp is missing — this runs
 * on every sweeper re-scan (~5s) for every waiting order, so unconditionally
 * issuing the markSearching UPDATE each tick was pointless write/lock churn
 * on rows whose timestamp was already set.
 */
const isWithinSearchWindow = async (orderId, connection = pool) => {
  const readWindow = async () => {
    const [rows] = await connection.query(
      `SELECT rider_search_started_at IS NOT NULL AS stamped,
              (rider_search_started_at > (NOW() - INTERVAL ? SECOND)) AS open
       FROM orders WHERE id = ?`,
      [RIDER_SEARCH_WINDOW_SEC, orderId]
    );
    return rows[0] || null;
  };

  let row = await readWindow();
  if (!row) return false;
  if (!row.stamped) {
    await markSearching(orderId, connection);
    row = await readWindow();
    if (!row) return false;
  }
  return Boolean(row.open);
};

/** Riders who already have any offer row for this order (cannot re-offer). */
const getExcludedRiderIdsForOrder = async (orderId, connection = pool) => {
  const [rows] = await connection.query(
    'SELECT rider_id FROM rider_order_offers WHERE order_id = ?',
    [orderId]
  );
  return rows.map((r) => r.rider_id);
};

const loadOrder = async (orderId, connection = pool) => {
  const [rows] = await connection.query('SELECT * FROM orders WHERE id = ?', [orderId]);
  return rows[0] || null;
};

/**
 * Map-pinned shops this order is picked up from — the centres the offer rings
 * grow around. Multi-shop orders return every shop so all rings open at once.
 * Empty for house-only orders or shops with no pin, which makes the selector
 * fall back to the plain distance-blind rule.
 *
 * Rejected lines are excluded: a partially-confirmed order still gets a rider
 * (see maybeStartRiderAssignment), and the rider never visits the shop that
 * rejected, so centring a ring there would bias selection toward a stop that
 * isn't on the route.
 */
const getOrderPickupPoints = async (orderId) => {
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT s.latitude, s.longitude
       FROM order_items oi
       JOIN shops s ON s.id = oi.shop_id
       WHERE oi.order_id = ?
         AND oi.shop_id IS NOT NULL
         AND oi.shop_rejected_at IS NULL
         AND s.latitude IS NOT NULL
         AND s.longitude IS NOT NULL`,
      [orderId]
    );
    // Number(null) === 0 passes Number.isFinite, so a null pin would survive as
    // a ring centred on lat/lng 0,0. The SQL above already excludes NULLs —
    // this keeps the guard honest if that filter is ever relaxed.
    const coord = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return rows
      .map((r) => ({ lat: coord(r.latitude), lng: coord(r.longitude) }))
      .filter((p) => p.lat !== null && p.lng !== null);
  } catch (e) {
    // Never block assignment on a pin lookup — degrade to distance-blind.
    console.error('[rider-assign] getOrderPickupPoints failed:', e.message);
    return [];
  }
};

/**
 * One Expo push for a pending delivery offer (initial + continuous reminders).
 */
const pushRiderOffer = async (userId, order, offer, { reminder = false } = {}) => {
  if (!userId) return;
  const orderNumber = order.order_number || order.orderNumber || order.id;
  const expoPush = require('../utils/expoPush');
  const fcmAlarm = require('../utils/fcmAlarmPush');
  const mins = Math.max(1, Math.round(RIDER_OFFER_TIMEOUT_SEC / 60));
  const alarmData = {
    type: 'rider_offer',
    alertType: 'rider_offer_alarm',
    offerId: String(offer.id),
    orderId: String(order.id || offer.order_id),
    orderNumber: String(orderNumber),
    expiresAt: String(offer.expires_at || offer.expiresAt || ''),
    reminder: reminder ? '1' : '0',
  };

  // Prefer native FCM data-only for killed-app notifee full-screen.
  const fcm = await fcmAlarm.sendFcmDataOnlyToUser(pool, userId, alarmData);
  if (!fcm.sent) {
    await expoPush.sendPushToUser(pool, userId, {
      title: reminder ? 'Delivery offer still waiting' : 'New delivery offer',
      body: reminder
        ? `Order ${orderNumber} — accept now before it expires`
        : `Order ${orderNumber} — accept within ${mins} minutes`,
      channelId: 'serveloco-rider-offers-alarm-v5',
      sound: 'rider_alarm',
      tag: `rider_offer_${offer.id}`,
      collapseId: `rider_offer_${offer.id}`,
      data: alarmData,
    });
  }
  offerLastRemindAt.set(Number(offer.id), Date.now());
};

/**
 * Notify selected rider via socket + Expo push.
 * Continuous re-pushes run from remindPendingOffers until accept/reject/expire.
 */
const notifyRiderOffer = async (rider, order, offer) => {
  try {
    const { emitToCustomer, emitToAdmins } = require('../realtime/socket');
    const userId = rider.userId || rider.user_id;
    const payload = {
      offerId: offer.id,
      orderId: order.id,
      orderNumber: order.order_number,
      order_number: order.order_number,
      expiresAt: offer.expires_at,
      expires_at: offer.expires_at,
      riderId: rider.id,
      rider_id: rider.id,
    };
    emitToCustomer(userId, 'rider.offer.created', payload);

    // Admin web Dispatch panel has no rider-user socket — push the same offer there.
    emitToAdmins(order.area_id, 'admin.order.rider_updated', {
      orderId: order.id,
      orderNumber: order.order_number,
      order_number: order.order_number,
      riderId: rider.id,
      rider_id: rider.id,
      offerId: offer.id,
      status: 'offered',
      expiresAt: offer.expires_at,
      expires_at: offer.expires_at,
    });
    emitToAdmins(order.area_id, 'admin.rider.offer.created', payload);

    await pushRiderOffer(userId, order, offer, { reminder: false });
  } catch (e) {
    console.error('[rider-assign] notifyRiderOffer failed:', e.message);
  }
};

/**
 * Re-send Expo push for every still-pending offer (app closed or open).
 * Throttled per offer via offerLastRemindAt. Called by rider-sweeper (~5s).
 *
 * No LIMIT here (unlike expireDueOffers/recoverStuckAssignments, which cap
 * batch size against a potentially larger backlog) — a rider can only ever
 * hold one pending offer at a time (listEligibleRiders excludes riders with
 * an existing pending offer), so this result set is naturally bounded by
 * concurrent online-rider count, not a scanning cost. Capping it broke the
 * eviction loop below: rows outside the cap were treated as "no longer
 * pending" and had their throttle-map entry wiped even while still pending,
 * causing them to skip the REMIND interval and refire immediately once they
 * re-entered the window.
 */
const remindPendingOffers = async () => {
  const [rows] = await pool.query(
    `SELECT o.id AS offer_id, o.order_id, o.rider_id, o.expires_at,
            r.user_id, ord.order_number
     FROM rider_order_offers o
     JOIN riders r ON r.id = o.rider_id
     JOIN orders ord ON ord.id = o.order_id
     WHERE o.status = 'pending'
       AND o.expires_at > NOW()
       AND ord.status NOT IN ('Delivered', 'Cancelled')
     ORDER BY o.expires_at ASC`
  );

  const now = Date.now();
  const liveIds = new Set();

  for (const row of rows) {
    const offerId = Number(row.offer_id);
    liveIds.add(offerId);
    const last = offerLastRemindAt.get(offerId) || 0;
    // Initial notifyRiderOffer already sent once; wait REMIND interval before next.
    if (last && now - last < RIDER_OFFER_REMIND_MS) continue;
    // If never tracked (API restart mid-offer), send immediately then throttle.
    try {
      await pushRiderOffer(
        row.user_id,
        { id: row.order_id, order_number: row.order_number },
        { id: offerId, order_id: row.order_id, expires_at: row.expires_at },
        { reminder: Boolean(last) }
      );
      // Also nudge open rider apps so popup + chime re-fire if they missed socket.
      try {
        const { emitToCustomer } = require('../realtime/socket');
        emitToCustomer(row.user_id, 'rider.offer.reminder', {
          offerId,
          orderId: row.order_id,
          orderNumber: row.order_number,
          order_number: row.order_number,
          expiresAt: row.expires_at,
          expires_at: row.expires_at,
        });
      } catch (_) { /* best-effort */ }
    } catch (e) {
      console.error('[rider-assign] remind push failed offer', offerId, e.message);
    }
  }

  // Drop map entries for offers no longer pending.
  for (const id of offerLastRemindAt.keys()) {
    if (!liveIds.has(id)) offerLastRemindAt.delete(id);
  }

  return { pending: rows.length };
};

/**
 * Create a single pending offer for chosen rider. Enforces no second pending.
 */
// Unique keys on rider_order_offers that a duplicate INSERT can trip, mapped
// to what each one means for dispatch. Order matters: the pending-* keys are
// the interesting ones, uq_offer_order_rider is the pre-existing "never
// re-offer the same order to the same rider" rule.
const OFFER_CONFLICT_BY_KEY = [
  ['uq_offer_pending_order', 'order_has_pending_offer'],
  ['uq_offer_pending_rider', 'rider_has_pending_offer'],
  ['uq_offer_order_rider', 'rider_already_offered_order'],
];

const offerConflictReason = (e) => {
  const msg = String((e && (e.sqlMessage || e.message)) || '');
  for (const [key, reason] of OFFER_CONFLICT_BY_KEY) {
    if (msg.includes(key)) return reason;
  }
  return 'duplicate_offer';
};

const isRetryableLockError = (e) => Boolean(e) && (
  e.code === 'ER_LOCK_DEADLOCK' || e.code === 'ER_LOCK_WAIT_TIMEOUT'
  || e.errno === 1213 || e.errno === 1205
);

const OFFER_LOCK_RETRIES = 3;
// How many riders to walk past when other dispatches keep winning the race
// for them. Bounded so one order can never spin through the whole roster.
const OFFER_RIDER_ATTEMPTS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One INSERT attempt. "One pending offer per order" and "one pending offer per
 * rider" are enforced by uq_offer_pending_order / uq_offer_pending_rider (see
 * migrate.js) — deliberately NOT by a `SELECT ... FOR UPDATE` pre-check, which
 * gap-locked the supremum of uq_offer_order_rider and deadlocked every
 * concurrent dispatch against every other one at peak.
 *
 * @returns {{offer: object|null, conflict?: string}}
 */
const createOfferAttempt = async (orderId, rider) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [orderRows] = await connection.query(
      'SELECT * FROM orders WHERE id = ? FOR UPDATE',
      [orderId]
    );
    const order = orderRows[0];
    if (!order || order.status === 'Cancelled' || order.status === 'Delivered' || order.rider_id) {
      await connection.rollback();
      return { offer: null, conflict: 'order_not_assignable' };
    }

    const [expRows] = await connection.query('SELECT DATE_ADD(NOW(), INTERVAL ? SECOND) AS e', [RIDER_OFFER_TIMEOUT_SEC]);
    const expiresAt = expRows[0].e;
    const [insertResult] = await connection.query(
      `INSERT INTO rider_order_offers (order_id, rider_id, status, expires_at)
       VALUES (?, ?, 'pending', ?)`,
      [orderId, rider.id, expiresAt]
    );

    await connection.query(
      `UPDATE orders SET rider_assignment_status = 'offered' WHERE id = ?`,
      [orderId]
    );

    await connection.commit();
    const offer = {
      id: insertResult.insertId,
      order_id: orderId,
      rider_id: rider.id,
      status: 'pending',
      expires_at: expiresAt,
    };

    await notifyRiderOffer(rider, order, offer);
    log('offer created', { orderId, offerId: offer.id, riderId: rider.id });
    return { offer };
  } catch (e) {
    await connection.rollback();
    if (e && e.code === 'ER_DUP_ENTRY') {
      const conflict = offerConflictReason(e);
      log('createOffer conflict', { orderId, riderId: rider.id, conflict });
      return { offer: null, conflict };
    }
    throw e;
  } finally {
    connection.release();
  }
};

/**
 * createOfferAttempt plus a bounded retry on lock errors. The gap-lock
 * deadlock is gone, but two dispatches racing for the same rider still meet
 * on uq_offer_pending_rider, and a busy peak can still time out a row lock —
 * neither is a reason to drop an order on the floor.
 */
const createOffer = async (orderId, rider) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await createOfferAttempt(orderId, rider);
    } catch (e) {
      if (isRetryableLockError(e) && attempt < OFFER_LOCK_RETRIES) {
        // Jittered so retrying dispatches do not re-collide in lockstep.
        await sleep(20 * (attempt + 1) + Math.floor(Math.random() * 30));
        continue;
      }
      console.error('[rider-assign] createOffer failed:', e.message);
      throw e;
    }
  }
};

/**
 * The whole "who gets this order" step, shared by startAssignment and
 * continueAssignment: eligible pool -> ring/fairness pick -> offer, stepping
 * to the next-best rider when another dispatch claimed that one first.
 *
 * markSearching is done here (not by the caller) so it still lands BEFORE
 * createOffer flips the order to 'offered' — the order those two writes
 * happen in is load-bearing.
 *
 * @returns {{offer: object|null, riderId: number|null, chosen: object|null, excluded: number[]}}
 */
const offerBestEligibleRider = async (orderId, areaId, { markBeforeOffer = false } = {}) => {
  const excluded = await getExcludedRiderIdsForOrder(orderId);
  let candidates = await listEligibleRiders({ excludeIds: excluded, areaId });
  if (candidates.length === 0) return { offer: null, riderId: null, chosen: null, excluded };

  const pickupPoints = await getOrderPickupPoints(orderId);
  let marked = false;

  for (let attempt = 0; attempt < OFFER_RIDER_ATTEMPTS && candidates.length > 0; attempt += 1) {
    const chosen = await selectEligibleRider(candidates, { pickupPoints });
    if (!chosen) break;

    if (markBeforeOffer && !marked) {
      await markSearching(orderId);
      marked = true;
    }

    const { offer, conflict } = await createOffer(orderId, chosen);
    if (offer) return { offer, riderId: chosen.id, chosen, excluded };
    // Another order's dispatch won this rider in the same tick — next best.
    if (conflict !== 'rider_has_pending_offer') break;
    candidates = candidates.filter((r) => r.id !== chosen.id);
  }

  return { offer: null, riderId: null, chosen: null, excluded };
};

/**
 * Stop the assignment engine when no riders remain.
 * Does NOT cancel the order — admin must cancel manually (or deliver) via
 * the mobile admin cancel-request popup / order detail.
 */
const failAssignment = async (orderId, reason = 'No riders available') => {
  try {
    const order = await loadOrder(orderId);
    if (!order) return null;
    if (order.status === 'Cancelled' || order.status === 'Delivered') {
      await pool.query(
        `UPDATE orders SET rider_assignment_status = 'failed' WHERE id = ?`,
        [orderId]
      );
      return order;
    }
    if (order.rider_id) {
      // Already assigned — do not mark failed.
      return order;
    }

    const failReason = reason.startsWith('No rider') || reason.includes('rider')
      ? reason
      : `No riders available: ${reason}`;

    await pool.query(
      `UPDATE orders
       SET rider_assignment_status = 'failed',
           rider_id = NULL,
           rider_assigned_at = NULL
       WHERE id = ? AND rider_id IS NULL AND status NOT IN ('Delivered', 'Cancelled')`,
      [orderId]
    );

    // Revoke any pending offers (should be none if chain exhausted, but safe).
    await pool.query(
      `UPDATE rider_order_offers
       SET status = 'cancelled', responded_at = NOW(), reject_reason = 'admin'
       WHERE order_id = ? AND status = 'pending'`,
      [orderId]
    );

    const updated = (await loadOrder(orderId)) || {
      ...order,
      rider_assignment_status: 'failed',
    };

    const adminInbox = require('../utils/adminNotifications');
    // reason is exactly 'No riders available' (zero eligible at start) or
    // 'No rider accepted' (pool exhausted after reject/timeout chain).
    const notifType = reason === 'No riders available'
      ? adminInbox.TYPES.RIDER_ZERO_AVAILABLE
      : adminInbox.TYPES.RIDER_ASSIGNMENT_FAILED;
    await adminInbox.createAdminNotification({
      type: notifType,
      title: `Order #${updated.order_number || orderId} — needs admin action`,
      body: `${failReason}. Cancel with a reason or investigate / deliver manually.`,
      relatedUrl: `/orders?id=${orderId}`,
      relatedId: String(orderId),
      areaId: updated.area_id,
    });

    try {
      const { notifyShopsRiderAssignmentFailed } = require('../utils/shops');
      notifyShopsRiderAssignmentFailed(updated);
    } catch (_) { /* best-effort */ }

    try {
      const { emitToAdmins } = require('../realtime/socket');
      emitToAdmins(updated.area_id, 'admin.order.cancel_request', {
        orderId: updated.id,
        orderNumber: updated.order_number,
        order_number: updated.order_number,
        reason: failReason,
        customerName: updated.customer_name || null,
        customer_name: updated.customer_name || null,
        customerPhone: updated.phone || null,
        customer_phone: updated.phone || null,
        address: updated.address || null,
        total: updated.total,
        paymentMethod: updated.payment_method || null,
        payment_method: updated.payment_method || null,
        status: updated.status,
        riderAssignmentStatus: 'failed',
        rider_assignment_status: 'failed',
        createdAt: updated.created_at,
        created_at: updated.created_at,
      });
      emitToAdmins(updated.area_id, 'admin.order.rider_updated', {
        orderId,
        status: 'failed',
        reason: failReason,
      });
    } catch (_) { /* best-effort */ }

    await syncDeliveryAvailabilityFromRiders(updated.area_id);
    log('failAssignment (no auto-cancel)', { orderId, reason: failReason });
    return updated;
  } catch (e) {
    console.error('[rider-assign] failAssignment failed:', e.message);
    return null;
  }
};

/**
 * When eligible pool is empty: wait inside the search window (30 min
 * default), else fail.
 * Fail reason distinguishes zero-ever-offered vs chain exhausted.
 */
const waitOrFailNoEligible = async (orderId, excludedIds = []) => {
  const open = await isWithinSearchWindow(orderId);
  if (open) {
    log('waiting for riders (search window open)', {
      orderId,
      windowSec: RIDER_SEARCH_WINDOW_SEC,
      excluded: excludedIds.length,
    });
    return { waiting: true, failed: false };
  }
  const reason = (excludedIds && excludedIds.length > 0)
    ? 'No rider accepted'
    : 'No riders available';
  await failAssignment(orderId, reason);
  return { waiting: false, failed: true, reason };
};

/**
 * After reject/expire/post-accept-cancel: pick next eligible, wait, or fail.
 */
const continueAssignment = async (orderId) => {
  const order = await loadOrder(orderId);
  if (!order || order.status === 'Cancelled' || order.status === 'Delivered' || order.rider_id) {
    return { continued: false };
  }

  // Only one pending at a time
  const [pending] = await pool.query(
    `SELECT id FROM rider_order_offers WHERE order_id = ? AND status = 'pending' LIMIT 1`,
    [orderId]
  );
  if (pending.length > 0) {
    return { continued: false, reason: 'pending_exists' };
  }

  const { offer, riderId, excluded } = await offerBestEligibleRider(
    orderId, order.area_id, { markBeforeOffer: true }
  );
  if (!offer) {
    const outcome = await waitOrFailNoEligible(orderId, excluded);
    return { continued: false, ...outcome };
  }
  return { continued: true, offer, riderId };
};

/**
 * Start assignment for an order (after shops confirmed or house Accepted).
 * If no riders are online yet, stays searching for RIDER_SEARCH_WINDOW_SEC
 * and is re-scanned by the sweeper — does not fail immediately.
 */
const startAssignment = async (orderId) => {
  try {
    const connection = await pool.getConnection();
    let order;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query(
        'SELECT * FROM orders WHERE id = ? FOR UPDATE',
        [orderId]
      );
      order = rows[0];
      if (!order) {
        await connection.rollback();
        return { started: false, reason: 'not_found' };
      }
      if (order.status === 'Cancelled' || order.status === 'Delivered') {
        await connection.rollback();
        return { started: false, reason: 'terminal_status' };
      }
      if (order.rider_id) {
        await connection.rollback();
        return { started: false, reason: 'already_assigned' };
      }
      const st = order.rider_assignment_status || 'none';
      if (st === 'searching' || st === 'offered' || st === 'assigned') {
        await connection.rollback();
        return { started: false, reason: 'already_in_progress', status: st };
      }
      // failed can be re-started only if we explicitly allow — v1 no restart
      if (st === 'failed') {
        await connection.rollback();
        return { started: false, reason: 'already_failed' };
      }

      await connection.query(
        `UPDATE orders
         SET rider_assignment_status = 'searching',
             rider_search_started_at = COALESCE(rider_search_started_at, NOW())
         WHERE id = ?`,
        [orderId]
      );
      await connection.commit();
    } catch (e) {
      await connection.rollback();
      throw e;
    } finally {
      connection.release();
    }

    // The row above already stamped 'searching', so no markBeforeOffer here.
    const { offer, riderId, chosen } = await offerBestEligibleRider(orderId, order.area_id);
    if (!offer) {
      // Do not fail yet — keep searching until window ends (sweeper re-scans).
      log('startAssignment waiting for riders', { orderId, windowSec: RIDER_SEARCH_WINDOW_SEC });
      return { started: true, waiting: true, reason: 'waiting_for_riders' };
    }

    log('startAssignment', {
      orderId, riderId, offerId: offer.id, distanceKm: chosen?.distanceKm,
    });
    return { started: true, offer, riderId };
  } catch (e) {
    console.error('[rider-assign] startAssignment failed:', e.message);
    return { started: false, error: e.message };
  }
};

/**
 * House-only orders (no shop-linked items): start assignment on platform Accepted.
 * No-ops when the order has any shop_id lines (shops must confirm first).
 */
const startAssignmentIfHouseOnly = async (orderId) => {
  try {
    const [items] = await pool.query(
      'SELECT shop_id FROM order_items WHERE order_id = ? AND shop_id IS NOT NULL LIMIT 1',
      [orderId]
    );
    if (items.length > 0) {
      return { started: false, reason: 'has_shops' };
    }
    return startAssignment(orderId);
  } catch (e) {
    console.error('[rider-assign] startAssignmentIfHouseOnly failed:', e.message);
    return { started: false, error: e.message };
  }
};

/**
 * Start assignment once every shop on the order has made its decision
 * (confirmed or rejected — nobody left pending), as long as at least one
 * shop confirmed something for the rider to actually pick up. A single
 * shop rejecting no longer blocks the whole order: the rider still gets
 * offered the order for whichever shops DID confirm, and sees the
 * accepted/rejected breakdown via the assignment detail endpoints
 * (riderController's shapeItemRow/loadAssignmentExtrasBatch).
 * If every shop rejected, maybeAutoCancelOrderWhenAllShopsRejected (shops.js)
 * cancels the order instead — nothing here needs to start a search for it.
 * House-only orders (no shop_id items): caller should call startAssignmentIfHouseOnly / startAssignment.
 */
const maybeStartRiderAssignment = async (orderId) => {
  try {
    const order = await loadOrder(orderId);
    if (!order || order.status === 'Cancelled' || order.rider_id) return { started: false };

    const [items] = await pool.query(
      'SELECT shop_id, shop_confirmed_at, shop_rejected_at FROM order_items WHERE order_id = ?',
      [orderId]
    );
    const shopItems = items.filter((it) => it.shop_id != null);
    if (shopItems.length === 0) {
      // House items only — do not auto-start here (Accepted path handles it).
      return { started: false, reason: 'no_shops' };
    }

    // Group by shop_id
    const byShop = new Map();
    for (const it of shopItems) {
      if (!byShop.has(it.shop_id)) byShop.set(it.shop_id, []);
      byShop.get(it.shop_id).push(it);
    }

    // Wait until every shop has decided; track whether anyone confirmed.
    let anyConfirmed = false;
    for (const shopItemsList of byShop.values()) {
      const allRejected = shopItemsList.every((it) => it.shop_rejected_at != null);
      const allConfirmed = shopItemsList.every((it) => it.shop_confirmed_at != null);
      if (!allRejected && !allConfirmed) {
        return { started: false, reason: 'waiting_shops' };
      }
      if (allConfirmed) anyConfirmed = true;
    }

    if (!anyConfirmed) {
      return { started: false, reason: 'all_shops_rejected' };
    }

    return startAssignment(orderId);
  } catch (e) {
    console.error('[rider-assign] maybeStartRiderAssignment failed:', e.message);
    return { started: false, error: e.message };
  }
};

const acceptOffer = async (offerId, riderId) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [offerRows] = await connection.query(
      `SELECT * FROM rider_order_offers WHERE id = ? FOR UPDATE`,
      [offerId]
    );
    const offer = offerRows[0];
    if (!offer) {
      await connection.rollback();
      return { ok: false, code: 'NOT_FOUND', message: 'Offer not found' };
    }
    if (Number(offer.rider_id) !== Number(riderId)) {
      await connection.rollback();
      return { ok: false, code: 'FORBIDDEN', message: 'Not your offer' };
    }
    if (offer.status !== 'pending') {
      await connection.rollback();
      return { ok: false, code: 'CONFLICT', message: 'Offer is no longer pending', status: 409 };
    }
    const [expiredCheck] = await connection.query(
      'SELECT (expires_at <= NOW()) AS is_expired FROM rider_order_offers WHERE id = ?',
      [offerId]
    );
    if (expiredCheck[0]?.is_expired) {
      await connection.query(
        `UPDATE rider_order_offers
         SET status = 'expired', responded_at = NOW(), reject_reason = 'timeout'
         WHERE id = ? AND status = 'pending'`,
        [offerId]
      );
      await connection.commit();
      clearOfferRemind(offerId);
      // Continue outside
      setImmediate(() => continueAssignment(offer.order_id).catch(() => {}));
      return { ok: false, code: 'CONFLICT', message: 'Offer expired', status: 409 };
    }

    const [orderRows] = await connection.query(
      'SELECT * FROM orders WHERE id = ? FOR UPDATE',
      [offer.order_id]
    );
    const order = orderRows[0];
    if (!order || order.status === 'Cancelled' || order.status === 'Delivered' || order.rider_id) {
      await connection.rollback();
      // Admin took the order out of play (delivered/reassigned) while offer was pending.
      await connection.query(
        `UPDATE rider_order_offers SET status = 'cancelled', responded_at = NOW(), reject_reason = 'admin'
         WHERE id = ? AND status = 'pending'`,
        [offerId]
      ).catch(() => {});
      return { ok: false, code: 'CONFLICT', message: 'Order not assignable', status: 409 };
    }

    // Multi-order allowed: riders may already hold other active deliveries.

    await connection.query(
      `UPDATE rider_order_offers
       SET status = 'accepted', responded_at = NOW()
       WHERE id = ? AND status = 'pending'`,
      [offerId]
    );
    await connection.query(
      `UPDATE orders
       SET rider_id = ?, rider_assigned_at = NOW(), rider_assignment_status = 'assigned'
       WHERE id = ?`,
      [riderId, offer.order_id]
    );

    await connection.commit();
    clearOfferRemind(offerId);

    const updated = await loadOrder(offer.order_id);

    try {
      const { emitToCustomer, emitToAdmins } = require('../realtime/socket');
      emitToCustomer(updated.customer_id, 'rider.assignment.updated', {
        orderId: updated.id,
        riderId,
        status: 'assigned',
      });
      // Rider app (or admin acting for them): clear Accept popup + refresh jobs.
      const [riderUserRows] = await pool.query('SELECT user_id FROM riders WHERE id = ?', [riderId]);
      if (riderUserRows[0]?.user_id) {
        emitToCustomer(riderUserRows[0].user_id, 'rider.offer.revoked', {
          offerId,
          orderId: updated.id,
          reason: 'accepted',
        });
        emitToCustomer(riderUserRows[0].user_id, 'rider.assignment.updated', {
          orderId: updated.id,
          riderId,
          status: 'assigned',
        });
      }
      emitToAdmins(updated.area_id, 'admin.order.rider_updated', {
        orderId: updated.id,
        riderId,
        status: 'assigned',
      });
    } catch (_) { /* best-effort */ }

    // Customer + shop notifications — rider assigned
    try {
      const notificationService = require('../utils/notificationService');
      const realtimeEvents = require('../realtime/orderEvents');
      notificationService.createOrderNotification({
        userId: updated.customer_id,
        order: updated,
        event: 'rider_assigned',
      }).then((result) => {
        if (result) realtimeEvents.emitNotificationCreated(updated.customer_id, result);
      }).catch(() => {});
      const { notifyShopsRiderAssigned } = require('../utils/shops');
      notifyShopsRiderAssigned(updated);
    } catch (_) { /* best-effort */ }

    log('acceptOffer', { offerId, orderId: offer.order_id, riderId });
    return { ok: true, order: updated };
  } catch (e) {
    await connection.rollback();
    console.error('[rider-assign] acceptOffer failed:', e.message);
    return { ok: false, code: 'INTERNAL', message: e.message, status: 500 };
  } finally {
    connection.release();
  }
};

const rejectOffer = async (offerId, riderId, rejectReason = 'manual') => {
  const connection = await pool.getConnection();
  let orderId = null;
  try {
    await connection.beginTransaction();
    const [offerRows] = await connection.query(
      `SELECT * FROM rider_order_offers WHERE id = ? FOR UPDATE`,
      [offerId]
    );
    const offer = offerRows[0];
    if (!offer) {
      await connection.rollback();
      return { ok: false, code: 'NOT_FOUND', message: 'Offer not found' };
    }
    if (Number(offer.rider_id) !== Number(riderId)) {
      await connection.rollback();
      return { ok: false, code: 'FORBIDDEN', message: 'Not your offer' };
    }
    if (offer.status !== 'pending') {
      await connection.rollback();
      return { ok: false, code: 'CONFLICT', message: 'Offer is no longer pending', status: 409 };
    }
    orderId = offer.order_id;
    await connection.query(
      `UPDATE rider_order_offers
       SET status = 'rejected', responded_at = NOW(), reject_reason = ?
       WHERE id = ? AND status = 'pending'`,
      [rejectReason, offerId]
    );
    await connection.commit();
  } catch (e) {
    await connection.rollback();
    console.error('[rider-assign] rejectOffer failed:', e.message);
    return { ok: false, code: 'INTERNAL', message: e.message, status: 500 };
  } finally {
    connection.release();
  }

  clearOfferRemind(offerId);

  // Clear Accept popup if admin rejected (or multi-device).
  try {
    const [riderRows] = await pool.query('SELECT user_id FROM riders WHERE id = ?', [riderId]);
    if (riderRows[0]?.user_id) {
      const { emitToCustomer } = require('../realtime/socket');
      emitToCustomer(riderRows[0].user_id, 'rider.offer.revoked', {
        offerId,
        orderId,
        reason: rejectReason || 'rejected',
      });
    }
  } catch (_) { /* best-effort */ }

  const cont = await continueAssignment(orderId);
  log('rejectOffer', { offerId, orderId, cont });
  return { ok: true, continued: cont };
};

/**
 * Expire a single pending offer if past expires_at (CAS).
 */
const expireOffer = async (offerId) => {
  const [result] = await pool.query(
    `UPDATE rider_order_offers
     SET status = 'expired', responded_at = NOW(), reject_reason = 'timeout'
     WHERE id = ? AND status = 'pending' AND expires_at <= NOW()`,
    [offerId]
  );
  if (result.affectedRows === 0) return { expired: false };

  clearOfferRemind(offerId);

  const [rows] = await pool.query('SELECT order_id, rider_id FROM rider_order_offers WHERE id = ?', [offerId]);
  const offer = rows[0];
  if (offer) {
    try {
      const [riderRows] = await pool.query('SELECT user_id FROM riders WHERE id = ?', [offer.rider_id]);
      if (riderRows[0]) {
        const { emitToCustomer } = require('../realtime/socket');
        emitToCustomer(riderRows[0].user_id, 'rider.offer.expired', {
          offerId,
          orderId: offer.order_id,
        });
      }
    } catch (_) { /* best-effort */ }
    await continueAssignment(offer.order_id);
  }
  log('expireOffer', { offerId, orderId: offer?.order_id });
  return { expired: true, orderId: offer?.order_id };
};

/**
 * Sweep all due pending offers.
 */
const expireDueOffers = async () => {
  const [rows] = await pool.query(
    `SELECT id FROM rider_order_offers
     WHERE status = 'pending' AND expires_at <= NOW()
     ORDER BY expires_at ASC
     LIMIT 50`
  );
  const results = [];
  for (const row of rows) {
    results.push(await expireOffer(row.id));
  }
  return results;
};

/**
 * Recover / re-scan orders stuck in 'searching'/'offered' with no rider and
 * no pending offer:
 *  - crash between startAssignment commit and createOffer
 *  - waiting for riders to come online (30-min window after shop confirm)
 *
 * Called by the offer sweeper every RIDER_SWEEPER_MS (~5s). That is at least
 * as frequent as the product "every RIDER_SEARCH_SCAN_SEC (30s)" re-scan.
 * continueAssignment either creates an offer, stays waiting, or fails the
 * window after RIDER_SEARCH_WINDOW_SEC.
 *
 * With nobody online IN THAT ORDER'S AREA, continueAssignment's own
 * listEligibleRiders query is guaranteed empty for every single waiting
 * order in that area — a full re-scan (loadOrder + pending check + the
 * eligible-riders JOIN, per order, every tick) buys nothing. One
 * countActiveRiders(areaId) check per distinct area up front collapses that
 * to a single window-expiry check per order instead, while still letting
 * failAssignment fire on schedule (an order stuck waiting the full
 * RIDER_SEARCH_WINDOW_SEC with zero riders online in its area is exactly the
 * case that must notify admin). Scoped per area (not once globally) so an
 * area with online riders never masks another area with none, or vice versa.
 * The SELECT above already guarantees the same not-cancelled/not-delivered/
 * no-pending-offer/rider_id-NULL state continueAssignment re-checks via
 * loadOrder, so skipping that recheck here is safe, not a shortcut.
 */
const recoverStuckAssignments = async () => {
  const [rows] = await pool.query(
    `SELECT o.id, o.area_id FROM orders o
     WHERE o.rider_assignment_status IN ('searching', 'offered')
       AND o.rider_id IS NULL
       AND o.status NOT IN ('Delivered', 'Cancelled')
       AND NOT EXISTS (
         SELECT 1 FROM rider_order_offers ro
         WHERE ro.order_id = o.id AND ro.status = 'pending'
       )
     ORDER BY o.rider_search_started_at ASC
     LIMIT 50`
  );
  if (rows.length === 0) return [];

  const areaIds = [...new Set(rows.map((row) => row.area_id))];
  const onlineByArea = new Map(
    await Promise.all(areaIds.map(async (areaId) => [areaId, (await countActiveRiders(areaId)) > 0]))
  );

  const results = [];
  for (const row of rows) {
    if (onlineByArea.get(row.area_id)) {
      log('recoverStuckAssignments — resuming/scanning', row.id);
      results.push(await continueAssignment(row.id));
      continue;
    }
    // Nobody online in this order's area — just check whether the window expired.
    const excluded = await getExcludedRiderIdsForOrder(row.id);
    const outcome = await waitOrFailNoEligible(row.id, excluded);
    results.push({ continued: false, ...outcome });
  }
  return results;
};

/**
 * Rider post-accept cancel is disabled — once accepted, only admin can cancel.
 */
const cancelAssignmentByRider = async (_orderId, _riderId) => ({
  ok: false,
  code: 'CANCEL_NOT_ALLOWED',
  message: 'Cannot cancel after accepting. Contact admin if needed.',
  status: 400,
});

/**
 * Revoke pending offers when order is cancelled externally.
 */
const revokeOffersForOrder = async (orderId) => {
  try {
    const queryResult = await pool.query(
      `SELECT o.id AS offer_id, o.rider_id, r.user_id
       FROM rider_order_offers o
       JOIN riders r ON r.id = o.rider_id
       WHERE o.order_id = ? AND o.status = 'pending'`,
      [orderId]
    );
    const pending = Array.isArray(queryResult?.[0]) ? queryResult[0] : [];
    await pool.query(
      `UPDATE rider_order_offers
       SET status = 'cancelled', responded_at = NOW(), reject_reason = 'admin'
       WHERE order_id = ? AND status = 'pending'`,
      [orderId]
    );
    const { emitToCustomer } = require('../realtime/socket');
    for (const row of pending) {
      clearOfferRemind(row.offer_id);
      emitToCustomer(row.user_id, 'rider.offer.revoked', {
        offerId: row.offer_id,
        orderId,
      });
    }
  } catch (e) {
    console.error('[rider-assign] revokeOffersForOrder failed:', e.message);
  }
};

/**
 * Admin emergency reassign: force a specific rider onto an order, before it's
 * "Out for Delivery" (goods not yet with a rider). Works whether the order
 * currently has an accepted rider, an unanswered pending offer, or gave up
 * with rider_assignment_status='failed' — the last case doubles as a manual
 * first-assign, since this calls createOffer() directly rather than
 * startAssignment(), so the "no restart after failed" guard never applies.
 * Old rider (if any) is cleared and told via the existing rider.assignment.updated
 * contract (their app already unconditionally refetches on that event).
 */
const reassignRider = async (orderId, targetRider, areaId) => {
  const connection = await pool.getConnection();
  let previousRiderUserId = null;
  let previousRiderId = null;
  try {
    await connection.beginTransaction();

    const [orderRows] = await connection.query(
      'SELECT * FROM orders WHERE id = ? AND area_id = ? FOR UPDATE',
      [orderId, areaId]
    );
    const order = orderRows[0];
    if (!order) {
      await connection.rollback();
      return { ok: false, code: 'NOT_FOUND', message: 'Order not found', status: 404 };
    }
    if (['Out for Delivery', 'Delivered', 'Cancelled'].includes(order.status)) {
      await connection.rollback();
      return {
        ok: false,
        code: 'CONFLICT',
        message: `Cannot reassign — order is already ${order.status}`,
        status: 409,
      };
    }
    if (Number(order.rider_id) === Number(targetRider.id) && order.rider_assignment_status === 'assigned') {
      await connection.rollback();
      return { ok: false, code: 'VALIDATION_ERROR', message: 'Order is already assigned to this rider', status: 400 };
    }

    if (order.rider_id) {
      previousRiderId = order.rider_id;
      const [prevRows] = await connection.query('SELECT user_id FROM riders WHERE id = ?', [previousRiderId]);
      previousRiderUserId = prevRows[0]?.user_id || null;
    }

    await connection.query(
      `UPDATE orders
       SET rider_id = NULL, rider_assigned_at = NULL, rider_assignment_status = 'searching'
       WHERE id = ?`,
      [orderId]
    );

    // uq_offer_order_rider is a hard UNIQUE on (order_id, rider_id) — it's
    // what stops the *auto* engine from re-offering a rider who already
    // rejected/expired on this order. An admin picking a rider by hand is an
    // explicit override of that history, so clear any old row for this exact
    // pair first or the createOffer() insert below hits ER_DUP_ENTRY and
    // silently no-ops even though nothing is actually wrong.
    await connection.query(
      `DELETE FROM rider_order_offers WHERE order_id = ? AND rider_id = ?`,
      [orderId, targetRider.id]
    );

    await connection.commit();
  } catch (e) {
    await connection.rollback();
    console.error('[rider-assign] reassignRider failed:', e.message);
    return { ok: false, code: 'ERROR', message: 'Reassign failed', status: 500 };
  } finally {
    connection.release();
  }

  // Kill any unanswered offer to whoever had one — revokeOffersForOrder runs
  // its own queries/emits, kept outside the transaction above like every
  // other caller of it in this file.
  await revokeOffersForOrder(orderId);

  if (previousRiderId && previousRiderUserId) {
    try {
      const { emitToCustomer } = require('../realtime/socket');
      emitToCustomer(previousRiderUserId, 'rider.assignment.updated', {
        orderId, riderId: previousRiderId, status: 'reassigned',
      });
    } catch (_) { /* best-effort */ }
  }

  try {
    const { emitToAdmins } = require('../realtime/socket');
    emitToAdmins(areaId, 'admin.order.rider_updated', {
      orderId, status: 'reassigning', riderId: targetRider.id,
    });
  } catch (_) { /* best-effort */ }

  // createOffer resolves to { offer, conflict } — offer is only ever null on
  // failure, so it's always a truthy object; destructure it, don't test the
  // wrapper's own truthiness (that never fires and previously made this
  // report ok:true even when the new offer was never actually created).
  const { offer, conflict } = await createOffer(orderId, targetRider);
  if (!offer) {
    return {
      ok: false,
      code: 'CONFLICT',
      message: conflict === 'order_not_assignable'
        ? 'Order is no longer assignable — it may have moved past dispatch already'
        : 'Could not create an offer for the selected rider — try again',
      status: 409,
    };
  }

  const updated = await loadOrder(orderId);
  return { ok: true, order: updated, offer, previousRiderId };
};

module.exports = {
  RIDER_OFFER_TIMEOUT_SEC,
  RIDER_SEARCH_WINDOW_SEC,
  RIDER_SEARCH_SCAN_SEC,
  RIDER_OFFER_REMIND_SEC,
  startAssignment,
  startAssignmentIfHouseOnly,
  maybeStartRiderAssignment,
  createOffer,
  acceptOffer,
  rejectOffer,
  expireOffer,
  expireDueOffers,
  failAssignment,
  cancelAssignmentByRider,
  continueAssignment,
  recoverStuckAssignments,
  getExcludedRiderIdsForOrder,
  getOrderPickupPoints,
  revokeOffersForOrder,
  reassignRider,
  remindPendingOffers,
  isWithinSearchWindow,
  markSearching,
};
