import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { RIDER_BACKGROUND_LOCATION_TASK } from '../tasks/riderBackgroundLocationTask';
import { IDLE_PING_INTERVAL_MS, IDLE_PING_ACCURACY } from '../utils/riderTracking';

const DISCLOSURE_SHOWN_KEY = 'serveloco-rider-bg-location-disclosure-shown';

// Rider mode ships on Android only — iOS is distributed as a customer-facing
// app. Rider screens are gated by ACCOUNT ROLE, not platform, so without this
// an iOS rider-role login would prompt for "Always" location and start a
// background task for a role that is never used on that platform.
//
// This gate is also what lets app.json keep isIosBackgroundLocationEnabled
// off: no Always request here means no UIBackgroundModes:location in the iOS
// build, and App Review rejects apps declaring a background mode their iOS
// functionality never exercises (Guideline 2.5.4). Re-enabling rider mode on
// iOS means flipping BOTH this constant and that app.json flag together.
const BACKGROUND_LOCATION_SUPPORTED = Platform.OS === 'android';

/**
 * Keeps a free (online, no active job) rider's position fresh on the server
 * even while the app is backgrounded or the screen is locked — the plain
 * foreground idle ping (useRiderIdleLocationPing) stops the moment the app
 * leaves the foreground, so a backgrounded idle rider goes stale past
 * RIDER_LOCATION_MAX_AGE_SEC and drops out of the nearest-ring offer match
 * on the server (apps/api/src/utils/riders.js).
 *
 * Scoped tightly to "online + no active job": starts when the rider goes
 * online, stops the instant they go offline OR pick up a job (the existing
 * foreground delivery watch, useRiderLocationTracking, already streams a much
 * finer trail while an order is active, and "nearest" only matters pre-assignment).
 *
 * Requesting Allow-all-the-time / Always access requires a prominent in-app
 * disclosure BEFORE the OS dialog (Play Store + App Store policy) — the
 * caller must render <RiderBackgroundLocationDisclosure> and drive it via
 * the returned `disclosure` state.
 */
