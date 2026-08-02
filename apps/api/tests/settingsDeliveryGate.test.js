/**
 * Tests for the delivery_available master gate on PATCH /api/admin/settings
 * (settingsController.updateSettings):
 *   - Manually opening shop_open while delivery_available is (or would be)
 *     off is rejected with 400.
 *   - Turning delivery_available off re-syncs shop_open closed even if not
 *     explicitly included in the same request.
 *   - Turning delivery_available back on re-syncs shop_open per the current
 *     shop states (see shopGlobalStatusSync.test.js for that logic).
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const adminRoutes = require('../src/routes/adminRoutes');
const { pool } = require('../src/db/mysql');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn() },
}));

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

// area_admin for area 1 — updateSettings requires a real req.areaId
// (resolveAdminArea, chained inside requireAdmin) since PATCH /settings
// targets exactly one area.
const adminToken = jwt.sign(
  { sub: 'admin', role: 'admin', adminRole: 'area_admin', areaId: 1 },
  process.env.JWT_SECRET || 'secret'
);

describe('PATCH /api/admin/settings — delivery_available master gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects shop_open: true when delivery_available is currently off', async () => {
    pool.query.mockResolvedValueOnce([[{ delivery_available: 0 }]]); // current-state lookup

    const res = await request(app)
      .patch('/api/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ shop_open: true });

    expect(res.statusCode).toEqual(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.message).toMatch(/delivery is turned off/);
  });

  it('coerces shop_open closed when delivery_available: false arrives in the same request', async () => {
    // The admin Settings page "save all" sends the whole form, so a stale
    // shop_open: true can ride along with delivery_available: false. That
    // must NOT reject — the intent is "delivery off"; shop_open is coerced
    // to 0 in the same write.
    pool.query
      .mockResolvedValueOnce([[{ id: 1 }]])                  // existence check
      .mockResolvedValueOnce([{}])                           // UPDATE (shop_open coerced to 0)
      .mockResolvedValueOnce([[{ delivery_available: 0 }]])  // sync: settings lookup
      .mockResolvedValueOnce([{ affectedRows: 0 }])          // sync: UPDATE (already 0)
      .mockResolvedValueOnce([[{ delivery_available: 0, shop_open: 0 }]]); // return updated

    const res = await request(app)
      .patch('/api/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ shop_open: true, delivery_available: false });

    expect(res.statusCode).toEqual(200);
    // The UPDATE wrote shop_open = 0, not 1 — coercion happened before the
    // write. shop_open is first in the controller's fields list, so it's the
    // first SET clause and the first param.
    const updateCall = pool.query.mock.calls[1];
    expect(updateCall[0]).toMatch(/UPDATE settings SET shop_open = \?/);
    expect(updateCall[1][0]).toBe(0);
    expect(res.body.data.shop_open).toBe(0);
  });

  it('allows shop_open: true when delivery_available is currently on', async () => {
    pool.query
      .mockResolvedValueOnce([[{ delivery_available: 1 }]]) // current-state lookup
      .mockResolvedValueOnce([[{ id: 1 }]])                  // existence check
      .mockResolvedValueOnce([{}])                           // UPDATE
      .mockResolvedValueOnce([[{ shop_open: 1 }]]);          // return updated

    const res = await request(app)
      .patch('/api/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ shop_open: true });

    expect(res.statusCode).toEqual(200);
  });

  it('turning delivery_available off re-syncs shop_open closed', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1 }]])                  // existence check
      .mockResolvedValueOnce([{}])                           // UPDATE delivery_available = 0
      .mockResolvedValueOnce([[{ delivery_available: 0 }]])  // sync: settings lookup
      .mockResolvedValueOnce([{ affectedRows: 1 }])          // sync: UPDATE shop_open = 0
      .mockResolvedValueOnce([[{ delivery_available: 0, shop_open: 0 }]]); // return updated

    const res = await request(app)
      .patch('/api/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ delivery_available: false });

    expect(res.statusCode).toEqual(200);
    expect(pool.query).toHaveBeenNthCalledWith(4, 'UPDATE settings SET shop_open = 0 WHERE shop_open = 1 AND area_id = 1');
  });

  it('turning delivery_available back on re-syncs shop_open per shop states', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1 }]])                            // existence check
      .mockResolvedValueOnce([{}])                                     // UPDATE delivery_available = 1
      .mockResolvedValueOnce([[{ delivery_available: 1 }]])            // sync: settings lookup
      .mockResolvedValueOnce([[{ total_active: 2, total_open: 1 }]])   // sync: shops SUM
      .mockResolvedValueOnce([{ affectedRows: 1 }])                    // sync: UPDATE shop_open = 1
      .mockResolvedValueOnce([[{ delivery_available: 1, shop_open: 1 }]]); // return updated

    const res = await request(app)
      .patch('/api/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ delivery_available: true });

    expect(res.statusCode).toEqual(200);
    expect(pool.query).toHaveBeenNthCalledWith(5, 'UPDATE settings SET shop_open = ? WHERE shop_open != ? AND area_id = 1', [1, 1]);
  });

  it('a plain shop_open: false close is never blocked by the gate', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1 }]]) // existence check
      .mockResolvedValueOnce([{}])          // UPDATE
      .mockResolvedValueOnce([[{ shop_open: 0 }]]); // return updated

    const res = await request(app)
      .patch('/api/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ shop_open: false });

    expect(res.statusCode).toEqual(200);
  });
});
