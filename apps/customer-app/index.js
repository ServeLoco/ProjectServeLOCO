import { registerRootComponent } from 'expo';
import { AppState, Platform } from 'react-native';
import notifee from '@notifee/react-native';
// Modular RNFirebase messaging API (v22+) — same native behavior as the
// old messaging() namespaced style, without deprecation warnings.
import {
  getMessaging,
  setBackgroundMessageHandler,
  onMessage,
} from '@react-native-firebase/messaging';
import App from './App';
import {
  handleBackgroundAlarmMessage,
  handleAlarmActionEvent,
  isAlarmPayload,
} from './src/utils/orderAlarmNotifications';
// Side-effect import: registers the TaskManager task at module scope so it
// exists before startLocationUpdatesAsync is called, including on the
// background-only JS relaunches Android/iOS use to deliver a location fix
// while the app isn't in the foreground (same reasoning as the FCM handler
// below — must run on every JS load, not just once RiderDashboardScreen mounts).
// require(), not a static import: expo-task-manager's native module must be
// linked into the binary (added this release, fenced by this release's
// runtimeVersion bump) — but runtimeVersion fencing only protects against
// OTA; a future channel/config mistake that serves this JS to an older
// binary anyway must not crash app launch over a feature (rider background
// location) most sessions never touch.
try {
  require('./src/tasks/riderBackgroundLocationTask');
} catch (err) {
  console.warn('[index] rider background location task unavailable:', err?.message || err);
}

// ── Background FCM handler (Android killed/background alarm path) ──────────
// MUST be registered at the top level before AppRegistry, and ONLY here —
// never from a BOOT_COMPLETED / REBOOT receiver. Starting a restricted
// foreground service from a boot receiver crashes on Android 15+.
// This path is reachable solely when an FCM data message arrives.
if (Platform.OS === 'android') {
  const messaging = getMessaging();

  // Required for android.asForegroundService notifications (ongoing alarm).
  // The promise stays pending until stopForegroundService() is called.
  notifee.registerForegroundService(() => new Promise(() => {}));

  setBackgroundMessageHandler(messaging, async (remoteMessage) => {
    await handleBackgroundAlarmMessage(remoteMessage);
  });

  // Notifee action buttons (Accept / Reject) while the process is in background.
  notifee.onBackgroundEvent(async (event) => {
    await handleAlarmActionEvent(event);
  });

  // onMessage runs when the JS process is alive (foreground OR warm background).
  // ColorOS often keeps the app process after Home — RNFB then delivers here,
  // NOT to setBackgroundMessageHandler. We must full-screen in that case too.
  // Only skip when the UI is actively open (socket 8s hooks own that UX).
  onMessage(messaging, async (remoteMessage) => {
    const data = remoteMessage?.data;
    if (isAlarmPayload(data)) {
      if (AppState.currentState === 'active') {
        return;
      }
      await handleBackgroundAlarmMessage(remoteMessage);
      return;
    }
  });

  // Accept/Reject action presses while app is in foreground.
  notifee.onForegroundEvent(async (event) => {
    await handleAlarmActionEvent(event);
  });
}

registerRootComponent(App);
