const request = require('supertest');
const express = require('express');
const adminRoutes = require('../src/routes/adminRoutes');
const authRoutes = require('../src/routes/authRoutes');
const orderRoutes = require('../src/routes/orderRoutes');
const { pool } = require('../src/db/mysql');
const jwt = require('jsonwebtoken');

jest.mock('../src/db/mysql', () => ({
  pool: {
    query: jest.fn(),
    getConnection: jest.fn()
  }
}));

jest.mock('../src/db/mongodb', () => {
  const insertOne = jest.fn(() => Promise.resolve());
  return {
    __mockInsertOne: insertOne,
    getDb: jest.fn(() => ({
      collection: jest.fn(() => ({ insertOne }))
    }))
  };
});

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/orders', orderRoutes);

const adminToken = jwt.sign({ id: 'admin', role: 'admin', adminRole: 'area_admin', areaId: 1 }, process.env.JWT_SECRET || 'secret');
const customerToken = jwt.sign({ id: 1, role: 'customer' }, process.env.JWT_SECRET || 'secret');

describe('Order Cancellation and Admin Action Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should allow customer to cancel a pending order', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1001, status: 'Pending', customer_id: 1 }]]) // check order
      .mockResolvedValueOnce([{}]); // update order

    const res = await request(app)
      .patch('/api/orders/1001/cancel')
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.message).toContain('cancelled');
  });

  it('should not allow customer to cancel a preparing order', async () => {
    pool.query.mockResolvedValueOnce([[{ id: 1001, status: 'Preparing', customer_id: 1 }]]);

    const res = await request(app)
      .patch('/api/orders/1001/cancel')
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.statusCode).toEqual(400);
  });

  it('should update admin order status without runtime DDL', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1001, status: 'Pending', customer_id: 1 }]]) // check existing
      .mockResolvedValueOnce([{}]) // update
      .mockResolvedValueOnce([[{ id: 1001, status: 'Accepted', customer_id: 1 }]]); // return updated

    const res = await request(app)
      .patch('/api/admin/orders/1001/status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'Accepted' });

    expect(res.statusCode).toEqual(200);
    expect(res.body.order.status).toEqual('Accepted');
    
    // Ensure ALTER TABLE was not called
    pool.query.mock.calls.forEach(call => {
      expect(call[0]).not.toMatch(/ALTER TABLE/i);
    });
  });

  it('should block a customer', async () => {
    pool.query.mockResolvedValueOnce([{}]); // update block

    const res = await request(app)
      .put('/api/admin/customers/1/block')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ blocked: true });

    expect(res.statusCode).toEqual(200);
    expect(res.body.message).toContain('blocked');
  });

  it('should aggregate admin stats', async () => {
    pool.query
      .mockResolvedValueOnce([[{ totalSales: 500, totalOrders: 5, pendingOrders: 2 }]]) // orders stats
      .mockResolvedValueOnce([[{ totalProducts: 10 }]]) // products
      .mockResolvedValueOnce([[{ totalCustomers: 50 }]]) // customers
      .mockResolvedValueOnce([[{ totalCategories: 5 }]]); // categories

    const res = await request(app)
      .get('/api/admin/dashboard')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.data.sales.totalSales).toEqual(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// C1 — an admin cancel must release the order's coupon redemption (soft-
// cancel the row) so the customer's quota is restored, mirroring the
// customer-cancel path.
// ─────────────────────────────────────────────────────────────────────────

describe('Admin cancel releases coupon redemption', () => {
  let mockConnection;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnection = {
      beginTransaction: jest.fn(),
      query: jest.fn().mockResolvedValue([{ affectedRows: 1 }]),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    pool.getConnection.mockResolvedValue(mockConnection);
  });

  it('soft-cancels the redemption row when cancelling an order that used a coupon', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1001, status: 'Pending', customer_id: 1, payment_method: 'Cash', coupon_id: 31 }]]) // order lookup
      .mockResolvedValueOnce([[{ id: 1001, status: 'Cancelled', customer_id: 1, coupon_id: 31 }]]); // re-read updated order

    const res = await request(app)
      .patch('/api/admin/orders/1001/status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'Cancelled', cancel_reason: 'Out of stock' });

    expect(res.statusCode).toEqual(200);
    expect(res.body.order.status).toEqual('Cancelled');

    const softCancelCall = mockConnection.query.mock.calls.find(([sql]) =>
      /UPDATE coupon_redemptions SET status = 'cancelled'/i.test(String(sql)));
    expect(softCancelCall).toBeDefined();
    expect(softCancelCall[1]).toEqual(['1001', 31]);
    expect(mockConnection.commit).toHaveBeenCalled();
  });

  it('skips the redemption update when the cancelled order had no coupon', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1002, status: 'Pending', customer_id: 1, payment_method: 'Cash', coupon_id: null }]])
      .mockResolvedValueOnce([[{ id: 1002, status: 'Cancelled', customer_id: 1, coupon_id: null }]]);

    const res = await request(app)
      .patch('/api/admin/orders/1002/status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'Cancelled' });

    expect(res.statusCode).toEqual(200);
    const softCancelCall = mockConnection.query.mock.calls.find(([sql]) =>
      /UPDATE coupon_redemptions/i.test(String(sql)));
    expect(softCancelCall).toBeUndefined();
    expect(mockConnection.commit).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// C5 — discount_value bounds: percent coupons must stay within [0, 100] on
// both create and update.
// ─────────────────────────────────────────────────────────────────────────

describe('Coupon discount_value validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects creating a percent coupon above 100', async () => {
    const res = await request(app)
      .post('/api/admin/coupons')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Huge', discount_type: 'percent', discount_value: 500, code: 'HUGE' });

    expect(res.statusCode).toEqual(400);
    expect(res.body.message).toMatch(/cannot exceed 100/i);
  });

  it('rejects updating a percent coupon above 100', async () => {
    pool.query.mockResolvedValueOnce([[{ id: 5, discount_type: 'percent', discount_value: 10, target_audience: 'all' }]]); // existing coupon

    const res = await request(app)
      .patch('/api/admin/coupons/5')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ discount_value: 150 });

    expect(res.statusCode).toEqual(400);
    expect(res.body.message).toMatch(/cannot exceed 100/i);
  });

  it('rejects switching a large flat coupon to percent', async () => {
    pool.query.mockResolvedValueOnce([[{ id: 6, discount_type: 'flat', discount_value: 500, target_audience: 'all' }]]);

    const res = await request(app)
      .patch('/api/admin/coupons/6')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ discount_type: 'percent' });

    expect(res.statusCode).toEqual(400);
    expect(res.body.message).toMatch(/cannot exceed 100/i);
  });

  it('rejects a negative discount_value on update', async () => {
    pool.query.mockResolvedValueOnce([[{ id: 7, discount_type: 'flat', discount_value: 10, target_audience: 'all' }]]);

    const res = await request(app)
      .patch('/api/admin/coupons/7')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ discount_value: -5 });

    expect(res.statusCode).toEqual(400);
    expect(res.body.message).toMatch(/non-negative/i);
  });

  it('accepts a valid percent coupon update', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 8, discount_type: 'percent', discount_value: 10, target_audience: 'all' }]]) // existing
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE

    const res = await request(app)
      .patch('/api/admin/coupons/8')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ discount_value: 25 });

    expect(res.statusCode).toEqual(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// TASK 2 — compare-and-set on order status/payment: a concurrent update
// must surface as 409 CONCURRENCY_CONFLICT instead of silently overwriting.
// ─────────────────────────────────────────────────────────────────────────

describe('Order status compare-and-set (409)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 409 when the order status changed underneath an admin update', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1001, status: 'Pending', customer_id: 1 }]]) // initial SELECT
      .mockResolvedValueOnce([{ affectedRows: 0 }]) // UPDATE matched 0 rows (concurrent change)
      .mockResolvedValueOnce([[{ id: 1001, status: 'Accepted', customer_id: 1 }]]); // fresh re-SELECT

    const res = await request(app)
      .patch('/api/admin/orders/1001/status')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'Accepted' });

    expect(res.statusCode).toEqual(409);
    expect(res.body.code).toEqual('CONCURRENCY_CONFLICT');
    expect(res.body.order.status).toEqual('Accepted');
  });

  it('returns 409 when payment status changed underneath an admin update', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1001, status: 'Accepted', customer_id: 1, payment_status: 'Pending' }]]) // initial SELECT
      .mockResolvedValueOnce([{ affectedRows: 0 }]) // UPDATE matched 0 rows
      .mockResolvedValueOnce([[{ id: 1001, status: 'Accepted', customer_id: 1, payment_status: 'Paid' }]]); // fresh re-SELECT

    const res = await request(app)
      .patch('/api/admin/orders/1001/payment')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ paymentStatus: 'Failed' });

    expect(res.statusCode).toEqual(409);
    expect(res.body.code).toEqual('CONCURRENCY_CONFLICT');
    expect(res.body.order.payment_status).toEqual('Paid');
  });

  it('returns 400 when a customer cancels an order that is no longer pending', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1001, status: 'Pending', customer_id: 1, payment_method: 'Cash' }]]) // initial SELECT
      .mockResolvedValueOnce([{ affectedRows: 0 }]) // UPDATE matched 0 (concurrent admin accepted it)
      .mockResolvedValueOnce([[{ id: 1001, status: 'Accepted', customer_id: 1 }]]); // fresh re-SELECT

    const res = await request(app)
      .patch('/api/orders/1001/cancel')
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.statusCode).toEqual(400);
    expect(res.body.message).toContain('Only pending orders can be cancelled');
  });
});

