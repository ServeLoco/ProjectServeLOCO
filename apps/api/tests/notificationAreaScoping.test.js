/**
 * TASK 16 — per-area admin notifications + broadcast targeting.
 *   - target: 'everyone' scopes to the caller's own area by default
 *     (area_admin always; super_admin unless X-Area-Id: all).
 *   - super_admin must pick a concrete area or 'all' — no silent default.
 *   - the operational inbox (admin_notifications) is scoped the same way.
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
jest.mock('../src/utils/expoPush', () => ({
  sendPushToMany: jest.fn().mockResolvedValue({ recipients: 0, tokensFound: 0, sent: 0, failed: 0 }),
  countPushEligible: jest.fn().mockResolvedValue(0),
}));

const adminRoutes = require('../src/routes/adminRoutes');
const { pool } = require('../src/db/mysql');
const areaScope = require('../src/utils/areaScope');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

// createBroadcastNotification runs its writes inside a transaction it owns
// (pool.getConnection()) — the returned connection's query() replays the
// same queued pool.query mocks so call-order assertions still line up.
const makeTxConn = () => ({
  query: (...args) => pool.query(...args),
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  commit: jest.fn().mockResolvedValue(undefined),
  rollback: jest.fn().mockResolvedValue(undefined),
  release: jest.fn(),
});

const areaAdminToken = jwt.sign(
  { id: 'admin-1', role: 'admin', adminRole: 'area_admin', areaId: 1 },
  process.env.JWT_SECRET || 'test_jwt_secret_that_is_long_enough'
);
const superAdminToken = jwt.sign(
  { id: 'admin-2', role: 'admin', adminRole: 'super_admin', areaId: null },
  process.env.JWT_SECRET || 'test_jwt_secret_that_is_long_enough'
);

describe('Broadcast + inbox area scoping (TASK 16)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pool.query.mockReset();
    pool.getConnection.mockReset();
    pool.getConnection.mockResolvedValue(makeTxConn());
    areaScope._resetCachesForTests();
  });

  it("area_admin's 'everyone' broadcast queries users by their own area's last_area_id", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 5 }, { id: 6 }]]) // users in area 1
      .mockResolvedValueOnce([{ insertId: 1, affectedRows: 1 }]) // notification_batches insert
      .mockResolvedValueOnce([{ affectedRows: 2 }]) // notifications bulk insert
      .mockResolvedValueOnce([[]]); // batch-load for socket emit

    const res = await request(app)
      .post('/api/admin/notifications')
      .set('Authorization', `Bearer ${areaAdminToken}`)
      .send({ title: 'Hi', body: 'Body', type: 'info', target: 'everyone' });

    expect(res.statusCode).toBe(201);
    const [usersSql, usersParams] = pool.query.mock.calls[0];
    expect(usersSql).toContain('last_area_id = ?');
    expect(usersParams).toEqual([1]);

    const [batchSql, batchParams] = pool.query.mock.calls[1];
    expect(batchSql).toContain('INSERT INTO notification_batches');
    expect(batchParams[0]).toBe(1); // area_id column, first bound param
    expect(res.body.data.audienceNote).toMatch(/Approximate/);
  });

  it("super_admin's 'everyone' broadcast with X-Area-Id: all skips the last_area_id filter", async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 5 }]]) // every non-blocked user
      .mockResolvedValueOnce([[{ id: 1, code: 'A1', name: 'Area 1', active: 1, is_default: 1 }]]) // getDefaultArea's areas lookup
      .mockResolvedValueOnce([{ insertId: 2, affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[]]);

    const res = await request(app)
      .post('/api/admin/notifications')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .set('X-Area-Id', 'all')
      .send({ title: 'Hi', body: 'Body', type: 'info', target: 'everyone' });

    expect(res.statusCode).toBe(201);
    const [usersSql] = pool.query.mock.calls[0];
    expect(usersSql).not.toContain('last_area_id');
    expect(res.body.data.audienceNote).toMatch(/every area/);
  });

  it('super_admin gets 400 without picking an area or "all"', async () => {
    const res = await request(app)
      .post('/api/admin/notifications')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ title: 'Hi', body: 'Body', type: 'info', target: 'everyone' });

    expect(res.statusCode).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("area_admin's inbox unread-count is scoped to their own area", async () => {
    pool.query.mockResolvedValueOnce([[{ n: 3 }]]);

    const res = await request(app)
      .get('/api/admin/inbox/unread-count')
      .set('Authorization', `Bearer ${areaAdminToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBe(3);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('area_id = ?');
    expect(params).toEqual([1]);
  });
});
