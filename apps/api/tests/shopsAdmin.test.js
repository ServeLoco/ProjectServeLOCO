/**
 * Tests for the admin shop CRUD endpoints (SHOP TASK 5).
 * GET /api/admin/shops, POST /api/admin/shops, PATCH /api/admin/shops/:id
 *
 * Strategy (follows adminValidation.test.js): mock the mysql pool, mount the
 * real adminRoutes on an express app, and drive it with supertest using an
 * admin JWT. The shop-owner lookup helper getShopForUser is exercised directly
 * for the "active=false hides the shop" case.
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const adminRoutes = require('../src/routes/adminRoutes');
const { getShopForUser } = require('../src/utils/shops');
const { pool } = require('../src/db/mysql');

jest.mock('../src/db/mysql', () => ({
  pool: {
    query: jest.fn(),
    getConnection: jest.fn(),
  },
}));

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const adminToken = jwt.sign(
  { id: 'admin', role: 'admin', adminRole: 'area_admin', areaId: 1 },
  process.env.JWT_SECRET || 'test_jwt_secret_that_is_long_enough'
);

describe('Admin Shop CRUD — /api/admin/shops', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('POST /shops with an unknown owner_phone → 404 OWNER_NOT_FOUND', async () => {
    // users lookup returns no rows for the given phone
    pool.query.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .post('/api/admin/shops')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Burger Point', owner_phone: '9999999999' });

    expect(res.statusCode).toEqual(404);
    expect(res.body.code).toBe('OWNER_NOT_FOUND');
    expect(res.body.message).toMatch(/No user with that phone/);
  });

  it('POST /shops with a valid owner_phone → 201', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 7 }]])           // users lookup (phone found)
      .mockResolvedValueOnce([[]])                     // OWNER_TAKEN check (no existing shop)
      .mockResolvedValueOnce([[]])                     // ROLE_CONFLICT rider check (not a rider)
      .mockResolvedValueOnce([[]])                     // ROLE_CONFLICT mobile-admin check (not a mobile admin)
      .mockResolvedValueOnce([{ insertId: 1 }])        // INSERT shops
      .mockResolvedValueOnce([[{                       // fetchShopRow re-query
        id: 1, name: 'Burger Point', is_open: 1, active: 1,
        owner_user_id: 7, owner_name: 'Reza', owner_phone: '9999999999',
        product_count: 0, created_at: '2026-07-09 00:00:00'
      }]]);

    const res = await request(app)
      .post('/api/admin/shops')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Burger Point', owner_phone: '9999999999' });

    expect(res.statusCode).toEqual(201);
    expect(res.body.shop.id).toBe(1);
    expect(res.body.shop.name).toBe('Burger Point');
    expect(res.body.shop.isOpen).toBe(true);
    expect(res.body.shop.ownerUserId).toBe(7);
    expect(res.body.shop.ownerPhone).toBe('9999999999');
  });

  it('POST /shops for a user who is an active mobile admin → 409 ROLE_CONFLICT', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 7 }]]) // users lookup (phone found)
      .mockResolvedValueOnce([[]])          // OWNER_TAKEN check (no existing shop)
      .mockResolvedValueOnce([[]])          // rider check (not a rider)
      .mockResolvedValueOnce([[{ id: 2 }]]); // active mobile admin for this phone

    const res = await request(app)
      .post('/api/admin/shops')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Burger Point', owner_phone: '9999999999' });

    expect(res.statusCode).toEqual(409);
    expect(res.body.code).toBe('ROLE_CONFLICT');
  });

  it('POST /shops for a user who already owns an active shop → 409 OWNER_TAKEN', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 7 }]])   // users lookup (phone found)
      .mockResolvedValueOnce([[{ id: 99 }]]); // OWNER_TAKEN check (already owns a shop)

    const res = await request(app)
      .post('/api/admin/shops')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Second Shop', owner_phone: '9999999999' });

    expect(res.statusCode).toEqual(409);
    expect(res.body.code).toBe('OWNER_TAKEN');
  });

  it('PATCH /shops/:id active=false hides the shop from getShopForUser', async () => {
    // 1. Before deactivation: getShopForUser returns the active shop.
    pool.query.mockResolvedValueOnce([[
      { id: 1, name: 'Burger Point', is_open: 1, active: 1 }
    ]]);
    const before = await getShopForUser(7);
    expect(before).not.toBeNull();
    expect(before.id).toBe(1);

    jest.clearAllMocks();

    // 2. Admin deactivates the shop via PATCH active=false.
    pool.query
      .mockResolvedValueOnce([[{ id: 1 }]])     // existence check (shop exists)
      .mockResolvedValueOnce([[{ owner_user_id: 7 }]]) // owner for customer demotion
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE active = 0
      .mockResolvedValueOnce([[{                 // fetchShopRow re-query (now active=0)
        id: 1, name: 'Burger Point', is_open: 1, active: 0,
        owner_user_id: 7, owner_name: 'Reza', owner_phone: '9999999999',
        product_count: 0, created_at: '2026-07-09 00:00:00'
      }]])
      // syncGlobalShopOpenState: settings lookup (delivery available), then
      // the shops SUM query — no other shops in this mock (total_active 0),
      // so it no-ops without touching settings.shop_open.
      .mockResolvedValueOnce([[{ delivery_available: 1 }]])
      .mockResolvedValueOnce([[{ total_active: 0, total_open: 0 }]]);

    const res = await request(app)
      .patch('/api/admin/shops/1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ active: false });

    expect(res.statusCode).toEqual(200);
    expect(res.body.message).toBe('Shop updated');
    expect(res.body.shop.active).toBe(false);

    // 3. After deactivation: getShopForUser's `active = 1` filter excludes the
    //    shop, so it returns null (owner can no longer access the shop API).
    pool.query.mockResolvedValueOnce([[]]); // active=1 filter → no rows
    const after = await getShopForUser(7);
    expect(after).toBeNull();
  });

  it('PATCH /shops/:id/orders/:orderId/confirm confirms shop items (admin = shop-owner confirm)', async () => {
    // loadShopOr404
    pool.query
      .mockResolvedValueOnce([[{ id: 1, name: 'Burger Point' }]])
      // confirmShopOrder: COUNT items for shop on order
      .mockResolvedValueOnce([[{ cnt: 2, order_status: 'Preparing' }]])
      // UPDATE shop_confirmed_at
      .mockResolvedValueOnce([{ affectedRows: 2 }])
      // notifyShopOwnerOrderUpdated: owner lookup
      .mockResolvedValueOnce([[{ owner_user_id: 7 }]]);

    // maybeStartRiderAssignment is fire-and-forget and may call more queries;
    // default empty results keep it from throwing hard.
    pool.query.mockResolvedValue([[]]);

    const res = await request(app)
      .patch('/api/admin/shops/1/orders/10/confirm')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.message).toBe('Order confirmed');
  });

  it('GET /shops/:id/orders lists active orders for the shop', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1, name: 'Burger Point' }]]) // shop exists
      .mockResolvedValueOnce([[
        { id: 10, order_number: 'ORD-10', status: 'Accepted', note: null, created_at: '2026-07-09 10:00:00', delivery_type: 'standard' },
      ]])
      .mockResolvedValueOnce([[{ standard_delivery_minutes: 55, fast_delivery_minutes: 20 }]])
      .mockResolvedValueOnce([[
        { id: 101, order_id: 10, product_name: 'Burger', quantity: 1, variant_label: null, shop_confirmed_at: null, shop_rejected_at: null, shop_ready_at: null },
      ]]);

    const res = await request(app)
      .get('/api/admin/shops/1/orders')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.shopName).toBe('Burger Point');
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0].confirmed).toBe(false);
    expect(res.body.orders[0].orderNumber).toBe('ORD-10');
  });

  it('DELETE /shops/:id reassigns products to home and removes shop', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1, name: 'Burger Point', owner_user_id: 7 }]]) // existence
      .mockResolvedValueOnce([[{ cnt: 0 }]]) // no active orders
      .mockResolvedValueOnce([{ affectedRows: 2 }]) // reassign products → house
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // DELETE shop
      // syncGlobalShopOpenState
      .mockResolvedValueOnce([[{ delivery_available: 1 }]])
      .mockResolvedValueOnce([[{ total_active: 0, total_open: 0 }]]);

    const res = await request(app)
      .delete('/api/admin/shops/1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.message).toBe('Shop deleted');
    expect(res.body.shopId).toBe(1);
    expect(res.body.becomesCustomer).toBe(true);
    expect(res.body.productsReassigned).toBe(2);
    // Products move to house (shop_id NULL), not soft-deleted.
    const reassignSql = String(pool.query.mock.calls[2][0]);
    expect(reassignSql).toMatch(/shop_id\s*=\s*NULL/i);
    expect(reassignSql).toMatch(/group_id\s*=\s*NULL/i);
    expect(reassignSql).not.toMatch(/deleted\s*=\s*1/i);
  });

  it('DELETE /shops/:id blocks when active orders remain', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1, name: 'Burger Point' }]])
      .mockResolvedValueOnce([[{ cnt: 2 }]]);

    const res = await request(app)
      .delete('/api/admin/shops/1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.message).toMatch(/active orders/i);
  });

  it('DELETE /shops/:id → 404 when missing', async () => {
    pool.query.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .delete('/api/admin/shops/99')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});
