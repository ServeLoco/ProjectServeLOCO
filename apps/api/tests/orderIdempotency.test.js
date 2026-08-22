const request = require('supertest');
const express = require('express');
const orderRoutes = require('../src/routes/orderRoutes');
const { pool } = require('../src/db/mysql');
const jwt = require('jsonwebtoken');

jest.mock('../src/db/mysql', () => ({
  pool: {
    query: jest.fn().mockResolvedValue([[]]),
    getConnection: jest.fn(),
  },
}));


jest.mock("../src/utils/coupons", () => ({
  validateCoupon: jest.fn().mockResolvedValue({ ok: false, reason: "No coupon" }),
  pickBestAutoApply: jest.fn().mockResolvedValue(null),
  findApplicableCoupons: jest.fn().mockResolvedValue([]),
  computeDiscount: jest.fn().mockReturnValue(0),
  checkEligibility: jest.fn().mockResolvedValue({ ok: false, reason: "No coupon" }),
}));

// The order route carries a per-user rate limiter (TASK 7, max 5/min). This
// file's race-safety test fires two concurrent POSTs from the same user
// back-to-back with the four earlier tests, which trips the cap. Mock the
// limiter as a pass-through here so idempotency behaviour is tested in
// isolation; the limiter stays active in production and in the other test
// files that stay under the cap.
// Supports both default and named ({ rateLimit, ipKeyGenerator }) imports.
jest.mock('express-rate-limit', () => {
  const factory = () => (req, res, next) => next();
  factory.rateLimit = factory;
  factory.ipKeyGenerator = (ip) => String(ip);
  return factory;
});

// Fire-and-forget side effects (notifications, realtime events, auto-accept)
// would otherwise consume pool.query mocks that the race test's catch path
// relies on. Mock them as no-ops so each request's pool.query mocks stay
// isolated to its own controller path.
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
const app = express();
app.use(express.json());
app.use('/api/orders', orderRoutes);

const token = jwt.sign({ id: 1, role: 'customer' }, process.env.JWT_SECRET || 'secret');

