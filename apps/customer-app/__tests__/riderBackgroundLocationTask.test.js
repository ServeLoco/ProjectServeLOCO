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

describe('riderBackgroundLocationTask', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
});
