import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import notifee, { AndroidImportance, AndroidVisibility } from '@notifee/react-native';
import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { subscribeNotificationEvents } from '../api/realtimeClient';
import { authApi } from '../api/authApi';
import * as notificationsApi from '../api/notificationsApi';
import { useAuthStore } from '../stores';
import { playNotificationChime } from '../utils/notificationChime';

// Expo project ID from app.json — used to get a valid push token.
const EXPO_PROJECT_ID =
  Constants.expoConfig?.extra?.eas?.projectId ??
  '1df5a9bf-de34-48ea-96f4-68f598d7d318';

const LAST_PUSH_TOKEN_KEY = 'serveloco:lastPushToken';
const LAST_CATCHUP_KEY = 'serveloco:lastNotifCatchupAt';
const SHOWN_NOTIF_IDS_KEY = 'serveloco:shownNotifIds';
const MAX_SHOWN_IDS = 100;

// Tracks inbox notification ids already shown as a local banner (via the
// socket path or catch-up) so catch-up doesn't re-show one that arrived via
// remote push while backgrounded — the timestamp watermark alone can't tell
// "already delivered" from "just old enough to skip".
//
// In-memory Set is the source of truth (mutations are synchronous, so
// concurrent callers — socket handler, push-received listener, catch-up loop
// — can't race each other into a lost id the way a read-then-write against
// AsyncStorage could). AsyncStorage is write-through only, for persistence
// across app restarts.
let shownIdsCache = null;
let shownIdsHydration = null;

async function hydrateShownIds() {
  if (shownIdsCache) return shownIdsCache;
  if (!shownIdsHydration) {
    shownIdsHydration = (async () => {
      try {
        const raw = await AsyncStorage.getItem(SHOWN_NOTIF_IDS_KEY);
        shownIdsCache = new Set(raw ? JSON.parse(raw) : []);
      } catch {
        shownIdsCache = new Set();
      }
      return shownIdsCache;
    })();
  }
  return shownIdsHydration;
}

function persistShownIds() {
  AsyncStorage.setItem(SHOWN_NOTIF_IDS_KEY, JSON.stringify([...shownIdsCache])).catch(() => {});
}

async function markNotificationShown(id) {
  if (id == null) return;
  const ids = await hydrateShownIds();
  const key = String(id);
  if (ids.has(key)) return;
  ids.add(key);
  while (ids.size > MAX_SHOWN_IDS) {
    ids.delete(ids.values().next().value);
  }
  persistShownIds();
}

async function hasShownNotification(id) {
  if (id == null) return false;
  const ids = await hydrateShownIds();
  return ids.has(String(id));
}

// When the app is actively in the foreground, suppress remote push banners
// (APNs/FCM) so we don't double-alert with the socket → local-notification
// path. Background / inactive / killed MUST show remote pushes:
//   - killed: OS delivers without this handler
//   - background (JS still warm): handler can still run on some Android
//     builds — if we always suppress remote, closed-app banners never show
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const isRemotePush = notification?.request?.trigger?.type === 'push';
    const appActive = AppState.currentState === 'active';
    const suppressRemote = isRemotePush && appActive;
    return {
      shouldShowBanner: !suppressRemote,
      shouldShowList: !suppressRemote,
      shouldPlaySound: !suppressRemote,
      shouldSetBadge: true,
    };
  },
});

// ─── helpers ────────────────────────────────────────────────────────────────

const PERMISSION_ASKED_KEY = 'serveloco:notifPermissionAsked';

// Module-level cache so we only hit AsyncStorage once per process.
let askedStateCache = null;
export const readAskedState = async () => {
  if (askedStateCache !== null) return askedStateCache;
  try {
    const raw = await AsyncStorage.getItem(PERMISSION_ASKED_KEY);
    askedStateCache = raw ? JSON.parse(raw) : { asked: false, decided: false };
  } catch {
    askedStateCache = { asked: false, decided: false };
  }
  return askedStateCache;
};
const writeAskedState = async (next) => {
  askedStateCache = next;
  try {
    await AsyncStorage.setItem(PERMISSION_ASKED_KEY, JSON.stringify(next));
  } catch { /* best-effort */ }
};

