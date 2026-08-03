import { storage } from '../utils/storage';
import { areaHeader } from '../stores/areaHeader';

const API_BASE = import.meta.env.VITE_API_BASE_URL;
if (!API_BASE) {
  throw new Error('VITE_API_BASE_URL environment variable is not set');
}
export const API_ORIGIN = (() => {
  try {
    return new URL(API_BASE).origin;
  } catch {
    return 'http://localhost:3000';
  }
})();

export const apiClient = async (endpoint, options = {}) => {
  const { root = false, ...requestOptions } = options;
  const baseUrl = root ? API_ORIGIN : API_BASE;
  const url = `${baseUrl}${endpoint}`;
  
  const headers = {
    ...requestOptions.headers,
  };

  if (!(requestOptions.body instanceof FormData)) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }

  const token = storage.getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // §4.4 — the ONLY place X-Area-Id is attached. No page component ever
  // passes an area explicitly. areaHeader.get() already gates this to
  // super_admin only (an area_admin sending this header at all gets a hard
  // 403 server-side) and returns null/'all'/a numeric string.
  const areaId = areaHeader.get();
  if (areaId) {
    headers['X-Area-Id'] = areaId;
  }

  const config = {
    ...requestOptions,
    headers,
  };

  if (config.body && typeof config.body === 'object' && !(config.body instanceof FormData)) {
    config.body = JSON.stringify(config.body);
  }

  const TIMEOUT_MS = 15000;
  let timeoutId;
  let internalController;
  if (!requestOptions.signal) {
    internalController = new AbortController();
    timeoutId = setTimeout(() => internalController.abort(), TIMEOUT_MS);
    config.signal = internalController.signal;
  } else {
    config.signal = requestOptions.signal;
  }

  try {
    const response = await fetch(url, config);
    
    if (response.status === 401) {
      storage.clearToken();
      // Emit an event so the app (App.jsx) can navigate via React Router and
      // preserve form/state, instead of doing a hard reload that wipes the page.
      try {
        window.dispatchEvent(new CustomEvent('admin:unauthorized'));
      } catch (_) {
        // Last-resort fallback if CustomEvent isn't available.
        window.location.href = '/login';
      }
      const err = new Error('Unauthorized');
      err.response = { status: 401, data: null };
      return Promise.reject(err);
    }

    const isJson = response.headers.get('content-type')?.includes('application/json');
    const data = isJson ? await response.json() : await response.text();

    if (!response.ok) {
      // Attach a `.response` so callers can branch on status code (e.g. 409
      // CONCURRENCY_CONFLICT, 429 rate-limit). Without this every `err.response`
      // access in the admin is dead code.
      const errorMsg = (data && typeof data === 'object' && (data.message || data.error))
        || response.statusText
        || 'API request failed';
      const err = new Error(errorMsg);
      err.response = { status: response.status, data };
      return Promise.reject(err);
    }

    return data;
  } catch (error) {
    if (error?.name === 'AbortError' || error?.message?.includes('aborted')) {
      return Promise.reject(new Error('Request timed out'));
    }
    return Promise.reject(error);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
};
