/**
 * Killed-app / background full-screen alarm path for shop-owner new orders
 * and rider delivery offers. Uses notifee; only invoked from the FCM
 * setBackgroundMessageHandler (never from boot receivers).
 *
 * Foreground alerts remain on useNewOrderAlert / useRiderOfferAlert.
 */
import { Platform } from 'react-native';
import notifee, {
  AndroidCategory,
  AndroidForegroundServiceType,
  AndroidImportance,
  AndroidVisibility,
  EventType,
} from '@notifee/react-native';
import {
  ORDER_ALARM_CHANNEL_ID,
  RIDER_OFFER_ALARM_CHANNEL_ID,
  createNotifeeAlarmChannels,
} from '../hooks/useLocalNotifications';
import { shopApi } from '../api/shopApi';
import { riderApi } from '../api/riderApi';
import { setCustomerTokenProvider } from '../api/sessionTokens';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuthStore } from '../stores';
import { playAlarmSound, stopAlarmSound } from './alarmSound';

// Stable notification ids so cancel-on-open can silence a still-ringing alarm.
export const ORDER_ALARM_NOTIFICATION_ID = 'serveloco-order-alarm';
export const RIDER_OFFER_ALARM_NOTIFICATION_ID = 'serveloco-rider-offer-alarm';

// Shop-owner ring cap (no server-side expiry for new-order alerts).
export const MAX_ORDER_ALARM_RING_MS = 5 * 60 * 1000;

export const ALERT_TYPE_NEW_ORDER = 'new_order_alarm';
export const ALERT_TYPE_RIDER_OFFER = 'rider_offer_alarm';

const ACTION_ACCEPT = 'accept';
const ACTION_REJECT = 'reject';

// Dedupe window: server re-pushes the same offer ~every 15s. Re-displaying
// the full-screen alarm + restarting media sound on every FCM message feels
// like spam. Same offer/order within this window is a no-op (already ringing).
const ALARM_DEDUPE_MS = 45_000;
let activeAlarmKey = null;
let activeAlarmAt = 0;

function isAlarmAlertType(alertType) {
  return alertType === ALERT_TYPE_NEW_ORDER || alertType === ALERT_TYPE_RIDER_OFFER;
}

/** Stable key for one logical alarm (one offer / one new-order). */
function alarmDedupeKey(data) {
  if (!data) return null;
  if (data.alertType === ALERT_TYPE_RIDER_OFFER) {
    const offerId = data.offerId || data.offer_id;
    return offerId ? `rider:${offerId}` : null;
  }
  if (data.alertType === ALERT_TYPE_NEW_ORDER) {
    const orderId = data.orderId || data.order_id;
    return orderId ? `order:${orderId}` : null;
  }
  return null;
}

function markAlarmActive(data) {
  const key = alarmDedupeKey(data);
  if (!key) return;
  activeAlarmKey = key;
  activeAlarmAt = Date.now();
}

function clearAlarmActive(kind) {
  if (kind === 'rider' && activeAlarmKey?.startsWith('rider:')) {
    activeAlarmKey = null;
    activeAlarmAt = 0;
  } else if (kind === 'order' && activeAlarmKey?.startsWith('order:')) {
    activeAlarmKey = null;
    activeAlarmAt = 0;
  } else if (kind === 'all') {
    activeAlarmKey = null;
    activeAlarmAt = 0;
  }
}

/**
 * True if we already displayed this offer/order alarm recently (still ringing).
 * Server reminders should not re-fire full-screen + sound every 15s.
 */
function isDuplicateActiveAlarm(data) {
  const key = alarmDedupeKey(data);
  if (!key || !activeAlarmKey) return false;
  if (key !== activeAlarmKey) return false;
  return Date.now() - activeAlarmAt < ALARM_DEDUPE_MS;
}

/**
 * Extract FCM / Expo data payload (string values).
 * @param {object} remoteMessage
 */
export function getRemoteAlarmData(remoteMessage) {
  const data = remoteMessage?.data;
  if (!data || typeof data !== 'object') return null;
  return data;
}

/**
 * Read persisted auth from AsyncStorage (Zustand persist shape).
 * Headless FCM JS often starts before rehydrate — memory store is empty.
 */
async function readPersistedAuthState() {
  try {
    const raw = await AsyncStorage.getItem('serveloco-customer-auth');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.state || parsed || null;
  } catch {
    return null;
  }
}

/**
 * Ensure a customer JWT is available for API calls from a background
 * notifee action (app may be killed — token providers not yet wired).
 * Exported for reuse by other background-only entry points (e.g.
 * riderBackgroundLocationTask.js's TaskManager callback) that hit the same
 * "JS relaunched headless, App.js's setCustomerTokenProvider(() =>
 * useAuthStore.getState().token) never ran, zustand-persist hasn't
 * rehydrated yet" gap.
 */
