import { useEffect, useRef } from 'react';
import * as Location from 'expo-location';
import { riderApi } from '../api/riderApi';
import {
  IDLE_PING_INTERVAL_MS,
  IDLE_PING_ACCURACY,
  IDLE_PING_TIMEOUT_MS,
} from '../utils/riderTracking';

/** Rejects if the GPS fix outlives the budget, so a stuck call can't wedge the loop. */
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('location timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Keeps a free rider's position fresh on the server so they can win nearby
 * offers. Runs only while online AND holding no active job — during a delivery
 * useRiderLocationTracking already streams a much finer GPS trail, and running
 * both would double-ping for nothing.
 *
 * One low-accuracy fix per interval, no position watch, so the GPS chip idles
 * in between. Never prompts for permission: useRiderLocationPermission already
 * asks on rider-mode entry, and a background nag here would be hostile.
 *
 * @param {boolean} isOnline - rider's online toggle
 * @param {boolean} hasActiveAssignment - true when a delivery is in progress
 */
export function useRiderIdleLocationPing(isOnline, hasActiveAssignment) {
  const busyRef = useRef(false);

  useEffect(() => {
    if (!isOnline || hasActiveAssignment) return undefined;

    let cancelled = false;

    async function pingOnce() {
      // Overlap guard: a slow fix must not stack behind the next tick.
      if (busyRef.current || cancelled) return;
      busyRef.current = true;
      try {
        const { status } = await Location.getForegroundPermissionsAsync();
        if (cancelled || status !== 'granted') return;

        // getCurrentPositionAsync can hang indefinitely with no sky view
        // (indoors, basement). Without a ceiling the busy guard below would
        // stay latched and this rider would silently stop reporting forever.
        const position = await withTimeout(
          Location.getCurrentPositionAsync({ accuracy: IDLE_PING_ACCURACY }),
          IDLE_PING_TIMEOUT_MS,
        );
        const coords = position?.coords;
        if (cancelled || !coords) return;

        await riderApi.updateLocation(coords.latitude, coords.longitude);
      } catch (_) {
        // Permission revoked, GPS off, or offline — retry on the next tick.
      } finally {
        busyRef.current = false;
      }
    }

    // Report immediately on going online so the first nearby order can already
    // see this rider, rather than after a full interval of invisibility.
    pingOnce();
    const id = setInterval(pingOnce, IDLE_PING_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isOnline, hasActiveAssignment]);
}
