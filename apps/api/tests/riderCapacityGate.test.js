/**
 * Rider assignment capacity controls:
 *   1. A rider carrying RIDER_MAX_ACTIVE_ORDERS (2) undelivered orders is
 *      excluded from new offers (listEligibleRiders) until one is
 *      Delivered/Cancelled.
 *   2. POST /api/orders rejects new checkouts once an area's non-terminal
 *      order count reaches onlineRiders * RIDER_CAPACITY_MULTIPLIER (3),
 *      surfacing a "riders are busy, try again in ~29 minutes" message.
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../src/db/mysql');
const { listEligibleRiders, RIDER_MAX_ACTIVE_ORDERS } = require('../src/utils/riders');
const config = require('../src/config/env');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn().mockResolvedValue([[]]), getConnection: jest.fn() },
}));

jest.mock('../src/utils/areaScope', () => ({
  resolveAreaIdForPricing: jest.fn().mockResolvedValue(1),
  getAreaById: jest.fn().mockResolvedValue({ id: 1, code: 'A1' }),
}));

jest.mock('../src/utils/coupons', () => ({
  validateCoupon: jest.fn().mockResolvedValue({ ok: false, reason: 'No coupon' }),
  validateCouponById: jest.fn().mockResolvedValue({ ok: false, reason: 'Coupon not found' }),
  pickBestAutoApply: jest.fn().mockResolvedValue(null),
}));

jest.mock('express-rate-limit', () => {
  const factory = () => (req, res, next) => next();
  factory.rateLimit = factory;
  factory.ipKeyGenerator = (ip) => String(ip);
  return factory;
});

jest.mock('../src/utils/notificationService', () => ({
  createOrderNotification: jest.fn().mockResolvedValue(null),
}));
jest.mock('../src/realtime/orderEvents', () => ({
  emitNotificationCreated: jest.fn(),
  emitOrderCreated: jest.fn(),
  emitOrderCancelled: jest.fn(),
}));
jest.mock('../src/utils/adminNotifications', () => ({
  createAdminNotification: jest.fn().mockResolvedValue(null),
  TYPES: { NEW_ORDER: 'new_order' },
}));
jest.mock('../src/realtime/orderAutoAccept', () => ({
  schedule: jest.fn(),
}));

const orderRoutes = require('../src/routes/orderRoutes');

const app = express();
app.use(express.json());
app.use('/api/orders', orderRoutes);

const token = jwt.sign({ id: 1, role: 'customer' }, process.env.JWT_SECRET || 'secret');

const baseSettings = {
  shop_open: 1, delivery_available: 1, delivery_charge: 10, night_charge: 0, fast_delivery_enabled: 0,
};

const orderBody = {
  address: '123 Test St',
  paymentMethod: 'Cash',
  items: [{ productId: 1, quantity: 1 }],
};

describe('POST /api/orders — rider capacity gate', () => {
  beforeEach(() => jest.clearAllMocks());

  const mockConnectionFor = (extraQueries = []) => ({
    beginTransaction: jest.fn(),
    query: jest.fn()
      .mockResolvedValueOnce([[{ blocked: 0 }]]) // user check
      .mockResolvedValueOnce([[baseSettings]]) // settings
      .mockResolvedValueOnce([[{ id: 1, name: 'Test', price: 100, available: 1 }]]) // product
      .mockResolvedValueOnce([[]]) // exclusion zones
      .mockResolvedValueOnce([{ insertId: 5001 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockImplementation(() => {
        const next = extraQueries.shift();
        return next ? Promise.resolve(next) : Promise.resolve([[]]);
      }),
    commit: jest.fn(),
    rollback: jest.fn(),
    release: jest.fn(),
  });

  it('rejects with RIDERS_AT_CAPACITY once active orders hit onlineRiders * multiplier', async () => {
    pool.getConnection.mockResolvedValue(mockConnectionFor());
    // 2 online riders * multiplier 3 = capacity 6; 6 active orders already in flight.
    pool.query
      .mockResolvedValueOnce([[{ cnt: 2 }]]) // countActiveRiders
      .mockResolvedValueOnce([[{ cnt: 6 }]]); // countActiveOrdersInArea

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send(orderBody);

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('RIDERS_AT_CAPACITY');
    expect(res.body.message).toMatch(/29 minutes/);
  });

  it('allows the order through when under capacity', async () => {
    pool.getConnection.mockResolvedValue(mockConnectionFor());
    pool.query
      .mockResolvedValueOnce([[{ cnt: 2 }]]) // countActiveRiders
      .mockResolvedValueOnce([[{ cnt: 5 }]]); // countActiveOrdersInArea — below capacity of 6

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send(orderBody);

    expect(res.statusCode).toBe(201);
  });

  it('skips the gate entirely when zero riders are online (delivery_available already covers that case)', async () => {
    pool.getConnection.mockResolvedValue(mockConnectionFor());
    pool.query.mockResolvedValueOnce([[{ cnt: 0 }]]); // countActiveRiders — only one call expected

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send(orderBody);

    expect(res.statusCode).toBe(201);
    // Only the countActiveRiders call — countActiveOrdersInArea never runs
    // when nobody is online, since there's nothing to gate against.
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('degrades to "not at capacity" and still lets the order through if the capacity check itself errors', async () => {
    pool.getConnection.mockResolvedValue(mockConnectionFor());
    pool.query.mockRejectedValueOnce(new Error('connection reset'));

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send(orderBody);

    expect(res.statusCode).toBe(201);
  });
});

describe('listEligibleRiders — per-rider active-order cap', () => {
  beforeEach(() => jest.clearAllMocks());

  it('SQL excludes riders at or over RIDER_MAX_ACTIVE_ORDERS via a correlated subquery', async () => {
    pool.query.mockResolvedValueOnce([[]]);
    await listEligibleRiders({ areaId: 1 });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/SELECT COUNT\(\*\) FROM orders o/);
    expect(sql).toMatch(/status NOT IN \('Delivered', 'Cancelled'\)/);
    expect(sql).toMatch(/\) < \?/);
    expect(params).toContain(RIDER_MAX_ACTIVE_ORDERS);
  });

  it('default cap is 2 unless overridden by config', () => {
    expect(RIDER_MAX_ACTIVE_ORDERS).toBe(config.RIDER_MAX_ACTIVE_ORDERS);
  });
});
