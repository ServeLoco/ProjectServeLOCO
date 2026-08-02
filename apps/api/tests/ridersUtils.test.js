/**
 * Unit tests for apps/api/src/utils/riders.js
 * - getRiderForUser / listEligibleRiders / countCompletedDeliveriesToday
 * - selectRiderByLeastOrders (pure, inject random) + selectEligibleRider wiring
 * - syncDeliveryAvailabilityFromRiders
 */

const { pool } = require('../src/db/mysql');
const {
  getRiderForUser,
  listEligibleRiders,
  countCompletedDeliveriesToday,
  countActiveOrdersBatch,
  selectRiderByLeastOrders,
  selectRiderByRadiusTiers,
  distanceToNearestPickupKm,
  selectEligibleRider,
  countActiveRiders,
  syncDeliveryAvailabilityFromRiders,
  RIDER_LOCATION_MAX_AGE_SEC,
} = require('../src/utils/riders');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn(), getConnection: jest.fn() },
}));

jest.mock('../src/realtime/socket', () => ({
  emitToAllCustomers: jest.fn(),
  emitToCustomer: jest.fn(),
  emitToAdmins: jest.fn(),
}));

jest.mock('../src/utils/shops', () => ({
  syncAreaShopOpenState: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/controllers/settingsController', () => ({
  bustSettingsCache: jest.fn(),
}));

const { emitToAllCustomers } = require('../src/realtime/socket');
const { syncAreaShopOpenState } = require('../src/utils/shops');
const { bustSettingsCache } = require('../src/controllers/settingsController');

describe('selectRiderByLeastOrders (pure)', () => {
  it('returns null for empty list', () => {
    expect(selectRiderByLeastOrders([])).toBeNull();
    expect(selectRiderByLeastOrders(null)).toBeNull();
  });

  it('returns the only rider', () => {
    const r = { id: 1, completedToday: 5 };
    expect(selectRiderByLeastOrders([r])).toBe(r);
  });

  it('picks the rider with least completedToday', () => {
    const a = { id: 1, completedToday: 3 };
    const b = { id: 2, completedToday: 1 };
    const c = { id: 3, completedToday: 2 };
    expect(selectRiderByLeastOrders([a, b, c])).toBe(b);
  });

  it('breaks ties with injected random', () => {
    const a = { id: 1, completedToday: 0 };
    const b = { id: 2, completedToday: 0 };
    // random → 0 → first candidate
    expect(selectRiderByLeastOrders([a, b], { random: () => 0 })).toBe(a);
    // random → 0.99 → second candidate
    expect(selectRiderByLeastOrders([a, b], { random: () => 0.99 })).toBe(b);
  });

  it('treats missing completedToday as 0', () => {
    const a = { id: 1 };
    const b = { id: 2, completedToday: 1 };
    expect(selectRiderByLeastOrders([a, b])).toBe(a);
  });

  it('prefers a free rider over a busy one even when it delivered more today', () => {
    const busy = { id: 1, activeOrders: 1, completedToday: 0 };
    const free = { id: 2, activeOrders: 0, completedToday: 9 };
    expect(selectRiderByLeastOrders([busy, free])).toBe(free);
  });

  it('falls back to least completedToday when all riders are free', () => {
    const a = { id: 1, activeOrders: 0, completedToday: 3 };
    const b = { id: 2, activeOrders: 0, completedToday: 1 };
    expect(selectRiderByLeastOrders([a, b])).toBe(b);
  });

  it('picks the fewest active orders when every rider is busy', () => {
    const a = { id: 1, activeOrders: 3, completedToday: 0 };
    const b = { id: 2, activeOrders: 1, completedToday: 8 };
    const c = { id: 3, activeOrders: 2, completedToday: 0 };
    expect(selectRiderByLeastOrders([a, b, c])).toBe(b);
  });

  it('breaks equal active loads by least completedToday', () => {
    const a = { id: 1, activeOrders: 2, completedToday: 5 };
    const b = { id: 2, activeOrders: 2, completedToday: 2 };
    expect(selectRiderByLeastOrders([a, b])).toBe(b);
  });

  it('breaks ties on both counts with injected random', () => {
    const a = { id: 1, activeOrders: 1, completedToday: 2 };
    const b = { id: 2, activeOrders: 1, completedToday: 2 };
    expect(selectRiderByLeastOrders([a, b], { random: () => 0 })).toBe(a);
    expect(selectRiderByLeastOrders([a, b], { random: () => 0.99 })).toBe(b);
  });
});

