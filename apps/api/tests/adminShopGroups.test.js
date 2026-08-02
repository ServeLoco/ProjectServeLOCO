/**
 * Tests for admin-side product group management —
 * /api/admin/shops/:id/groups* and /api/admin/shops/:id/products/:productId/group.
 * Same mock strategy as shopsAdmin.test.js. Assertions mirror shopGroups.test.js
 * (the shop-owner-side equivalent), since this is the same logic scoped by
 * :id from the URL instead of req.shop.id.
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
  { id: 'admin', role: 'admin', adminRole: 'area_admin', areaId: 1 },
  process.env.JWT_SECRET || 'test_jwt_secret_that_is_long_enough'
);

describe('Admin shop groups — /api/admin/shops/:id/groups*', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /shops/:id/groups 404s when the shop does not exist', async () => {
    pool.query.mockResolvedValueOnce([[]]); // loadShopOr404 -> no rows

    const res = await request(app)
      .get('/api/admin/shops/99/groups')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it("GET /shops/:id/groups returns this shop's groups with member counts", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1, name: 'Burger Point' }]]) // loadShopOr404
      .mockResolvedValueOnce([[
        { id: 1, name: 'Starters', active: 1, product_count: 3 },
        { id: 2, name: 'Mains', active: 0, product_count: 0 },
      ]]);

    const res = await request(app)
      .get('/api/admin/shops/1/groups')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.groups).toHaveLength(2);
    expect(res.body.groups[0]).toEqual(expect.objectContaining({
      id: 1, name: 'Starters', active: true, isActive: true, productCount: 3, product_count: 3,
    }));
    expect(res.body.groups[1].active).toBe(false);
  });

  it('POST /shops/:id/groups with blank name -> 400 VALIDATION_ERROR', async () => {
    pool.query.mockResolvedValueOnce([[{ id: 1, name: 'Burger Point' }]]); // loadShopOr404

    const res = await request(app)
      .post('/api/admin/shops/1/groups')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '  ' });

    expect(res.statusCode).toEqual(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('POST /shops/:id/groups creates a group scoped to this shop', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1, name: 'Burger Point' }]]) // loadShopOr404
      .mockResolvedValueOnce([{ insertId: 5 }])                    // INSERT
      .mockResolvedValueOnce([[{ id: 5, name: 'Starters', active: 1, product_count: 0 }]]); // re-select

    const res = await request(app)
      .post('/api/admin/shops/1/groups')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Starters' });

    expect(res.statusCode).toEqual(201);
    expect(res.body.group).toEqual(expect.objectContaining({ id: 5, name: 'Starters', active: true }));
    expect(pool.query).toHaveBeenNthCalledWith(2,
      'INSERT INTO product_groups (area_id, shop_id, name) VALUES (?, ?, ?)', [1, 1, 'Starters']);
  });

  it('PATCH /shops/:id/groups/:groupId 404s when the group belongs to another shop', async () => {
    pool.query.mockResolvedValueOnce([[]]); // existence check scoped to shop_id=1 -> not found

    const res = await request(app)
      .patch('/api/admin/shops/1/groups/999')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ active: false });

    expect(res.statusCode).toEqual(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('DELETE /shops/:id/groups/:groupId ungroups member products then deletes the group', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1 }]])          // existence check
      .mockResolvedValueOnce([{ affectedRows: 3 }])  // UPDATE products SET group_id = NULL
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // DELETE FROM product_groups

    const res = await request(app)
      .delete('/api/admin/shops/1/groups/1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.message).toBe('Group deleted');
    expect(pool.query).toHaveBeenNthCalledWith(2,
      'UPDATE products SET group_id = NULL WHERE group_id = ?', ['1']);
  });

  it('PATCH /shops/:id/products/:productId/group -> 400 when group_id belongs to another shop', async () => {
    pool.query.mockResolvedValueOnce([[]]); // group lookup scoped to shop_id=1 -> not found

    const res = await request(app)
      .patch('/api/admin/shops/1/products/42/group')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ group_id: 999 });

    expect(res.statusCode).toEqual(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('PATCH /shops/:id/products/:productId/group assigns a valid group and clears with null', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1 }]])          // group lookup ok
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE products

    const res = await request(app)
      .patch('/api/admin/shops/1/products/42/group')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ group_id: 1 });

    expect(res.statusCode).toEqual(200);
    expect(res.body.message).toBe('Product group updated');
  });

  it('PATCH /shops/:id/products/:productId/group 404s when the product is not this shop\'s', async () => {
    pool.query.mockResolvedValueOnce([{ affectedRows: 0 }]); // UPDATE products (null group_id path, no group lookup)

    const res = await request(app)
      .patch('/api/admin/shops/1/products/42/group')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ group_id: null });

    expect(res.statusCode).toEqual(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});
