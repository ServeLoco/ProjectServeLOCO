const { Expo } = require('expo-server-sdk');
const config = require('../config/env');

const expo = new Expo();
// Per-push success line is diagnostic noise at prod volume (one line per
// notification sent) — keep it for local/dev debugging, drop it in prod.
// Failures/warnings (no token, ticket errors) always log regardless.
const isProd = config.NODE_ENV === 'production';

/**
 * Build a single Expo push message object.
 * Title + body + high priority + channelId so FCM/APNs show a system banner
 * when the app is backgrounded or fully killed (swiped away). Shop/rider
 * alarm alerts prefer native FCM data-only delivery instead (see
 * fcmAlarmPush.js) and only fall back to this — with a custom sound/tag —
 * when the device has no fcm_token registered yet.
 *
 * Do NOT set `color` — Expo Push API currently rejects every hex form we
 * tried ("Must be a valid hex color") and the whole send fails, so no
 * device ever gets the banner. Brand tint stays on the Android channel
 * created client-side instead.
 */
const buildMessage = (token, {
  title, body, data = {}, categoryId, channelId, sound, tag, collapseId,
} = {}) => {
  const dataPayload = {
    // Stringify-friendly payload; clients read these on tap from killed state.
    ...Object.fromEntries(
      Object.entries(data || {}).map(([k, v]) => [k, v == null ? v : String(v)])
    ),
  };

  // sound: omit or pass custom res/raw basename (e.g. 'order_alarm') for alarm
  // channels. 'default' can override channel custom audio on some OEMs.
  //
  // This field is effectively iOS-facing: on Android 8+ the notification
  // sound comes from the channel referenced by channelId (the client
  // registers ORDER_ALARM_CHANNEL_ID with sound: 'order_alarm'), so the
  // payload value is only consulted by APNs. iOS resolves it against files
  // bundled in the app and needs the FULL filename — a bare 'order_alarm'
  // matches nothing there, which is why iOS shop/rider alarms fell back to
  // the default notification sound. Call sites keep passing the Android
  // res/raw basename (one convention, matching the channel config) and the
  // extension is added here for APNs.
  const IOS_SOUND_EXTENSION = '.wav';
  const withIosExtension = (value) => (
    typeof value === 'string' && value !== 'default' && !value.includes('.')
      ? `${value}${IOS_SOUND_EXTENSION}`
      : value
  );
  const soundValue = sound === undefined ? 'default' : withIosExtension(sound);

  return {
    to: token,
    data: dataPayload,
    ...(soundValue != null ? { sound: soundValue } : {}),
    title: title || 'VillKro',
    body: body || '',
    // Default matches client ORDER_NOTIFICATION_CHANNEL_ID (sound + vibrate).
    // Rider offers / alarms pass a dedicated channelId.
    channelId: channelId || 'serveloco-orders-v2',
    // high = wake device / heads-up when app is not in foreground.
    priority: 'high',
    // Keep trying delivery for ~1h if device was offline.
    ttl: 3600,
    // categoryId wires up action buttons registered on the client side
    // (e.g. "View Order") so the user can act without opening the app.
    ...(categoryId ? { categoryId } : {}),
    // Android: same tag replaces the previous tray item (prevents spam).
    ...(tag ? { tag: String(tag) } : {}),
    ...(collapseId ? { collapseId: String(collapseId) } : {}),
  };
};

/**
 * Send a push notification to a single user identified by their DB userId.
 * Looks up their push_token, validates it, and fires via Expo Push API.
 * Completely fire-and-forget — never throws.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {number} userId
 * @param {{ title?: string, body?: string, data?: object, categoryId?: string, channelId?: string }} opts
 */
