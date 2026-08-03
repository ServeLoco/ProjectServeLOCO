/**
 * ADMIN TASK 2 — mobile admin CRUD + role exclusivity with shop owners/riders.
 */
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn(), getConnection: jest.fn() },
}));
jest.mock('../src/realtime/socket', () => ({
  emitToAdmins: jest.fn(),
  emitToCustomer: jest.fn(),
  emitToAllCustomers: jest.fn(),
}));
jest.mock('../src/utils/shops', () => ({
  syncGlobalShopOpenState: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/controllers/settingsController', () => ({
  bustSettingsCache: jest.fn(),
}));

const adminRoutes = require('../src/routes/adminRoutes');
const { pool } = require('../src/db/mysql');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const adminToken = () => jwt.sign(
  { id: 'admin-1', role: 'admin', adminRole: 'area_admin', areaId: 1 },
  process.env.JWT_SECRET || 'test_jwt_secret_that_is_long_enough'
);

describe('Admin mobile-admins API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockReset();
  });

  it('lists mobile admins', async () => {
    pool.query.mockResolvedValueOnce([[{
      id: 1, phone: '9876543210', display_name: 'Owner Phone', user_id: 5,
      active: 1, created_at: null, user_name: 'Yash',
    }]]);

    const res = await request(app)
      .get('/api/admin/mobile-admins')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.mobileAdmins).toHaveLength(1);
    expect(res.body.mobileAdmins[0].displayName).toBe('Owner Phone');
  });

  it('rejects a phone shorter than 10 digits', async () => {
    const res = await request(app)
      .post('/api/admin/mobile-admins')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ phone: '999' });

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('creates a mobile admin for a phone with no existing user row yet', async () => {
    pool.query
      .mockResolvedValueOnce([[]]) // users lookup — no user yet
      .mockResolvedValueOnce([{ insertId: 9 }]) // INSERT mobile_admins
      .mockResolvedValueOnce([[{ // fetchMobileAdminRow re-query
        id: 9, phone: '9876543210', display_name: 'New Admin', user_id: null,
        active: 1, created_at: null, user_name: null,
      }]]);

    const res = await request(app)
      .post('/api/admin/mobile-admins')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ phone: '+91 98765 43210', displayName: 'New Admin' });

    expect(res.statusCode).toBe(201);
    expect(res.body.mobileAdmin.id).toBe(9);
    expect(res.body.mobileAdmin.userId).toBeNull();
  });

  it('create fails 409 if phone is an active shop owner', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 7, name: 'Reza' }]]) // users lookup — found
      .mockResolvedValueOnce([[{ id: 1 }]]); // active shop for this user

    const res = await request(app)
      .post('/api/admin/mobile-admins')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ phone: '9999999999' });

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('ROLE_CONFLICT');
  });

  it('create fails 409 if phone is an active rider', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 7, name: 'Ravi' }]]) // users lookup — found
      .mockResolvedValueOnce([[]]) // not a shop owner
      .mockResolvedValueOnce([[{ id: 3 }]]); // active rider row

    const res = await request(app)
      .post('/api/admin/mobile-admins')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ phone: '9999999999' });

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('ROLE_CONFLICT');
  });

  it('create fails 409 on duplicate phone (DB unique constraint)', async () => {
    const dupError = Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
    pool.query
      .mockResolvedValueOnce([[]]) // users lookup — no user
      .mockRejectedValueOnce(dupError); // INSERT throws dup

    const res = await request(app)
      .post('/api/admin/mobile-admins')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ phone: '9999999999' });

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('ALREADY_MOBILE_ADMIN');
  });

  it('patch deactivates a mobile admin', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 9, phone: '9876543210', display_name: 'X', user_id: 5, active: 1 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE active = 0
      .mockResolvedValueOnce([[{ // fetchMobileAdminRow re-query
        id: 9, phone: '9876543210', display_name: 'X', user_id: 5, active: 0, created_at: null, user_name: 'Yash',
      }]]);

    const res = await request(app)
      .patch('/api/admin/mobile-admins/9')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ active: false });

    expect(res.statusCode).toBe(200);
    expect(res.body.mobileAdmin.active).toBe(false);
  });

  it('patch reactivate fails 409 if user became a rider meanwhile', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 9, phone: '9876543210', display_name: 'X', user_id: 5, active: 0 }]])
      .mockResolvedValueOnce([[]]) // not a shop owner
      .mockResolvedValueOnce([[{ id: 4 }]]); // now an active rider

    const res = await request(app)
      .patch('/api/admin/mobile-admins/9')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ active: true });

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('ROLE_CONFLICT');
  });

  it('super_admin with no X-Area-Id gets 400, never a guessed area', async () => {
    const superToken = jwt.sign(
      { id: 'admin-1', role: 'admin', adminRole: 'super_admin' },
      process.env.JWT_SECRET || 'test_jwt_secret_that_is_long_enough'
    );

    const res = await request(app)
      .get('/api/admin/mobile-admins')
      .set('Authorization', `Bearer ${superToken}`);

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('list scopes the query to the admin\'s own area_id', async () => {
    pool.query.mockResolvedValueOnce([[]]);

    await request(app)
      .get('/api/admin/mobile-admins')
      .set('Authorization', `Bearer ${adminToken()}`);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('ma.area_id = ?');
    expect(params).toEqual([1]);
  });

  it('create INSERTs with the admin\'s area_id, never a null/omitted value', async () => {
    pool.query
      .mockResolvedValueOnce([[]]) // users lookup — no user yet
      .mockResolvedValueOnce([{ insertId: 9 }]) // INSERT mobile_admins
      .mockResolvedValueOnce([[{
        id: 9, phone: '9876543210', display_name: 'New Admin', user_id: null,
        active: 1, created_at: null, user_name: null,
      }]]);

    await request(app)
      .post('/api/admin/mobile-admins')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ phone: '9876543210', displayName: 'New Admin' });

    const [insertSql, insertParams] = pool.query.mock.calls[1];
    expect(insertSql).toContain('INSERT INTO mobile_admins (area_id,');
    expect(insertParams[0]).toBe(1);
  });

  it('patch phone change while active fails 409 if new phone is a shop owner', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 9, phone: '9876543210', display_name: 'X', user_id: 5, active: 1 }]])
      .mockResolvedValueOnce([[]]) // no duplicate mobile admin for new phone
      .mockResolvedValueOnce([[{ id: 8 }]]) // users row for new phone
      .mockResolvedValueOnce([[{ id: 2 }]]); // that user is an active shop owner

    const res = await request(app)
      .patch('/api/admin/mobile-admins/9')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ phone: '9999999999' });

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('ROLE_CONFLICT');
  });
});
