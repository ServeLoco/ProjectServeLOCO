/**
 * Realtime half of the rider-capacity gate. Checkout polls
 * GET /api/rider-capacity as a reconciler, but the moments capacity actually
 * moves — an order delivered, a rider coming online, the admin re-tuning the
 * multiplier — are already realtime events, so the verdict is pushed too.
 *
 * Three things this has to get right:
 *   1. Emit only on a TRANSITION. Order events fire constantly in an area
 *      nowhere near capacity; re-broadcasting "still fine" on each would be
 *      pure noise.
 *   2. Never carry the counts. `customers:<areaId>` is a room any customer
 *      lands in, so online_riders / active_orders would be exactly as public
 *      there as on the unauthenticated HTTP route.
 *   3. Never throw. Every caller is on an emit path where the order event
 *      itself must survive a capacity check failing.
 */
const { emitToAllCustomers } = require('../src/realtime/socket');
const { getCapacityStatus } = require('../src/utils/riders');
const {
  broadcastCapacityIfChanged,
  _resetCapacityBroadcastForTests,
} = require('../src/realtime/riderCapacityBroadcast');
const config = require('../src/config/env');

jest.mock('../src/realtime/socket', () => ({
  emitToAllCustomers: jest.fn(),
  emitToCustomer: jest.fn(),
  emitToAdmins: jest.fn(),
}));

jest.mock('../src/utils/riders', () => ({
  getCapacityStatus: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  _resetCapacityBroadcastForTests();
});

describe('broadcastCapacityIfChanged', () => {
  it('pushes the verdict to the area\'s customer room on a transition', async () => {
    getCapacityStatus.mockResolvedValue({ onlineRiders: 2, activeOrders: 6, atCapacity: true });

    await broadcastCapacityIfChanged(7);

    expect(emitToAllCustomers).toHaveBeenCalledTimes(1);
    const [areaId, eventName, payload] = emitToAllCustomers.mock.calls[0];
    expect(areaId).toBe(7);
    expect(eventName).toBe('settings.rider_capacity.updated');
    expect(payload.atCapacity).toBe(true);
    expect(payload.at_capacity).toBe(true);
    expect(payload.cooldownMinutes).toBe(config.RIDER_CAPACITY_COOLDOWN_MIN);
    // Stamped so the client can drop it when its socket room is still a
    // different area than the pin it's checking out with.
    expect(payload.areaId).toBe(7);
    expect(payload.area_id).toBe(7);
  });

  it('never carries the rider / order counts', async () => {
    // Values chosen so they can't collide with anything legitimately in the
    // payload (the cooldown is 29, so a bare /9/ would match it).
    getCapacityStatus.mockResolvedValue({ onlineRiders: 111, activeOrders: 333, atCapacity: true });

    await broadcastCapacityIfChanged(7);

    const [, , payload] = emitToAllCustomers.mock.calls[0];
    expect(Object.keys(payload).sort()).toEqual([
      'areaId', 'area_id', 'atCapacity', 'at_capacity', 'cooldownMinutes', 'cooldown_minutes',
    ].sort());
    expect(JSON.stringify(payload)).not.toMatch(/111|333/);
  });

  it('stays silent when the verdict has not changed', async () => {
    getCapacityStatus.mockResolvedValue({ onlineRiders: 2, activeOrders: 6, atCapacity: true });

    await broadcastCapacityIfChanged(7);
    await broadcastCapacityIfChanged(7);
    await broadcastCapacityIfChanged(7);

    expect(emitToAllCustomers).toHaveBeenCalledTimes(1);
  });

  it('emits again when the verdict flips back', async () => {
    getCapacityStatus.mockResolvedValueOnce({ atCapacity: true });
    getCapacityStatus.mockResolvedValueOnce({ atCapacity: false });

    await broadcastCapacityIfChanged(7);
    await broadcastCapacityIfChanged(7);

    expect(emitToAllCustomers).toHaveBeenCalledTimes(2);
    expect(emitToAllCustomers.mock.calls[1][2].atCapacity).toBe(false);
  });

  it('tracks areas independently — area 1 going busy says nothing about area 2', async () => {
    getCapacityStatus.mockResolvedValue({ atCapacity: true });

    await broadcastCapacityIfChanged(1);
    await broadcastCapacityIfChanged(2);

    expect(emitToAllCustomers).toHaveBeenCalledTimes(2);
    expect(emitToAllCustomers.mock.calls.map(([areaId]) => areaId)).toEqual([1, 2]);
  });

  it('swallows a capacity-read failure instead of breaking the event that triggered it', async () => {
    getCapacityStatus.mockRejectedValue(new Error('db down'));

    await expect(broadcastCapacityIfChanged(7)).resolves.toBeUndefined();
    expect(emitToAllCustomers).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 0, 'all'])('ignores a non-area id (%p)', async (areaId) => {
    await broadcastCapacityIfChanged(areaId);

    expect(getCapacityStatus).not.toHaveBeenCalled();
    expect(emitToAllCustomers).not.toHaveBeenCalled();
  });
});
