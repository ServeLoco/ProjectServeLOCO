// VillKro customer app — v1.6.0 production rebuild
import React, { useEffect, useState } from 'react';
import { AppState, StatusBar, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image as ExpoImage } from 'expo-image';
import * as Updates from 'expo-updates';
import * as Application from 'expo-application';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RootNavigator, navigationRef } from './src/navigation';
import { colors } from './src/theme';
import { setAdminTokenProvider, setCustomerTokenProvider, settingsApi } from './src/api';
import { setAdminReMintHandler, setAdminSessionClearHandler, setCustomerLogoutHandler } from './src/api/httpClient';
import {
  useCustomerRealtime,
  useLocalNotifications,
  useNetworkStatus,
  useShopStatusSync,
  useDeliveryZoneSync,
  useDeliveryLocationSync,
  useProductAvailabilitySync,
  useAuthRoleSync,
} from './src/hooks';
import { useAuthStore } from './src/stores';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { OfflineBanner } from './src/components/OfflineBanner';
import { ToastProvider } from './src/components/Toast';
import { ForceUpdateModal } from './src/components/ForceUpdateModal';
import appJson from './app.json';

/**
 * Compares two semver strings (e.g. "1.2.0" vs "1.1.0").
 * Returns true when `current` is strictly less than `required`.
 */
function isUpdateRequired(current, required) {
  if (!required) return false;
  const toNum = (v) =>
    String(v)
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
  const [ma1, mi1, pa1] = toNum(current);
  const [ma2, mi2, pa2] = toNum(required);
  if (ma1 !== ma2) return ma1 < ma2;
  if (mi1 !== mi2) return mi1 < mi2;
  return pa1 < pa2;
}

// AsyncStorage key remembering which native binary version last ran. When it
// differs from the currently installed binary the app was updated outside the
// ForceUpdateModal flow (Play Store auto-update / manual store update), so the
// post-update wipe below must run.
const LAST_NATIVE_VERSION_KEY = 'serveloco-last-native-version';
const AUTH_STORAGE_KEY = 'serveloco-customer-auth';

// Registered at module load — BEFORE any component effect runs — so the
// token/logout providers are always ready by the time the first request
// goes out. Background sync hooks (useDeliveryZoneSync, useDeliveryLocationSync)
// mount their effects ahead of App's own effects and can fire an authed
// request on the very first render; if these providers were registered
// inside a useEffect instead, that request would go out with no
// Authorization header, get a 401, and trigger a spurious logout.
setCustomerLogoutHandler(() => {
  useAuthStore.getState().logout();
});
setCustomerTokenProvider(() => useAuthStore.getState().token);
setAdminTokenProvider(() => useAuthStore.getState().adminToken);
setAdminReMintHandler(() => useAuthStore.getState().mintAdminSession());
setAdminSessionClearHandler(() => useAuthStore.getState().clearAdminSession());

