const request = require('supertest');
const express = require('express');
const adminRoutes = require('../src/routes/adminRoutes');
const { pool } = require('../src/db/mysql');
const jwt = require('jsonwebtoken');

jest.mock('../src/db/mysql', () => ({
  pool: {
    query: jest.fn(),
    getConnection: jest.fn().mockResolvedValue({
      beginTransaction: jest.fn(),
      query: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn()
    })
  }
}));

const app = express();
app.use(express.json());
app.use('/api/admin', adminRoutes);

// adminRole/areaId added for the "Settings radius_pricing_active guard"
// block below, which goes through updateSettings (requires a real
// req.areaId since TASK 9); harmless no-op for every other test in this
// file, which don't touch settings.
const adminToken = jwt.sign(
  { sub: 'admin', role: 'admin', adminRole: 'area_admin', areaId: 1 },
  process.env.JWT_SECRET || 'secret'
);

const SQUARE_BOUNDARY = [
  { lat: 29.51, lng: 75.45 },
  { lat: 29.51, lng: 75.47 },
  { lat: 29.53, lng: 75.47 },
  { lat: 29.53, lng: 75.45 },
];

const boundaryOfSide = (sideDeg) => [
  { lat: 29.50, lng: 75.40 },
  { lat: 29.50, lng: 75.40 + sideDeg },
  { lat: 29.50 + sideDeg, lng: 75.40 + sideDeg },
  { lat: 29.50 + sideDeg, lng: 75.40 },
];

const ZONE_ROW = {
  id: 1, name: 'Main Village', boundary: SQUARE_BOUNDARY, parent_zone_id: null,
  normal_charge: '10.00', fast_charge: '25.00',
  normal_eta_minutes: 45, fast_eta_minutes: 20, night_charge: '5.00',
  cod_enabled: 1, active: 1, created_at: '2026-07-19', updated_at: '2026-07-19',
};

