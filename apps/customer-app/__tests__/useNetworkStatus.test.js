/**
 * Tests for useNetworkStatus: health-ping URL construction, and the
 * reveal-delay/fast-retry UX (warn only after sustained trouble, clear
 * instantly the moment it recovers).
 *
 * The URL bug this guards against: API base URL ends in '/api' (e.g.
 * https://api.serveloco.app/api) but the /health endpoint is mounted at
 * the root, NOT under /api. If the hook blindly appends '/health', it
 * pings /api/health (404) and the offline banner falsely shows up while
 * the user is online.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { act } from 'react-test-renderer';

jest.mock('../src/api/config', () => ({
  getApiBaseUrl: jest.fn(),
}));

jest.mock('react-native', () => {
  const AppState = {
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  };
  return { AppState };
});

jest.mock('@react-native-community/netinfo', () => ({
  addEventListener: jest.fn(() => jest.fn()),
  fetch: jest.fn(() => Promise.resolve({ isConnected: true })),
}));

const { getApiBaseUrl } = require('../src/api/config');

function renderUseNetworkStatus(options) {
  const captured = { current: null };
  function Probe() {
    const { useNetworkStatus } = require('../src/hooks/useNetworkStatus');
    captured.current = useNetworkStatus(options);
    return null;
  }
  let testRenderer;
  act(() => {
    testRenderer = ReactTestRenderer.create(<Probe />);
  });
  return { captured, testRenderer };
}

describe('useNetworkStatus', () => {
  let originalFetch;

  beforeEach(() => {
    jest.useFakeTimers();
    originalFetch = global.fetch;
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it('pings the ROOT /ping endpoint, NOT /api/ping', async () => {
    getApiBaseUrl.mockReturnValue('https://api.serveloco.app/api');
    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    renderUseNetworkStatus();

    // The first check fires synchronously; let microtasks flush.
    await act(async () => {
      await Promise.resolve();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.serveloco.app/ping',
      expect.objectContaining({ method: 'HEAD' })
    );
    // It must NOT have been called with /api/ping.
    expect(global.fetch).not.toHaveBeenCalledWith(
      'https://api.serveloco.app/api/ping',
      expect.any(Object)
    );
  });

  it('handles a base URL without a trailing /api suffix', async () => {
    getApiBaseUrl.mockReturnValue('http://10.0.2.2:3000');
    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    renderUseNetworkStatus();

    await act(async () => {
      await Promise.resolve();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'http://10.0.2.2:3000/ping',
      expect.objectContaining({ method: 'HEAD' })
    );
  });

  it('does not show trouble immediately — waits out the reveal grace period', async () => {
    getApiBaseUrl.mockReturnValue('https://api.serveloco.app/api');
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

    const { captured } = renderUseNetworkStatus({ revealDelayMs: 3000, retryIntervalMs: 1000 });

    // First failed ping — a single blip must not flash the banner.
    await act(async () => { await Promise.resolve(); });
    expect(captured.current.isOnline).toBe(true);

    // Trouble is still ongoing 3s later — now it reveals.
    await act(async () => {
      jest.advanceTimersByTime(3000);
      await Promise.resolve();
    });
    expect(captured.current.isOnline).toBe(false);
  });

  it('clears the warning instantly on the very next successful ping', async () => {
    getApiBaseUrl.mockReturnValue('https://api.serveloco.app/api');
    let response = { ok: false, status: 500 };
    global.fetch = jest.fn().mockImplementation(() => Promise.resolve(response));

    const { captured } = renderUseNetworkStatus({ revealDelayMs: 3000, retryIntervalMs: 1000 });

    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      jest.advanceTimersByTime(3000);
      await Promise.resolve();
    });
    expect(captured.current.isOnline).toBe(false);

    // Server comes back. Polling still runs far faster than the steady-state
    // interval, but the retry gap now backs off with each consecutive failure
    // (1s, 2s, 4s…) instead of staying pinned at 1s, so recovery is caught on
    // the next backed-off tick rather than the next flat one. Advance in
    // lockstep with a microtask flush — the continuation after `await fetch`
    // has to run before the following timer is even scheduled.
    response = { ok: true, status: 200 };
    await act(async () => {
      jest.advanceTimersByTime(4000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(captured.current.isOnline).toBe(true);
  });

  it('backs the retry interval off exponentially instead of hammering at a flat rate', async () => {
    // Regression guard for the ping storm: a device on a dead link used to
    // retry at a flat 2s forever, and because every AppState 'active' event
    // leaked an additional never-cancelled poll chain, production saw 23
    // pings inside a single second repeating on an exact 30s period. Two
    // invariants matter here — the gap must grow, and one chain must stay
    // one chain.
    getApiBaseUrl.mockReturnValue('https://api.serveloco.app/api');
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

    renderUseNetworkStatus({ checkIntervalMs: 60000, retryIntervalMs: 1000, revealDelayMs: 3000 });

    await act(async () => { await Promise.resolve(); });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // 1s gets the 2nd probe (backoff 1000 * 2^0).
    await act(async () => {
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);

    // The 3rd is now 2s out, not 1s — at +1s nothing has fired yet.
    await act(async () => {
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);

    await act(async () => {
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('a foreground event folds into the existing poll chain instead of starting another', async () => {
    // The leak itself: check() re-arms itself, so anything calling it out of
    // band forked a second immortal chain. Every 'active' event added one
    // more, and they never stopped. Here the listener fires repeatedly and
    // the request count must stay linear, not multiply.
    getApiBaseUrl.mockReturnValue('https://api.serveloco.app/api');
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    const { AppState } = require('react-native');
    renderUseNetworkStatus({ checkIntervalMs: 30000, retryIntervalMs: 1000, revealDelayMs: 3000 });

    // Two flushes to fully settle the mount probe: one for `await fetch`, one
    // for the continuation that reaches `finally` and re-arms the chain.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Grab the handler the hook registered and fire 'active' five times, the
    // way Android does for the notification shade, permission dialogs and the
    // app switcher.
    const handler = AppState.addEventListener.mock.calls
      .map(([eventName, fn]) => (eventName === 'change' ? fn : null))
      .filter(Boolean)
      .pop();

    // Five foregrounds, staggered a second apart the way real ones arrive.
    // Each fires its own immediate probe either way — that part is intended.
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        jest.advanceTimersByTime(1000);
        handler('active');
        await Promise.resolve();
        await Promise.resolve();
      });
    }
    expect(global.fetch).toHaveBeenCalledTimes(6);

    // Now the real question: how many chains are still armed? Step forward a
    // second at a time, flushing microtasks between steps. That matters —
    // jest.advanceTimersByTime() fires every due timer in one synchronous
    // sweep with no chance for the awaited continuations to run, so the
    // in-flight guard swallows all but the first and a leak looks clean.
    // Stepping lets each chain's probe settle before the next comes due,
    // reproducing how real timers drift apart on a device.
    //
    // One chain re-based by the last foreground comes due at t=35s: exactly
    // one more probe. The leak left six chains stacked at 30s…35s, which
    // would land six — the accumulation that produced 23 pings in one second
    // in production.
    for (let i = 0; i < 31; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {
        jest.advanceTimersByTime(1000);
        await Promise.resolve();
        await Promise.resolve();
      });
    }
    expect(global.fetch).toHaveBeenCalledTimes(7);
  });

  it('polls at the fast retry rate while trouble is suspected, not the slow steady-state interval', async () => {
    getApiBaseUrl.mockReturnValue('https://api.serveloco.app/api');
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

    renderUseNetworkStatus({ checkIntervalMs: 60000, retryIntervalMs: 1000, revealDelayMs: 3000 });

    await act(async () => { await Promise.resolve(); });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Each retry tick's continuation (after `await fetch`) needs a microtask
    // flush before the next setTimeout is even scheduled, so advance+flush
    // in lockstep rather than one big jump. Well under one steady-state
    // interval (60s) worth of 1s fast-retry ticks should still produce
    // several extra pings.
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        jest.advanceTimersByTime(1000);
        await Promise.resolve();
        await Promise.resolve();
      });
    }
    expect(global.fetch.mock.calls.length).toBeGreaterThan(2);
  });
});