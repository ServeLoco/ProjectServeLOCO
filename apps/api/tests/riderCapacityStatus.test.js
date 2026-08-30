/**
 * GET /api/rider-capacity?latitude=&longitude= — polled by the customer app
 * while checkout is focused, so the Place Order button can re-enable itself
 * once an area's rider capacity frees up, without waiting for a rejected
 * checkout attempt. Mirrors the exact at-capacity formula the createOrder
 * gate uses (riderCapacityGate.test.js): onlineRiders * the area's own
 * rider_capacity_multiplier, falling back to config.RIDER_CAPACITY_MULTIPLIER
 * when a settings row predates that column.
 *
 * The route is public and takes an arbitrary pin, so it must expose the
 * verdict ONLY — never the rider/order counts behind it.
 */
const request = require('supertest');
const express = require('express');
const riderCapacityRoutes = require('../src/routes/riderCapacityRoutes');
const { pool } = require('../src/db/mysql');
const areaScope = require('../src/utils/areaScope');
const config = require('../src/config/env');
const { ACTIVE_ORDER_STATUSES } = require('../src/utils/riders');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn() },
}));

jest.mock('express-rate-limit', () => {
  const factory = () => (req, res, next) => next();
  factory.rateLimit = factory;
  factory.ipKeyGenerator = (ip) => String(ip);
  return factory;
});

const app = express();
app.use(express.json());
app.use('/api/rider-capacity', riderCapacityRoutes);

const AREA_1 = {
  id: 1, code: 'A1', name: 'Area 1', active: 1, is_default: 1, timezone: 'Asia/Kolkata',
  min_lat: 10, max_lat: 11, min_lng: 10, max_lng: 11, catalog_version: 5,
  brand_color: '#4f46e5', logo_image_id: null,
};

const ZONE_900 = {
  id: 900, area_id: 1, name: 'Zone A', boundary: JSON.stringify([
    { lat: 10, lng: 10 }, { lat: 10, lng: 11 }, { lat: 11, lng: 11 }, { lat: 11, lng: 10 },
  ]), parent_zone_id: null, active: 1,
};

// The capacity read is a single row of three subquery counts (one round trip
// — see getCapacityStatus), so a scenario is just that one row.
const capacityRow = ({ riders, orders, multiplier = 3 }) => [[{
  online_riders: riders, active_orders: orders, capacity_multiplier: multiplier,
}]];

const resolvedPin = (capacity) => {
  pool.query
    .mockResolvedValueOnce([[AREA_1]]) // bbox candidates
    .mockResolvedValueOnce([[ZONE_900]]) // zone match -> areaId 1
    .mockResolvedValueOnce(capacity);
};