describe('getRiderForUser', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns null without userId', async () => {
    expect(await getRiderForUser(null)).toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns shaped rider when found', async () => {
    pool.query.mockResolvedValueOnce([[{
      id: 7,
      user_id: 42,
      display_name: 'Ravi',
      phone: '999',
      active: 1,
      is_online: 1,
      last_heartbeat_at: '2026-07-12T10:00:00Z',
    }]]);

    const rider = await getRiderForUser(42);
    expect(rider).toEqual(expect.objectContaining({
      id: 7,
      userId: 42,
      user_id: 42,
      displayName: 'Ravi',
      display_name: 'Ravi',
      isOnline: true,
      is_online: true,
      active: true,
    }));
  });

  it('returns null when no row', async () => {
    pool.query.mockResolvedValueOnce([[]]);
    expect(await getRiderForUser(99)).toBeNull();
  });
});

describe('listEligibleRiders', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries without exclude clause when excludeIds empty', async () => {
    pool.query.mockResolvedValueOnce([[{
      id: 1, user_id: 10, display_name: 'A', phone: null, active: 1, is_online: 1, last_heartbeat_at: new Date(),
    }]]);

    const list = await listEligibleRiders();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(1);
    const sql = pool.query.mock.calls[0][0];
    expect(sql).toContain('NOT EXISTS');
    expect(sql).not.toMatch(/r\.id NOT IN/);
    expect(sql).not.toMatch(/last_heartbeat_at/);
    expect(sql).toContain('is_online = 1');
  });

  it('excludes given rider ids', async () => {
    pool.query.mockResolvedValueOnce([[]]);
    await listEligibleRiders({ excludeIds: [3, 5], areaId: 1 });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/r\.id NOT IN/);
    // Location-freshness seconds are bound first, then areaId, then the exclude list.
    expect(params).toEqual([RIDER_LOCATION_MAX_AGE_SEC, 1, 3, 5]);
  });

  it('marks a stale GPS ping as not fresh', async () => {
    pool.query.mockResolvedValueOnce([[{
      id: 1, user_id: 10, display_name: 'A', phone: null, active: 1, is_online: 1,
      last_lat: '12.9000000', last_lng: '77.6000000', location_fresh: 0,
    }]]);
    const [rider] = await listEligibleRiders();
    expect(rider.lastLat).toBe(12.9);
    expect(rider.lastLng).toBe(77.6);
    expect(rider.locationFresh).toBe(false);
  });
});

describe('countCompletedDeliveriesToday', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 0 without riderId', async () => {
    expect(await countCompletedDeliveriesToday(null)).toBe(0);
  });

  it('returns count from DB', async () => {
    pool.query.mockResolvedValueOnce([[{ cnt: 4 }]]);
    expect(await countCompletedDeliveriesToday(9)).toBe(4);
  });
});