export async function checkNotificationPermission() {
  const { status } = await Notifications.getPermissionsAsync();
  return status === 'granted';
}

/**
 * Request notification permission exactly once per install/session, while the
 * app is authenticated. Idempotent — safe to call from multiple places
 * (login, signup, order-detail screen).
 *
 * Returns one of:
 *   'granted' | 'denied' | 'undetermined' | 'unsupported'
 *
 * Never throws. Never shows a custom UI; iOS and Android 13+ show their own
 * native system dialogs.
 */
export async function requestNotificationPermission() {
  // Android <13 doesn't need a runtime grant — auto-granted at install.
  if (Platform.OS === 'android' && Platform.Version < 33) {
    return 'granted';
  }

  try {
    const existing = await Notifications.getPermissionsAsync();
    const state = await readAskedState();

    // If the user already responded to the prompt, respect that decision and
    // only re-check the live status (which can change via system Settings).
    if (state.asked) {
      return existing.status === 'granted' ? 'granted'
           : existing.status === 'denied'  ? 'denied'
           : 'undetermined';
    }

    // First time — record that we're about to ask so we don't ask again even
    // if the user dismisses without choosing.
    await writeAskedState({ asked: true, decided: false });

    const { status } = await Notifications.requestPermissionsAsync();
    await writeAskedState({ asked: true, decided: status !== 'undetermined' });
    return status === 'granted' ? 'granted'
         : status === 'denied'  ? 'denied'
         : 'undetermined';
  } catch (err) {
    console.warn('[notifications] requestNotificationPermission failed:', err?.message || err);
    return 'unsupported';
  }
}

/**
 * Reset the "asked" flag — used by Settings / a future "enable notifications" CTA
 * so a user who previously declined can re-trigger the system prompt.
 */
export async function resetNotificationAskedFlag() {
  await writeAskedState({ asked: false, decided: false });
}

const BRAND_COLOR = '#FF7A3A';

// Bumped to v2: Android freezes channel sound after first create; v1 had no
// audioAttributes so banners could show silently. Server channelId must match.
export const ORDER_NOTIFICATION_CHANNEL_ID = 'serveloco-orders-v2';
// Rider delivery offers — longer vibration so the phone is hard to miss.
export const RIDER_OFFER_CHANNEL_ID = 'serveloco-rider-offers';

// Notifee full-screen alarm channels (killed-app path). New IDs only — never
// reuse the expo-notifications channels above (Android freezes channel settings).
// Bumped when custom sound assets / audio attributes change.
// Android freezes channel sound after first create.
// v5: re-create after ColorOS muted v4; MAX importance + raw order_alarm sound.
export const ORDER_ALARM_CHANNEL_ID = 'serveloco-orders-alarm-v5';
export const RIDER_OFFER_ALARM_CHANNEL_ID = 'serveloco-rider-offers-alarm-v5';

// Strong pattern: pause, buzz, pause, buzz… (ms) — RN Vibration API allows a
// leading 0 (initial delay). Used by foreground alert hooks.
export const RIDER_VIBRATION_PATTERN = [0, 600, 200, 600, 200, 600];
// Shop-owner alarm vibration (matches useNewOrderAlert foreground pattern).
export const SHOP_VIBRATION_PATTERN = [0, 500, 200, 500, 200, 500];
// Notifee channel vibrationPattern requires an even count of *positive* ms
// (leading 0 throws and aborts createChannel → push token registration).
const NOTIFEE_SHOP_VIBRATION_PATTERN = [500, 200, 500, 200, 500, 200];
const NOTIFEE_RIDER_VIBRATION_PATTERN = [600, 200, 600, 200, 600, 200];

