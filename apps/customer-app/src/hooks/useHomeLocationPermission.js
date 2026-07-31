import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import * as Location from 'expo-location';
import {
  requestPreciseLocationPermission,
  openAppLocationSettings,
} from './usePreciseLocationPermissionOnStart';
import { syncDeliveryLocation } from './useDeliveryLocationSync';

/**
 * Drives Home's inline "Enable Location" card (replaces the old full-screen
 * LocationPermissionGate route). Status:
 *   'checking' - first read in flight
 *   'denied'   - not granted, OS dialog can still be shown
 *   'blocked'  - not granted, OS won't show the dialog again (needs Settings)
 *   'granted'  - usable
 *
 * Re-checks on every foreground resume so returning from device Settings
 * clears the card without an app restart — same behavior the old gate had.
 */
export function useHomeLocationPermission() {
  const [status, setStatus] = useState('checking');
  const statusRef = useRef(status);
  statusRef.current = status;

  const check = useCallback(async () => {
    try {
      const existing = await Location.getForegroundPermissionsAsync();
      if (existing?.granted) {
        // Covers granting via device Settings (not the in-app Allow button) —
        // that path skips requestAllow's own sync call, so fire it here on
        // the not-granted -> granted transition instead, same as the old
        // full-screen gate's AppState listener did. Awaited for the same
        // reason requestAllow awaits it: this also runs on the AppState
        // 'active' fired when the OS permission dialog closes, racing
        // requestAllow's own call — flipping status before coords/zone land
        // let the dashboard render, then flash "out of zone" once the real
        // check caught up.
        if (statusRef.current !== 'granted') await syncDeliveryLocation();
        setStatus('granted');
        return;
      }
      // Always land on 'denied' (Allow Location card) here, even if the OS
      // already reports canAskAgain: false. 'blocked' (Open Settings) is only
      // set from an actual tap in requestAllow below — jumping straight to
      // Open Settings on mount skips the popup attempt the user expects.
      setStatus('denied');
    } catch (_) {
      // 'denied' rather than 'granted': pretending the permission is granted
      // hides the card and lets the dashboard render with no coords, which
      // is the state the location gate exists to prevent. 'denied' shows the
      // Allow card, which the user can actually act on — and a retry of the
      // permission read is exactly what pressing it does.
      setStatus('denied');
    }
  }, []);

  useEffect(() => {
    check();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') check();
    });
    return () => sub.remove();
  }, [check]);

  // Tap-only — never auto-fires the OS dialog on mount/resume.
  const requestAllow = useCallback(async () => {
    const result = await requestPreciseLocationPermission();
    if (result.granted) {
      // Awaited on purpose — the card's "requesting" spinner (and the
      // permission-card -> dashboard swap in HomeScreen, gated only on
      // `status`) must hold until coords/zone are actually known, not just
      // until the OS dialog closes. Firing this without awaiting flipped
      // status to 'granted' the instant the dialog resolved, so the
      // dashboard appeared before the GPS fetch behind it had landed.
      await syncDeliveryLocation();
      setStatus('granted');
      return true;
    }
    setStatus(result.needsSettings ? 'blocked' : 'denied');
    return false;
  }, []);

  return { status, requestAllow, openSettings: openAppLocationSettings };
}

export default useHomeLocationPermission;
