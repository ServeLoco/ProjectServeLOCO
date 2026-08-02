const request = require('supertest');
const express = require('express');
const adminRoutes = require('../src/routes/adminRoutes');
const { pool } = require('../src/db/mysql');
const jwt = require('jsonwebtoken');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn().mockResolvedValue([[]]), getConnection: jest.fn() }
}));

jest.mock('../src/utils/coupons', () => ({
  validateCoupon: jest.fn().mockResolvedValue({ ok: false, reason: 'No coupon' }),
  validateCouponById: jest.fn().mockResolvedValue({ ok: false, reason: 'Coupon not found' }),
  pickBestAutoApply: jest.fn().mockResolvedValue(null),
  findApplicableCoupons: jest.fn().mockResolvedValue([]),
  getNextFreeDeliveryThreshold: jest.fn().mockResolvedValue(null),
  getNearestUnlockableCoupon: jest.fn().mockResolvedValue(null),
  computeDiscount: jest.fn().mockReturnValue(0),
  checkEligibility: jest.fn().mockResolvedValue({ ok: false, reason: 'No coupon' }),
}));

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const adminToken = jwt.sign({ id: 'admin', role: 'admin' }, process.env.JWT_SECRET || 'secret');
const areaScope = require('../src/utils/areaScope');

describe('Admin-placed orders (order on behalf of a customer)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    areaScope._resetCachesForTests();
  });

  describe('POST /api/admin/orders/calculate', () => {
    it('requires customer_id', async () => {
      const res = await request(app)
        .post('/api/admin/orders/calculate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ items: [{ productId: 1, quantity: 1 }] });

      expect(res.statusCode).toEqual(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('404s when the customer does not exist', async () => {
      pool.query.mockResolvedValueOnce([[]]);

      const res = await request(app)
        .post('/api/admin/orders/calculate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ customer_id: 999, items: [{ productId: 1, quantity: 1 }] });

      expect(res.statusCode).toEqual(404);
    });

    it('rejects a blocked customer', async () => {
      pool.query.mockResolvedValueOnce([[{ id: 42, blocked: 1 }]]);

      const res = await request(app)
        .post('/api/admin/orders/calculate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ customer_id: 42, items: [{ productId: 1, quantity: 1 }] });

      expect(res.statusCode).toEqual(403);
    });

    it('returns the same cart calculation the customer app would get', async () => {
      pool.query.mockResolvedValueOnce([[{ id: 42, blocked: 0 }]]); // customer lookup
      // No pin sent: calculateCart's area resolution (TASK 13) goes
      // straight to getDefaultArea() — one extra query before settings.
      pool.query.mockResolvedValueOnce([[{ id: 1, code: 'A1', name: 'Area 1', active: 1, is_default: 1 }]]);
      pool.query.mockResolvedValueOnce([[{ shop_open: 1, delivery_charge: 10, night_charge: 0 }]]); // settings
      pool.query.mockResolvedValueOnce([[{ id: 1, name: 'Pizza', price: 100, available: 1 }]]); // products

      const res = await request(app)
        .post('/api/admin/orders/calculate')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ customer_id: 42, items: [{ productId: 1, quantity: 2 }] });

      expect(res.statusCode).toEqual(200);
      expect(res.body.subtotal).toEqual(200);
      expect(res.body.deliveryCharge).toEqual(10);
      expect(res.body.total).toEqual(210);
    });
  });

  describe('POST /api/admin/orders', () => {
    it('requires customer_id', async () => {
      const res = await request(app)
        .post('/api/admin/orders')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ address: '123 Test St', paymentMethod: 'Cash', items: [{ productId: 1, quantity: 1 }] });

      expect(res.statusCode).toEqual(400);
    });

    it('creates the order for the target customer, not the admin', async () => {
      pool.query.mockResolvedValueOnce([[{ id: 42, blocked: 0 }]]); // resolveOrderTargetCustomer

      const mockConnection = {
        beginTransaction: jest.fn(),
        query: jest.fn(),
        commit: jest.fn(),
        rollback: jest.fn(),
        release: jest.fn(),
      };
      pool.getConnection.mockResolvedValue(mockConnection);

      mockConnection.query
        .mockResolvedValueOnce([[{ id: 42, name: 'Jane Doe', phone: '9990001111', whatsapp_number: '9990001111', address: 'Saved address', blocked: 0 }]]) // user
        .mockResolvedValueOnce([[{ shop_open: 1, delivery_available: 1, delivery_charge: 10, night_charge: 0 }]]) // settings
        .mockResolvedValueOnce([[{ id: 1, name: 'Pizza', price: 100, available: 1 }]]) // products
        .mockResolvedValueOnce([[]]) // exclusion zones
        .mockResolvedValueOnce([{ insertId: 5001 }]) // INSERT orders
        .mockResolvedValueOnce([{ affectedRows: 1 }]); // INSERT order_items

      const res = await request(app)
        .post('/api/admin/orders')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          customer_id: 42,
          address: '123 Test St',
          paymentMethod: 'Cash',
          items: [{ productId: 1, quantity: 2 }],
        });

      expect(res.statusCode).toEqual(201);
      expect(res.body.orderId).toBe(5001);
      expect(res.body.order.customerId).toBe(42);
      expect(res.body.order.subtotal).toBe(200);
      expect(mockConnection.commit).toHaveBeenCalledTimes(1);
    });

    it('404s when the customer does not exist', async () => {
      pool.query.mockResolvedValueOnce([[]]);

      const res = await request(app)
        .post('/api/admin/orders')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          customer_id: 999,
          address: '123 Test St',
          paymentMethod: 'Cash',
          items: [{ productId: 1, quantity: 1 }],
        });

      expect(res.statusCode).toEqual(404);
    });
  });
});
