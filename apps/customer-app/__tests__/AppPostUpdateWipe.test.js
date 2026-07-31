/**
 * Post-update storage wipe (App.js).
 *
 * When the native binary version changes between launches (Play Store
 * auto-update or manual store update — paths that bypass ForceUpdateModal's
 * "Update Now" wipe), App.js must wipe every AsyncStorage key except the
 * auth session, stamp the new version marker, and reload the JS bundle.
 * When the version is unchanged, it must touch nothing.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';

const AUTH_KEY = 'serveloco-customer-auth';
const MARKER_KEY = 'serveloco-last-native-version';

// ---- In-memory AsyncStorage double (overrides the jest.setup.js stub,
// which lacks getAllKeys/multiRemove) -------------------------------------
const mockStore = new Map();
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async (k) => (mockStore.has(k) ? mockStore.get(k) : null)),
  setItem: jest.fn(async (k, v) => { mockStore.set(k, v); }),
  removeItem: jest.fn(async (k) => { mockStore.delete(k); }),
  getAllKeys: jest.fn(async () => [...mockStore.keys()]),
  multiRemove: jest.fn(async (keys) => { keys.forEach((k) => mockStore.delete(k)); }),
  clear: jest.fn(async () => { mockStore.clear(); }),
}));

jest.mock('expo-application', () => ({
  nativeApplicationVersion: '1.7.0',
}));

jest.mock('expo-updates', () => ({
  checkForUpdateAsync: jest.fn(async () => ({ isAvailable: false })),
  fetchUpdateAsync: jest.fn(async () => {}),
  reloadAsync: jest.fn(async () => {}),
}));

// ---- Silence the rest of the app so only the App.js effects run ----------
jest.mock('../src/navigation', () => {
  const { View } = require('react-native');
  return { RootNavigator: () => <View />, navigationRef: { current: null } };
});
jest.mock('../src/hooks', () => ({
  useCustomerRealtime: () => {},
  useLocalNotifications: () => {},
  useNetworkStatus: () => ({ isOnline: true }),
  usePreciseLocationPermissionOnStart: () => {},
  useShopStatusSync: () => {},
  useDeliveryZoneSync: () => {},
  useDeliveryLocationSync: () => {},
  useProductAvailabilitySync: () => {},
  useAuthRoleSync: () => {},
}));
jest.mock('../src/api', () => ({
  settingsApi: { getSettings: jest.fn(async () => ({ data: {} })) },
  setAdminTokenProvider: jest.fn(),
  setCustomerTokenProvider: jest.fn(),
}));
jest.mock('../src/api/httpClient', () => ({
  setAdminReMintHandler: jest.fn(),
  setAdminSessionClearHandler: jest.fn(),
  setCustomerLogoutHandler: jest.fn(),
}));
jest.mock('../src/stores', () => ({
  useAuthStore: {
    getState: () => ({
      hasHydrated: true,
      isAuthenticated: false,
      token: null,
      adminToken: null,
      validateSession: jest.fn(),
      logout: jest.fn(),
      mintAdminSession: jest.fn(),
      clearAdminSession: jest.fn(),
    }),
    persist: { onFinishHydration: jest.fn(() => jest.fn()) },
  },
}));
jest.mock('../src/components/ForceUpdateModal', () => ({
  ForceUpdateModal: () => null,
}));

const AsyncStorage = require('@react-native-async-storage/async-storage');
const Updates = require('expo-updates');
const App = require('../App').default;

// The wipe effect is skipped in __DEV__ (jest default). Flip it off so the
// production code path runs; restore afterwards.
let devFlagBackup;
beforeAll(() => {
  devFlagBackup = global.__DEV__;
  global.__DEV__ = false;
});
afterAll(() => {
  global.__DEV__ = devFlagBackup;
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function renderApp() {
  let root;
  await ReactTestRenderer.act(async () => {
    root = ReactTestRenderer.create(<App />);
    // Drain the async wipe chain (getItem → getAllKeys → multiRemove →
    // setItem → reloadAsync are sequential awaits).
    await flush(); await flush(); await flush(); await flush(); await flush();
  });
  await ReactTestRenderer.act(async () => { root.unmount(); });
}

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
});

it('wipes everything except auth, stamps the marker, and reloads when the native version changed', async () => {
  mockStore.set('serveloco-cart', '{"items":[{"stale":true}]}');
  mockStore.set('serveloco-settings', '{"old":true}');
  mockStore.set(AUTH_KEY, '{"token":"keep-me"}');
  mockStore.set(MARKER_KEY, '1.6.0');

  await renderApp();

  expect(AsyncStorage.multiRemove).toHaveBeenCalledWith(
    expect.arrayContaining(['serveloco-cart', 'serveloco-settings'])
  );
  // Auth + marker must never be in the removal list
  const removed = AsyncStorage.multiRemove.mock.calls[0][0];
  expect(removed).not.toContain(AUTH_KEY);
  expect(removed).not.toContain(MARKER_KEY);

  expect(mockStore.has('serveloco-cart')).toBe(false);
  expect(mockStore.has('serveloco-settings')).toBe(false);
  expect(mockStore.get(AUTH_KEY)).toBe('{"token":"keep-me"}');
  expect(mockStore.get(MARKER_KEY)).toBe('1.7.0');
  expect(Updates.reloadAsync).toHaveBeenCalled();
});

it('wipes on first run after rollout (no marker stored yet)', async () => {
  mockStore.set('serveloco-cart', '{"items":[{"stale":true}]}');
  mockStore.set(AUTH_KEY, '{"token":"keep-me"}');

  await renderApp();

  expect(mockStore.has('serveloco-cart')).toBe(false);
  expect(mockStore.get(AUTH_KEY)).toBe('{"token":"keep-me"}');
  expect(mockStore.get(MARKER_KEY)).toBe('1.7.0');
  expect(Updates.reloadAsync).toHaveBeenCalled();
});

it('does nothing when the native version is unchanged', async () => {
  mockStore.set('serveloco-cart', '{"items":[]}');
  mockStore.set(MARKER_KEY, '1.7.0');

  await renderApp();

  expect(AsyncStorage.multiRemove).not.toHaveBeenCalled();
  expect(Updates.reloadAsync).not.toHaveBeenCalled();
  expect(mockStore.has('serveloco-cart')).toBe(true);
});

it('does not reload when there was nothing to wipe (fresh install)', async () => {
  await renderApp();

  expect(AsyncStorage.multiRemove).not.toHaveBeenCalled();
  expect(Updates.reloadAsync).not.toHaveBeenCalled();
  expect(mockStore.get(MARKER_KEY)).toBe('1.7.0');
});

it('reloads exactly once when a native update and a pending OTA land on the same launch', async () => {
  // Native version changed AND an OTA update is waiting — the wipe reload
  // must win and the OTA fetch must be skipped on this pass (the reloaded
  // JS re-runs the effect and picks the OTA up with a matching marker).
  Updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: true });
  mockStore.set('serveloco-cart', '{"items":[{"stale":true}]}');
  mockStore.set(MARKER_KEY, '1.6.0');

  await renderApp();

  expect(Updates.reloadAsync).toHaveBeenCalledTimes(1);
  expect(Updates.fetchUpdateAsync).not.toHaveBeenCalled();
  expect(mockStore.get(MARKER_KEY)).toBe('1.7.0');
});

it('fetches and applies a pending OTA when the native version is unchanged', async () => {
  Updates.checkForUpdateAsync.mockResolvedValue({ isAvailable: true });
  mockStore.set(MARKER_KEY, '1.7.0');

  await renderApp();

  expect(AsyncStorage.multiRemove).not.toHaveBeenCalled();
  expect(Updates.fetchUpdateAsync).toHaveBeenCalledTimes(1);
  expect(Updates.reloadAsync).toHaveBeenCalledTimes(1);
});