describe('distanceToNearestPickupKm', () => {
  // ~1.1 km apart at this latitude (0.01 degrees of latitude ≈ 1.11 km).
  const near = { lat: 12.9700, lng: 77.6000 };
  const far = { lat: 13.0700, lng: 77.6000 };

  it('returns null when the rider position is stale', () => {
    const rider = { lastLat: 12.97, lastLng: 77.6, locationFresh: false };
    expect(distanceToNearestPickupKm(rider, [near])).toBeNull();
  });

  it('returns null when the rider has never reported a position', () => {
    const rider = { lastLat: null, lastLng: null, locationFresh: true };
    expect(distanceToNearestPickupKm(rider, [near])).toBeNull();
  });

  it('returns null when the order has no pinned shops', () => {
    const rider = { lastLat: 12.97, lastLng: 77.6, locationFresh: true };
    expect(distanceToNearestPickupKm(rider, [])).toBeNull();
  });

  it('measures to the CLOSEST shop on a multi-shop order', () => {
    const rider = { lastLat: 12.9700, lstLng: undefined, lastLng: 77.6000, locationFresh: true };
    // Rider sits on top of `near`; `far` is ~11 km away. Nearest wins.
    const km = distanceToNearestPickupKm(rider, [far, near]);
    expect(km).toBeCloseTo(0, 2);
  });

  it('ignores shops with unusable coordinates', () => {
    const rider = { lastLat: 12.9700, lastLng: 77.6000, locationFresh: true };
    const km = distanceToNearestPickupKm(rider, [{ lat: null, lng: null }, near]);
    expect(km).toBeCloseTo(0, 2);
  });
});

describe('selectRiderByRadiusTiers (ring expansion)', () => {
  const tiers = [1, 2, 3];

  it('offers inside the 1 km ring before anyone further out', () => {
    const inner = { id: 1, distanceKm: 0.4, activeOrders: 2, completedToday: 9 };
    const outer = { id: 2, distanceKm: 2.5, activeOrders: 0, completedToday: 0 };
    // Ring beats load: the 1 km rider wins despite being busier and having
    // delivered more today.
    expect(selectRiderByRadiusTiers([inner, outer], tiers).id).toBe(1);
  });

  it('applies the free-first rule among riders sharing a ring', () => {
    const busy = { id: 1, distanceKm: 0.2, activeOrders: 1, completedToday: 0 };
    const free = { id: 2, distanceKm: 0.9, activeOrders: 0, completedToday: 7 };
    expect(selectRiderByRadiusTiers([busy, free], tiers).id).toBe(2);
  });

  it('opens the 2 km ring once the 1 km riders are gone', () => {
    // Rejected 1 km riders arrive here already filtered out by excludeIds.
    const mid = { id: 2, distanceKm: 1.8, activeOrders: 0, completedToday: 0 };
    const outer = { id: 3, distanceKm: 2.9, activeOrders: 0, completedToday: 0 };
    expect(selectRiderByRadiusTiers([mid, outer], tiers).id).toBe(2);
  });

  it('falls back to a distance-blind pick past the last ring', () => {
    const farAway = { id: 1, distanceKm: 12, activeOrders: 1, completedToday: 0 };
    const unlocatable = { id: 2, distanceKm: null, activeOrders: 0, completedToday: 5 };
    // Nobody is inside 3 km, so the rings are skipped and the normal
    // free-first rule decides — including the rider with no known position.
    expect(selectRiderByRadiusTiers([farAway, unlocatable], tiers).id).toBe(2);
  });

  it('never puts an unlocatable rider in a ring while a located one exists', () => {
    const located = { id: 1, distanceKm: 2.2, activeOrders: 3, completedToday: 9 };
    const unlocatable = { id: 2, distanceKm: null, activeOrders: 0, completedToday: 0 };
    expect(selectRiderByRadiusTiers([located, unlocatable], tiers).id).toBe(1);
  });

  it('treats a rider exactly on the ring edge as inside it', () => {
    const edge = { id: 1, distanceKm: 1, activeOrders: 1, completedToday: 0 };
    const outside = { id: 2, distanceKm: 1.01, activeOrders: 0, completedToday: 0 };
    expect(selectRiderByRadiusTiers([edge, outside], tiers).id).toBe(1);
  });

  it('returns null for an empty list', () => {
    expect(selectRiderByRadiusTiers([], tiers)).toBeNull();
  });
});

