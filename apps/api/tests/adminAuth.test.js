const request = require('supertest');
const express = require('express');
const bcrypt = require('bcrypt');
const adminRoutes = require('../src/routes/adminRoutes');

jest.mock('../src/db/mysql', () => ({
  pool: {
    query: jest.fn()
  }
}));

const { pool } = require('../src/db/mysql');

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

// Low cost factor — these tests only care about compare() correctness, not
// real-world hashing cost.
const BCRYPT_ROUNDS = 4;

describe('Admin Auth Tests', () => {
  beforeEach(() => {
    // resetAllMocks, not clearAllMocks: clearAllMocks wipes call history but
    // leaves queued mockResolvedValueOnce values in place, so a test whose
    // code path consumes fewer pool.query calls than it queued bleeds the
    // leftovers into the next test — which reads as an unrelated failure
    // several tests later.
    jest.resetAllMocks();
    delete process.env.ADMIN_OWNER_ID;
    delete process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_PASSWORD_HASH;
  });

  describe('legacy env-password bootstrap (admins table empty)', () => {
    it('logs in with correct credentials using ADMIN_PASSWORD', async () => {
      process.env.ADMIN_OWNER_ID = 'admin';
      process.env.ADMIN_PASSWORD = 'admin';
      delete process.env.ADMIN_PASSWORD_HASH;

      pool.query
        .mockResolvedValueOnce([[]]) // SELECT ... FROM admins WHERE username = ? -> no row
        .mockResolvedValueOnce([[{ cnt: 0 }]]); // SELECT COUNT(*) FROM admins -> empty table

      const res = await request(app)
        .post('/api/admin/login')
        .send({ ownerId: 'admin', password: 'admin' });

      if (res.statusCode !== 200) console.log(res.body);
      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('token');
      expect(res.body.user.role).toEqual('admin');
      // Bootstrap login is always treated as a super_admin with no area.
      expect(res.body.user.adminRole).toEqual('super_admin');
      expect(res.body.user.admin_role).toEqual('super_admin');
      expect(res.body.user.areaId).toBeNull();
      expect(res.body.user.area_id).toBeNull();
    });

    it('fails with incorrect credentials', async () => {
      process.env.ADMIN_OWNER_ID = 'admin';
      process.env.ADMIN_PASSWORD = 'admin';
      delete process.env.ADMIN_PASSWORD_HASH;

      pool.query
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([[{ cnt: 0 }]]);

      const res = await request(app)
        .post('/api/admin/login')
        .send({ ownerId: 'admin', password: 'wrong' });

      expect(res.statusCode).toEqual(401);
      expect(res.body.message).toContain('Invalid admin credentials');
    });

    it('never falls back to the env password once the admins table has any rows', async () => {
      process.env.ADMIN_OWNER_ID = 'admin';
      process.env.ADMIN_PASSWORD = 'admin';

      pool.query
        .mockResolvedValueOnce([[]]) // username doesn't match any real admin row either
        .mockResolvedValueOnce([[{ cnt: 1 }]]); // but the table is NOT empty

      const res = await request(app)
        .post('/api/admin/login')
        .send({ ownerId: 'admin', password: 'admin' });

      expect(res.statusCode).toEqual(401);
    });
  });

  describe('real admins table row', () => {
    it('logs in a super_admin and returns adminRole/areaId in both casings', async () => {
      const hash = bcrypt.hashSync('correct-password', BCRYPT_ROUNDS);
      pool.query.mockResolvedValueOnce([[
        { id: 1, username: 'owner', password_hash: hash, role: 'super_admin', area_id: null, active: 1 },
      ]]);

      const res = await request(app)
        .post('/api/admin/login')
        .send({ ownerId: 'owner', password: 'correct-password' });

      expect(res.statusCode).toEqual(200);
      expect(res.body.user).toMatchObject({
        id: 1,
        role: 'admin',
        adminRole: 'super_admin',
        admin_role: 'super_admin',
        areaId: null,
        area_id: null,
      });
    });

    it('logs in an area_admin and returns their area id', async () => {
      const hash = bcrypt.hashSync('correct-password', BCRYPT_ROUNDS);
      pool.query.mockResolvedValueOnce([[
        { id: 2, username: 'area2admin', password_hash: hash, role: 'area_admin', area_id: 2, active: 1 },
      ]]);

      const res = await request(app)
        .post('/api/admin/login')
        .send({ ownerId: 'area2admin', password: 'correct-password' });

      expect(res.statusCode).toEqual(200);
      expect(res.body.user).toMatchObject({
        id: 2,
        adminRole: 'area_admin',
        areaId: 2,
        area_id: 2,
      });
    });

    it('rejects a real admin with the wrong password (and does not fall through to env)', async () => {
      const hash = bcrypt.hashSync('correct-password', BCRYPT_ROUNDS);
      process.env.ADMIN_OWNER_ID = 'owner';
      process.env.ADMIN_PASSWORD = 'wrong-attempt'; // matches what's being sent, but must not be consulted
      pool.query.mockResolvedValueOnce([[
        { id: 1, username: 'owner', password_hash: hash, role: 'super_admin', area_id: null, active: 1 },
      ]]);

      const res = await request(app)
        .post('/api/admin/login')
        .send({ ownerId: 'owner', password: 'wrong-attempt' });

      expect(res.statusCode).toEqual(401);
    });

    it('rejects a deactivated admin and does not fall back to env even if the table is otherwise non-empty', async () => {
      const hash = bcrypt.hashSync('correct-password', BCRYPT_ROUNDS);
      pool.query
        .mockResolvedValueOnce([[
          { id: 3, username: 'disabled', password_hash: hash, role: 'area_admin', area_id: 1, active: 0 },
        ]])
        .mockResolvedValueOnce([[{ cnt: 1 }]]); // table not empty -> fallback path is never eligible

      const res = await request(app)
        .post('/api/admin/login')
        .send({ ownerId: 'disabled', password: 'correct-password' });

      expect(res.statusCode).toEqual(401);
    });
  });
});