async function createAndroidChannel() {
  if (Platform.OS !== 'android') return;

  // Drop the old silent channel if it still exists (best-effort).
  try {
    await Notifications.deleteNotificationChannelAsync('serveloco-orders');
  } catch { /* ignore */ }

  const sharedAudio = {
    usage: Notifications.AndroidAudioUsage.NOTIFICATION,
    contentType: Notifications.AndroidAudioContentType.SONIFICATION,
    flags: {
      enforceAudibility: true,
      requestHardwareAudioVideoSynchronization: false,
    },
  };

  // MAX + USAGE_NOTIFICATION so closed/background FCM banners play sound + vibrate.
  await Notifications.setNotificationChannelAsync(ORDER_NOTIFICATION_CHANNEL_ID, {
    name: 'Order Updates',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 250, 250],
    sound: 'default',
    lightColor: BRAND_COLOR,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    bypassDnd: false,
    enableVibrate: true,
    enableLights: true,
    showBadge: true,
    audioAttributes: sharedAudio,
  });

  // Dedicated rider-offer channel: longer vibration for continuous offer alerts.
  await Notifications.setNotificationChannelAsync(RIDER_OFFER_CHANNEL_ID, {
    name: 'Rider Delivery Offers',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: RIDER_VIBRATION_PATTERN,
    sound: 'default',
    lightColor: BRAND_COLOR,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    bypassDnd: false,
    enableVibrate: true,
    enableLights: true,
    showBadge: true,
    audioAttributes: sharedAudio,
  });
}

/**
 * Notifee / expo alarm channels for **shop-owner and rider only**.
 * Customers and admins never need these channels; call only when the signed-in
 * user has a shop or rider profile.
 * Separate from createAndroidChannel() — expo-notifications order channels stay untouched.
 */
export async function createNotifeeAlarmChannels() {
  if (Platform.OS !== 'android') return;

  // Scope: shop-owner + rider only (never customer / plain admin).
  // Headless FCM may run before Zustand rehydrates — allow channel create when
  // either in-memory or persisted auth has a shop/rider (display path seeds store).
  let { shop, rider } = useAuthStore.getState();
  if (!shop && !rider) {
    try {
      const raw = await AsyncStorage.getItem('serveloco-customer-auth');
      if (raw) {
        const parsed = JSON.parse(raw);
        const st = parsed?.state || parsed;
        shop = st?.shop;
        rider = st?.rider;
      }
    } catch { /* ignore */ }
  }
  if (!shop && !rider) return;

  try {
    // Drop superseded channel ids (settings frozen after first create).
    for (const oldId of [
      'serveloco-orders-alarm-v1',
      'serveloco-orders-alarm-v2',
      'serveloco-orders-alarm-v3',
      'serveloco-orders-alarm-v4',
      'serveloco-rider-offers-alarm-v1',
      'serveloco-rider-offers-alarm-v2',
      'serveloco-rider-offers-alarm-v3',
      'serveloco-rider-offers-alarm-v4',
    ]) {
      try { await notifee.deleteChannel(oldId); } catch { /* ignore */ }
      try { await Notifications.deleteNotificationChannelAsync(oldId); } catch { /* ignore */ }
    }

    // Expo channel first: USAGE_ALARM is more likely to play on ColorOS than
    // USAGE_NOTIFICATION for custom res/raw sounds (FCM tray path uses this).
    const alarmAudio = {
      usage: Notifications.AndroidAudioUsage.ALARM,
      contentType: Notifications.AndroidAudioContentType.SONIFICATION,
      flags: {
        enforceAudibility: true,
        requestHardwareAudioVideoSynchronization: false,
      },
    };

    await Notifications.setNotificationChannelAsync(ORDER_ALARM_CHANNEL_ID, {
      name: 'Shop Order Alarms',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: NOTIFEE_SHOP_VIBRATION_PATTERN,
      sound: 'order_alarm',
      lightColor: BRAND_COLOR,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      bypassDnd: true,
      enableVibrate: true,
      enableLights: true,
      showBadge: true,
      audioAttributes: alarmAudio,
    });

    await Notifications.setNotificationChannelAsync(RIDER_OFFER_ALARM_CHANNEL_ID, {
      name: 'Rider Offer Alarms',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: NOTIFEE_RIDER_VIBRATION_PATTERN,
      sound: 'rider_alarm',
      lightColor: BRAND_COLOR,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      bypassDnd: true,
      enableVibrate: true,
      enableLights: true,
      showBadge: true,
      audioAttributes: alarmAudio,
    });

    // IMPORTANT: do NOT recreate the same ids with notifee at HIGH (4).
    // Android freezes channel settings on first create; a second create with
    // lower importance was locking alarms at importance=4 and muting heads-up
    // on ColorOS. Expo MAX (5) + USAGE_ALARM is what we keep.
    // Notifee displayNotification can post to the expo-created channel id.
  } catch (err) {
    // Never block Expo push token registration on channel setup failure.
    console.warn('[notifications] createNotifeeAlarmChannels failed:', err?.message || err);
  }
}