export async function ensureBackgroundCustomerToken() {
  let token = useAuthStore.getState()?.token || null;
  if (!token) {
    const persisted = await readPersistedAuthState();
    token = persisted?.token || null;
  }
  if (token) {
    setCustomerTokenProvider(async () => token);
  }
  return token;
}

/**
 * Shop/rider gate for alarms: seed Zustand from disk when headless cold-start
 * has not rehydrated yet (otherwise displayAlarmNotification no-ops).
 * @returns {Promise<{ shop: object|null, rider: object|null }>}
 */
async function ensureShopOrRiderSession() {
  let { shop, rider, token, user, profile, isAuthenticated } = useAuthStore.getState();
  if (shop || rider) {
    return { shop, rider };
  }
  const persisted = await readPersistedAuthState();
  if (!persisted) return { shop: null, rider: null };

  const pShop = persisted.shop ?? null;
  const pRider = persisted.rider ?? null;
  if (!pShop && !pRider) {
    return { shop: null, rider: null };
  }

  // Seed enough session for alarm display + Accept/Reject API.
  useAuthStore.setState({
    token: persisted.token ?? token ?? null,
    user: persisted.user ?? user ?? null,
    profile: persisted.profile ?? profile ?? null,
    shop: pShop,
    rider: pRider,
    isAuthenticated: Boolean(persisted.token || isAuthenticated),
  });
  if (persisted.token) {
    setCustomerTokenProvider(async () => persisted.token);
  }
  return { shop: pShop, rider: pRider };
}

function resolveRiderTimeoutMs(data) {
  const expiresAt = data?.expiresAt || data?.expires_at;
  if (expiresAt) {
    const end = new Date(expiresAt).getTime();
    if (!Number.isNaN(end)) {
      const remaining = end - Date.now();
      // Clamp: at least 5s so the notification can show; at most 10 min.
      return Math.max(5000, Math.min(remaining, 10 * 60 * 1000));
    }
  }
  // Fallback when expiresAt missing (should not happen for rider offers).
  return MAX_ORDER_ALARM_RING_MS;
}

/**
 * Display a full-screen / ongoing alarm notification for an alarm-type push.
 * Falls back to a heads-up notification when full-screen intent is denied.
 *
 * @param {object} data — remoteMessage.data
 */
