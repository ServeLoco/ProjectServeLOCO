/**
 * Tests for src/tasks/riderBackgroundLocationTask.js — the TaskManager
 * callback expo-location invokes (including on a background-only JS
 * relaunch) to deliver a rider's location fix while the app isn't foregrounded.
 *
 * expo-task-manager is mocked in jest.setup.js (defineTask: jest.fn()), so
 * the task body is never auto-invoked — these tests grab the registered
 * callback off the mock and invoke it directly with a synthetic
 * {data, error} payload, same shape TaskManager passes at runtime.
 */
import * as TaskManager from 'expo-task-manager';
import { riderApi } from '../src/api/riderApi';
import { ensureBackgroundCustomerToken } from '../src/utils/orderAlarmNotifications';
import { IDLE_PING_INTERVAL_MS } from '../src/utils/riderTracking';

jest.mock('../src/api/riderApi', () => ({
  riderApi: { updateLocation: jest.fn().mockResolvedValue({}) },
}));

jest.mock('../src/utils/orderAlarmNotifications', () => ({
  ensureBackgroundCustomerToken: jest.fn().mockResolvedValue('a-token'),
}));

// Imported for its module-scope side effect (TaskManager.defineTask(...)).
// Capture the registered task callback immediately — clearAllMocks() in
// beforeEach below would otherwise wipe defineTask.mock.calls, and this
// registration only ever happens once, at import time.
require('../src/tasks/riderBackgroundLocationTask');
const registeredTaskCall = TaskManager.defineTask.mock.calls.find(
  ([name]) => name === 'rider-background-location'
);
const task = registeredTaskCall?.[1];

// The task throttles its POST against a module-scope timestamp, so that state
// leaks between tests. Drive Date.now() from here and jump the clock well past
// the throttle window before each test, so every test starts un-throttled and
// the throttle tests below can control elapsed time exactly.
let nowMs = 1_000_000;
const fix = (lat, lng) => ({ data: { locations: [{ coords: { latitude: lat, longitude: lng } }] } });

describe('riderBackgroundLocationTask', () => {
  beforeAll(() => {
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });
  afterAll(() => {
    Date.now.mockRestore();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    nowMs += IDLE_PING_INTERVAL_MS * 10; // clear any throttle from a prior test
  });

  it('registers the task at module scope', () => {
    expect(registeredTaskCall).toBeDefined();
    expect(typeof task).toBe('function');
  });

  it('ensures a background auth token before posting the location fix', async () => {
    const callOrder = [];
    ensureBackgroundCustomerToken.mockImplementationOnce(async () => {
      callOrder.push('token');
    });
    riderApi.updateLocation.mockImplementationOnce(async () => {
      callOrder.push('updateLocation');
    });

    await task({
      data: { locations: [{ coords: { latitude: 12.9, longitude: 77.6 } }] },
    });

    expect(ensureBackgroundCustomerToken).toHaveBeenCalledTimes(1);
    expect(riderApi.updateLocation).toHaveBeenCalledWith(12.9, 77.6);
    // The token must be secured before the request goes out — otherwise a
    // headless relaunch (zustand-persist not yet hydrated, App.js's
    // setCustomerTokenProvider never ran) sends no Authorization header.
    expect(callOrder).toEqual(['token', 'updateLocation']);
  });

  it('posts the most recent fix when multiple locations are delivered in one batch', async () => {

    await task({
      data: {
        locations: [
          { coords: { latitude: 1, longitude: 1 } },
          { coords: { latitude: 2, longitude: 2 } },
        ],
      },
    });

    expect(riderApi.updateLocation).toHaveBeenCalledWith(2, 2);
  });

  it('does nothing when the task reports an error', async () => {

    await task({ error: { message: 'permission revoked' } });

    expect(ensureBackgroundCustomerToken).not.toHaveBeenCalled();
    expect(riderApi.updateLocation).not.toHaveBeenCalled();
  });

  it('does nothing when no coords are present', async () => {

    await task({ data: { locations: [] } });

    expect(ensureBackgroundCustomerToken).not.toHaveBeenCalled();
    expect(riderApi.updateLocation).not.toHaveBeenCalled();
  });

  it('swallows updateLocation failures — a following fix on the next interval retries', async () => {
    riderApi.updateLocation.mockRejectedValueOnce(new Error('network down'));

    await expect(
      task({ data: { locations: [{ coords: { latitude: 5, longitude: 5 } }] } })
    ).resolves.toBeUndefined();
  });

  // iOS ignores startLocationUpdatesAsync's `timeInterval` (Android-only) and
  // honours only `distanceInterval`, which is deliberately 0 so a stationary
  // rider keeps reporting. iOS therefore delivers a fix on nearly every
  // location change — without this throttle a backgrounded iOS rider would
  // POST continuously instead of once per IDLE_PING_INTERVAL_MS.
  describe('POST throttle (iOS delivers fixes continuously)', () => {
    it('posts the first fix', async () => {
      await task(fix(1, 1));
      expect(riderApi.updateLocation).toHaveBeenCalledTimes(1);
    });

    it('drops a burst of fixes arriving within the interval', async () => {
      await task(fix(1, 1));
      expect(riderApi.updateLocation).toHaveBeenCalledTimes(1);

      // 20 more fixes over the next few seconds, as iOS would deliver them.
      for (let i = 0; i < 20; i++) {
        nowMs += 250;
        await task(fix(1 + i, 1 + i));
      }
      expect(riderApi.updateLocation).toHaveBeenCalledTimes(1);
    });

    it('posts again once the interval has elapsed', async () => {
      await task(fix(1, 1));
      nowMs += IDLE_PING_INTERVAL_MS;
      await task(fix(2, 2));

      expect(riderApi.updateLocation).toHaveBeenCalledTimes(2);
      expect(riderApi.updateLocation).toHaveBeenLastCalledWith(2, 2);
    });

    it('does not skip an Android tick that fires slightly early (10% slack)', async () => {
      await task(fix(1, 1));
      // Android's timeInterval timer firing 5% early must still get through,
      // otherwise a stationary rider's cadence silently halves.
      nowMs += IDLE_PING_INTERVAL_MS * 0.95;
      await task(fix(2, 2));

      expect(riderApi.updateLocation).toHaveBeenCalledTimes(2);
    });

    it('claims the throttle window before awaiting, so a concurrent burst cannot slip through', async () => {
      let release;
      riderApi.updateLocation.mockImplementationOnce(
        () => new Promise((r) => { release = r; })
      );

      const first = task(fix(1, 1));           // in flight, not yet resolved
      await task(fix(2, 2));                   // arrives while first is pending
      expect(riderApi.updateLocation).toHaveBeenCalledTimes(1);

      release({});
      await first;
    });

    it('a fix with no coords does not consume the throttle window', async () => {
      await task({ data: { locations: [] } });
      await task(fix(9, 9));

      expect(riderApi.updateLocation).toHaveBeenCalledTimes(1);
      expect(riderApi.updateLocation).toHaveBeenCalledWith(9, 9);
    });
  });
});