// Register the "order_update" category so Android and iOS show a
// "View Order" action button in the expanded notification without the
// user having to open the app first.
async function registerNotificationCategories() {
  try {
    await Notifications.setNotificationCategoryAsync('order_update', [
      {
        identifier: 'view_order',
        buttonTitle: '📦 View Order',
        options: { opensAppToForeground: true },
      },
    ]);
  } catch {
    // Not all environments support categories (e.g. Expo Go on Android < 8).
  }
}

function parseActionPayload(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractOrderId(payload) {
  const actionPayload = parseActionPayload(
    payload?.actionPayload ?? payload?.action_payload,
  );
  const fromAction =
    actionPayload?.orderId || actionPayload?.order_id;
  if (fromAction) return String(fromAction);

  const isOrderSource =
    String(payload?.sourceType || payload?.source_type || '').toLowerCase() ===
    'order';
  if (isOrderSource && payload?.sourceId) return String(payload.sourceId);

  return null;
}

/**
 * Register / refresh the Expo push token on the API so remote pushes reach
 * this device when the app is backgrounded or killed (OS delivers via FCM/APNs).
 * Safe to call repeatedly; skips the network when the token is unchanged.
 */
async function registerExpoPushTokenWithServer({ force = false } = {}) {
  const { isAuthenticated, token: jwt } = useAuthStore.getState();
  if (!isAuthenticated || !jwt) return false;

  const status = await requestNotificationPermission();
  if (status !== 'granted') return false;

  // Channel must exist before the first closed-app push arrives on Android.
  await createAndroidChannel();
  await createNotifeeAlarmChannels();
  await registerNotificationCategories();

  // getExpoPushTokenAsync can hang forever when the FCM handshake fails
  // silently (misconfigured Firebase, no Play services). Race it against a
  // timeout so the failure is visible instead of a dead end.
  const tokenObj = await Promise.race([
    Notifications.getExpoPushTokenAsync({ projectId: EXPO_PROJECT_ID }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('getExpoPushTokenAsync timed out after 15s')), 15000)
    ),
  ]);
  const token = tokenObj?.data;
  if (!token) return false;

  // Native FCM token for high-priority data-only shop/rider alarms (killed app).
  // Modular API (getMessaging/getToken) — same token as messaging().getToken().
  let fcmToken = null;
  if (Platform.OS === 'android') {
    try {
      // eslint-disable-next-line global-require
      const { getMessaging, getToken } = require('@react-native-firebase/messaging');
      fcmToken = await Promise.race([
        getToken(getMessaging()),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('FCM getToken timed out')), 15000)
        ),
      ]);
    } catch (err) {
      console.warn('[notifications] FCM getToken failed:', err?.message || err);
    }
  }

  // Skip network when both tokens unchanged unless force (login / first open).
  const cacheVal = fcmToken ? `${token}|${fcmToken}` : token;
  if (!force) {
    try {
      const last = await AsyncStorage.getItem(LAST_PUSH_TOKEN_KEY);
      if (last === cacheVal) return true;
    } catch { /* ignore and re-register */ }
  }

  await authApi.registerPushToken(token, fcmToken);
  try {
    await AsyncStorage.setItem(LAST_PUSH_TOKEN_KEY, cacheVal);
  } catch { /* best-effort */ }
  return true;
}

/**
 * If a remote push was missed while the process was dead, surface recent
 * unread order inbox rows as local banners on next open/resume.
 */
