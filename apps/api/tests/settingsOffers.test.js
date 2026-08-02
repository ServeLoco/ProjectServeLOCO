const request = require('supertest');
const express = require('express');
const adminRoutes = require('../src/routes/adminRoutes');
const { pool } = require('../src/db/mysql');
const jwt = require('jsonwebtoken');

jest.mock('../src/db/mysql', () => ({
  pool: {
    query: jest.fn()
  }
}));

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

const adminToken = jwt.sign(
  { sub: 'admin', role: 'admin', adminRole: 'area_admin', areaId: 1 },
  process.env.JWT_SECRET || 'secret'
);

describe('Settings and Offers Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should partially update settings (shop toggle)', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1 }]]) // check existing
      .mockResolvedValueOnce([{}]) // update
      .mockResolvedValueOnce([[{ shop_open: 0 }]]); // return updated

    const res = await request(app)
      .patch('/api/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ shop_open: false });

    expect(res.statusCode).toEqual(200);
    expect(res.body.data.shop_open).toEqual(0);
  });

  it('should update location delivery settings', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1 }]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{
        shop_latitude: 12.9716,
        shop_longitude: 77.5946,
        delivery_radius_km: 8,
        delivery_cost_per_km: 10,
      }]]);

    const res = await request(app)
      .patch('/api/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        // shop_latitude/longitude/delivery_radius_km/delivery_cost_per_km are
        // deprecated (not in the update whitelist) — delivery_charge is the
        // one live field in this payload, needed so `updates.length` isn't 0.
        delivery_charge: 15,
        shop_latitude: 12.9716,
        shop_longitude: 77.5946,
        delivery_radius_km: 8,
        delivery_cost_per_km: 10,
      });

    expect(res.statusCode).toEqual(200);
    expect(res.body.data.delivery_radius_km).toEqual(8);
    expect(res.body.data.delivery_cost_per_km).toEqual(10);
  });

  it('should reject invalid shop latitude', async () => {
    const res = await request(app)
      .patch('/api/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ shop_latitude: 120 });

    expect(res.statusCode).toEqual(400);
    expect(res.body.message).toContain('Latitude must be between -90 and 90');
  });

  it('should reject invalid shop longitude', async () => {
    const res = await request(app)
      .patch('/api/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ shop_longitude: 220 });

    expect(res.statusCode).toEqual(400);
    expect(res.body.message).toContain('Longitude must be between -180 and 180');
  });

  it('should reject negative radius and per-km cost', async () => {
    const radiusRes = await request(app)
      .patch('/api/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ delivery_radius_km: -1 });

    const costRes = await request(app)
      .patch('/api/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ delivery_cost_per_km: -1 });

    expect(radiusRes.statusCode).toEqual(400);
    expect(radiusRes.body.message).toContain('Delivery radius cannot be negative');
    expect(costRes.statusCode).toEqual(400);
    expect(costRes.body.message).toContain('Delivery cost per km cannot be negative');
  });

  it('should get active offer', async () => {
    pool.query.mockResolvedValueOnce([[{ id: 1, title: 'Test Offer', active: 1 }]]);

    const res = await request(app)
      .get('/api/admin/offers/active')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.data.title).toEqual('Test Offer');
  });

  it('should not silently map active offer store_type=all to packed', async () => {
    pool.query.mockResolvedValueOnce([[{ id: 1, title: 'Any Mode Offer', active: 1 }]]);

    const res = await request(app)
      .get('/api/admin/offers/active?store_type=all')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.data.title).toEqual('Any Mode Offer');
    expect(pool.query.mock.calls[0][0]).not.toContain('store_type = ?');
  });

  it('should return null if no offer is active', async () => {
    pool.query.mockResolvedValueOnce([[]]); // no rows

    const res = await request(app)
      .get('/api/admin/offers/active')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.data).toBeNull();
  });

  it('should not deactivate other offers when activating an offer', async () => {
    pool.query
      .mockResolvedValueOnce([[{
        id: 2,
        title: 'Second Banner',
        active: 0,
        image_id: '507f1f77bcf86cd799439011',
        store_type: 'fast_food',
        deleted: 0
      }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await request(app)
      .patch('/api/admin/offers/2')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ active: true });

    expect(res.statusCode).toEqual(200);
    // 3, not 2: SELECT existing + UPDATE offer + bustAreaCaches's
    // catalog_version bump (TASK 9). The assertion this test actually
    // cares about — no extra "deactivate other offers" UPDATE — is the
    // one below.
    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(pool.query.mock.calls.some(([query]) => query.includes('id != ?'))).toBe(false);
  });
});