describe('GET /api/rider-capacity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    areaScope._resetCachesForTests();
  });

  it('reports atCapacity: true once active orders reach onlineRiders * the area multiplier', async () => {
    resolvedPin(capacityRow({ riders: 2, orders: 6, multiplier: 3 })); // 2 * 3 = 6

    const res = await request(app).get('/api/rider-capacity?latitude=10.5&longitude=10.5');

    expect(res.statusCode).toBe(200);
    expect(res.body.atCapacity).toBe(true);
    expect(res.body.at_capacity).toBe(true);
    expect(res.body.areaId).toBe(1);
    expect(res.body.area_id).toBe(1);
    expect(res.body.cooldownMinutes).toBe(config.RIDER_CAPACITY_COOLDOWN_MIN);
    expect(res.body.cooldown_minutes).toBe(config.RIDER_CAPACITY_COOLDOWN_MIN);
  });

  // This route is public and takes any pin, so echoing the counts would hand
  // anyone live rider headcount and order volume for any area on a 45s poll.
  it('never exposes the rider / order counts behind the verdict', async () => {
    resolvedPin(capacityRow({ riders: 7, orders: 21 }));

    const res = await request(app).get('/api/rider-capacity?latitude=10.5&longitude=10.5');

    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([
      'areaId', 'area_id', 'atCapacity', 'at_capacity', 'cooldownMinutes', 'cooldown_minutes',
    ].sort());
    expect(JSON.stringify(res.body)).not.toMatch(/7|21/);
  });

  it('uses a lower per-area multiplier when the admin has tuned this area down', async () => {
    // Area multiplier 2, so 2 riders * 2 = 4 trips it — the same order count
    // the config default of 3 would NOT trip.
    resolvedPin(capacityRow({ riders: 2, orders: 4, multiplier: 2 }));

    const res = await request(app).get('/api/rider-capacity?latitude=10.5&longitude=10.5');

    expect(res.statusCode).toBe(200);
    expect(res.body.atCapacity).toBe(true);
  });

  it('falls back to config.RIDER_CAPACITY_MULTIPLIER when the area has no settings row yet', async () => {
    resolvedPin(capacityRow({ riders: 2, orders: 6, multiplier: null })); // 2 * config default 3

    const res = await request(app).get('/api/rider-capacity?latitude=10.5&longitude=10.5');

    expect(res.statusCode).toBe(200);
    expect(res.body.atCapacity).toBe(true);
  });

  it('reports atCapacity: false when one order under capacity', async () => {
    resolvedPin(capacityRow({ riders: 2, orders: 5, multiplier: 3 })); // one under 6

    const res = await request(app).get('/api/rider-capacity?latitude=10.5&longitude=10.5');

    expect(res.statusCode).toBe(200);
    expect(res.body.atCapacity).toBe(false);
  });

  it('is never at capacity with zero online riders, regardless of active orders', async () => {
    resolvedPin(capacityRow({ riders: 0, orders: 999, multiplier: 3 }));

    const res = await request(app).get('/api/rider-capacity?latitude=10.5&longitude=10.5');

    expect(res.statusCode).toBe(200);
    expect(res.body.atCapacity).toBe(false);
  });

  it('a pin outside every zone returns the "no coverage" shape, not a 500 or a stale area', async () => {
    pool.query
      .mockResolvedValueOnce([[AREA_1]]) // bbox candidates — inside the bbox
      .mockResolvedValueOnce([[]]); // ...but no zone shape covers this point

    const res = await request(app).get('/api/rider-capacity?latitude=10.5&longitude=10.5');

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      areaId: null, area_id: null,
      atCapacity: false, at_capacity: false,
      cooldownMinutes: config.RIDER_CAPACITY_COOLDOWN_MIN,
      cooldown_minutes: config.RIDER_CAPACITY_COOLDOWN_MIN,
    });
    // No capacity query should run once resolution yields no area.
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('no pin at all resolves through the default area, same as bootstrap', async () => {
    pool.query
      .mockResolvedValueOnce([[AREA_1]]) // listAreas() for getDefaultArea
      .mockResolvedValueOnce(capacityRow({ riders: 1, orders: 0 }));

    const res = await request(app).get('/api/rider-capacity');

    expect(res.statusCode).toBe(200);
    expect(res.body.areaId).toBe(1);
    expect(res.body.atCapacity).toBe(false);
  });

  // Polled every 45s by every customer sitting on checkout, against a
  // cross-region MySQL — three sequential awaits would cost ~3x one.
  it('reads riders, orders and the multiplier in a single area-scoped round trip', async () => {
    resolvedPin(capacityRow({ riders: 1, orders: 0 }));

    await request(app).get('/api/rider-capacity?latitude=10.5&longitude=10.5');

    // 2 area-resolution queries + exactly one capacity query.
    expect(pool.query).toHaveBeenCalledTimes(3);

    const [sql, params] = pool.query.mock.calls[2];
    expect(sql).toMatch(/AS online_riders/);
    expect(sql).toMatch(/AS active_orders/);
    expect(sql).toMatch(/AS capacity_multiplier/);
    expect(sql).toMatch(/r\.area_id = \?/);
    expect(sql).toMatch(/o\.area_id = \?/);
    expect(sql).toMatch(/s\.area_id = \?/);
    expect(sql).toMatch(/created_at > NOW\(\) - INTERVAL \? MINUTE/);
    expect(params).toEqual([1, 1, ACTIVE_ORDER_STATUSES, config.RIDER_CAPACITY_LOOKBACK_MIN, 1]);
  });
});
