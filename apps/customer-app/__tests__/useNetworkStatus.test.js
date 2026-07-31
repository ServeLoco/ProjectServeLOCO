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

    // Server comes back — while trouble is showing, polling runs at the fast
    // retry interval (1s here), not the slow steady-state interval, so
    // recovery clears the banner almost immediately.
    response = { ok: true, status: 200 };
    await act(async () => {
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(captured.current.isOnline).toBe(true);
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