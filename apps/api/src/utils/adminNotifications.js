const { pool } = require('../db/mysql');
const { emitToAdmins } = require('../realtime/socket');
const { sendPushToMany } = require('./expoPush');

const TYPES = {
  NEW_ORDER: 'new_order',
  NEW_CUSTOMER: 'new_customer',
  SHOP_REJECTED: 'shop_rejected',
  ORDER_AUTO_CANCELLED: 'order_auto_cancelled',
  RIDER_ASSIGNMENT_FAILED: 'rider_assignment_failed',
  RIDER_ZERO_AVAILABLE: 'rider_zero_available',
  ORDER_CANCELLED_NO_RIDER: 'order_cancelled_no_rider',
};

/**
 * Inserts an admin notification and pushes it live to every connected
 * admin via Socket.IO. Failures are logged but never throw — admin inbox
 * writes are best-effort and must not break the caller (e.g. a customer
 * checkout).
 *
 * areaId is required — admin_notifications.area_id is NOT NULL (TASK 3) and
 * part of its composite unique key (uniq_admin_inbox_area_event). Every real
 * caller already has one on hand (an order's own area_id, a shop-owner
 * action's shop area, etc.); the one caller with no natural signal
 * (authController's new-signup notification, before any area is resolved)
 * passes getDefaultArea() explicitly rather than this function guessing —
 * see that call site for why. Omitting it entirely fails the INSERT's NOT
 * NULL constraint, caught below same as any other DB error (never throws to
 * the caller), but every real site must pass one.
 */
const createAdminNotification = async ({ type, title, body, relatedUrl = null, relatedId = null, areaId }) => {
  try {
    // Skip rows that would collide with an existing un-acknowledged event for
    // the same business entity (e.g. duplicate signup/order retries) — same
    // area, same type, same related entity.
    const [result] = await pool.query(
      `INSERT IGNORE INTO admin_notifications (area_id, type, title, body, related_url, related_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [areaId, type, title, body, relatedUrl, relatedId]
    );
    if (result.affectedRows === 0) {
      // Duplicate — don't emit a realtime event, the original is already
      // pending in the admin's inbox.
      return null;
    }
    const [rows] = await pool.query(
      `SELECT id, area_id, type, title, body, related_url, related_id, read_at, created_at
         FROM admin_notifications
        WHERE id = ?`,
      [result.insertId]
    );
    const notification = rows[0];
    if (notification) {
      // Not yet area-scoped on the socket layer (per-area rooms land in
      // TASK 23) — every connected admin gets this regardless of area, same
      // as every other realtime emit in the codebase until then.
      emitToAdmins('admin.notification.created', notification);
      // Fire-and-forget updated badge count so all open admin tabs refresh.
      broadcastUnreadCount(areaId);
      // Background push to mobile admin phones (D4 — foreground gets the
      // socket event above; backgrounded/killed apps need a device push).
      // Every inbox type gets a push, matching the bell — the INSERT IGNORE
      // above already means this only runs once per event even if callers
      // double-fire. Fire-and-forget: several request handlers await
      // createAdminNotification (shop-owner reject, rider dispatch), and this
      // push is an external Expo HTTP round trip — blocking their response on
      // it added hundreds of ms for a side effect the caller never reads.
      // Failures still log inside notifyMobileAdminsPush/expoPush.
      notifyMobileAdminsPush({ title, body, type, relatedId })
        .catch((err) => console.error('[adminNotifications] push failed:', err.message));
    }
    return notification;
  } catch (e) {
    console.error('[adminNotifications] create failed:', e.message);
    return null;
  }
};

/**
 * areaId: a number scopes to one area; 'all' or omitted counts every area
 * (the pre-TASK-16 behavior, still used by broadcastUnreadCount's own
 * un-awaited fire-and-forget push since emitToAdmins isn't per-area yet).
 */
const getUnreadCount = async (areaId) => {
  try {
    const scoped = areaId !== undefined && areaId !== 'all';
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM admin_notifications WHERE read_at IS NULL${scoped ? ' AND area_id = ?' : ''}`,
      scoped ? [areaId] : []
    );
    return Number(rows[0].n) || 0;
  } catch (e) {
    console.error('[adminNotifications] unread count failed:', e.message);
    return 0;
  }
};

const broadcastUnreadCount = async (areaId) => {
  const n = await getUnreadCount(areaId);
  emitToAdmins('admin.notification.unread_count', { count: n });
};

/**
 * Fan out an Expo push to every active mobile admin with a linked, push-token
 * capable device, scoped to this notification's own area — a mobile admin
 * in area 2 has no reason to be paged about area 1's new order. Fire-and-
 * forget — never throws (mirrors createAdminNotification). `mobile_admins`
 * itself (CRUD/login) is otherwise untouched by this task — only this one
 * read, which lives in this task's own file, gained the area filter.
 */
const notifyMobileAdminsPush = async ({ title, body, type, relatedId, areaId }) => {
  try {
    const [rows] = await pool.query(
      'SELECT user_id FROM mobile_admins WHERE active = 1 AND user_id IS NOT NULL AND area_id = ?',
      [areaId]
    );
    const userIds = rows.map((r) => r.user_id);
    if (userIds.length === 0) return;
    await sendPushToMany(pool, userIds, {
      title,
      body,
      data: { type, orderId: relatedId },
    });
  } catch (e) {
    console.error('[adminNotifications] mobile admin push fan-out failed:', e.message);
  }
};

module.exports = {
  TYPES,
  createAdminNotification,
  getUnreadCount,
  broadcastUnreadCount,
};
