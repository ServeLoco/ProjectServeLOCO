const request = require('supertest');
const express = require('express');
const authRoutes = require('../src/routes/authRoutes');
const adminRoutes = require('../src/routes/adminRoutes');
const jwt = require('jsonwebtoken');

jest.mock('../src/db/mysql', () => ({
  pool: {
    query: jest.fn()
  }
}));

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);

const customerToken = jwt.sign({ id: 1, role: 'customer' }, process.env.JWT_SECRET || 'secret');
const adminToken = jwt.sign({ id: 'admin', role: 'admin' }, process.env.JWT_SECRET || 'secret');

const areaAdminToken = jwt.sign(
  { sub: 4, role: 'admin', adminRole: 'area_admin', areaId: 4 },
  process.env.JWT_SECRET || 'secret'
);
const superAdminToken = jwt.sign(
  { sub: 1, role: 'admin', adminRole: 'super_admin' },
  process.env.JWT_SECRET || 'secret'
);

describe('Role Protection Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should deny customer access to admin routes', async () => {
    const res = await request(app)
      .get('/api/admin/dashboard')
      .set('Authorization', `Bearer ${customerToken}`);

    expect(res.statusCode).toEqual(403);
  });

  it('should deny admin access to customer routes', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(403);
  });
});

describe('Admin area resolution (TASK 8 — requireAdmin -> resolveAdminArea)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('an area_admin with no X-Area-Id header gets their own area', async () => {
    const res = await request(app)
      .get('/api/admin/me')
      .set('Authorization', `Bearer ${areaAdminToken}`);
    expect(res.statusCode).toEqual(200);
  });

  it('an area_admin sending X-Area-Id for another area gets 403, never a silent override', async () => {
    const res = await request(app)
      .get('/api/admin/me')
      .set('Authorization', `Bearer ${areaAdminToken}`)
      .set('X-Area-Id', '9');
    expect(res.statusCode).toEqual(403);
  });

  it('an area_admin sending X-Area-Id: all also gets 403', async () => {
    const res = await request(app)
      .get('/api/admin/me')
      .set('Authorization', `Bearer ${areaAdminToken}`)
      .set('X-Area-Id', 'all');
    expect(res.statusCode).toEqual(403);
  });

  it('a super_admin with no X-Area-Id header does not error — resolves to no area picked yet', async () => {
    // /me doesn't require an area, so this just proves the request completes
    // rather than 500ing; an area-required endpoint is expected to check
    // requestAreaId()/areaScope itself and surface its own clear error.
    const res = await request(app)
      .get('/api/admin/me')
      .set('Authorization', `Bearer ${superAdminToken}`);
    expect(res.statusCode).toEqual(200);
  });

  it('a super_admin with a numeric X-Area-Id succeeds', async () => {
    const res = await request(app)
      .get('/api/admin/me')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .set('X-Area-Id', '3');
    expect(res.statusCode).toEqual(200);
  });

  it('a super_admin with a garbage X-Area-Id gets 400', async () => {
    const res = await request(app)
      .get('/api/admin/me')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .set('X-Area-Id', 'not-a-number');
    expect(res.statusCode).toEqual(400);
  });

  it('a pre-TASK-7 admin token (no adminRole claim) still authenticates — resolveAdminArea no-ops', async () => {
    const res = await request(app)
      .get('/api/admin/me')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toEqual(200);
  });
});

describe('requireSuperAdmin', () => {
  const { requireSuperAdmin } = require('../src/middleware/authMiddleware');

  it('403s an area_admin', () => {
    const req = { admin: { adminRole: 'area_admin' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    requireSuperAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('403s when there is no req.admin at all', () => {
    const req = {};
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    requireSuperAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows a super_admin through', () => {
    const req = { admin: { adminRole: 'super_admin' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    requireSuperAdmin(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });
});
