/**
 * Tests for the shop-owner API (SHOP TASK 7) - /api/shop/*.
 *
 * Strategy (follows adminValidation.test.js / shopsAdmin.test.js): mock the
 * mysql pool + the realtime socket emitter, mount the real shopRoutes on an
 * express app, and drive it with supertest using a customer JWT (role:
 * 'customer'). requireCustomer skips its DB blocked-check in NODE_ENV=test, so
 * only requireShopOwner's shops lookup consumes a mock response.
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const shopRoutes = require('../src/routes/shopRoutes');
const { pool } = require('../src/db/mysql');
const { emitToAdmins } = require('../src/realtime/socket');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn(), getConnection: jest.fn() },
}));
jest.mock('../src/realtime/socket', () => ({
  emitToAdmins: jest.fn(),
  emitToCustomer: jest.fn(),
}));

const app = express();
app.use(express.json());
app.use('/api/shop', shopRoutes);

const customerToken = (id = 7) => jwt.sign(
  { id, role: 'customer' },
  process.env.JWT_SECRET || 'test_jwt_secret_that_is_long_enough'
);

const SHOP_ROW = [{ id: 1, name: 'Burger Point', is_open: 1, active: 1 }];

describe('Shop-owner API - /api/shop', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("non-owner customer -> 403 FORBIDDEN", async () => {
    // requireShopOwner finds no active shop for this user.
    pool.query.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .get('/api/shop/me')
      .set('Authorization', `Bearer ${customerToken(99)}`);

    expect(res.statusCode).toEqual(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(res.body.message).toBe('Not a shop owner');
  });

  it("owner toggling another shop's product -> 404", async () => {
    pool.query
      .mockResolvedValueOnce([SHOP_ROW])        // requireShopOwner lookup
      .mockResolvedValueOnce([{ affectedRows: 0 }]); // UPDATE scoped to shop_id=1 -> 0 rows

    const res = await request(app)
      .patch('/api/shop/products/55/toggle')
      .set('Authorization', `Bearer ${customerToken(7)}`)
      .send({ available: false });

    expect(res.statusCode).toEqual(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it("getMyOrders excludes Pending/Delivered orders and other shops' items", async () => {
    pool.query
      .mockResolvedValueOnce([SHOP_ROW]) // requireShopOwner lookup
      // orders query: SQL filters status IN ('Accepted','Preparing') + shop_id,
      // so the mock returns only an Accepted + a Preparing order (no Pending/Delivered).
      .mockResolvedValueOnce([[
        { id: 10, order_number: 'ORD-10', status: 'Accepted', note: 'extra onions', created_at: '2026-07-09 10:00:00', delivery_type: 'standard' },
        { id: 11, order_number: 'ORD-11', status: 'Preparing', note: null, created_at: '2026-07-09 10:05:00', delivery_type: 'fast' },
      ]])
      // settings query: delivery-time minutes used to compute expectedMinutes.
      .mockResolvedValueOnce([[{ standard_delivery_minutes: 55, fast_delivery_minutes: 20 }]])
      // items query: SQL filters shop_id = 1, so only this shop's items are returned
      // (no other-shop items, no prices, no customer PII).
      .mockResolvedValueOnce([[
        { id: 101, order_id: 10, product_name: 'Burger', quantity: 2, variant_label: 'Double', shop_confirmed_at: null, shop_rejected_at: null },
        { id: 102, order_id: 10, product_name: 'Fries', quantity: 1, variant_label: null, shop_confirmed_at: '2026-07-09 10:01:00', shop_rejected_at: null },
        { id: 103, order_id: 11, product_name: 'Burger', quantity: 1, variant_label: 'Single', shop_confirmed_at: null, shop_rejected_at: null },
      ]]);

    const res = await request(app)
      .get('/api/shop/orders')
      .set('Authorization', `Bearer ${customerToken(7)}`);

    expect(res.statusCode).toEqual(200);
    const orders = res.body.orders;
    expect(orders).toHaveLength(2);
    // Only Accepted / Preparing statuses present.
    expect(orders.map(o => o.status).sort()).toEqual(['Accepted', 'Preparing']);
    // Each order has both casings of order_number + created_at.
    expect(orders[0].orderNumber).toBe('ORD-10');
    expect(orders[0].order_number).toBe('ORD-10');
    expect(orders[0].createdAt).toBeTruthy();
    expect(orders[0].created_at).toBeTruthy();
    // Items expose product name + qty + variant label only - no price/PII.
    const ord10 = orders.find(o => o.id === 10);
    expect(ord10.items).toHaveLength(2);
    expect(ord10.items[0]).toHaveProperty('productName', 'Burger');
    expect(ord10.items[0]).toHaveProperty('product_name', 'Burger');
    expect(ord10.items[0]).toHaveProperty('quantity', 2);
    expect(ord10.items[0]).toHaveProperty('variantLabel', 'Double');
    expect(ord10.items[0]).not.toHaveProperty('unit_price');
    expect(ord10.items[0]).not.toHaveProperty('line_total');
    // confirmed = all my items have shop_confirmed_at. ORD-10 has one unconfirmed -> false.
    expect(ord10.confirmed).toBe(false);
    expect(ord10.rejected).toBe(false);
    // expectedMinutes keyed by delivery_type: standard -> 55, fast -> 20.
    expect(ord10.expectedMinutes).toBe(55);
    const ord11 = orders.find(o => o.id === 11);
    expect(ord11.expectedMinutes).toBe(20);
    // No other-shop items leaked in (mock only returned shop 1 items).
    expect(orders.flatMap(o => o.items).every(it => it.productName !== 'Pizza')).toBe(true);
  });

  it('GET /orders/history returns every status, most recent first, no expectedMinutes', async () => {
    pool.query
      .mockResolvedValueOnce([SHOP_ROW]) // requireShopOwner lookup
      .mockResolvedValueOnce([[
        { id: 20, order_number: 'ORD-20', status: 'Delivered', note: null, created_at: '2026-07-10 09:00:00', delivery_type: 'standard' },
        { id: 21, order_number: 'ORD-21', status: 'Cancelled', note: null, created_at: '2026-07-09 12:00:00', delivery_type: 'fast' },
      ]])
      .mockResolvedValueOnce([[{ total: 0 }]]) // payout SUM query (no shop_line_total set on these fixtures)
      .mockResolvedValueOnce([[
        { id: 201, order_id: 20, product_name: 'Burger', quantity: 1, variant_label: null, shop_confirmed_at: '2026-07-10 09:01:00', shop_rejected_at: null },
        { id: 211, order_id: 21, product_name: 'Fries', quantity: 2, variant_label: null, shop_confirmed_at: null, shop_rejected_at: '2026-07-09 12:01:00' },
      ]]);

    const res = await request(app)
      .get('/api/shop/orders/history')
      .set('Authorization', `Bearer ${customerToken(7)}`);

    expect(res.statusCode).toEqual(200);
    const orders = res.body.orders;
    expect(orders).toHaveLength(2);
    expect(orders.map(o => o.status)).toEqual(['Delivered', 'Cancelled']);
    // History includes terminal statuses getMyOrders never returns.
    const delivered = orders.find(o => o.id === 20);
    expect(delivered.confirmed).toBe(true);
    const cancelled = orders.find(o => o.id === 21);
    expect(cancelled.rejected).toBe(true);
    // No expectedMinutes in the history payload (that's a live-queue-only field).
    expect(delivered).not.toHaveProperty('expectedMinutes');
  });

  it('GET /orders/history payableTotal only counts Delivered orders, summed independently of the 100-row page', async () => {
    pool.query
      .mockResolvedValueOnce([SHOP_ROW]) // requireShopOwner lookup
      .mockResolvedValueOnce([[
        { id: 30, order_number: 'ORD-30', status: 'Delivered', note: null, created_at: '2026-07-10 09:00:00', delivery_type: 'standard' },
        { id: 31, order_number: 'ORD-31', status: 'Preparing', note: null, created_at: '2026-07-10 10:00:00', delivery_type: 'standard' },
      ]])
      // Payout SUM query is independent of the (possibly truncated) page above —
      // simulate a shop with far more than 100 Delivered orders that day.
      .mockResolvedValueOnce([[{ total: 12345.678 }]])
      .mockResolvedValueOnce([[
        { id: 301, order_id: 30, product_name: 'Burger', quantity: 1, variant_label: null, shop_line_total: 58.01, shop_confirmed_at: '2026-07-10 09:01:00', shop_rejected_at: null },
        { id: 311, order_id: 31, product_name: 'Fries', quantity: 1, variant_label: null, shop_line_total: 500, shop_confirmed_at: '2026-07-10 10:01:00', shop_rejected_at: null },
      ]]);

    const res = await request(app)
      .get('/api/shop/orders/history')
      .set('Authorization', `Bearer ${customerToken(7)}`);

    expect(res.statusCode).toEqual(200);
    // Reflects the SUM query result, not a fold over the 2 fetched orders
    // (which would wrongly include the still-Preparing order's ₹500 and/or
    // wrongly cap at what's visible on the page).
    expect(res.body.payableTotal).toEqual(12345.68);
    expect(res.body.payable_total).toEqual(12345.68);
    // Per-order shopTotal is still shown (and rounded) even though it's not
    // in the payout yet.
    const preparing = res.body.orders.find(o => o.id === 31);
    expect(preparing.shopTotal).toEqual(500);
  });

  it('GET /orders/history returns empty array when the shop has no orders', async () => {
    pool.query
      .mockResolvedValueOnce([SHOP_ROW]) // requireShopOwner lookup
      .mockResolvedValueOnce([[]])        // orders query -> none
      .mockResolvedValueOnce([[{ total: 0 }]]); // payout SUM query

    const res = await request(app)
      .get('/api/shop/orders/history')
      .set('Authorization', `Bearer ${customerToken(7)}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.orders).toEqual([]);
  });

  it('GET /orders/history -> 400 on a malformed date instead of silently returning an empty day', async () => {
    pool.query.mockResolvedValueOnce([SHOP_ROW]); // requireShopOwner lookup

    const res = await request(app)
      .get('/api/shop/orders/history?date=30-07-2026')
      .set('Authorization', `Bearer ${customerToken(7)}`);

    expect(res.statusCode).toEqual(400);
    expect(res.body.code).toEqual('VALIDATION_ERROR');
  });

  it('GET /orders/history payableTotal is scoped to the same created_at day as the orders list', async () => {
    // Payout and orders both key off created_at now, so an empty orders day
    // must also show a zero payout — no cross-day (delivered_at) leakage.
    pool.query
      .mockResolvedValueOnce([SHOP_ROW]) // requireShopOwner lookup
      .mockResolvedValueOnce([[]])        // orders query (created_at = today) -> none
      .mockResolvedValueOnce([[{ total: 0 }]]); // payout SUM query (created_at = today)

    const res = await request(app)
      .get('/api/shop/orders/history?date=2026-07-30')
      .set('Authorization', `Bearer ${customerToken(7)}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.orders).toEqual([]);
    expect(res.body.payableTotal).toEqual(0);
  });

  it('confirmMyOrder is idempotent - second call still 200, no error', async () => {
    // First confirm: COUNT > 0, UPDATE confirms 2 rows.
    pool.query
      .mockResolvedValueOnce([SHOP_ROW])             // requireShopOwner lookup
      .mockResolvedValueOnce([[{ cnt: 2, area_id: 1 }]])           // COUNT items for this shop
      .mockResolvedValueOnce([{ affectedRows: 2 }]); // UPDATE (2 newly confirmed)

    const res1 = await request(app)
      .patch('/api/shop/orders/10/confirm')
      .set('Authorization', `Bearer ${customerToken(7)}`);

    expect(res1.statusCode).toEqual(200);
    expect(res1.body.message).toBe('Order confirmed');
    expect(emitToAdmins).toHaveBeenCalledWith(
      1,
      'admin.order.shop_confirmed',
      expect.objectContaining({ orderId: 10, shopId: 1, shopName: 'Burger Point' })
    );

    // Second confirm: same COUNT (items still exist), but UPDATE matches 0 rows
    // because shop_confirmed_at IS NULL no longer matches (already confirmed).
    // The handler still returns 200 - idempotent. The SQL's IS NULL guard is
    // what keeps timestamps unchanged on repeat calls.
    pool.query
      .mockResolvedValueOnce([SHOP_ROW])             // requireShopOwner lookup
      .mockResolvedValueOnce([[{ cnt: 2 }]])           // COUNT items (still present)
      .mockResolvedValueOnce([{ affectedRows: 0 }]); // UPDATE (0 newly confirmed - idempotent)

    const res2 = await request(app)
      .patch('/api/shop/orders/10/confirm')
      .set('Authorization', `Bearer ${customerToken(7)}`);

    expect(res2.statusCode).toEqual(200);
    expect(res2.body.message).toBe('Order confirmed');
  });

  it("confirmMyOrder -> 404 when the order has none of this shop's items", async () => {
    pool.query
      .mockResolvedValueOnce([SHOP_ROW])   // requireShopOwner lookup
      .mockResolvedValueOnce([[{ cnt: 0 }]]); // COUNT -> no items for this shop

    const res = await request(app)
      .patch('/api/shop/orders/999/confirm')
      .set('Authorization', `Bearer ${customerToken(7)}`);

    expect(res.statusCode).toEqual(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('rejectMyOrder is idempotent - second call still 200', async () => {
    pool.query
      .mockResolvedValueOnce([SHOP_ROW])             // requireShopOwner lookup
      .mockResolvedValueOnce([[{ cnt: 1 }]])           // COUNT items for this shop
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE (1 newly rejected)

    const res1 = await request(app)
      .patch('/api/shop/orders/10/reject')
      .set('Authorization', `Bearer ${customerToken(7)}`);

    expect(res1.statusCode).toEqual(200);
    expect(res1.body.message).toBe('Order rejected');

    pool.query
      .mockResolvedValueOnce([SHOP_ROW])             // requireShopOwner lookup
      .mockResolvedValueOnce([[{ cnt: 1 }]])           // COUNT (still present)
      .mockResolvedValueOnce([{ affectedRows: 0 }]); // UPDATE (0 newly rejected - idempotent)

    const res2 = await request(app)
      .patch('/api/shop/orders/10/reject')
      .set('Authorization', `Bearer ${customerToken(7)}`);

    expect(res2.statusCode).toEqual(200);
    expect(res2.body.message).toBe('Order rejected');
  });

  it("rejectMyOrder -> 404 when the order has none of this shop's items", async () => {
    pool.query
      .mockResolvedValueOnce([SHOP_ROW])   // requireShopOwner lookup
      .mockResolvedValueOnce([[{ cnt: 0 }]]); // COUNT -> no items for this shop

    const res = await request(app)
      .patch('/api/shop/orders/999/reject')
      .set('Authorization', `Bearer ${customerToken(7)}`);

    expect(res.statusCode).toEqual(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  describe('POST /orders/:orderId/alert-ack', () => {
    it('acks the alarm and reports acked: true on first call', async () => {
      pool.query
        .mockResolvedValueOnce([SHOP_ROW])              // requireShopOwner lookup
        .mockResolvedValueOnce([{ affectedRows: 1 }]);  // UPDATE shop_alert_acked_at

      const res = await request(app)
        .post('/api/shop/orders/10/alert-ack')
        .set('Authorization', `Bearer ${customerToken(7)}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body).toEqual({ acked: true });
      expect(pool.query).toHaveBeenLastCalledWith(
        expect.stringMatching(/UPDATE order_items SET shop_alert_acked_at = NOW/),
        ['10', 1]
      );
    });

    it('is idempotent - second ack reports acked: false, never errors', async () => {
      pool.query
        .mockResolvedValueOnce([SHOP_ROW])
        .mockResolvedValueOnce([{ affectedRows: 0 }]); // already acked / confirmed / rejected

      const res = await request(app)
        .post('/api/shop/orders/10/alert-ack')
        .set('Authorization', `Bearer ${customerToken(7)}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body).toEqual({ acked: false });
    });

    it("non-owner customer -> 403 (never touches order_items)", async () => {
      pool.query.mockResolvedValueOnce([[]]); // requireShopOwner finds no shop

      const res = await request(app)
        .post('/api/shop/orders/10/alert-ack')
        .set('Authorization', `Bearer ${customerToken(99)}`);

      expect(res.statusCode).toEqual(403);
      expect(pool.query).toHaveBeenCalledTimes(1);
    });
  });
});
