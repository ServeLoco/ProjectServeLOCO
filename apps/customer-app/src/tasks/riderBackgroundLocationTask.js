import * as TaskManager from 'expo-task-manager';
import { riderApi } from '../api/riderApi';
import { ensureBackgroundCustomerToken } from '../utils/orderAlarmNotifications';

// Defined at module scope (before AppRegistry, mirrors index.js's FCM
// background handler pattern) — TaskManager requires the task to exist
// before startLocationUpdatesAsync is ever called, on every JS load
// including the background-only relaunches Android/iOS use to deliver
// location updates while the app is not in the foreground.
export const RIDER_BACKGROUND_LOCATION_TASK = 'rider-background-location';

TaskManager.defineTask(RIDER_BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.warn('[riderBackgroundLocationTask]', error.message || error);
    return;
  }
  const locations = data?.locations;
  const point = Array.isArray(locations) ? locations[locations.length - 1] : null;
  const coords = point?.coords;
  if (!coords) return;

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