describe('selectEligibleRider (load-aware wiring)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('offers the free rider when the busiest one has delivered less today', async () => {
    // 1st query: completed-today batch; 2nd: active-orders batch.
    pool.query
      .mockResolvedValueOnce([[{ rider_id: 2, cnt: 6 }]])
      .mockResolvedValueOnce([[{ rider_id: 1, cnt: 2 }]]);

    const chosen = await selectEligibleRider([{ id: 1 }, { id: 2 }]);
    // Rider 1 delivered 0 today but is carrying 2 active orders;
    // rider 2 delivered 6 today and is free — free wins.
    expect(chosen.id).toBe(2);

    const activeSql = pool.query.mock.calls[1][0];
    expect(activeSql).toContain("status NOT IN ('Delivered', 'Cancelled')");
  });

  it('uses least completed today when nobody is carrying an order', async () => {
    pool.query
      .mockResolvedValueOnce([[{ rider_id: 1, cnt: 4 }]])
      .mockResolvedValueOnce([[]]);

    const chosen = await selectEligibleRider([{ id: 1 }, { id: 2 }]);
    expect(chosen.id).toBe(2);
  });
});

describe('countActiveOrdersBatch', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns {} for an empty id list without querying', async () => {
    expect(await countActiveOrdersBatch([])).toEqual({});
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('maps rider_id to active count', async () => {
    pool.query.mockResolvedValueOnce([[{ rider_id: 3, cnt: 2 }]]);
    expect(await countActiveOrdersBatch([3, 4])).toEqual({ 3: 2 });
    expect(pool.query.mock.calls[0][1]).toEqual([3, 4]);
  });
});

describe('countActiveRiders', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns numeric count', async () => {
    pool.query.mockResolvedValueOnce([[{ cnt: 2 }]]);
    expect(await countActiveRiders(1)).toBe(2);
  });
});

describe('syncDeliveryAvailabilityFromRiders', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('turns delivery_available ON when active riders > 0 and currently off', async () => {
    pool.query
      .mockResolvedValueOnce([[{ cnt: 1 }]]) // countActiveRiders
      .mockResolvedValueOnce([[{ delivery_available: 0 }]]) // settings
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE

    const result = await syncDeliveryAvailabilityFromRiders(1);

    expect(result.changed).toBe(true);
    expect(result.deliveryAvailable).toBe(true);
    expect(pool.query).toHaveBeenCalledWith(
      'UPDATE settings SET delivery_available = ? WHERE delivery_available != ? AND area_id = ?',
      [1, 1, 1]
    );
    expect(bustSettingsCache).toHaveBeenCalledWith(1);
    expect(emitToAllCustomers).toHaveBeenCalledWith(
      'settings.delivery_available.updated',
      expect.objectContaining({ deliveryAvailable: true, delivery_available: true })
    );
    expect(syncAreaShopOpenState).toHaveBeenCalledWith(1);
  });

  it('turns delivery_available OFF when zero active riders and currently on', async () => {
    pool.query
      .mockResolvedValueOnce([[{ cnt: 0 }]])
      .mockResolvedValueOnce([[{ delivery_available: 1 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const result = await syncDeliveryAvailabilityFromRiders(1);

    expect(result.changed).toBe(true);
    expect(result.deliveryAvailable).toBe(false);
    expect(pool.query).toHaveBeenCalledWith(
      'UPDATE settings SET delivery_available = ? WHERE delivery_available != ? AND area_id = ?',
      [0, 0, 1]
    );
    expect(syncAreaShopOpenState).toHaveBeenCalledWith(1);
  });

  it('no-ops when already matching desired state', async () => {
    pool.query
      .mockResolvedValueOnce([[{ cnt: 2 }]])
      .mockResolvedValueOnce([[{ delivery_available: 1 }]]);

    const result = await syncDeliveryAvailabilityFromRiders(1);

    expect(result.changed).toBe(false);
    expect(bustSettingsCache).not.toHaveBeenCalled();
    expect(syncAreaShopOpenState).not.toHaveBeenCalled();
  });

  it('returns early when settings row missing', async () => {
    pool.query
      .mockResolvedValueOnce([[{ cnt: 1 }]])
      .mockResolvedValueOnce([[]]);

    const result = await syncDeliveryAvailabilityFromRiders(1);
    expect(result.changed).toBe(false);
    expect(syncAreaShopOpenState).not.toHaveBeenCalled();
  });
});
