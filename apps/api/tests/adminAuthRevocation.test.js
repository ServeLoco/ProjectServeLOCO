/**
 * Bug fix (multi-area audit finding #5): requireAdmin used to only check
 * the single shared admin_auth_state.revoked_before kill-switch, never
 * re-reading the `admins` table itself. That left a deactivated admin, or
 * one whose role/area was just reassigned, fully authorized under their OLD
 * claims for the rest of their JWT's life (up to ADMIN_JWT_EXPIRES_IN, 12h).
 *
 * The admin_auth_state DB check (and this new admins-table re-check) is
 * gated behind `process.env.NODE_ENV !== 'test'`, so it needs a non-'test'
 * NODE_ENV to exercise at all — 'staging' avoids both the jest default skip
 * and config/env.js's production-only validation (which would reject this
 * suite's CORS_ORIGIN='*' test default).
 */
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'staging';

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn() },
}));

const { pool } = require('../src/db/mysql');
const adminRoutes = require('../src/routes/adminRoutes');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const JWT_SECRET = process.env.JWT_SECRET;
const areaAdminToken = jwt.sign(
  { sub: 4, role: 'admin', adminRole: 'area_admin', areaId: 1 },
  JWT_SECRET
);
const mobileAdminToken = jwt.sign(
  { sub: 'mobile:9', role: 'admin', adminRole: 'area_admin', areaId: 1 },
  JWT_SECRET
);

describe('requireAdmin — live re-check against admins table', () => {
  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('401s a deactivated admin even with a still-valid JWT', async () => {
    pool.query
      .mockResolvedValueOnce([[]]) // admin_auth_state — no revocation
      .mockResolvedValueOnce([[{ role: 'area_admin', area_id: 1, active: 0 }]]); // admins row — deactivated

    const res = await request(app)
      .get('/api/admin/me')
      .set('Authorization', `Bearer ${areaAdminToken}`);

    expect(res.statusCode).toBe(401);
  });

  it("reflects a live role/area reassignment instead of trusting the JWT's stale claim", async () => {
    pool.query
      .mockResolvedValueOnce([[]]) // admin_auth_state
      .mockResolvedValueOnce([[{ role: 'area_admin', area_id: 7, active: 1 }]]); // reassigned to area 7

    const res = await request(app)
      .get('/api/admin/me')
      .set('Authorization', `Bearer ${areaAdminToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.user).toMatchObject({ areaId: 7, area_id: 7 });
  });

  it('401s an admin id removed from the admins table entirely', async () => {
    pool.query
      .mockResolvedValueOnce([[]]) // admin_auth_state
      .mockResolvedValueOnce([[]]); // admins row — gone

    const res = await request(app)
      .get('/api/admin/me')
      .set('Authorization', `Bearer ${areaAdminToken}`);

    expect(res.statusCode).toBe(401);
  });

  it('does not attempt the admins-table re-check for a mobile-admin session (sub is not numeric)', async () => {
    pool.query.mockResolvedValueOnce([[]]); // admin_auth_state only

    const res = await request(app)
      .get('/api/admin/me')
      .set('Authorization', `Bearer ${mobileAdminToken}`);

    expect(res.statusCode).toBe(200);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  // Bug fix (multi-area audit finding #3): the re-check used to be skipped
  // by inferring "no admins row to re-check" from `sub` looking non-numeric
  // — which silently broke the legacy ADMIN_PASSWORD/ADMIN_PASSWORD_HASH
  // bootstrap login forever whenever ADMIN_OWNER_ID happened to be a
  // numeric value (nothing enforces it isn't). envFallback is now an
  // explicit claim signAdminToken sets on that login path, checked directly
  // instead of guessed from the shape of `sub`.
  it('does not attempt the admins-table re-check for an envFallback session even when sub is numeric', async () => {
    const envFallbackToken = jwt.sign(
      { sub: 1, role: 'admin', adminRole: 'super_admin', areaId: null, envFallback: true },
      JWT_SECRET
    );
    pool.query.mockResolvedValueOnce([[]]); // admin_auth_state only

    const res = await request(app)
      .get('/api/admin/me')
      .set('Authorization', `Bearer ${envFallbackToken}`);

    expect(res.statusCode).toBe(200);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});
