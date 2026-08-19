import * as TaskManager from 'expo-task-manager';
import { riderApi } from '../api/riderApi';
import { ensureBackgroundCustomerToken } from '../utils/orderAlarmNotifications';
import { IDLE_PING_INTERVAL_MS } from '../utils/riderTracking';

// Defined at module scope (before AppRegistry, mirrors index.js's FCM
// background handler pattern) — TaskManager requires the task to exist
// before startLocationUpdatesAsync is ever called, on every JS load
// including the background-only relaunches Android/iOS use to deliver
// location updates while the app is not in the foreground.
export const RIDER_BACKGROUND_LOCATION_TASK = 'rider-background-location';

// startLocationUpdatesAsync's `timeInterval` is Android-only (expo-location
// LocationTaskOptions: "@platform android"). iOS ignores it and honours only
// `distanceInterval`, which is deliberately 0 here so a STATIONARY rider
// still reports and doesn't age out of the server's
// RIDER_LOCATION_MAX_AGE_SEC window. The two together mean iOS delivers a
// fix on essentially every location change — so without this throttle a
// backgrounded iOS rider POSTs continuously instead of once per interval,
// burning battery and hammering the endpoint.
//
// Throttling the POST (rather than raising distanceInterval) keeps the
// stationary-rider guarantee intact and leaves Android byte-for-byte
// unchanged: its fixes already arrive ~IDLE_PING_INTERVAL_MS apart, so the
// window below is already elapsed every time and this never skips one. The
// 10% slack absorbs Android timer jitter firing a touch early.
const MIN_POST_INTERVAL_MS = IDLE_PING_INTERVAL_MS * 0.9;
let lastPostAtMs = 0;

TaskManager.defineTask(RIDER_BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.warn('[riderBackgroundLocationTask]', error.message || error);
    return;
  }
  const locations = data?.locations;
  const point = Array.isArray(locations) ? locations[locations.length - 1] : null;
  const coords = point?.coords;
  if (!coords) return;

  const now = Date.now();
  if (now - lastPostAtMs < MIN_POST_INTERVAL_MS) return;
  // Claimed before the await so a burst of iOS fixes delivered back-to-back
  // can't all pass the check while the first POST is still in flight.
  lastPostAtMs = now;

  try {
    // A background-only JS relaunch never runs App.js's
    // setCustomerTokenProvider(() => useAuthStore.getState().token) — the
    // zustand-persist store may still be mid-hydration (or never started)
    // when this task fires, so httpClient's token resolution would silently
    // send no Authorization header and 401. Same persisted-token fallback
    // the FCM background handler already uses for the same gap.
    await ensureBackgroundCustomerToken();
    await riderApi.updateLocation(coords.latitude, coords.longitude);
  } catch (_) {
    // Best-effort — the next fix on the following interval retries.
  }
});
