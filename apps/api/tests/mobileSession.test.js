/**
 * ADMIN TASK 3 — POST /api/admin/mobile-session mints an admin JWT for an
 * OTP-logged-in phone that is an active mobile admin.
 */
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn(), getConnection: jest.fn() },
}));

const adminRoutes = require('../src/routes/adminRoutes');
const { pool } = require('../src/db/mysql');
const { verifyToken } = require('../src/utils/auth');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_that_is_long_enough';
const customerToken = (userId) => jwt.sign({ sub: userId, role: 'customer' }, JWT_SECRET);
const adminToken = () => jwt.sign({ sub: 'mobile:1', role: 'admin' }, JWT_SECRET);

describe('POST /api/admin/mobile-session', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockReset();
  });

  it('rejects an admin JWT (must be customer token)', async () => {
    const res = await request(app)
      .post('/api/admin/mobile-session')
      .set('Authorization', `Bearer ${adminToken()}`);

    expect(res.statusCode).toBe(403);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('mints an admin token for an active mobile admin found by user_id', async () => {
    pool.query.mockResolvedValueOnce([[{ id: 4, phone: '9876543210', user_id: 12, active: 1, area_id: 7 }]]);

    const res = await request(app)
      .post('/api/admin/mobile-session')
      .set('Authorization', `Bearer ${customerToken(12)}`);

    expect(res.statusCode).toBe(200);
    // adminRole/areaId are required on the token (bug fix, multi-area audit
    // finding #1) — without them, requestAreaId() throws for every
    // admin-route controller a mobile admin's app calls afterward.
    expect(res.body.user).toEqual({
      id: 4, role: 'admin', mobileAdminId: 4, adminRole: 'area_admin', areaId: 7, area_id: 7,
    });
    const decoded = verifyToken(res.body.token);
    expect(decoded.role).toBe('admin');
    expect(decoded.sub).toBe('mobile:4');
    expect(decoded.adminRole).toBe('area_admin');
    expect(decoded.areaId).toBe(7);
  });

  it('backfills user_id when found by phone but not yet linked', async () => {
    pool.query
      .mockResolvedValueOnce([[]]) // not found by user_id
      .mockResolvedValueOnce([[{ phone: '9876543210' }]]) // users lookup for phone
      .mockResolvedValueOnce([[{ id: 4, phone: '9876543210', user_id: null, active: 1, area_id: 7 }]]) // found by phone
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE user_id backfill

    const res = await request(app)
      .post('/api/admin/mobile-session')
      .set('Authorization', `Bearer ${customerToken(12)}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.user.mobileAdminId).toBe(4);
    expect(pool.query).toHaveBeenCalledWith('UPDATE mobile_admins SET user_id = ? WHERE id = ?', [12, 4]);
  });

  it('403s when the phone is not an active mobile admin', async () => {
    pool.query
      .mockResolvedValueOnce([[]]) // not found by user_id
      .mockResolvedValueOnce([[{ phone: '9999999999' }]]) // users lookup
      .mockResolvedValueOnce([[]]); // not found by phone either

    const res = await request(app)
      .post('/api/admin/mobile-session')
      .set('Authorization', `Bearer ${customerToken(99)}`);

    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('NOT_MOBILE_ADMIN');
  });
});
