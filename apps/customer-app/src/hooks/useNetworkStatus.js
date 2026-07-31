import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { addEventListener as addNetInfoListener } from '@react-native-community/netinfo';
import { getApiBaseUrl } from '../api/config';

/**
 * useNetworkStatus
 * Lightweight online/offline detection for the customer app.
 *
 * Approach:
 *   1. Subscribe to NetInfo for device-level connectivity (isConnected) so
 *      we can distinguish "no network at all" from "network up but server
 *      unreachable".
 *   2. Periodically ping a lightweight endpoint to confirm the server is
 *      reachable. The ping is cheap (HEAD /ping) and throttled.
 *   3. A single failed/slow ping doesn't show the banner — it only reveals
 *      after `revealDelayMs` of continuous trouble (a debounced blip filter),
 *      but the moment a ping succeeds the banner clears instantly, and while
 *      trouble is suspected the hook polls at `retryIntervalMs` instead of
 *      the slower steady-state `checkIntervalMs` so recovery is caught fast.
 *
 * Returns:
 *   { isOnline: boolean, isReachable: boolean, isDeviceOffline: boolean,
 *     lastCheckedAt: number|null }
 */
const DEFAULT_CHECK_INTERVAL_MS = 30 * 1000;
const DEFAULT_RETRY_INTERVAL_MS = 2 * 1000;
const DEFAULT_REVEAL_DELAY_MS = 3 * 1000;
const DEFAULT_PING_TIMEOUT_MS = 4 * 1000;

export function useNetworkStatus({
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
  retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS,
  revealDelayMs = DEFAULT_REVEAL_DELAY_MS,
  pingTimeoutMs = DEFAULT_PING_TIMEOUT_MS,
  healthPath = '/ping',
} = {}) {
  // Best-effort: navigator.onLine is a partial signal on RN; start optimistic.
  const [isReachable, setIsReachable] = useState(true);
  const [lastCheckedAt, setLastCheckedAt] = useState(null);
  const [isDeviceOffline, setIsDeviceOffline] = useState(false);
  const mountedRef = useRef(true);
  // Timestamp trouble was first observed, or null while healthy. Used both to
  // gate the reveal timer and to know whether to poll at the fast retry rate.
  const problemSinceRef = useRef(null);
  const revealTimerRef = useRef(null);
  const pollTimerRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const unsubscribe = addNetInfoListener(state => {
      // isConnected is a tri-state: true / false / null (not yet determined,
      // common right at app start). Only a hard `false` means offline —
      // treating null as offline flashes "You appear to be offline" on a
      // perfectly fine connection before NetInfo finishes resolving.
      if (state.isConnected === false) setIsDeviceOffline(true);
      else if (state.isConnected === true) setIsDeviceOffline(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    let cancelled = false;

    const clearRevealTimer = () => {
      if (revealTimerRef.current) {
        clearTimeout(revealTimerRef.current);
        revealTimerRef.current = null;
      }
    };

    // A ping succeeded (or none was needed) — drop the warning immediately,
    // "on the spot", the instant connectivity is confirmed back.
    const markHealthy = () => {
      problemSinceRef.current = null;
      clearRevealTimer();
      if (mountedRef.current) setIsReachable(true);
    };

    // A ping failed or timed out — don't show anything yet. Start (or keep)
    // a 3s grace window; only reveal the banner if trouble is still ongoing
    // when it fires, so one dropped packet or a single slow response doesn't
    // flash a warning the user has to notice and dismiss.
    const markTrouble = () => {
      if (problemSinceRef.current) return; // grace timer already running
      problemSinceRef.current = Date.now();
      revealTimerRef.current = setTimeout(() => {
        revealTimerRef.current = null;
        if (mountedRef.current && problemSinceRef.current) setIsReachable(false);
      }, revealDelayMs);
    };

    const scheduleNext = () => {
      if (cancelled) return;
      // Poll faster while trouble is suspected/showing so recovery — and the
      // warning clearing — happens almost immediately once the network is
      // back, instead of waiting out the slow steady-state interval.
      const delay = problemSinceRef.current ? retryIntervalMs : checkIntervalMs;
      pollTimerRef.current = setTimeout(check, delay);
    };

    const check = async () => {
      if (cancelled) return;
      const baseUrl = getApiBaseUrl();
      if (!baseUrl) {
        // No base URL configured — we can't ping. Stay optimistic.
        scheduleNext();
        return;
      }
      // The API base URL ends in '/api' (e.g. https://api.serveloco.app/api).
      // The health endpoint is mounted at the root, NOT under /api
      // (see apps/api/src/app.js:114 — `app.get('/health', ...)`).
      // Strip the trailing /api so we ping the real health endpoint;
      // otherwise we always 404 and falsely report the user as offline.
      const rootBaseUrl = baseUrl.replace(/\/api\/?$/, '');
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), pingTimeoutMs);
        const res = await fetch(`${rootBaseUrl}${healthPath}`, {
          method: 'HEAD',
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (cancelled) return;
        if (res.ok) markHealthy(); else markTrouble();
        if (mountedRef.current) setLastCheckedAt(Date.now());
      } catch (_) {
        // Covers both a network failure and the abort() timeout above — a
        // request that hangs past pingTimeoutMs counts as "very slow" too.
        if (cancelled) return;
        markTrouble();
        if (mountedRef.current) setLastCheckedAt(Date.now());
      }
      scheduleNext();
    };

    // Kick off a check on app start and on every interval / foreground.
    check();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') check();
    });
    return () => {
      cancelled = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      clearRevealTimer();
      sub.remove();
    };
  }, [checkIntervalMs, retryIntervalMs, revealDelayMs, pingTimeoutMs, healthPath]);

  // isOnline reflects whether the server is actually reachable from this
  // device. We deliberately ignore navigator.onLine because on React Native
  // it's unreliable (often returns false even with working network) and
  // would falsely show the offline banner forever.
  return { isOnline: isReachable, isReachable, isDeviceOffline, lastCheckedAt };
}