describe('Admin delivery zones CRUD', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Every zone write now also calls notifyZonesChanged -> recomputeAreaBbox
    // (TASK 10), which issues its own loadActiveZones + UPDATE areas queries
    // after whatever a given test explicitly mocked. None of these tests
    // assert on that bbox recompute, so a harmless default fallback (rather
    // than every create/update/delete test appending extra
    // mockResolvedValueOnce calls it doesn't care about) keeps them focused
    // on what they're actually testing. Explicit mockResolvedValueOnce
    // chains below still take priority — this only catches calls beyond them.
    pool.query.mockImplementation(async () => [[], {}]);
  });

  it('lists zones with dual-cased fields', async () => {
    pool.query.mockResolvedValueOnce([[ZONE_ROW]]);

    const res = await request(app)
      .get('/api/admin/delivery-zones')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toEqual(expect.objectContaining({
      id: 1,
      name: 'Main Village',
      parentZoneId: null, parent_zone_id: null,
      normalCharge: 10, normal_charge: 10,
      fastCharge: 25, fast_charge: 25,
      normalEtaMinutes: 45, normal_eta_minutes: 45,
      fastEtaMinutes: 20, fast_eta_minutes: 20,
      nightCharge: 5, night_charge: 5,
      codEnabled: true, cod_enabled: true,
      active: true,
    }));
    expect(res.body.data[0].boundary).toEqual(SQUARE_BOUNDARY);
    expect(res.body.data[0].areaKm2).toBeGreaterThan(0);
    expect(res.body.data[0].extentKm).toBeGreaterThan(0);
  });

  it('lists zones sorted smallest-area first, regardless of insertion order', async () => {
    const big = { ...ZONE_ROW, id: 1, boundary: boundaryOfSide(0.10) };
    const small = { ...ZONE_ROW, id: 2, boundary: boundaryOfSide(0.02) };
    const mid = { ...ZONE_ROW, id: 3, boundary: boundaryOfSide(0.05) };
    pool.query.mockResolvedValueOnce([[big, small, mid]]);

    const res = await request(app)
      .get('/api/admin/delivery-zones')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.body.data.map((z) => z.id)).toEqual([2, 3, 1]);
  });

  it('creates a top-level zone', async () => {
    pool.query
      .mockResolvedValueOnce([{ insertId: 7 }]) // insert
      .mockResolvedValueOnce([[{ ...ZONE_ROW, id: 7 }]]); // re-select

    const res = await request(app)
      .post('/api/admin/delivery-zones')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Main Village', boundary: SQUARE_BOUNDARY, normal_charge: 10, fast_charge: 25, normal_eta_minutes: 45, fast_eta_minutes: 20, night_charge: 5, cod_enabled: true });

    expect(res.statusCode).toEqual(201);
    expect(res.body.id).toBe(7);
    expect(res.body.data.name).toBe('Main Village');
    expect(res.body.data.parentZoneId).toBeNull();

    // area_id is now the first bound param (INSERT INTO delivery_zones
    // (area_id, name, boundary, parent_zone_id, ...)).
    const insertParams = pool.query.mock.calls[0][1];
    expect(insertParams[0]).toBe(1); // area_id
    expect(insertParams[1]).toBe('Main Village');
    expect(JSON.parse(insertParams[2])).toEqual(SQUARE_BOUNDARY);
    expect(insertParams[3]).toBeNull(); // parent_zone_id
  });

  it('creates a zone nested inside a parent', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1, parent_zone_id: null }]]) // parent lookup
      .mockResolvedValueOnce([{ insertId: 8 }]) // insert
      .mockResolvedValueOnce([[{ ...ZONE_ROW, id: 8, name: 'Sub Village', parent_zone_id: 1 }]]); // re-select

    const res = await request(app)
      .post('/api/admin/delivery-zones')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Sub Village', boundary: SQUARE_BOUNDARY, parent_zone_id: 1, normal_charge: 15, fast_charge: 30 });

    expect(res.statusCode).toEqual(201);
    expect(res.body.data.parentZoneId).toBe(1);

    const insertParams = pool.query.mock.calls[1][1];
    expect(insertParams[3]).toBe(1); // parent_zone_id (area_id, name, boundary, parent_zone_id, ...)
  });

  it('rejects a boundary with fewer than 3 points', async () => {
    const res = await request(app)
      .post('/api/admin/delivery-zones')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ boundary: [{ lat: 29.5, lng: 75.5 }, { lat: 29.6, lng: 75.6 }], normal_charge: 10, fast_charge: 25 });

    expect(res.statusCode).toEqual(400);
    expect(res.body.message).toContain('Boundary must be');
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects a missing boundary', async () => {
    const res = await request(app)
      .post('/api/admin/delivery-zones')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ normal_charge: 10, fast_charge: 25 });

    expect(res.statusCode).toEqual(400);
    expect(res.body.message).toContain('Boundary must be');
  });

  // A bowtie breaks the even-odd ray-casting test in matchZone — the crossed
  // lobe reads as outside the zone. The admin map blocks these, the API must
  // too since it is reachable directly.
  it('rejects a self-intersecting (bowtie) boundary', async () => {
    const res = await request(app)
      .post('/api/admin/delivery-zones')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        boundary: [
          { lat: 29.50, lng: 75.40 },
          { lat: 29.52, lng: 75.42 },
          { lat: 29.50, lng: 75.42 },
          { lat: 29.52, lng: 75.40 },
        ],
        normal_charge: 10,
        fast_charge: 25,
      });

    expect(res.statusCode).toEqual(400);
    expect(res.body.message).toMatch(/cross each other/i);
    expect(pool.query).not.toHaveBeenCalled();
  });

  // Zero area would also win every smallest-area tiebreak in matchZone while
  // containing nothing.
  it('rejects a degenerate boundary with no enclosed area', async () => {
    const res = await request(app)
      .post('/api/admin/delivery-zones')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        boundary: [
          { lat: 29.50, lng: 75.40 },
          { lat: 29.50, lng: 75.40 },
          { lat: 29.50, lng: 75.40 },
        ],
        normal_charge: 10,
        fast_charge: 25,
      });

    expect(res.statusCode).toEqual(400);
    expect(res.body.message).toMatch(/no meaningful area/i);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects a name longer than the column allows instead of 500ing', async () => {
    const res = await request(app)
      .post('/api/admin/delivery-zones')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'x'.repeat(256), boundary: SQUARE_BOUNDARY, normal_charge: 10, fast_charge: 25 });

    expect(res.statusCode).toEqual(400);
    expect(res.body.message).toMatch(/255 characters or fewer/i);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects a parent zone that does not exist', async () => {
    pool.query.mockResolvedValueOnce([[]]); // parent lookup finds nothing

    const res = await request(app)
      .post('/api/admin/delivery-zones')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ boundary: SQUARE_BOUNDARY, parent_zone_id: 999, normal_charge: 10, fast_charge: 25 });

    expect(res.statusCode).toEqual(400);
    expect(res.body.message).toContain('Parent zone not found');
  });

  it('rejects a negative charge', async () => {
    const res = await request(app)
      .post('/api/admin/delivery-zones')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ boundary: SQUARE_BOUNDARY, normal_charge: -1, fast_charge: 25 });

    expect(res.statusCode).toEqual(400);
    expect(res.body.message).toContain('cannot be negative');
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('accepts fast charge below normal charge (fast is an add-on fee, not a replacement)', async () => {
    pool.query
      .mockResolvedValueOnce([{ insertId: 7 }]) // insert
      .mockResolvedValueOnce([[{ ...ZONE_ROW, id: 7, normal_charge: '30.00', fast_charge: '20.00' }]]); // re-select

    const res = await request(app)
      .post('/api/admin/delivery-zones')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ boundary: SQUARE_BOUNDARY, normal_charge: 30, fast_charge: 20 });

    expect(res.statusCode).toEqual(201);
  });

  it('accepts a PATCH that sinks fast below normal via merged values', async () => {
    pool.query
      .mockResolvedValueOnce([[ZONE_ROW]]) // existing (normal 10, fast 25)
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // update
      .mockResolvedValueOnce([[{ ...ZONE_ROW, normal_charge: '30.00' }]]); // re-select

    const res = await request(app)
      .patch('/api/admin/delivery-zones/1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ normal_charge: 30 }); // fast stays 25 < 30 — now allowed

    expect(res.statusCode).toEqual(200);
  });

  it('rejects a zone being set as its own parent', async () => {
    pool.query.mockResolvedValueOnce([[ZONE_ROW]]); // existing (id 1)

    const res = await request(app)
      .patch('/api/admin/delivery-zones/1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ parent_zone_id: 1 });

    expect(res.statusCode).toEqual(400);
    expect(res.body.message).toContain('own parent');
  });

  it('rejects a parent assignment that would create a nesting cycle', async () => {
    pool.query
      .mockResolvedValueOnce([[ZONE_ROW]]) // existing (id 1, top-level)
      .mockResolvedValueOnce([[{ id: 2, parent_zone_id: 1 }]]); // candidate parent (id 2) is already zone 1's child

    const res = await request(app)
      .patch('/api/admin/delivery-zones/1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ parent_zone_id: 2 });

    expect(res.statusCode).toEqual(400);
    expect(res.body.message).toContain('cycle');
  });

  it('updates a zone (camelCase body accepted)', async () => {
    pool.query
      .mockResolvedValueOnce([[ZONE_ROW]]) // existing
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // update
      .mockResolvedValueOnce([[{ ...ZONE_ROW, normal_charge: '12.00' }]]); // re-select

    const res = await request(app)
      .patch('/api/admin/delivery-zones/1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ normalCharge: 12 });

    expect(res.statusCode).toEqual(200);
    expect(res.body.data.normalCharge).toBe(12);
  });

  it('updates a zone boundary', async () => {
    const newBoundary = boundaryOfSide(0.03);
    pool.query
      .mockResolvedValueOnce([[ZONE_ROW]]) // existing
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // update
      .mockResolvedValueOnce([[{ ...ZONE_ROW, boundary: newBoundary }]]); // re-select

    const res = await request(app)
      .patch('/api/admin/delivery-zones/1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ boundary: newBoundary });

    expect(res.statusCode).toEqual(200);
    expect(res.body.data.boundary).toEqual(newBoundary);

    const updateParams = pool.query.mock.calls[1][1];
    expect(JSON.parse(updateParams[1])).toEqual(newBoundary);
  });

  // The admin UI's "— none (top-level) —" option sends parent_zone_id: null.
  // hasValue() treats null the same as absent, so this used to silently keep
  // the old parent and the selection appeared to do nothing.
  it('detaches a zone from its parent when parent_zone_id is explicitly null', async () => {
    const nested = { ...ZONE_ROW, id: 2, parent_zone_id: 1 };
    pool.query
      .mockResolvedValueOnce([[nested]])                       // existing row
      .mockResolvedValueOnce([{ affectedRows: 1 }])            // the UPDATE
      .mockResolvedValueOnce([[{ ...nested, parent_zone_id: null }]]); // re-read

    const res = await request(app)
      .patch('/api/admin/delivery-zones/2')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ parent_zone_id: null });

    expect(res.statusCode).toEqual(200);
    const updateParams = pool.query.mock.calls[1][1];
    expect(updateParams[2]).toBeNull(); // parent_zone_id column
    expect(res.body.data.parentZoneId).toBeNull();
  });

  it('keeps the existing parent when parent_zone_id is absent from the body', async () => {
    const nested = { ...ZONE_ROW, id: 2, parent_zone_id: 1 };
    pool.query
      .mockResolvedValueOnce([[nested]])
      .mockResolvedValueOnce([[{ id: 1, parent_zone_id: null }]]) // parent lookup
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[nested]]);

    const res = await request(app)
      .patch('/api/admin/delivery-zones/2')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ normal_charge: 12 });

    expect(res.statusCode).toEqual(200);
    const updateParams = pool.query.mock.calls[2][1];
    expect(updateParams[2]).toBe(1);
  });

  it('clears the name when an empty name is sent', async () => {
    pool.query
      .mockResolvedValueOnce([[ZONE_ROW]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ ...ZONE_ROW, name: null }]]);

    const res = await request(app)
      .patch('/api/admin/delivery-zones/1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '' });

    expect(res.statusCode).toEqual(200);
    const updateParams = pool.query.mock.calls[1][1];
    expect(updateParams[0]).toBeNull(); // name column
  });

  it('404s a PATCH to a missing zone', async () => {
    pool.query.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .patch('/api/admin/delivery-zones/99')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ normal_charge: 12 });

    expect(res.statusCode).toEqual(404);
  });

  it('deletes a zone', async () => {
    pool.query
      .mockResolvedValueOnce([[{ active: 1 }]])            // existence + active lookup
      .mockResolvedValueOnce([[{ radius_pricing_active: 0 }]]) // zone pricing off — guard passes
      .mockResolvedValueOnce([{ affectedRows: 1 }]);       // the DELETE

    const res = await request(app)
      .delete('/api/admin/delivery-zones/1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(200);
  });

  it('404s deleting a missing zone', async () => {
    pool.query.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .delete('/api/admin/delivery-zones/99')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(404);
  });

  // Zone pricing with zero active zones silently degrades to flat pricing for
  // everyone, including customers who should be blocked as out of area.
  it('refuses to delete the last active zone while zone pricing is ON', async () => {
    pool.query
      .mockResolvedValueOnce([[{ active: 1 }]])
      .mockResolvedValueOnce([[{ radius_pricing_active: 1 }]])
      .mockResolvedValueOnce([[{ count: 0 }]]); // no other active zone would remain

    const res = await request(app)
      .delete('/api/admin/delivery-zones/1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(400);
    expect(res.body.message).toMatch(/only active zone/i);
    // The DELETE must never have been issued.
    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  it('allows deleting an active zone when another active zone remains', async () => {
    pool.query
      .mockResolvedValueOnce([[{ active: 1 }]])
      .mockResolvedValueOnce([[{ radius_pricing_active: 1 }]])
      .mockResolvedValueOnce([[{ count: 2 }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await request(app)
      .delete('/api/admin/delivery-zones/1')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toEqual(200);
  });

  it('refuses to deactivate the last active zone while zone pricing is ON', async () => {
    pool.query
      .mockResolvedValueOnce([[ZONE_ROW]])                    // existing row
      .mockResolvedValueOnce([[{ radius_pricing_active: 1 }]])
      .mockResolvedValueOnce([[{ count: 0 }]]);

    const res = await request(app)
      .patch('/api/admin/delivery-zones/1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ active: false });

    expect(res.statusCode).toEqual(400);
    expect(res.body.message).toMatch(/only active zone/i);
  });
});

describe('Settings radius_pricing_active guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('blocks enabling the flag with no active zones', async () => {
    pool.query.mockResolvedValueOnce([[{ count: 0 }]]); // active zone count

    const res = await request(app)
      .patch('/api/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ radius_pricing_active: true });

    expect(res.statusCode).toEqual(400);
    expect(res.body.message).toContain('active delivery zone');
  });

  it('allows enabling the flag once an active zone exists', async () => {
    pool.query
      .mockResolvedValueOnce([[{ count: 1 }]]) // active zone count
      .mockResolvedValueOnce([[{ id: 1, upi_qr_image_id: null }]]) // settings id lookup
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // update
      .mockResolvedValueOnce([[{ id: 1, radius_pricing_active: 1 }]]); // re-select

    const res = await request(app)
      .patch('/api/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ radius_pricing_active: true });

    expect(res.statusCode).toEqual(200);
  });

  it('allows disabling the flag without prerequisites', async () => {
    pool.query
      .mockResolvedValueOnce([[{ id: 1, upi_qr_image_id: null }]]) // settings id lookup
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // update
      .mockResolvedValueOnce([[{ id: 1, radius_pricing_active: 0 }]]); // re-select

    const res = await request(app)
      .patch('/api/admin/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ radius_pricing_active: false });

    expect(res.statusCode).toEqual(200);
  });
});
