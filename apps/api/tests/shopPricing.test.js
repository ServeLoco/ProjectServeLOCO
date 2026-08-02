/**
 * Shop pricing / commission tests (plans/shop-pricing.md).
 *
 * Covers:
 *  1. PATCH /api/admin/products/pricing — validation, variant scoping
 *     (cross-product id abuse blocked), default-variant re-sync.
 *  2. Order creation snapshots shop_unit_price / shop_line_total from the
 *     live catalog (product path and variant path).
 *  3. Shop-owner payloads compute shop money correctly: rejected items and
 *     cancelled orders never count toward what's owed.
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const adminRoutes = require('../src/routes/adminRoutes');
const orderRoutes = require('../src/routes/orderRoutes');
const shopRoutes = require('../src/routes/shopRoutes');
const { pool } = require('../src/db/mysql');
const areaScope = require('../src/utils/areaScope');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn(), getConnection: jest.fn() },
}));
jest.mock('../src/realtime/socket', () => ({
  emitToAdmins: jest.fn(),
  emitToCustomer: jest.fn(),
  emitToAllCustomers: jest.fn(),
}));
jest.mock('../src/utils/coupons', () => ({
  validateCoupon: jest.fn().mockResolvedValue({ ok: false, reason: 'No coupon' }),
  validateCouponById: jest.fn().mockResolvedValue({ ok: false, reason: 'Coupon not found' }),
  pickBestAutoApply: jest.fn().mockResolvedValue(null),
}));

const adminApp = express();
adminApp.use(express.json());
adminApp.use('/api/admin', adminRoutes);

const orderApp = express();
orderApp.use(express.json());
orderApp.use('/api/orders', orderRoutes);

const shopApp = express();
shopApp.use(express.json());
shopApp.use('/api/shop', shopRoutes);

const adminToken = jwt.sign({ id: 'admin', role: 'admin', adminRole: 'area_admin', areaId: 1 }, process.env.JWT_SECRET || 'secret');
const customerToken = (id) => jwt.sign({ id, role: 'customer' }, process.env.JWT_SECRET || 'test_jwt_secret_that_is_long_enough');

beforeEach(() => {
  jest.clearAllMocks();
  areaScope._resetCachesForTests();
});

// TASK 10: order creation resolves which area the (validator-normalized,
// here effectively 0,0) pin belongs to via the outer pool — 2 queries
// (areas list, then a zone-match check that finds nothing) — before the
// rest of the transaction runs on mockConnection.
const queueAreaResolution = () => {
  pool.query
    .mockResolvedValueOnce([[{ id: 1, active: 1, is_default: 1, min_lat: null, max_lat: null, min_lng: null, max_lng: null }]])
    .mockResolvedValueOnce([[]]);
};

// ─────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/products/pricing
// ─────────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/products/pricing', () => {
  it('rejects an empty rows array', async () => {
    const res = await request(adminApp)
      .patch('/api/admin/products/pricing')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rows: [] });

    expect(res.statusCode).toEqual(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects more than 200 rows in one request', async () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({ productId: i + 1, price: 10 }));
    const res = await request(adminApp)
      .patch('/api/admin/products/pricing')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rows });

    expect(res.statusCode).toEqual(400);
    expect(res.body.message).toMatch(/200 rows/);
  });

  it('surfaces a per-row error for an invalid price without failing the whole batch', async () => {
    const mockConn = {
      beginTransaction: jest.fn(),
      query: jest.fn()
        .mockResolvedValueOnce([{ affectedRows: 1 }]), // product 1 update succeeds
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    pool.getConnection.mockResolvedValue(mockConn);

    const res = await request(adminApp)
      .patch('/api/admin/products/pricing')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rows: [{ productId: 1, price: 199 }, { productId: 2, price: 'not-a-number' }] });

    expect(res.statusCode).toEqual(200);
    expect(res.body.updated).toBe(1);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0].message).toMatch(/valid amount/);
    expect(mockConn.commit).toHaveBeenCalledTimes(1);
  });

  it('scopes a variant price update to its own product (cross-product id abuse blocked)', async () => {
    const mockConn = {
      beginTransaction: jest.fn(),
      // AND product_id = ? means a variantId belonging to a different
      // product matches zero rows.
      query: jest.fn().mockResolvedValueOnce([{ affectedRows: 0 }]),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    pool.getConnection.mockResolvedValue(mockConn);

    const res = await request(adminApp)
      .patch('/api/admin/products/pricing')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rows: [{ productId: 1, variantId: 99, shopPrice: 50 }] });

    expect(res.statusCode).toEqual(200);
    expect(res.body.updated).toBe(0);
    expect(res.body.errors[0].message).toBe('Variant not found for this product');

    const variantUpdateCall = mockConn.query.mock.calls[0];
    expect(variantUpdateCall[0]).toContain('WHERE id = ? AND product_id = ? AND deleted = 0');
    expect(variantUpdateCall[1]).toEqual([50, 99, 1, 1]);
  });

  it('re-syncs products.price/shop_price from the default variant after a variant edit', async () => {
    const mockConn = {
      beginTransaction: jest.fn(),
      query: jest.fn()
        .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE product_variants
        .mockResolvedValueOnce([[{ price: 249, shop_price: 180 }]]) // re-read default variant
        .mockResolvedValueOnce([{ affectedRows: 1 }]), // UPDATE products mirror
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    pool.getConnection.mockResolvedValue(mockConn);

    const res = await request(adminApp)
      .patch('/api/admin/products/pricing')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rows: [{ productId: 1, variantId: 10, price: 249, shopPrice: 180 }] });

    expect(res.statusCode).toEqual(200);
    expect(res.body.updated).toBe(1);

    const mirrorSyncCall = mockConn.query.mock.calls.find(
      c => c[0] === 'UPDATE products SET price = ?, shop_price = ? WHERE id = ?'
    );
    expect(mirrorSyncCall).toBeDefined();
    expect(mirrorSyncCall[1]).toEqual([249, 180, 1]);
    expect(mockConn.commit).toHaveBeenCalledTimes(1);
  });

  it('clears shop_price when explicitly sent as null, leaves price untouched when omitted', async () => {
    const mockConn = {
      beginTransaction: jest.fn(),
      query: jest.fn().mockResolvedValueOnce([{ affectedRows: 1 }]),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    pool.getConnection.mockResolvedValue(mockConn);

    const res = await request(adminApp)
      .patch('/api/admin/products/pricing')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rows: [{ productId: 5, shopPrice: null }] });

    expect(res.statusCode).toEqual(200);
    const updateCall = mockConn.query.mock.calls[0];
    expect(updateCall[0]).toBe('UPDATE products SET shop_price = ? WHERE id = ? AND deleted = 0 AND area_id = ?');
    expect(updateCall[1]).toEqual([null, 5, 1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Order creation — shop_unit_price / shop_line_total snapshot
// ─────────────────────────────────────────────────────────────────────────

describe('Order creation snapshots shop pricing', () => {
  const orderToken = customerToken(1001);

  it('snapshots shop_unit_price/shop_line_total for a plain product', async () => {
    const mockConnection = {
      beginTransaction: jest.fn(),
      query: jest.fn()
        .mockResolvedValueOnce([[{ blocked: 0 }]])
        .mockResolvedValueOnce([[{ shop_open: 1, delivery_available: 1, delivery_charge: 10, night_charge: 0, fast_delivery_enabled: 0 }]])
        .mockResolvedValueOnce([[{ id: 1, name: 'Burger', price: 100, shop_price: 70, shop_id: 5 }]])
        .mockResolvedValueOnce([[]]) // exclusion zones
        .mockResolvedValueOnce([{ insertId: 3001 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }]),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    queueAreaResolution();
    pool.getConnection.mockResolvedValue(mockConnection);

    const res = await request(orderApp)
      .post('/api/orders')
      .set('Authorization', `Bearer ${orderToken}`)
      .send({
        address: '123 Test St',
        paymentMethod: 'Cash',
        items: [{ productId: 1, quantity: 3 }],
      });

    expect(res.statusCode).toEqual(201);
    const insertCall = mockConnection.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO order_items')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[0]).toContain('shop_unit_price');
    expect(insertCall[0]).toContain('shop_line_total');
    // order_id, product_id, variant_id, variant_label, shop_id, item_type,
    // product_name, quantity, unit_price, line_total, shop_unit_price, shop_line_total
    const values = insertCall[1];
    expect(values[8]).toBe(100); // unit_price
    expect(values[9]).toBe(300); // line_total
    expect(values[10]).toBe(70); // shop_unit_price
    expect(values[11]).toBe(210); // shop_line_total = 70 * 3
  });

  it('leaves shop_unit_price/shop_line_total null when the product has no shop_price configured', async () => {
    const mockConnection = {
      beginTransaction: jest.fn(),
      query: jest.fn()
        .mockResolvedValueOnce([[{ blocked: 0 }]])
        .mockResolvedValueOnce([[{ shop_open: 1, delivery_available: 1, delivery_charge: 10, night_charge: 0, fast_delivery_enabled: 0 }]])
        .mockResolvedValueOnce([[{ id: 1, name: 'Burger', price: 100, shop_price: null, shop_id: null }]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([{ insertId: 3002 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }]),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    queueAreaResolution();
    pool.getConnection.mockResolvedValue(mockConnection);

    const res = await request(orderApp)
      .post('/api/orders')
      .set('Authorization', `Bearer ${customerToken(1002)}`)
      .send({
        address: '123 Test St',
        paymentMethod: 'Cash',
        items: [{ productId: 1, quantity: 1 }],
      });

    expect(res.statusCode).toEqual(201);
    const insertCall = mockConnection.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO order_items')
    );
    const values = insertCall[1];
    expect(values[10]).toBeNull(); // shop_unit_price
    expect(values[11]).toBeNull(); // shop_line_total
  });

  it('snapshots the variant shop_price, not the product-level one', async () => {
    const mockConnection = {
      beginTransaction: jest.fn(),
      query: jest.fn()
        .mockResolvedValueOnce([[{ blocked: 0 }]])
        .mockResolvedValueOnce([[{ shop_open: 1, delivery_available: 1, delivery_charge: 10, night_charge: 0, fast_delivery_enabled: 0 }]])
        .mockResolvedValueOnce([[{ id: 1, name: 'Pizza', price: 199, shop_price: 120, shop_id: 5 }]])
        .mockResolvedValueOnce([[{ id: 10, product_id: 1, label: 'Large', price: 349, shop_price: 260, available: 1, deleted: 0 }]])
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([{ insertId: 3003 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }]),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    queueAreaResolution();
    pool.getConnection.mockResolvedValue(mockConnection);

    const res = await request(orderApp)
      .post('/api/orders')
      .set('Authorization', `Bearer ${customerToken(1003)}`)
      .send({
        address: '123 Test St',
        paymentMethod: 'Cash',
        items: [{ productId: 1, variantId: 10, quantity: 2 }],
      });

    expect(res.statusCode).toEqual(201);
    const insertCall = mockConnection.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO order_items')
    );
    const values = insertCall[1];
    expect(values[8]).toBe(349); // unit_price = variant price, not product price
    expect(values[10]).toBe(260); // shop_unit_price = variant shop_price
    expect(values[11]).toBe(520); // shop_line_total = 260 * 2
  });

  it('never snapshots a shop price for a combo line', async () => {
    const mockConnection = {
      beginTransaction: jest.fn(),
      query: jest.fn()
        .mockResolvedValueOnce([[{ blocked: 0 }]])
        .mockResolvedValueOnce([[{ shop_open: 1, delivery_available: 1, delivery_charge: 10, night_charge: 0, fast_delivery_enabled: 0 }]])
        .mockResolvedValueOnce([[{ id: 1, name: 'Combo Meal', price: 299 }]]) // combos table has no shop_price column
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([{ insertId: 3004 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }]),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    queueAreaResolution();
    pool.getConnection.mockResolvedValue(mockConnection);

    const res = await request(orderApp)
      .post('/api/orders')
      .set('Authorization', `Bearer ${customerToken(1004)}`)
      .send({
        address: '123 Test St',
        paymentMethod: 'Cash',
        items: [{ productId: 1, quantity: 1, isCombo: true }],
      });

    expect(res.statusCode).toEqual(201);
    const insertCall = mockConnection.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO order_items')
    );
    const values = insertCall[1];
    expect(values[10]).toBeNull();
    expect(values[11]).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Shop-owner payloads — shop money totals
// ─────────────────────────────────────────────────────────────────────────

describe('Shop-owner API exposes shop money, excluding rejected/cancelled', () => {
  const SHOP_ROW = [{ id: 1, name: 'Burger Point', is_open: 1, active: 1 }];

  it('GET /orders: shopTotal excludes an item the shop already rejected', async () => {
    pool.query
      .mockResolvedValueOnce([SHOP_ROW]) // requireShopOwner lookup
      .mockResolvedValueOnce([[
        { id: 10, order_number: 'ORD-10', status: 'Accepted', note: null, created_at: '2026-07-09 10:00:00', delivery_type: 'standard' },
      ]])
      .mockResolvedValueOnce([[{ standard_delivery_minutes: 55, fast_delivery_minutes: 20 }]])
      .mockResolvedValueOnce([[
        { id: 101, order_id: 10, product_name: 'Burger', quantity: 2, variant_label: null, shop_line_total: 140, shop_confirmed_at: null, shop_rejected_at: null, shop_ready_at: null },
        { id: 102, order_id: 10, product_name: 'Fries', quantity: 1, variant_label: null, shop_line_total: 50, shop_confirmed_at: null, shop_rejected_at: '2026-07-09 10:02:00', shop_ready_at: null },
      ]]);

    const res = await request(shopApp)
      .get('/api/shop/orders')
      .set('Authorization', `Bearer ${customerToken(7)}`);

    expect(res.statusCode).toEqual(200);
    const order = res.body.orders[0];
    // Only the non-rejected line (140) counts, not the rejected Fries (50).
    expect(order.shopTotal).toBe(140);
    expect(order.shop_total).toBe(140);
    expect(order.items.find(it => it.productName === 'Fries').shopLineTotal).toBe(50);
  });

  it('GET /orders/history: payableTotal excludes Cancelled orders entirely', async () => {
    pool.query
      .mockResolvedValueOnce([SHOP_ROW])
      .mockResolvedValueOnce([[
        { id: 20, order_number: 'ORD-20', status: 'Delivered', note: null, admin_remark: null, created_at: '2026-07-10 09:00:00', delivery_type: 'standard' },
        { id: 21, order_number: 'ORD-21', status: 'Cancelled', note: null, admin_remark: null, created_at: '2026-07-09 12:00:00', delivery_type: 'fast' },
      ]])
      .mockResolvedValueOnce([[{ total: 70 }]]) // payout SUM query — Delivered order's 70 only
      .mockResolvedValueOnce([[
        { id: 201, order_id: 20, product_name: 'Burger', quantity: 1, variant_label: null, shop_line_total: 70, shop_confirmed_at: '2026-07-10 09:01:00', shop_rejected_at: null, shop_ready_at: null },
        { id: 211, order_id: 21, product_name: 'Fries', quantity: 2, variant_label: null, shop_line_total: 100, shop_confirmed_at: null, shop_rejected_at: null, shop_ready_at: null },
      ]]);

    const res = await request(shopApp)
      .get('/api/shop/orders/history')
      .set('Authorization', `Bearer ${customerToken(7)}`);

    expect(res.statusCode).toEqual(200);
    // Delivered order's 70 counts; Cancelled order's 100 is excluded even
    // though shop_rejected_at is null on that line (never fulfilled either way).
    expect(res.body.payableTotal).toBe(70);
    expect(res.body.payable_total).toBe(70);
    const cancelled = res.body.orders.find(o => o.id === 21);
    expect(cancelled.shopTotal).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Admin oversight surfaces — order detail drawer + rider dispatch panel.
// Riders' own app (riderController/riderRoutes) deliberately does NOT get
// this: a delivery rider has no reason to see a shop's cost/commission.
// ─────────────────────────────────────────────────────────────────────────

describe('Admin order detail exposes per-shop payable (shopConfirmations)', () => {
  it('sums non-rejected shop_line_total per shop, excludes a shop that rejected', async () => {
    pool.query
      .mockResolvedValueOnce([[
        { id: 50, order_number: 'ORD-50', status: 'Pending', rider_id: null },
      ]]) // order row
      .mockResolvedValueOnce([[
        { id: 501, order_id: 50, shop_id: 1, shop_name: 'Burger Point', product_name: 'Burger', quantity: 2, shop_line_total: 140, shop_confirmed_at: null, shop_rejected_at: null, shop_ready_at: null },
        { id: 502, order_id: 50, shop_id: 2, shop_name: 'Pizza Place', product_name: 'Pizza', quantity: 1, shop_line_total: 120, shop_confirmed_at: null, shop_rejected_at: '2026-07-20 10:00:00', shop_ready_at: null },
      ]]); // items rows (oi.*)

    const res = await request(adminApp)
      .get('/api/admin/orders/50')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(200);
    const order = res.body.data;
    const burger = order.shopConfirmations.find(sc => sc.shopId === 1);
    const pizza = order.shopConfirmations.find(sc => sc.shopId === 2);
    expect(burger.shopTotal).toBe(140);
    // Pizza Place rejected its only line -> owed nothing.
    expect(pizza.shopTotal).toBe(0);
    expect(pizza.rejected).toBe(true);
  });
});

describe('Admin rider dispatch exposes per-shop payable on active jobs', () => {
  it('GET /api/admin/riders/:id/dispatch sums shop_line_total per pickup shop', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 9, user_id: 700, display_name: 'Ravi', phone: '9999999999' }]]) // loadRiderOr404
      .mockResolvedValueOnce([[]]) // no pending offer
      .mockResolvedValueOnce([[
        { id: 60, order_number: 'ORD-60', status: 'Preparing', rider_id: 9 },
      ]]) // active assignment orders
      .mockResolvedValueOnce([[
        { order_id: 60, id: 1, name: 'Burger Point', latitude: null, longitude: null },
      ]]) // shopRows
      .mockResolvedValueOnce([[
        { id: 601, order_id: 60, product_name: 'Burger', quantity: 2, variant_label: null, shop_id: 1, shop_line_total: 140, shop_rejected_at: null },
        { id: 602, order_id: 60, product_name: 'Fries', quantity: 1, variant_label: null, shop_id: 1, shop_line_total: 30, shop_rejected_at: '2026-07-20 11:00:00' },
      ]]); // itemRows

    const res = await request(adminApp)
      .get('/api/admin/riders/9/dispatch')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(200);
    const job = res.body.orders[0];
    const shop = job.shops.find(s => s.id === 1);
    // Only the Burger line (140) counts; the rejected Fries line (30) is excluded.
    expect(shop.shopTotal).toBe(140);
    expect(shop.shop_total).toBe(140);
  });
});