async function catchUpMissedOrderNotifications() {
  try {
    const res = await notificationsApi.list({ limit: 20 });
    const items = res?.data || [];
    if (!items.length) return;

    let lastAt = 0;
    try {
      lastAt = Number(await AsyncStorage.getItem(LAST_CATCHUP_KEY)) || 0;
    } catch { /* ignore */ }

    const now = Date.now();
    // Only catch up events from the last 6 hours that we haven't shown yet.
    const windowStart = Math.max(lastAt, now - 6 * 60 * 60 * 1000);
    let newest = lastAt;

    for (const n of items) {
      const created = new Date(n.createdAt || n.created_at || 0).getTime();
      if (!created || created <= windowStart) continue;
      if (created > newest) newest = created;

      // Already shown via socket local-schedule or a received remote push
      // for this exact inbox row — don't replay it.
      if (await hasShownNotification(n.id)) continue;

      const isOrder = String(n.sourceType || n.source_type || n.type || '').toLowerCase().includes('order')
        || n.eventKey
        || n.event_key
        || (n.actionPayload && (n.actionPayload.orderId || n.actionPayload.order_id));
      if (!isOrder && String(n.type || '').toLowerCase() === 'info' && !n.title) continue;

      const orderId = n.actionPayload?.orderId
        || n.actionPayload?.order_id
        || (String(n.sourceType || n.source_type || '').toLowerCase() === 'order' ? n.sourceId || n.source_id : null);

      await Notifications.scheduleNotificationAsync({
        content: {
          title: n.title || 'VillKro',
          body: n.body || n.message || '',
          sound: 'default',
          data: orderId ? { orderId: String(orderId) } : {},
        },
        trigger: Platform.OS === 'android'
          ? { channelId: ORDER_NOTIFICATION_CHANNEL_ID }
          : null,
      }).catch(() => {});
      await markNotificationShown(n.id);
    }

    if (newest > lastAt) {
      try {
        await AsyncStorage.setItem(LAST_CATCHUP_KEY, String(newest));
      } catch { /* ignore */ }
    }
  } catch (err) {
    console.warn('[useLocalNotifications] catch-up failed:', err?.message || err);
  }
}

const ADMIN_ORDER_PUSH_TYPES = new Set([
  'new_order', 'order_auto_cancelled', 'rider_assignment_failed',
  'rider_zero_available', 'order_cancelled_no_rider',
]);

// Retry budget for deep-links that arrive before their target screen exists:
// 50 attempts x 200ms = ~10s. Long enough to outlast a cold start and the
// location-permission gate resolving, short enough not to fire into a
// session the user has since left.
const NAV_RETRY_INTERVAL_MS = 200;
const NAV_MAX_ATTEMPTS = 50;

/**
 * Navigates once the navigator is ready AND the target screen is actually
 * registered, retrying until then.
 *
 * A ready navigator is not enough: the customer stack renders ONLY the
 * location-permission gate until permission resolves, so navigate('OrderDetail')
 * during that window throws and the tap would otherwise be lost silently.
 */
function navigateWhenRouteExists(navigationRef, routeName, params) {
  let attempts = 0;
  const attempt = () => {
    attempts += 1;
    const retry = () => {
      if (attempts < NAV_MAX_ATTEMPTS) setTimeout(attempt, NAV_RETRY_INTERVAL_MS);
    };
    if (!navigationRef?.current?.isReady?.()) {
      retry();
      return;
    }
    try {
      navigationRef.current.navigate(routeName, params);
    } catch (_) {
      // Screen not in the current stack yet (gate still showing).
      retry();
    }
  };
  attempt();
}

/**
 * Navigate from a notification tap (foreground, background, or cold start).
 */