export async function displayAlarmNotification(data) {
  if (Platform.OS !== 'android') return;
  if (!data || !isAlarmAlertType(data.alertType)) return;

  // Shop-owner + rider sessions only (rehydrate from disk if headless).
  const { shop, rider } = await ensureShopOrRiderSession();
  if (!shop && !rider) {
    console.warn('[orderAlarm] skip: no shop/rider session (memory + disk)');
    return;
  }

  // Skip server reminder re-pushes while this offer/order is already ringing.
  if (isDuplicateActiveAlarm(data)) {
    console.warn(
      '[orderAlarm] skip duplicate (already ringing)',
      alarmDedupeKey(data),
    );
    return;
  }
  // Claim the slot before any await so two concurrent FCM wakes cannot
  // both pass the check and double-display. Release on failure so the
  // next reminder can retry.
  markAlarmActive(data);

  const isRider = data.alertType === ALERT_TYPE_RIDER_OFFER;
  try {
    await createNotifeeAlarmChannels();

    // Replace any previous alarm of the same type (one ringing banner max).
    try {
      await notifee.cancelNotification(
        isRider
          ? RIDER_OFFER_ALARM_NOTIFICATION_ID
          : ORDER_ALARM_NOTIFICATION_ID,
      );
    } catch { /* ignore */ }

    const orderNumber = data.orderNumber || data.order_number || '';
    const notificationId = isRider
      ? RIDER_OFFER_ALARM_NOTIFICATION_ID
      : ORDER_ALARM_NOTIFICATION_ID;
    const channelId = isRider
      ? RIDER_OFFER_ALARM_CHANNEL_ID
      : ORDER_ALARM_CHANNEL_ID;
    const title = isRider ? 'Delivery offer waiting' : 'New order waiting';
    const body = orderNumber
      ? `Order ${orderNumber} — accept or reject now`
      : (isRider
        ? 'Accept or reject before this offer expires.'
        : 'Accept or reject the order to keep the queue moving.');
    // Notifee requires even-length positive ms (no leading 0 delay).
    const vibrationPattern = isRider
      ? [600, 200, 600, 200, 600, 200]
      : [500, 200, 500, 200, 500, 200];

    let canFullScreen = true;
    try {
      if (typeof notifee.canUseFullScreenIntent === 'function') {
        canFullScreen = await notifee.canUseFullScreenIntent();
      }
    } catch {
      canFullScreen = true;
    }
    console.warn('[orderAlarm] canUseFullScreenIntent=', canFullScreen);

    // Google Play FGS policy requires the alert to run only as long as
    // necessary — an indefinite ring is not "user perceptible, time-bounded"
    // behavior. Rider offers already expire server-side (data.expiresAt);
    // shop-owner new-order alerts have no server expiry, so cap them at
    // MAX_ORDER_ALARM_RING_MS. Android auto-cancels the notification at this
    // time and fires EventType.DISMISSED, which already stops the alarm
    // sound + foreground service (see handleAlarmActionEvent above).
    const ringTimeoutAt = Date.now() + (isRider ? resolveRiderTimeoutMs(data) : MAX_ORDER_ALARM_RING_MS);

    const android = {
      channelId,
      category: AndroidCategory.CALL,
      importance: AndroidImportance.HIGH,
      visibility: AndroidVisibility.PUBLIC,
      pressAction: { id: 'default', launchActivity: 'default' },
      actions: [
        {
          title: 'Accept',
          pressAction: { id: ACTION_ACCEPT, launchActivity: 'default' },
        },
        {
          title: 'Reject',
          pressAction: { id: ACTION_REJECT },
        },
      ],
      // Ongoing alarm-style notification so the sound can loop until action/timeout.
      asForegroundService: true,
      foregroundServiceTypes: [
        AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
      ],
      ongoing: true,
      autoCancel: false,
      loopSound: true,
      vibrationPattern,
      lightUpScreen: true,
      // Hard cap so the FGS can't ring forever — required for Play policy
      // compliance (see ringTimeoutAt above). Android fires DISMISSED at this
      // time even if the user never touches the notification.
      timeoutAfter: ringTimeoutAt,
      // Always attach fullScreenAction when OS allows — critical for lock screen.
      ...(canFullScreen
        ? {
          fullScreenAction: {
            id: 'default',
            launchActivity: 'default',
          },
        }
        : {}),
    };

    await notifee.displayNotification({
      id: notificationId,
      title,
      body,
      data: {
        alertType: String(data.alertType || ''),
        orderId: String(data.orderId || data.order_id || ''),
        orderNumber: String(orderNumber),
        offerId: String(data.offerId || data.offer_id || ''),
        expiresAt: String(data.expiresAt || data.expires_at || ''),
        type: String(data.type || ''),
      },
      android: {
        ...android,
        // Force custom raw sound on the notification itself (in addition to channel).
        sound: isRider ? 'rider_alarm' : 'order_alarm',
        loopSound: true,
      },
    });

    // OEM-safe audible path: ColorOS often mutes channel sounds; media stack works.
    // Shop + rider: loop until accept/reject (stop via cancel*Alarm).
    await playAlarmSound(isRider ? 'rider' : 'order', { untilStopped: true });
  } catch (err) {
    clearAlarmActive(isRider ? 'rider' : 'order');
    console.warn('[orderAlarm] display failed:', err?.message || err);
  }
}

/**
 * Cancel the shop and/or rider alarm notification (and stop FGS if any).
 * Always stops the expo-audio media loop — canceling the notifee banner alone
 * does not stop that path.
 */
export async function cancelOrderAlarm() {
  if (Platform.OS !== 'android') return;
  clearAlarmActive('order');
  stopAlarmSound();
  try {
    await notifee.cancelNotification(ORDER_ALARM_NOTIFICATION_ID);
  } catch { /* ignore */ }
  try {
    await notifee.stopForegroundService();
  } catch { /* ignore */ }
}

export async function cancelRiderOfferAlarm() {
  if (Platform.OS !== 'android') return;
  clearAlarmActive('rider');
  stopAlarmSound();
  try {
    await notifee.cancelNotification(RIDER_OFFER_ALARM_NOTIFICATION_ID);
  } catch { /* ignore */ }
  try {
    await notifee.stopForegroundService();
  } catch { /* ignore */ }
}

export async function cancelAllAlarmNotifications() {
  clearAlarmActive('all');
  await cancelOrderAlarm();
  await cancelRiderOfferAlarm();
}

/** Silence media + notifee for the alarm type on this notification (or all). */
async function silenceAlarmForAlertType(alertType) {
  if (alertType === ALERT_TYPE_RIDER_OFFER) {
    await cancelRiderOfferAlarm();
  } else if (alertType === ALERT_TYPE_NEW_ORDER) {
    await cancelOrderAlarm();
  } else {
    await cancelAllAlarmNotifications();
  }
}

