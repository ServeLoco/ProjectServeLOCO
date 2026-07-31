/**
 * Tests for the HTTP client retry + 401 logic.
 *
 * The fetch call is mocked globally; we exercise the retry, timeout, and
 * 401-handler paths.
 */

import {
  apiClient,
  setAdminReMintHandler,
  setAdminSessionClearHandler,
  setCustomerLogoutHandler,
} from '../src/api/httpClient';
import { setAdminTokenProvider, setCustomerTokenProvider } from '../src/api/sessionTokens';

describe('httpClient', () => {
  let originalFetch;
  let logoutHandler;

  beforeEach(() => {
    originalFetch = global.fetch;
    logoutHandler = jest.fn();
    setCustomerLogoutHandler(logoutHandler);
    // Most tests exercise a request that DID carry a token — the "no token
    // attached" case is covered by its own test below with the provider unset.
    setCustomerTokenProvider(() => 'valid-customer-token');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    setCustomerLogoutHandler(null);
    setAdminReMintHandler(null);
    setAdminSessionClearHandler(null);
    setAdminTokenProvider(null);
    setCustomerTokenProvider(null);
    jest.clearAllTimers();
  });

  // Helper: mock a single fetch response
  function mockFetchOnce(response) {
    global.fetch = jest.fn().mockResolvedValueOnce(response);
  }

  function jsonResponse(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }

  it('returns JSON on a 2xx response', async () => {
    mockFetchOnce(jsonResponse(200, { hello: 'world' }));
    const out = await apiClient.get('/test');
    expect(out).toEqual({ hello: 'world' });
  });

  it('throws an ApiError on a 4xx response', async () => {
    mockFetchOnce(jsonResponse(404, { code: 'NOT_FOUND', message: 'gone' }));
    await expect(apiClient.get('/missing')).rejects.toMatchObject({ status: 404 });
  });

  it('triggers logout on a 401 for customer-authed requests', async () => {
    mockFetchOnce(jsonResponse(401, { code: 'UNAUTHORIZED', message: 'bad token' }));
    await expect(apiClient.get('/me', { auth: 'customer' })).rejects.toBeDefined();
    // Allow the synchronous triggerLogout to run
    await new Promise((r) => setImmediate(r));
    expect(logoutHandler).toHaveBeenCalledTimes(1);
  });

  it('does NOT trigger logout on a 401 when no customer token was attached', async () => {
    // Regression guard: a background sync hook racing the token provider's
    // registration on cold start (see App.js) can fire a customer-authed
    // request before a token exists. That 401 must never be treated as
    // "the server rejected our session" — only "we forgot the token".
    setCustomerTokenProvider(null);
    mockFetchOnce(jsonResponse(401, { code: 'UNAUTHORIZED', message: 'no token' }));
    await expect(apiClient.get('/me', { auth: 'customer' })).rejects.toBeDefined();
    await new Promise((r) => setImmediate(r));
    expect(logoutHandler).not.toHaveBeenCalled();
  });

  it('re-mints and retries once on a 401 for admin-authed requests', async () => {
    let currentAdminToken = 'stale-token';
    setAdminTokenProvider(() => currentAdminToken);
    const reMint = jest.fn().mockImplementation(async () => {
      currentAdminToken = 'fresh-token';
      return 'fresh-token';
    });
    setAdminReMintHandler(reMint);
    const clear = jest.fn();
    setAdminSessionClearHandler(clear);

    global.fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse(401, { code: 'UNAUTHORIZED' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const out = await apiClient.get('/admin/dashboard', { auth: 'admin' });
    expect(out).toEqual({ ok: true });
    expect(reMint).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(2);
    // Second call must carry the re-minted token, not the stale one.
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer fresh-token');
  });

  it('clears the admin session when re-mint itself is rejected', async () => {
    setAdminTokenProvider(() => 'stale-token');
    const reMint = jest.fn().mockResolvedValue(null);
    setAdminReMintHandler(reMint);
    const clear = jest.fn();
    setAdminSessionClearHandler(clear);

    global.fetch = jest.fn().mockResolvedValue(jsonResponse(401, { code: 'UNAUTHORIZED' }));

    await expect(apiClient.get('/admin/dashboard', { auth: 'admin' })).rejects.toMatchObject({ status: 401 });
    expect(reMint).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
    // No infinite loop — one initial call, no further retry after remint fails.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT trigger logout on a 401 for public requests', async () => {
    mockFetchOnce(jsonResponse(401, { code: 'UNAUTHORIZED', message: 'bad creds' }));
    // login is a public endpoint
    await expect(apiClient.post('/auth/login', { phone: 'x', password: 'y' }))
      .rejects.toBeDefined();
    await new Promise((r) => setImmediate(r));
    expect(logoutHandler).not.toHaveBeenCalled();
  });

  it('retries on 503 and eventually succeeds', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse(503, { code: 'BUSY', message: 'busy' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const out = await apiClient.get('/flaky');
    expect(out).toEqual({ ok: true });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 502 and gives up after MAX_RETRIES', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(jsonResponse(502, { code: 'BAD_GATEWAY' }))
      .mockResolvedValueOnce(jsonResponse(502, { code: 'BAD_GATEWAY' }))
      .mockResolvedValueOnce(jsonResponse(502, { code: 'BAD_GATEWAY' }));
    await expect(apiClient.get('/down')).rejects.toMatchObject({ status: 502 });
    // 1 initial + 2 retries = 3 total
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry on 400 (client error)', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(jsonResponse(400, { code: 'BAD_REQUEST' }));
    await expect(apiClient.get('/bad')).rejects.toMatchObject({ status: 400 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries on network failure (fetch rejects)', async () => {
    global.fetch = jest.fn()
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const out = await apiClient.get('/net');
    expect(out).toEqual({ ok: true });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('times out and throws NETWORK_ERROR after REQUEST_TIMEOUT_MS', async () => {
    // Approach: stub the global AbortController so that calling
    // controller.abort() synchronously marks the signal aborted AND
    // invokes any listener the request attached. The real
    // REQUEST_TIMEOUT_MS constant is 8000ms — we cannot wait that long
    // in a unit test, so we shorten the interval by using jest fake
    // timers + advancing time. But the httpClient captures the
    // constant at module load, so the cleanest path is to simulate
    // the controller's abort behaviour directly.
    const originalAbortController = global.AbortController;
    const listeners = new Set();
    class MockAbortController {
      constructor() {
        this.signal = {
          aborted: false,
          addEventListener: (event, cb) => {
            if (event === 'abort') listeners.add(cb);
          },
        };
      }
      abort() {
        this.signal.aborted = true;
        listeners.forEach((cb) => { try { cb(); } catch (_err) { /* swallow listener errors */ } });
      }
    }
    global.AbortController = MockAbortController;

    // Slow fetch — only rejects once abort is called.
    global.fetch = jest.fn().mockImplementation((url, options) => {
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (options.signal && options.signal.aborted) {
          onAbort();
        } else if (options.signal && typeof options.signal.addEventListener === 'function') {
          options.signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    });

    try {
      // Trigger the request. Inside the client, createTimeoutSignal
      // schedules a setTimeout(...abort, REQUEST_TIMEOUT_MS). We can't
      // wait 8s, so instead we eagerly invoke any pending timeout by
      // waiting one microtask then dispatching the abort. In practice,
      // since the setTimeout is pending, we simulate it by calling
      // .abort() on the freshly-created controller via the registered
      // listener. The cleanest approach: just await a real setTimeout
      // matching REQUEST_TIMEOUT_MS — too slow. Instead, the test
      // delegates to the mock by directly triggering fetch's abort
      // through the listener set the controller tracks.
      //
      // The httpClient's internal controller is local; we can't reach
      // it. So we expose an indirection: replace setTimeout with a
      // shim that calls back immediately.
      const originalSetTimeout = global.setTimeout;
      global.setTimeout = (cb, ms, ...rest) => originalSetTimeout(cb, 0, ...rest);

      try {
        // The httpClient retries timeouts (up to MAX_RETRIES=2), so we
        // expect the initial fetch + 2 retries = 3 calls before it
        // gives up. The point of this test: verify the timeout eventually
        // surfaces as an ApiError with code NETWORK_ERROR and a
        // human-readable message — NOT a generic fetch error.
        await expect(apiClient.get('/hangs')).rejects.toMatchObject({
          message: expect.stringMatching(/Network is slow|timed out/i),
          code: 'NETWORK_ERROR',
          isNetworkError: true,
        });
        expect(global.fetch).toHaveBeenCalledTimes(3);
      } finally {
        global.setTimeout = originalSetTimeout;
      }
    } finally {
      global.AbortController = originalAbortController;
    }
  });

  it('does NOT retry when caller aborts the request (signal.aborted)', async () => {
    // User-initiated cancellation must surface immediately, never retry.
    const callerController = new AbortController();
    global.fetch = jest.fn().mockImplementation((url, options) => {
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
      });
    });

    // Abort the caller-provided signal immediately.
    callerController.abort();

    await expect(
      apiClient.get('/user-cancel', { signal: callerController.signal })
    ).rejects.toMatchObject({ code: 'ABORTED' });
    // CRITICAL: only 1 fetch call (no retries on user abort).
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