function navigateFromNotificationData(data, navigationRef) {
  if (!data || typeof data !== 'object') return;

  // Shop-owner order notification → Dashboard tab (new-order popup lives there).
  if (data.type === 'shop_order') {
    navigateWhenRouteExists(navigationRef, 'ShopDashboard');
    return;
  }

  // Rider delivery offer → open rider dashboard (popup rehydrates there).
  if (data.type === 'rider_offer') {
    navigateWhenRouteExists(navigationRef, 'RiderDashboard');
    return;
  }

  // Admin inbox push — deep-link once admin shell is ready.
  if (ADMIN_ORDER_PUSH_TYPES.has(data.type) || data.type === 'new_customer') {
    let attempts = 0;
    const maxAttempts = 50;
    const tryNavigateAdmin = () => {
      attempts += 1;
      const { admin, adminToken } = useAuthStore.getState();
      const navReady = navigationRef?.current?.isReady?.();
      if (!navReady || !(admin && adminToken)) {
        if (attempts < maxAttempts) setTimeout(tryNavigateAdmin, 200);
        return;
      }
      try {
        if (data.type === 'new_customer') {
          navigationRef.current.navigate('AdminPeople');
        } else if (data.orderId) {
          navigationRef.current.navigate('AdminOrderDetail', { orderId: data.orderId });
        } else {
          navigationRef.current.navigate('AdminOrders');
        }
      } catch (_) {
        if (attempts < maxAttempts) setTimeout(tryNavigateAdmin, 200);
      }
    };
    tryNavigateAdmin();
    return;
  }

  const orderId = data.orderId;
  if (!orderId) return;

  navigateWhenRouteExists(navigationRef, 'OrderDetail', { orderId });
}

// ─── hook ────────────────────────────────────────────────────────────────────

/**
 * useLocalNotifications
 *
 * 1) Registers Expo push token so FCM/APNs can deliver when app is closed.
 * 2) Bridges Socket.io "notification.created" → local banner while open.
 * 3) Handles notification taps (incl. cold start from killed app).
 *
 * @param {React.MutableRefObject} navigationRef - ref to the NavigationContainer
 */