/**
 * Handle Accept/Reject from the notifee action buttons.
 * Reuses shopApi / riderApi (same endpoints as dashboard UI).
 */
export async function handleAlarmActionEvent({ type, detail }) {
  const data = detail?.notification?.data || {};
  const alertType = data.alertType;

  // Swipe-dismiss / system timeout: always stop media loop.
  if (type === EventType.DISMISSED) {
    await silenceAlarmForAlertType(alertType);
    return;
  }

  if (type !== EventType.ACTION_PRESS && type !== EventType.PRESS) return;

  const pressId = detail?.pressAction?.id;

  // Tap notification body / default open: launch app but KEEP ringing until
  // Accept or Reject (shop + rider). Only action buttons silence via cancel*.
  if (type === EventType.PRESS || pressId === 'default') {
    return;
  }

  if (pressId !== ACTION_ACCEPT && pressId !== ACTION_REJECT) return;

  const token = await ensureBackgroundCustomerToken();
  if (!token) {
    // Cannot call API without auth — cancel ring and let user open the app.
    await silenceAlarmForAlertType(alertType);
    return;
  }

  try {
    if (alertType === ALERT_TYPE_NEW_ORDER) {
      const orderId = data.orderId || data.order_id;
      if (orderId) {
        if (pressId === ACTION_ACCEPT) {
          await shopApi.confirmOrder(orderId);
        } else {
          await shopApi.rejectOrder(orderId);
        }
      }
      await cancelOrderAlarm();
    } else if (alertType === ALERT_TYPE_RIDER_OFFER) {
      const offerId = data.offerId || data.offer_id;
      if (offerId) {
        if (pressId === ACTION_ACCEPT) {
          await riderApi.acceptOffer(offerId);
        } else {
          await riderApi.rejectOffer(offerId);
        }
      }
      await cancelRiderOfferAlarm();
    } else {
      await cancelAllAlarmNotifications();
    }
  } catch (err) {
    console.warn('[orderAlarm] action failed:', err?.message || err);
    // Still stop the ring so the user is not stuck with an endless alarm.
    await silenceAlarmForAlertType(alertType);
  }
}

/**
 * Background FCM entry point — only called from setBackgroundMessageHandler.
 */
export async function handleBackgroundAlarmMessage(remoteMessage) {
  // Structured log for device verification (adb logcat | grep orderAlarm).
  try {
    console.warn(
      '[orderAlarm] bg message',
      JSON.stringify({
        messageId: remoteMessage?.messageId,
        from: remoteMessage?.from,
        data: remoteMessage?.data || null,
        notification: remoteMessage?.notification || null,
      }),
    );
  } catch { /* ignore */ }

  const data = getRemoteAlarmData(remoteMessage);
  // Expo sometimes nests JSON under a single "body"/"data" string key.
  let alertData = data;
  if (data && !isAlarmAlertType(data.alertType)) {
    for (const key of ['body', 'message', 'payload', 'data']) {
      const raw = data[key];
      if (typeof raw === 'string' && raw.startsWith('{')) {
        try {
          const nested = JSON.parse(raw);
          if (nested && isAlarmAlertType(nested.alertType)) {
            alertData = nested;
            break;
          }
        } catch { /* ignore */ }
      }
    }
  }

  if (!alertData || !isAlarmAlertType(alertData.alertType)) {
    // Non-alarm data messages: no-op (customer/admin pushes keep title+body OS path).
    return;
  }

  // Shop/rider alert types only — never act on customer/admin notification payloads.
  // Native FCM data-only has no notification key → full notifee display.
  // Expo fallback may include title+body → sound only (avoid double banner).
  const hasOsBanner = Boolean(
    remoteMessage?.notification?.title
    || remoteMessage?.notification?.body
  );
  try {
    if (hasOsBanner) {
      console.warn('[orderAlarm] OS banner present — sound only', alertData.alertType);
      const { playAlarmSound } = require('./alarmSound');
      await playAlarmSound(
        alertData.alertType === ALERT_TYPE_RIDER_OFFER ? 'rider' : 'order',
        { untilStopped: true },
      );
      return;
    }
    // True data-only (native FCM): full-screen notifee + media sound.
    console.warn('[orderAlarm] data-only → full-screen alarm', alertData.alertType, alertData.orderId || alertData.offerId);
    await displayAlarmNotification(alertData);
    console.warn('[orderAlarm] display complete');
  } catch (err) {
    console.warn('[orderAlarm] display failed:', err?.message || err);
  }
}

export function isAlarmPayload(data) {
  return Boolean(data && isAlarmAlertType(data.alertType));
}