export function useRiderBackgroundLocationTracking(isOnline, hasActiveAssignment) {
  const [disclosureVisible, setDisclosureVisible] = useState(false);
  const resolveDisclosureRef = useRef(null);
  const runningRef = useRef(false);

  useEffect(() => {
    // Inert on unsupported platforms: no permission prompt, no task, and no
    // stop() either (nothing was ever started).
    if (!BACKGROUND_LOCATION_SUPPORTED) return undefined;

    let cancelled = false;

    async function ensureBackgroundPermission() {
      const existing = await Location.getBackgroundPermissionsAsync();
      if (existing.status === 'granted') return true;

      let alreadyShown = false;
      try {
        alreadyShown = (await AsyncStorage.getItem(DISCLOSURE_SHOWN_KEY)) === '1';
      } catch (_) { /* ignore, treat as not-shown */ }

      if (!alreadyShown) {
        const proceed = await new Promise((resolve) => {
          resolveDisclosureRef.current = resolve;
          setDisclosureVisible(true);
        });
        if (!proceed || cancelled) return false;
        // Only persist "shown" on an actual Allow — a decline means the
        // rider hasn't consented and the OS dialog was never shown either
        // (that's the very next line), so the next online-toggle must show
        // the in-app disclosure again rather than skip straight past it.
        // Play/App Store policy requires the disclosure precede the OS
        // "Allow all the time" prompt every time that prompt can appear.
        try {
          await AsyncStorage.setItem(DISCLOSURE_SHOWN_KEY, '1');
        } catch (_) { /* best-effort */ }
      }

      const { status } = await Location.requestBackgroundPermissionsAsync();
      return status === 'granted';
    }

    async function start() {
      if (runningRef.current) return;
      const foreground = await Location.getForegroundPermissionsAsync();
      if (foreground.status !== 'granted') return;

      const granted = await ensureBackgroundPermission();
      if (cancelled || !granted) return;

      const already = await Location.hasStartedLocationUpdatesAsync(
        RIDER_BACKGROUND_LOCATION_TASK
      ).catch(() => false);
      if (already) {
        runningRef.current = true;
        return;
      }

      await Location.startLocationUpdatesAsync(RIDER_BACKGROUND_LOCATION_TASK, {
        accuracy: IDLE_PING_ACCURACY,
        // Android-only knob (expo-location marks timeInterval "@platform
        // android"); iOS honours distanceInterval alone.
        timeInterval: IDLE_PING_INTERVAL_MS,
        // Deliberately 0 so a STATIONARY rider keeps reporting and doesn't
        // age out of the server's RIDER_LOCATION_MAX_AGE_SEC window — a
        // metres-based filter would silently stop pinging exactly the rider
        // who is parked and waiting for an offer. The cost is that iOS then
        // delivers a fix on nearly every location change; the POST itself is
        // throttled to IDLE_PING_INTERVAL_MS in riderBackgroundLocationTask.
        distanceInterval: 0,
        foregroundService: {
          notificationTitle: 'VillKro Rider',
          notificationBody: 'Sharing location while online',
        },
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
        // iOS-only. Batches background deliveries so the OS wakes the app
        // roughly on our cadence instead of per fix — belt-and-braces with
        // the task's own POST throttle, which stays authoritative.
        deferredUpdatesInterval: IDLE_PING_INTERVAL_MS,
        // iOS-only. Tells CoreLocation this is vehicle movement so it tunes
        // power/filtering appropriately; without it the default is `other`.
        activityType: Location.ActivityType.AutomotiveNavigation,
      }).catch(() => {});
      runningRef.current = true;
    }

    async function stop() {
      if (!runningRef.current) return;
      runningRef.current = false;
      const already = await Location.hasStartedLocationUpdatesAsync(
        RIDER_BACKGROUND_LOCATION_TASK
      ).catch(() => false);
      if (already) {
        await Location.stopLocationUpdatesAsync(RIDER_BACKGROUND_LOCATION_TASK).catch(() => {});
      }
    }

    if (isOnline && !hasActiveAssignment) {
      start();
    } else {
      stop();
    }

    return () => {
      cancelled = true;
      // The disclosure modal can be up (awaiting the rider's tap) when this
      // effect re-runs (isOnline/hasActiveAssignment flipped, e.g. a job
      // just got assigned) or the component unmounts. Without resolving it
      // here, the `await new Promise(...)` inside ensureBackgroundPermission
      // never settles — that specific start() call hangs forever, and if the
      // owning component unmounted, disclosureVisible's setState landed on
      // an unmounted hook instance with nothing left to ever hide it.
      // Resolve as an implicit decline (`cancelled` is now true either way,
      // so start() bails right after regardless of what proceed was).
      if (resolveDisclosureRef.current) {
        resolveDisclosureRef.current(false);
        resolveDisclosureRef.current = null;
        setDisclosureVisible(false);
      }
    };
  }, [isOnline, hasActiveAssignment]);

  // Stop the background task on unmount (e.g. rider signs out of rider mode).
  useEffect(() => {
    return () => {
      if (runningRef.current) {
        runningRef.current = false;
        Location.hasStartedLocationUpdatesAsync(RIDER_BACKGROUND_LOCATION_TASK)
          .then((started) => {
            if (started) return Location.stopLocationUpdatesAsync(RIDER_BACKGROUND_LOCATION_TASK);
          })
          .catch(() => {});
      }
    };
  }, []);

  const handleDisclosureAllow = () => {
    setDisclosureVisible(false);
    resolveDisclosureRef.current?.(true);
    resolveDisclosureRef.current = null;
  };

  const handleDisclosureDecline = () => {
    setDisclosureVisible(false);
    resolveDisclosureRef.current?.(false);
    resolveDisclosureRef.current = null;
  };

  return {
    disclosureVisible,
    onDisclosureAllow: handleDisclosureAllow,
    onDisclosureDecline: handleDisclosureDecline,
  };
}