const sendPushToUser = async (pool, userId, opts) => {
  try {
    const [rows] = await pool.query(
      'SELECT push_token FROM users WHERE id = ? AND push_token IS NOT NULL LIMIT 1',
      [userId]
    );
    const token = rows[0]?.push_token;
    if (!token || !Expo.isExpoPushToken(token)) {
      console.warn('[expoPush] sendPushToUser: user %s has no valid push_token — device will not get banner', userId);
      return { sent: false, reason: 'no_token' };
    }

    const tickets = await expo.sendPushNotificationsAsync([buildMessage(token, opts)]);
    const { ok, failed } = tallyTickets(tickets, 'sendPushToUser');
    await cleanupDeadTokens(pool, tickets, [token]);
    if (!isProd) {
      console.log('[expoPush] sendPushToUser user=%s title=%j ok=%d failed=%d', userId, opts?.title, ok, failed);
    }
    return { sent: ok > 0, ok, failed };
  } catch (err) {
    console.error('[expoPush] sendPushToUser failed:', err.message);
    return { sent: false, reason: err.message };
  }
};

/**
 * Send push notifications to many users in one batched call.
 * Completely fire-and-forget — never throws.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {number[]} userIds
 * @param {{ title?: string, body?: string, data?: object, categoryId?: string, channelId?: string }} opts
 */
const sendPushToMany = async (pool, userIds, opts) => {
  const stats = { recipients: userIds?.length || 0, tokensFound: 0, sent: 0, failed: 0 };

  if (!userIds || userIds.length === 0) return stats;

  try {
    const placeholders = userIds.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT push_token FROM users WHERE id IN (${placeholders}) AND push_token IS NOT NULL`,
      userIds
    );

    const messages = rows
      .map(r => r.push_token)
      .filter(t => Expo.isExpoPushToken(t))
      .map(token => buildMessage(token, opts));

    stats.tokensFound = messages.length;

    if (messages.length === 0) {
      console.warn('[expoPush] sendPushToMany: 0 of %d target users have a valid push token — no device pushes sent', userIds.length);
      return stats;
    }

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      let tickets;
      try {
        tickets = await expo.sendPushNotificationsAsync(chunk);
      } catch (err) {
        console.error('[expoPush] chunk send failed:', err.message);
        stats.failed += chunk.length;
        continue;
      }
      const { ok, failed } = tallyTickets(tickets, 'sendPushToMany');
      stats.sent += ok;
      stats.failed += failed;
      await cleanupDeadTokens(pool, tickets, chunk.map(m => m.to));
    }
    return stats;
  } catch (err) {
    console.error('[expoPush] sendPushToMany failed:', err.message);
    return stats;
  }
};

// Log every error ticket (Expo only nulls tokens for DeviceNotRegistered;
// other errors like InvalidCredentials were previously invisible).
const tallyTickets = (tickets, context) => {
  let ok = 0, failed = 0;
  for (const ticket of tickets || []) {
    if (ticket?.status === 'error') {
      failed++;
      console.error('[expoPush] %s ticket error: %s — %s', context, ticket.details?.error || 'unknown', ticket.message || '');
    } else {
      ok++;
    }
  }
  return { ok, failed };
};

/**
 * Inspect Expo push tickets and null out push_tokens for devices that the
 * APNS/FCM layer has marked as `DeviceNotRegistered`. Fire-and-forget safe —
 * any error is logged and swallowed so cleanup can never fail the send.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {Array<{status?: string, details?: {error?: string}}>} tickets
 * @param {string[]} tokens  Same length and order as the messages sent.
 */
const cleanupDeadTokens = async (pool, tickets, tokens) => {
  try {
    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      if (ticket?.status === 'error' && ticket?.details?.error === 'DeviceNotRegistered') {
        const token = tokens[i];
        if (token) {
          await pool.query('UPDATE users SET push_token = NULL WHERE push_token = ?', [token]);
        }
      }
    }
  } catch (err) {
    console.error('[expoPush] cleanup failed:', err.message);
  }
};

// How many of userIds can actually receive a device push.
// Never throws; returns null on query failure (callers treat null as "unknown",
// 0 as a definite "no devices" — do not collapse the two).
const countPushEligible = async (pool, userIds) => {
  if (!userIds || userIds.length === 0) return 0;
  try {
    const placeholders = userIds.map(() => '?').join(',');
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM users WHERE id IN (${placeholders}) AND push_token IS NOT NULL`,
      userIds
    );
    return Number(rows?.[0]?.cnt ?? 0);
  } catch (err) {
    console.error('[expoPush] countPushEligible failed:', err.message);
    return null;
  }
};

module.exports = { sendPushToUser, sendPushToMany, cleanupDeadTokens, countPushEligible };