function App() {
  useCustomerRealtime();
  useLocalNotifications(navigationRef);
  useShopStatusSync();
  useDeliveryZoneSync();
  useDeliveryLocationSync();
  useProductAvailabilitySync();
  useAuthRoleSync();
  const { isOnline } = useNetworkStatus();

  // Startup update sequence. ONE effect on purpose: the post-update wipe and
  // the OTA check both end in Updates.reloadAsync(), and as separate effects
  // they could race each other into two back-to-back reloads when a native
  // update and a pending OTA land on the same launch. Running them
  // sequentially guarantees at most one reload per JS pass.
  useEffect(() => {
    if (__DEV__) return;
    let cancelled = false;

    (async () => {
      // 1) Post-update wipe: if the native binary version changed since the
      // last launch, wipe ALL persisted data except the auth session and
      // reload. ForceUpdateModal's own wipe only runs when the user taps
      // "Update Now" — Play Store auto-updates and manual store updates
      // bypass that button entirely, leaving stale carts/settings (e.g. cart
      // lines pointing at products that no longer exist) to poison the new
      // build. Keying on the native version (not the JS bundle) means OTA
      // updates don't trigger it.
      try {
        const nativeVersion = Application.nativeApplicationVersion;
        if (nativeVersion) {
          const lastVersion = await AsyncStorage.getItem(LAST_NATIVE_VERSION_KEY);
          if (lastVersion !== nativeVersion) {
            const keys = await AsyncStorage.getAllKeys();
            const toRemove = keys.filter(
              (k) => k !== AUTH_STORAGE_KEY && k !== LAST_NATIVE_VERSION_KEY
            );
            if (toRemove.length) {
              await AsyncStorage.multiRemove(toRemove);
            }
            await AsyncStorage.setItem(LAST_NATIVE_VERSION_KEY, nativeVersion);
            if (toRemove.length) {
              // The zustand stores already hydrated the stale state into
              // memory before this effect ran, and any state change would
              // re-persist it. Reload the JS so every store rehydrates from
              // the now-clean storage. The OTA check below is skipped on
              // this pass — the reloaded JS runs this same effect again with
              // a matching marker and falls through to it.
              await Updates.reloadAsync();
              return;
            }
          }
        }
      } catch (_) {
        // Best-effort — never block launch on the cleanup.
      }

      // 2) OTA: fetch + apply any pending JS bundle immediately instead of
      // the default next-launch behavior, so a user who reopens the app
      // right after we publish doesn't run stale JS against the current
      // backend.
      try {
        const result = await Updates.checkForUpdateAsync();
        if (cancelled || !result.isAvailable) return;
        await Updates.fetchUpdateAsync();
        if (!cancelled) await Updates.reloadAsync();
      } catch (_) {
        // No connectivity or update service unreachable — fall back to
        // Expo's default next-launch check, don't block the current session.
      }
    })();

    return () => { cancelled = true; };
  }, []);

  // Force-update gate: check server's minimum_version against installed version
  const [forceUpdate, setForceUpdate] = useState(false);
  useEffect(() => {
    let cancelled = false;
    settingsApi.getSettings().then((res) => {
      if (cancelled) return;
      const minimumVersion = res?.data?.minimum_version ?? null;
      // Use the NATIVE binary version (versionName baked into the APK/AAB),
      // not appJson.expo.version — after an OTA update the JS bundle carries
      // the new app.json, so the JS version lies about what binary is
      // installed and the force-update gate would never fire.
      const installedVersion =
        Application.nativeApplicationVersion ?? appJson?.expo?.version ?? '0.0.0';
      if (isUpdateRequired(installedVersion, minimumVersion)) {
        setForceUpdate(true);
      }
    }).catch(() => {
      // Network unavailable at launch — don't block the user; they can update
      // once connectivity is restored and they reopen the app.
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    // Clear the image memory cache when the app comes back to the
    // foreground after being backgrounded for a while. expo-image's
    // disk cache persists across launches, so we only need to clear
    // RAM — the next image will re-decode from disk on demand.
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        try { ExpoImage.clearMemoryCache(); } catch (_) { /* ignore */ }
      }
    });
    return () => sub.remove();
  }, []);

  // Startup session check. Uses the persist middleware's onFinishHydration
  // hook (zustand v5) so we wait for rehydration to complete via a real
  // event instead of polling hasHydrated every 50ms for up to 1s — slow
  // Android devices could time out and force a spurious logout.
  useEffect(() => {
    let cancelled = false;
    const runValidation = () => {
      if (cancelled) return;
      useAuthStore.getState().validateSession();
    };

    // If rehydration finished before this effect mounted (common on cold
    // start when the JS thread is busy), onFinishHydration will not fire the
    // callback because the event already happened. Run validation immediately
    // when hasHydrated is already true so sessionChecked never stays false.
    if (useAuthStore.getState().hasHydrated) {
      runValidation();
      return () => { cancelled = true; };
    }

    const unsubFinish = useAuthStore.persist.onFinishHydration(runValidation);
    return () => {
      cancelled = true;
      unsubFinish();
    };
  }, []);

  // Foreground re-validation. When the user reopens the app after a long
  // background, re-validate the session so we catch a freshly-expired
  // token before the first focus-driven fetch fires a 401 and kicks the
  // user out mid-screen.
  useEffect(() => {
    // Skip the first 'active' event (it's the cold-start one; startup
    // validateSession above already ran).
    const skipFirst = { value: true };
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      if (skipFirst.value) {
        skipFirst.value = false;
        return;
      }
      // Only re-validate if the user is currently authenticated — no
      // point round-tripping to /auth/me for a logged-out user.
      if (!useAuthStore.getState().isAuthenticated) return;
      useAuthStore.getState().validateSession();
    });
    return () => sub.remove();
  }, []);

  // Periodic in-foreground re-validation. AppState 'change' only fires
  // on background<->active transitions, so a user who keeps the app open
  // for many hours never triggers a refresh. We poll /auth/me every
  // SESSION_REVALIDATE_INTERVAL_MS while the app is in the foreground
  // and the user is authenticated; the server's sliding-refresh hands
  // back a renewed token long before the current one expires.
  useEffect(() => {
    const SESSION_REVALIDATE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
    let intervalId = null;

    const start = () => {
      if (intervalId) return;
      intervalId = setInterval(() => {
        if (!useAuthStore.getState().isAuthenticated) return;
        useAuthStore.getState().validateSession();
      }, SESSION_REVALIDATE_INTERVAL_MS);
    };
    const stop = () => {
      if (!intervalId) return;
      clearInterval(intervalId);
      intervalId = null;
    };

    // Only run the timer while the app is actually foregrounded — no
    // point waking the JS engine in the background just to fire a fetch
    // that will hang until the OS resumes us.
    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') start();
      else stop();
    });

    return () => {
      stop();
      sub.remove();
    };
  }, []);

  // Show the splash colour while the rehydration + validation is in flight
  // so we never flash the home tabs with a doomed token. CustomerNavigator
  // shows its own spinner while !hasHydrated; we just paint the background
  // here so the first paint isn't a white flash.
  return (
    <SafeAreaProvider>
      {/* barStyle only — status bar bg is deprecated under Android 15 edge-to-edge */}
      <StatusBar barStyle="dark-content" />
      <ErrorBoundary>
        <ToastProvider>
          <View style={{ flex: 1, backgroundColor: colors.bgApp }}>
            <RootNavigator />
          </View>
          <OfflineBanner visible={!isOnline} />
        </ToastProvider>
      </ErrorBoundary>
      {/* Blocking update gate — rendered outside ToastProvider so nothing can appear above it */}
      <ForceUpdateModal visible={forceUpdate} />
    </SafeAreaProvider>
  );
}

export default App;
