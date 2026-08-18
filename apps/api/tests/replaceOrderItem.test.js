/**
 * PATCH /api/admin/orders/:id/items/:itemId/replace — admin swaps a line
 * item's product (out-of-stock substitution).
 *
 * Scope here: the coupon-terms warning (F-7 fix) — discount_amount stays
 * frozen after a swap (no refund/reconciliation automation), but a swap
 * down to a cheaper product can drop the new subtotal below the applied
 * coupon's min_order_amount. The order must still surface that to the
 * admin (response field + admin notification) rather than silently
 * shipping an order that violates its own coupon terms.
 */
const request = require('supertest');
const express = require('express');
const adminRoutes = require('../src/routes/adminRoutes');
const { pool } = require('../src/db/mysql');
const jwt = require('jsonwebtoken');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn().mockResolvedValue([[]]), getConnection: jest.fn() },
}));

jest.mock('../src/utils/adminNotifications', () => ({
  TYPES: { COUPON_TERMS_VIOLATED: 'coupon_terms_violated' },
  createAdminNotification: jest.fn().mockResolvedValue({ id: 1 }),
}));

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const adminToken = jwt.sign({ id: 'admin', role: 'admin', adminRole: 'area_admin', areaId: 1 }, process.env.JWT_SECRET || 'secret');
const adminInbox = require('../src/utils/adminNotifications');

const BASE_ORDER = {
  id: 501,
  area_id: 1,
  status: 'Accepted',
  delivery_charge: 20,
  fast_delivery_charge: 0,
  night_charge: 0,
  rain_charge: 0,
  discount_amount: 0,
  coupon_id: null,
  coupon_code: null,
  coupon_title: null,
};

const BASE_ITEM = {
  id: 9001,
  order_id: 501,
  area_id: 1,
  item_type: 'product',
  product_id: 10,
  variant_id: null,
  unit_price: 100,
  quantity: 2,
  shop_id: null,
};

function mockHappyPathConnection({ order, item, newProduct, newSubtotal, couponRow }) {
  const mockConnection = {
    beginTransaction: jest.fn(),
    query: jest.fn(),
    commit: jest.fn(),
    rollback: jest.fn(),
    release: jest.fn(),
  };
  pool.getConnection.mockResolvedValue(mockConnection);

  const calls = [
    [[order]], // SELECT orders FOR UPDATE
    [[item]], // SELECT order_items FOR UPDATE
    [[newProduct]], // SELECT products
    [{ affectedRows: 1 }], // UPDATE order_items
    [[{ subtotal: newSubtotal }]], // SELECT SUM(line_total)
  ];
  if (couponRow !== undefined) {
    calls.push([couponRow ? [couponRow] : []]); // SELECT coupons (F-7)
  }
  calls.push([{ affectedRows: 1 }]); // UPDATE orders

  mockConnection.query.mockImplementation(() => Promise.resolve(calls.shift()));
  return mockConnection;
}

describe('PATCH /orders/:id/items/:itemId/replace — coupon terms warning', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockResolvedValue([[]]);
  });

  it('no warning when the order has no applied coupon', async () => {
    mockHappyPathConnection({
      order: BASE_ORDER,
      item: BASE_ITEM,
      newProduct: { id: 20, name: 'Cheap Item', price: 10, shop_price: null, shop_id: null, area_id: 1, available: 1, deleted: 0 },
      newSubtotal: 20,
    });
    pool.query.mockResolvedValueOnce([[{ ...BASE_ORDER, subtotal: 20, total: 40 }]]) // re-select order
      .mockResolvedValueOnce([[{ ...BASE_ITEM, product_id: 20 }]]); // re-select item

    const res = await request(app)
      .patch('/api/admin/orders/501/items/9001/replace')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ expectedProductId: 10, expectedUnitPrice: 100, newProductId: 20 });

    expect(res.statusCode).toEqual(200);
    expect(res.body.couponWarning).toBeNull();
    expect(adminInbox.createAdminNotification).not.toHaveBeenCalled();
  });

  it('no warning when the coupon\'s min_order_amount is still met after the swap', async () => {
    const order = { ...BASE_ORDER, coupon_id: 77, coupon_code: 'SAVE50', discount_amount: 50 };
    mockHappyPathConnection({
      order,
      item: BASE_ITEM,
      newProduct: { id: 20, name: 'Similar Item', price: 90, shop_price: null, shop_id: null, area_id: 1, available: 1, deleted: 0 },
      newSubtotal: 180, // still >= min_order_amount below
      couponRow: { min_order_amount: 150 },
    });
    pool.query.mockResolvedValueOnce([[{ ...order, subtotal: 180, total: 150 }]])
      .mockResolvedValueOnce([[{ ...BASE_ITEM, product_id: 20 }]]);

    const res = await request(app)
      .patch('/api/admin/orders/501/items/9001/replace')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ expectedProductId: 10, expectedUnitPrice: 100, newProductId: 20 });

    expect(res.statusCode).toEqual(200);
    expect(res.body.couponWarning).toBeNull();
    expect(adminInbox.createAdminNotification).not.toHaveBeenCalled();
  });

  it('warns (response + admin notification) when the swap drops the subtotal below min_order_amount', async () => {
    const order = { ...BASE_ORDER, coupon_id: 77, coupon_code: 'SAVE50', discount_amount: 50 };
    mockHappyPathConnection({
      order,
      item: BASE_ITEM,
      newProduct: { id: 21, name: 'Cheap Substitute', price: 20, shop_price: null, shop_id: null, area_id: 1, available: 1, deleted: 0 },
      newSubtotal: 40, // below min_order_amount
      couponRow: { min_order_amount: 150 },
    });
    pool.query.mockResolvedValueOnce([[{ ...order, subtotal: 40, total: 10 }]])
      .mockResolvedValueOnce([[{ ...BASE_ITEM, product_id: 21 }]]);

    const res = await request(app)
      .patch('/api/admin/orders/501/items/9001/replace')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ expectedProductId: 10, expectedUnitPrice: 100, newProductId: 21 });

    expect(res.statusCode).toEqual(200);
    expect(res.body.couponWarning).toMatch(/SAVE50/);
    expect(res.body.couponWarning).toMatch(/150/);
    // The discount itself is never auto-adjusted — same no-refund-automation
    // rule this function already applies to the total shift.
    expect(res.body.order.discount_amount).toBe(50);
    expect(adminInbox.createAdminNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'coupon_terms_violated',
        relatedId: '501',
        areaId: 1,
      })
    );
  });

  it('does not warn when the coupon row no longer exists (deleted) — best-effort, never blocks the swap', async () => {
    const order = { ...BASE_ORDER, coupon_id: 77, coupon_code: 'SAVE50', discount_amount: 50 };
    mockHappyPathConnection({
      order,
      item: BASE_ITEM,
      newProduct: { id: 21, name: 'Cheap Substitute', price: 20, shop_price: null, shop_id: null, area_id: 1, available: 1, deleted: 0 },
      newSubtotal: 40,
      couponRow: null,
    });
    pool.query.mockResolvedValueOnce([[{ ...order, subtotal: 40, total: 10 }]])
      .mockResolvedValueOnce([[{ ...BASE_ITEM, product_id: 21 }]]);

    const res = await request(app)
      .patch('/api/admin/orders/501/items/9001/replace')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ expectedProductId: 10, expectedUnitPrice: 100, newProductId: 21 });

    expect(res.statusCode).toEqual(200);
    expect(res.body.couponWarning).toBeNull();
  });
});
