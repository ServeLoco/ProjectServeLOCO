/**
 * Tests for the admin shop schedule endpoint — PATCH /api/admin/shops/:id/schedule.
 * Same mock strategy as shopsAdmin.test.js: mock the mysql pool, mount the real
 * adminRoutes on an express app, drive it with supertest using an admin JWT.
 * Validation rules mirror shopOwnerController.updateMyShopSchedule
 * (see shopOwner.test.js for the shop-owner-side equivalent assertions).
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const adminRoutes = require('../src/routes/adminRoutes');
const { pool } = require('../src/db/mysql');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn(), getConnection: jest.fn() },
}));

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const adminToken = jwt.sign(
  { id: 'admin', role: 'admin' },
  process.env.JWT_SECRET || 'test_jwt_secret_that_is_long_enough'
);

describe('Admin shop schedule — PATCH /api/admin/shops/:id/schedule', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('404s when the shop does not exist', async () => {
    pool.query.mockResolvedValueOnce([[]]); // loadShopOr404 -> no rows

    const res = await request(app)
      .patch('/api/admin/shops/99/schedule')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ openTime: '09:00', closeTime: '21:00' });

    expect(res.statusCode).toEqual(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('400s on a malformed time', async () => {
    pool.query.mockResolvedValueOnce([[{ id: 1, name: 'Burger Point' }]]); // loadShopOr404

    const res = await request(app)
      .patch('/api/admin/shops/1/schedule')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ openTime: '25:00', closeTime: '21:00' });

    expect(res.statusCode).toEqual(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('400s when open and close time are the same', async () => {
    pool.query.mockResolvedValueOnce([[{ id: 1, name: 'Burger Point' }]]); // loadShopOr404

    const res = await request(app)
      .patch('/api/admin/shops/1/schedule')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ openTime: '09:00', closeTime: '09:00' });

    expect(res.statusCode).toEqual(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('sets the schedule and returns the updated shop', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1, name: 'Burger Point' }]]) // loadShopOr404
      .mockResolvedValueOnce([{ affectedRows: 1 }])                // UPDATE shops
      .mockResolvedValueOnce([[{                                   // fetchShopRow re-query
        id: 1, name: 'Burger Point', is_open: 1, active: 1,
        owner_user_id: null, owner_name: null, owner_phone: null,
        product_count: 0, open_time: '09:00:00', close_time: '21:00:00',
        created_at: '2026-07-09 00:00:00',
      }]]);

    const res = await request(app)
      .patch('/api/admin/shops/1/schedule')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ openTime: '09:00', closeTime: '21:00' });

    expect(res.statusCode).toEqual(200);
    expect(res.body.message).toBe('Shop schedule updated');
    expect(res.body.shop.openTime).toBe('09:00');
    expect(res.body.shop.closeTime).toBe('21:00');
    expect(pool.query).toHaveBeenNthCalledWith(2,
      'UPDATE shops SET open_time = ?, close_time = ? WHERE id = ?', ['09:00', '21:00', 1]);
  });

  it('clears the schedule when both times are null', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1, name: 'Burger Point' }]]) // loadShopOr404
      .mockResolvedValueOnce([{ affectedRows: 1 }])                // UPDATE shops
      .mockResolvedValueOnce([[{                                   // fetchShopRow re-query
        id: 1, name: 'Burger Point', is_open: 1, active: 1,
        owner_user_id: null, owner_name: null, owner_phone: null,
        product_count: 0, open_time: null, close_time: null,
        created_at: '2026-07-09 00:00:00',
      }]]);

    const res = await request(app)
      .patch('/api/admin/shops/1/schedule')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ openTime: null, closeTime: null });

    expect(res.statusCode).toEqual(200);
    expect(res.body.shop.openTime).toBeNull();
    expect(res.body.shop.closeTime).toBeNull();
  });
});
