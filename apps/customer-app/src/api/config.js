import { NativeModules, Platform } from 'react-native';
import Constants from 'expo-constants';

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function extractHost(value) {
  if (!value) return null;
  const str = String(value);
  // Accepts both a full URL ("http://10.0.0.5:8081/index.bundle") and a bare
  // host:port pair ("10.0.0.5:8081"), which is the shape expo-constants uses.
  const withScheme = str.includes('://') ? str : `http://${str}`;
  return withScheme.match(/^[^:]+:\/\/([^:/]+)/)?.[1] || null;
}

function getDevServerHost() {
  // NativeModules.SourceCode is absent under the New Architecture's bridgeless
  // mode, so expo-constants is the reliable source there. Both are checked:
  // whichever is populated gives the machine serving the Metro bundle.
  const host =
    extractHost(NativeModules?.SourceCode?.scriptURL) ||
    extractHost(Constants?.expoConfig?.hostUri) ||
    extractHost(Constants?.expoGoConfig?.debuggerHost);

  if (
    !host ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host.startsWith('169.254.')
  ) {
    return null;
  }

  return host;
}

function resolveDefaultApiBaseUrl() {
  const envBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;

  if (envBaseUrl) {
    // A localhost base URL only reaches the API where the device can tunnel to
    // the host — Android over `adb reverse`. On a physical iOS device localhost
    // is the phone itself, so every request fails without ever leaving it.
    // Prefer the Metro dev-server host whenever we can derive one; that is the
    // same machine serving the bundle, so it is where the API lives too.
    // Android + adb reverse is unaffected: its dev-server host IS localhost,
    // so getDevServerHost() returns null and we keep the env value as-is.
    if (__DEV__ && /^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(envBaseUrl)) {
      const devServerHost = getDevServerHost();
      if (devServerHost) {
        return `http://${devServerHost}:3000/api`;
      }
    }
    return normalizeBaseUrl(envBaseUrl);
  }

  if (!__DEV__) {
    throw new Error('EXPO_PUBLIC_API_BASE_URL must be set for release builds.');
  }

  const devServerHost = getDevServerHost();

  if (devServerHost) {
    return `http://${devServerHost}:3000/api`;
  }

  if (Platform.OS === 'android') {
    return 'http://10.0.2.2:3000/api';
  }

  return 'http://localhost:3000/api';
}

const DEFAULT_API_BASE_URL = resolveDefaultApiBaseUrl();
let apiBaseUrl = DEFAULT_API_BASE_URL;

function getApiBaseUrl() {
  return normalizeBaseUrl(apiBaseUrl);
}

function setApiBaseUrl(nextBaseUrl) {
  apiBaseUrl = normalizeBaseUrl(nextBaseUrl || DEFAULT_API_BASE_URL);
}

export { DEFAULT_API_BASE_URL, getApiBaseUrl, setApiBaseUrl };