export function useLocalNotifications(navigationRef) {
  const isAuthenticated = useAuthStore(state => state.isAuthenticated);
  const hasHydrated = useAuthStore(state => state.hasHydrated);
  const permissionGranted = useRef(false);
  const registeringRef = useRef(false);
  // Avoid double-handling the same cold-start response.
  const handledResponseIds = useRef(new Set());

  // ── 1. One-time setup: Android channel, notification categories ──────────
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const granted = await checkNotificationPermission();
      if (!cancelled) permissionGranted.current = granted;
      await createAndroidChannel();
      await createNotifeeAlarmChannels();
      await registerNotificationCategories();
    })();

    return () => { cancelled = true; };
  }, []);

  // ── 1b. Register Expo push token after auth hydrate so closed-app pushes work.
  // Also re-run when the app returns to foreground (permission may have been
  // granted in Settings; FCM token may have rotated).
  useEffect(() => {
    if (!hasHydrated || !isAuthenticated) return undefined;

    let cancelled = false;

    const run = async (force = false) => {
      if (cancelled || registeringRef.current) return;
      registeringRef.current = true;
      try {
        // Brief delay so App.js can attach the customer JWT provider before
        // the first POST /auth/me/push-token (avoids tokenless 401 on cold start).
        await new Promise((r) => setTimeout(r, 300));
        if (cancelled) return;
        await registerExpoPushTokenWithServer({ force });
        // Re-surface recent order inbox rows if a remote push was missed.
        if (!cancelled) await catchUpMissedOrderNotifications();
      } catch (err) {
        console.warn('[useLocalNotifications] push token registration failed:', err?.message || err);
      } finally {
        registeringRef.current = false;
      }
    };

    run(true);

    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active' && useAuthStore.getState().isAuthenticated) {
        run(false);
      }
    });

    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [hasHydrated, isAuthenticated]);

  // ── 2. Listen for realtime "notification.created" events ─────────────────
  // Foreground path only — when app is closed, remote Expo push is the path.
  useEffect(() => {
    if (!isAuthenticated) return undefined;

    const unsubscribe = subscribeNotificationEvents(async ({ eventName, payload }) => {
      if (eventName !== 'notification.created') return;

      // Foreground-only: background/killed apps get the remote FCM/APNs
      // push instead (see setNotificationHandler above). The socket can
      // stay connected while backgrounded on some Android builds — without
      // this check that produces a local banner ON TOP OF the remote one
      // for the same event (the duplicate-notification bug).
      if (AppState.currentState !== 'active') return;

      // Check permission every time (user might grant it later)
      const hasPermission = await checkNotificationPermission();
      console.log('[useLocalNotifications] Permission status:', hasPermission);
      console.log('[useLocalNotifications] Notification payload:', payload);

      if (!hasPermission) {
        console.log('[useLocalNotifications] No permission, skipping notification');
        return;
      }

      const title = payload?.title ?? 'ServeLoco';
      const body  = payload?.body  ?? payload?.message ?? '';
      const orderId = extractOrderId(payload);

      console.log('[useLocalNotifications] Scheduling notification:', { title, body, orderId });

      await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          sound: 'default',
          data: { orderId },
          // Show "View Order" action button in the expanded notification
          // when the notification relates to an order.
          ...(orderId ? { categoryIdentifier: 'order_update' } : {}),
          ...(Platform.OS === 'android' && {
            // Tint the notification icon with the brand saffron color.
            color: BRAND_COLOR,
          }),
        },
        // Android: channelId must be on the trigger, not in content — in
        // content it's silently ignored and the notification lands on the
        // OS fallback channel, which has no sound/heads-up. A bare
        // { channelId } trigger still fires immediately.
        trigger: Platform.OS === 'android'
          ? { channelId: ORDER_NOTIFICATION_CHANNEL_ID }
          : null,
      });

      await markNotificationShown(payload?.id ?? payload?.notificationId);

      // Local notifications only fire while the app is foregrounded, and
      // several Android OEM skins mute the channel sound for the foreground
      // app — play the chime ourselves so the alert is audible.
      playNotificationChime();

      console.log('[useLocalNotifications] Notification scheduled successfully');
    });

    return () => unsubscribe();
  }, [isAuthenticated]);

  // ── 2b. Mark remote pushes as shown so catch-up doesn't replay them ──────
  // (fires when the OS delivers a push while JS is warm — foreground or,
  // on some Android builds, background).
  // Also: when an alarm-type push arrives while JS is warm, upgrade to a
  // notifee full-screen / FGS alarm (best-effort — killed process uses OS
  // tray on the alarm channel with custom sound instead).
  useEffect(() => {
    let cancelled = false;
    const subscription = Notifications.addNotificationReceivedListener((notification) => {
      const data = notification?.request?.content?.data || {};
      markNotificationShown(data?.notificationId);

      // Alarm media sound: shop new-order + rider offer only.
      // Customers/admins never receive alertType new_order_alarm / rider_offer_alarm
      // (those are only set on the two alarm push call sites). Extra role gate:
      // only play if this device is currently a shop-owner or rider session.
      //
      // Foreground gate: while active, useNewOrderAlert/useRiderOfferAlert's own
      // 8s loop already owns the alarm sound. Without this check, an Expo-fallback
      // push (device has no fcm_token yet) delivered while foregrounded would
      // trigger this listener too, layering a second sound on top of that loop.
      // This listener exists for the backgrounded-but-JS-warm case, where that
      // foreground loop is paused and nothing else would play audio.
      const alertType = data?.alertType;
      if (
        Platform.OS === 'android'
        && AppState.currentState !== 'active'
        && (alertType === 'new_order_alarm' || alertType === 'rider_offer_alarm')
      ) {
        const { shop, rider } = useAuthStore.getState();
        if (shop || rider) {
          import('../utils/alarmSound')
            .then(({ playAlarmSound }) => {
              if (cancelled) return undefined;
              // Shop + rider: keep ringing until accept/reject.
              return playAlarmSound(
                alertType === 'rider_offer_alarm' ? 'rider' : 'order',
                { untilStopped: true },
              );
            })
            .catch(() => {});
        }
      }
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  // ── 3. Handle tap / action button → navigate (live + cold start) ─────────
  useEffect(() => {
    const handleResponse = (response) => {
      if (!response) return;
      const id = response.notification?.request?.identifier
        || `${response.notification?.date || ''}:${JSON.stringify(response.notification?.request?.content?.data || {})}`;
      if (handledResponseIds.current.has(id)) return;
      handledResponseIds.current.add(id);

      const data = response.notification.request.content.data || {};
      navigateFromNotificationData(data, navigationRef);
    };

    const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);

    // Cold start: app was killed; user tapped a system notification.
    // addNotificationResponseReceivedListener alone often misses this.
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) handleResponse(response);
      })
      .catch(() => {});

    return () => {
      subscription.remove();
    };
  }, [navigationRef]);
}
