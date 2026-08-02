/**
 * Tests for bulk "assign to shop" via PATCH /api/admin/products/bulk.
 * Mirrors the shopsAdmin.test.js strategy: mock the mysql pool, mount the
 * real adminRoutes on an express app, drive it with supertest + admin JWT.
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const adminRoutes = require('../src/routes/adminRoutes');
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

describe('Admin bulk product update — shop_id — PATCH /api/admin/products/bulk', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('assigns selected products to a shop', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 5 }]])                 // shop exists
      .mockResolvedValueOnce([[{ id: 1 }, { id: 2 }]])       // existing non-deleted product ids
      .mockResolvedValueOnce([{ affectedRows: 2 }]);         // UPDATE

    const res = await request(app)
      .patch('/api/admin/products/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ids: [1, 2], updates: { shop_id: 5 } });

    expect(res.statusCode).toEqual(200);
    expect(res.body).toEqual({ updated: 2, skipped: 0, errors: [] });

    const updateCall = pool.query.mock.calls[2];
    expect(updateCall[0]).toMatch(/shop_id = \?/);
    expect(updateCall[1]).toEqual([5, [1, 2], 1]);
  });

  it('rejects an unknown shop_id with 400 VALIDATION_ERROR', async () => {
    pool.query.mockResolvedValueOnce([[]]); // shop lookup returns no rows

    const res = await request(app)
      .patch('/api/admin/products/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ids: [1, 2], updates: { shop_id: 999 } });

    expect(res.statusCode).toEqual(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.message).toMatch(/Shop ID 999 does not exist/);
  });

  it('shop_id: 0 clears the assignment (house item)', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1 }]])          // existing non-deleted product ids
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE

    const res = await request(app)
      .patch('/api/admin/products/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ids: [1], updates: { shop_id: 0 } });

    expect(res.statusCode).toEqual(200);
    expect(res.body).toEqual({ updated: 1, skipped: 0, errors: [] });

    const updateCall = pool.query.mock.calls[1];
    expect(updateCall[0]).toMatch(/shop_id = \?/);
    expect(updateCall[1]).toEqual([null, [1], 1]);
  });

  it('applies shop_id alongside other allowed fields', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 5 }]])          // shop exists
      .mockResolvedValueOnce([[{ id: 1 }]])          // existing non-deleted product ids
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE

    const res = await request(app)
      .patch('/api/admin/products/bulk')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ids: [1], updates: { available: true, shop_id: 5 } });

    expect(res.statusCode).toEqual(200);
    expect(res.body).toEqual({ updated: 1, skipped: 0, errors: [] });

    const updateCall = pool.query.mock.calls[2];
    expect(updateCall[0]).toMatch(/available = \?/);
    expect(updateCall[0]).toMatch(/shop_id = \?/);
    expect(updateCall[1]).toEqual([1, 5, [1], 1]);
  });
});