describe('Order idempotency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the same order on a second request with the same Idempotency-Key', async () => {
    // The idempotency lookup now runs INSIDE the transaction with
    // SELECT ... FOR UPDATE so concurrent requests serialize. The lookup
    // uses the connection (not pool.query directly).
    const mockConnection = {
      beginTransaction: jest.fn(),
      query: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    pool.getConnection.mockResolvedValue(mockConnection);

    // 1. Idempotency lookup (FOR UPDATE) — row found.
    // 2. order_items lookup so the replay returns full details.
    // 3. coupon snapshot lookup (coupon_id/code/title/discount on orders).
    mockConnection.query
      .mockResolvedValueOnce([[{
        id: 501,
        order_number: 'OD-EXISTING',
        idempotency_key_created_at: new Date(),
        subtotal: 80,
        total: 80,
        status: 'Pending',
        payment_status: 'Pending',
        age_seconds: 30,
      }]])
      .mockResolvedValueOnce([[{
        product_id: 1,
        item_type: 'product',
        product_name: 'Samosa',
        quantity: 2,
        unit_price: 20,
        line_total: 40,
      }]])
      .mockResolvedValueOnce([[{
        coupon_id: null,
        coupon_code: null,
        coupon_title: null,
        discount_amount: 0,
      }]]);

    const idempotencyKey = 'idem-test-abc-123';

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', idempotencyKey)
      .send({
        address: '123 Test St',
        paymentMethod: 'Cash',
        items: [{ productId: 1, quantity: 1 }],
      });

    if (res.statusCode === 500) console.log('DEBUG 500 body:', JSON.stringify(res.body));
    expect(res.statusCode).toBe(200);
    expect(res.body.idempotent).toBe(true);
    expect(res.body.orderId).toBe(501);
    expect(res.body.orderNumber).toBe('OD-EXISTING');
    // Replay must include full order items (Fix #4) so the confirmation
    // screen can render properly.
    expect(Array.isArray(res.body.order.items)).toBe(true);
    expect(res.body.order.items.length).toBe(1);
    expect(res.body.order.items[0].name).toBe('Samosa');
    // No INSERT should have been issued.
    const insertCalls = mockConnection.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && /INSERT INTO orders/i.test(sql)
    );
    expect(insertCalls.length).toBe(0);
    // Connection must be released cleanly.
    expect(mockConnection.release).toHaveBeenCalledTimes(1);
  });

  it('proceeds with normal order creation when no Idempotency-Key is provided', async () => {
    const mockConnection = {
      beginTransaction: jest.fn(),
      query: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    pool.getConnection.mockResolvedValue(mockConnection);

    mockConnection.query
      .mockResolvedValueOnce([[{ blocked: 0 }]])
      .mockResolvedValueOnce([[{
        shop_open: 1,
        delivery_available: 1,
        delivery_charge: 0,
      }]])
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test' }]])
      .mockResolvedValueOnce([[]]) // exclusion zones
      .mockResolvedValueOnce([{ insertId: 999 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: '123 Test St',
        paymentMethod: 'Cash',
        items: [{ productId: 1, quantity: 1 }],
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.idempotent).toBeUndefined();
    expect(res.body.orderId).toBe(999);
  });

  it('ignores the Idempotency-Key when an expired (>5min) key is reused', async () => {
    // First query (idempotency lookup inside the transaction) returns
    // empty — key is older than 5 minutes, so the controller proceeds
    // with normal creation.
    const mockConnection = {
      beginTransaction: jest.fn(),
      query: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    pool.getConnection.mockResolvedValue(mockConnection);

    // The controller inside a transaction runs:
    //  0. idempotency lookup (empty — expired)
    //  1. user lookup (returns user)
    //  2. settings lookup
    //  3. product query
    //  4. order INSERT
    //  5. order_items INSERT
    mockConnection.query
      .mockResolvedValueOnce([[]]) // expired idempotency lookup
      .mockResolvedValueOnce([[{
        id: 1, name: 'Test', phone: '123', whatsapp_number: '123', blocked: 0, address: 'Addr'
      }]])
      .mockResolvedValueOnce([[{
        shop_open: 1,
        delivery_available: 1,
        delivery_charge: 10,
        night_charge: 0,
        shop_latitude: 12.9716,
        shop_longitude: 77.5946,
        delivery_radius_km: 8,
        delivery_cost_per_km: 5
      }]])
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test' }]])
      .mockResolvedValueOnce([[]]) // exclusion zones
      .mockResolvedValueOnce([{ insertId: 777 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'idem-old-key-123')
      .send({
        address: '123 Test St',
        paymentMethod: 'Cash',
        items: [{ productId: 1, quantity: 1 }],
      });

    if (res.statusCode === 500) console.log('DEBUG 500 body:', JSON.stringify(res.body));
    expect(res.statusCode).toBe(201);
    expect(res.body.idempotent).toBeUndefined();
    expect(res.body.orderId).toBe(777);
  });

  it('uses SELECT ... FOR UPDATE so concurrent requests serialize (race safety)', async () => {
    // Simulate two concurrent requests with the same Idempotency-Key.
    // Both should serialize through the transaction. The first wins
    // (creates the order); the second sees the first's row and returns
    // it as an idempotent replay.
    const mockConnection = {
      beginTransaction: jest.fn(),
      query: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    pool.getConnection.mockResolvedValue(mockConnection);

    // Request 1: idempotency lookup (empty), user, settings, product,
    // INSERT, INSERT items.
    // Request 2 would hit the same connection mock — the second
    // invocation of the test path would see a row inserted by request 1.
    // For this test we just verify the SQL uses FOR UPDATE.
    mockConnection.query.mockResolvedValueOnce([[]]); // expired/not found
    mockConnection.query.mockResolvedValueOnce([[{
      id: 1, name: 'Test', phone: '123', whatsapp_number: '123', blocked: 0, address: 'Addr'
    }]]);
    mockConnection.query.mockResolvedValueOnce([[{
      shop_open: 1, delivery_available: 1,
      delivery_charge: 10, night_charge: 0,
      shop_latitude: 12.97, shop_longitude: 77.59,
      delivery_radius_km: 8, delivery_cost_per_km: 5
    }]]);
    mockConnection.query.mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test' }]]);
    mockConnection.query.mockResolvedValueOnce([[]]); // exclusion zones
    mockConnection.query.mockResolvedValueOnce([{ insertId: 888 }]);
    mockConnection.query.mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'idem-race-test-456')
      .send({
        address: '456 Race St',
        paymentMethod: 'Cash',
        items: [{ productId: 1, quantity: 1 }],
      });

    // We don't assert status (depends on whether the race-resolution
    // path returned 201 or 200) — we assert the SQL contract: the very
    // first query on the connection must use FOR UPDATE so concurrent
    // attempts serialize.
    expect(res.statusCode).toBe(201);
    const firstCall = mockConnection.query.mock.calls[0];
    expect(firstCall[0]).toMatch(/FOR UPDATE/);
  });

  it('returns real subtotal/total/status/payment_status on replay when the order has advanced', async () => {
    // TASK 10.4: replay must not hardcode subtotal/total/status to placeholders.
    // Simulate the case where the original order was created, then later the
    // customer retried (or the network re-played) the request after the
    // order had already moved to Accepted/Paid.
    const mockConnection = {
      beginTransaction: jest.fn(),
      query: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    pool.getConnection.mockResolvedValue(mockConnection);

    // Pre-check now SELECTs subtotal, total, status, payment_status.
    mockConnection.query
      .mockResolvedValueOnce([[{
        id: 777,
        order_number: 'OD-ACCEPTED',
        idempotency_key_created_at: new Date('2026-07-04T10:00:00Z'),
        subtotal: 300,
        total: 280,
        status: 'Accepted',
        payment_status: 'Paid',
        age_seconds: 600,
      }]])
      .mockResolvedValueOnce([[{
        product_id: 1,
        item_type: 'product',
        product_name: 'Pizza',
        quantity: 1,
        unit_price: 300,
        line_total: 300,
      }]])
      .mockResolvedValueOnce([[{
        coupon_id: 11,
        coupon_code: 'SAVE20',
        coupon_title: '20 off',
        discount_amount: 20,
      }]]);

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'idem-accepted-123')
      .send({
        address: '123 Test St',
        paymentMethod: 'UPI',
        items: [{ productId: 1, quantity: 1 }],
      });

    if (res.statusCode === 500) console.log('DEBUG 500 body:', JSON.stringify(res.body));
    expect(res.statusCode).toBe(200);
    expect(res.body.idempotent).toBe(true);
    expect(res.body.orderId).toBe(777);
    // Real values from the row, NOT the placeholder nulls/'Pending'.
    expect(res.body.order.subtotal).toBe(300);
    expect(res.body.order.total).toBe(280);
    expect(res.body.order.status).toBe('Accepted');
    expect(res.body.order.paymentStatus).toBe('Paid');
    expect(res.body.order.payment_status).toBe('Paid');
    // Discount comes from the coupon snapshot, not the orders subtotal row.
    expect(res.body.order.discount).toBe(20);
  });

  it('converts ER_DUP_ENTRY on the unique idempotency index into a replay (two racing submissions → one order)', async () => {
    // TASK 10.3: two simultaneous requests with the same Idempotency-Key
    // both pass the pre-check (the lookup is inside the transaction with
    // FOR UPDATE, but the second one arrives before the first commits).
    // The unique index on (customer_id, idempotency_key) makes only one
    // INSERT succeed; the loser's INSERT fails with ER_DUP_ENTRY naming
    // 'idx_orders_idempotency'. The controller catches that specific
    // error, rolls back, re-fetches the winner's order via pool.query,
    // and returns it as an idempotent replay.
    const winner = {
      beginTransaction: jest.fn(),
      query: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    const loser = {
      beginTransaction: jest.fn(),
      query: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    pool.getConnection
      .mockResolvedValueOnce(winner)
      .mockResolvedValueOnce(loser);

    // Winner: pre-check empty, user, settings, product, INSERT, items INSERT.
    winner.query
      .mockResolvedValueOnce([[]]) // empty pre-check
      .mockResolvedValueOnce([[{
        id: 1, name: 'Test', phone: '123', whatsapp_number: '123', blocked: 0, address: 'Addr'
      }]])
      .mockResolvedValueOnce([[{
        shop_open: 1, delivery_available: 1,
        delivery_charge: 10, night_charge: 0,
      }]])
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test' }]])
      .mockResolvedValueOnce([[]]) // exclusion zones
      .mockResolvedValueOnce([{ insertId: 999 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    // Loser: same path, but INSERT throws ER_DUP_ENTRY on idx_orders_idempotency.
    loser.query
      .mockResolvedValueOnce([[]]) // pre-check empty (race not visible yet)
      .mockResolvedValueOnce([[{
        id: 1, name: 'Test', phone: '123', whatsapp_number: '123', blocked: 0, address: 'Addr'
      }]])
      .mockResolvedValueOnce([[{
        shop_open: 1, delivery_available: 1,
        delivery_charge: 10, night_charge: 0,
      }]])
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test' }]])
      .mockResolvedValueOnce([[]]); // exclusion zones
    const dupErr = new Error("Duplicate entry '1-idem-race-001' for key 'orders.idx_orders_idempotency'");
    dupErr.code = 'ER_DUP_ENTRY';
    dupErr.errno = 1062;
    loser.query.mockRejectedValueOnce(dupErr);

    // Both requests hit the capacity gate's countActiveRiders check via
    // pool.query before their transaction even opens; 0 online riders skips
    // the gate (no second countActiveOrdersInArea call) for either.
    pool.query
      .mockResolvedValueOnce([[{ cnt: 0 }]]) // winner's countActiveRiders
      .mockResolvedValueOnce([[{ cnt: 0 }]]); // loser's countActiveRiders

    // After rollback+release, the controller fetches via pool.query.
    pool.query
      .mockResolvedValueOnce([[{
        id: 999,
        order_number: 'OD-WINNER',
        idempotency_key_created_at: new Date(),
        subtotal: 100,
        total: 110,
        status: 'Pending',
        payment_status: 'Pending',
      }]])
      .mockResolvedValueOnce([[{
        product_id: 1,
        item_type: 'product',
        product_name: 'Test',
        quantity: 1,
        unit_price: 100,
        line_total: 100,
      }]])
      .mockResolvedValueOnce([[{
        coupon_id: null,
        coupon_code: null,
        coupon_title: null,
        discount_amount: 0,
      }]]);

    const payload = {
      address: '456 Race St',
      paymentMethod: 'Cash',
      items: [{ productId: 1, quantity: 1 }],
    };
    const headers = {
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': 'idem-race-001',
    };

    const [resWinner, resLoser] = await Promise.all([
      request(app).post('/api/orders').set(headers).send(payload),
      request(app).post('/api/orders').set(headers).send(payload),
    ]);

    // Winner: fresh order, status 201.
    expect(resWinner.statusCode).toBe(201);
    expect(resWinner.body.orderId).toBe(999);
    expect(resWinner.body.idempotent).toBeUndefined();

    // Loser: caught the unique-index violation and returned a replay
    // pointing at the winner's order.
    expect(resLoser.statusCode).toBe(200);
    expect(resLoser.body.idempotent).toBe(true);
    expect(resLoser.body.orderId).toBe(999);
    expect(resLoser.body.orderNumber).toBe('OD-WINNER');
    expect(resLoser.body.order.subtotal).toBe(100);
    expect(resLoser.body.order.total).toBe(110);

    // Each connection attempted exactly one orders INSERT. The DB unique
    // index means only one of those rows actually exists; the loser saw
    // the constraint violation instead of inserting a duplicate.
    const winnerInserts = winner.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && /INSERT INTO orders/i.test(sql)
    );
    const loserInserts = loser.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && /INSERT INTO orders/i.test(sql)
    );
    expect(winnerInserts.length).toBe(1);
    expect(loserInserts.length).toBe(1);

    // Loser must have rolled back AND released its connection (no leaked tx).
    expect(loser.rollback).toHaveBeenCalledTimes(1);
    expect(loser.release).toHaveBeenCalledTimes(1);
    // Winner commits normally.
    expect(winner.commit).toHaveBeenCalledTimes(1);
    expect(winner.release).toHaveBeenCalledTimes(1);
  });
});
