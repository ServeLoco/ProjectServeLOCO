/**
 * TASK 27.3-27.6 — GET /bootstrap?lat=&lng=. One response carrying area,
 * zone, settings, storeModes, zoneGeometry and catalogVersion, reusing the
 * exact same per-area helpers (getSettingsForArea, getActiveStoreModesForArea,
 * getActiveZonesForArea) the standalone endpoints already use — so this can
 * never drift from what GET /api/settings, /api/store-modes or
 * /api/delivery-zones themselves return (27.6, purely additive).
 */
const request = require('supertest');
const express = require('express');
const bootstrapRoutes = require('../src/routes/bootstrapRoutes');
const { pool } = require('../src/db/mysql');
const areaScope = require('../src/utils/areaScope');
const microCache = require('../src/utils/microCache');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn() },
}));

const app = express();
app.use(express.json());
app.use('/api/bootstrap', bootstrapRoutes);

const AREA_1 = {
  id: 1, code: 'A1', name: 'Area 1', active: 1, is_default: 1, timezone: 'Asia/Kolkata',
  min_lat: 10, max_lat: 11, min_lng: 10, max_lng: 11, catalog_version: 5,
  brand_color: '#4f46e5', logo_image_id: null,
};

describe('GET /bootstrap (TASK 27.3-27.6)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    areaScope._resetCachesForTests();
    microCache.clearAll();
  });

  it('a pin resolving into a real zone returns deliverable: true with area/zone/settings/storeModes/zoneGeometry/catalogVersion', async () => {
    pool.query
      .mockResolvedValueOnce([[AREA_1]]) // bbox candidates
      .mockResolvedValueOnce([[{ // area 1's own zone matches the pin
        id: 900, area_id: 1, name: 'Zone A', boundary: JSON.stringify([
          { lat: 10, lng: 10 }, { lat: 10, lng: 11 }, { lat: 11, lng: 11 }, { lat: 11, lng: 10 },
        ]), parent_zone_id: null, active: 1,
      }]])
      // getAreaById (catalogETag, then again inside Promise.all) reuses the
      // areasCache the bbox-candidates lookup above already populated — no
      // extra query for either call.
      .mockResolvedValueOnce([[{ id: 900, name: 'Zone A', boundary: JSON.stringify([
        { lat: 10, lng: 10 }, { lat: 10, lng: 11 }, { lat: 11, lng: 11 }, { lat: 11, lng: 10 },
      ]), parent_zone_id: null }]]) // getActiveZonesForArea
      .mockResolvedValueOnce([[{ // settings row
        area_id: 1, shop_open: 1, upi_id: 'area1@upi', upi_qr_image_id: null,
        support_phone: '9990001111', whatsapp_number: '9990001111',
      }]])
      .mockResolvedValueOnce([[{ id: 1, slug: 'packed', label: 'Packed Items', display_order: 1, is_default: 1, icon_image_url: null }]]); // store modes

    const res = await request(app).get('/api/bootstrap?latitude=10.5&longitude=10.5');

    expect(res.statusCode).toEqual(200);
    expect(res.body.deliverable).toBe(true);
    expect(res.body.area).toMatchObject({ id: 1, code: 'A1', name: 'Area 1' });
    expect(res.body.zone).toMatchObject({ id: 900, name: 'Zone A' });
    expect(res.body.catalogVersion).toEqual(5);
    expect(res.body.storeModes).toHaveLength(1);
    expect(res.body.zoneGeometry).toHaveLength(1);
    // 27.5 — money-routing fields must be the resolved area's own.
    expect(res.body.settings).toMatchObject({ upi_id: 'area1@upi', support_phone: '9990001111' });
  });

  it('a pin outside every zone returns the "we don\'t deliver here yet" shape, never the default area', async () => {
    pool.query
      .mockResolvedValueOnce([[AREA_1]]) // bbox candidates — this point IS inside area 1's bbox
      .mockResolvedValueOnce([[]]); // ...but area 1 has no zone shapes covering it

    const res = await request(app).get('/api/bootstrap?latitude=10.5&longitude=10.5');

    expect(res.statusCode).toEqual(200);
    expect(res.body).toEqual({
      deliverable: false, area: null, zone: null, settings: null, storeModes: [], zoneGeometry: [], catalogVersion: null,
    });
  });

  it('sets an ETag and 304s a matching If-None-Match', async () => {
    pool.query
      .mockResolvedValueOnce([[AREA_1]])
      .mockResolvedValueOnce([[{ id: 900, area_id: 1, name: 'Zone A', boundary: JSON.stringify([
        { lat: 10, lng: 10 }, { lat: 10, lng: 11 }, { lat: 11, lng: 11 }, { lat: 11, lng: 10 },
      ]), parent_zone_id: null, active: 1 }]]);
    // catalogETag's getAreaById reuses the areasCache the bbox lookup above
    // already populated — no extra query needed.

    const res = await request(app)
      .get('/api/bootstrap?latitude=10.5&longitude=10.5')
      .set('If-None-Match', '"1-5"');

    expect(res.statusCode).toEqual(304);
  });

  it('no pin at all falls back through users.last_area_id / the default area (resolveCustomerArea\'s own chain), not "we don\'t deliver here"', async () => {
    pool.query
      .mockResolvedValueOnce([[AREA_1]]) // listAreas() for getDefaultArea — also populates areasCache, so getAreaById needs no query of its own
      .mockResolvedValueOnce([[]]) // getActiveZonesForArea
      .mockResolvedValueOnce([[{ area_id: 1, shop_open: 1 }]]) // settings
      .mockResolvedValueOnce([[]]); // store modes

    const res = await request(app).get('/api/bootstrap');

    expect(res.statusCode).toEqual(200);
    expect(res.body.deliverable).toBe(true);
    expect(res.body.area.id).toEqual(1);
    expect(res.body.zone).toBeNull(); // no pin was ever matched to a specific zone
  });
});
