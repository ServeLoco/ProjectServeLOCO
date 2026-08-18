const request = require('supertest');
const express = require('express');
const deliveryZonesRoutes = require('../src/routes/deliveryZonesRoutes');
const { pool } = require('../src/db/mysql');
const microCache = require('../src/utils/microCache');
const areaScope = require('../src/utils/areaScope');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn() },
}));

const app = express();
app.use(express.json());
app.use('/api/delivery-zones', deliveryZonesRoutes);

const BOUNDARY = [
  { lat: 29.50, lng: 75.40 },
  { lat: 29.50, lng: 75.44 },
  { lat: 29.54, lng: 75.44 },
  { lat: 29.54, lng: 75.40 },
];

const ZONE_ROW = { id: 1, name: 'Main Village', boundary: BOUNDARY, parent_zone_id: null };
// The composite ETag reads every active area's catalog_version (areaScope's
// listAreas, its own 60s-cached loadAllAreas() query) — queued after the
// zones query in every test below that expects a real DB hit.
const AREAS_ROW = { id: 1, code: 'A1', name: 'Area 1', active: 1, is_default: 1, catalog_version: 7 };

describe('GET /api/delivery-zones (public, geometry only, all areas)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    microCache.clearAll();
    areaScope._resetCachesForTests();
  });

  it('returns geometry without any pricing, ETA or COD fields', async () => {
    pool.query
      .mockResolvedValueOnce([[{
        ...ZONE_ROW,
        // Even if the query were widened by accident, the mapper must not leak these.
        normal_charge: '10.00', fast_charge: '25.00', cod_enabled: 1,
      }]])
      .mockResolvedValueOnce([[AREAS_ROW]]);

    const res = await request(app).get('/api/delivery-zones');

    expect(res.statusCode).toEqual(200);
    expect(res.body.data).toHaveLength(1);
    const zone = res.body.data[0];
    expect(zone).toEqual({
      id: 1,
      name: 'Main Village',
      boundary: BOUNDARY,
      parentZoneId: null,
      parent_zone_id: null,
    });
    expect(zone.normalCharge).toBeUndefined();
    expect(zone.codEnabled).toBeUndefined();
  });

  // The customer can be physically anywhere, independent of which area they
  // last ordered from — this overlay shows every active zone from every
  // area rather than guessing "their" area and hiding the rest.
  it('selects active zones across every area, with no area filter', async () => {
    pool.query
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[AREAS_ROW]]);

    await request(app).get('/api/delivery-zones');

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('active = 1'),
    );
    const [, params] = pool.query.mock.calls[0];
    expect(params).toBeUndefined();
  });

  it('ignores a pin on the request — still returns every area\'s zones', async () => {
    pool.query
      .mockResolvedValueOnce([[ZONE_ROW]])
      .mockResolvedValueOnce([[AREAS_ROW]]);

    const res = await request(app).get('/api/delivery-zones?latitude=10&longitude=10');

    expect(res.statusCode).toEqual(200);
    expect(res.body.data).toHaveLength(1);
    expect(pool.query).toHaveBeenCalledTimes(2); // zones + areas (for the ETag)
  });

  // Unauthenticated endpoint hit by every app that opens the map — it must not
  // scan the table once per request.
  it('serves repeat requests from the micro-cache', async () => {
    pool.query
      .mockResolvedValueOnce([[ZONE_ROW]])
      .mockResolvedValueOnce([[AREAS_ROW]]);

    const first = await request(app).get('/api/delivery-zones');
    const second = await request(app).get('/api/delivery-zones');

    expect(first.body.data).toEqual(second.body.data);
    // Zones (microCache) and areas (areaScope's own TTL cache) both serve
    // the second request from cache — no extra queries.
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it('re-reads after the cache is busted by a zone write', async () => {
    pool.query
      .mockResolvedValueOnce([[ZONE_ROW]])
      .mockResolvedValueOnce([[AREAS_ROW]])
      .mockResolvedValueOnce([[{ ...ZONE_ROW, name: 'Renamed' }]]);
    // Areas cache is untouched by a zone-only write (bustAreaCaches bumps
    // that area's catalog_version in place, doesn't clear loadAllAreas'
    // cache) — still served from cache on the second call.

    await request(app).get('/api/delivery-zones');
    microCache.bust('delivery-zones', 0); // what notifyZonesChanged() does
    const res = await request(app).get('/api/delivery-zones');

    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(res.body.data[0].name).toEqual('Renamed');
  });

  it('sets a composite ETag and returns 304 on a matching If-None-Match', async () => {
    pool.query
      .mockResolvedValueOnce([[ZONE_ROW]])
      .mockResolvedValueOnce([[AREAS_ROW]]);

    const first = await request(app).get('/api/delivery-zones');
    expect(first.statusCode).toEqual(200);
    const etag = first.headers.etag;
    expect(etag).toBeTruthy();

    const second = await request(app).get('/api/delivery-zones').set('If-None-Match', etag);
    expect(second.statusCode).toEqual(304);
    expect(second.body).toEqual({});
  });

  it('changes the ETag when an area\'s catalog_version bumps (a zone changed)', async () => {
    pool.query
      .mockResolvedValueOnce([[ZONE_ROW]])
      .mockResolvedValueOnce([[AREAS_ROW]]);
    const first = await request(app).get('/api/delivery-zones');
    const firstEtag = first.headers.etag;

    // Simulate notifyZonesChanged: bust the zones cache (new geometry) and
    // the areas cache (catalog_version bumped) independently.
    microCache.bust('delivery-zones', 0);
    areaScope._resetCachesForTests();
    pool.query
      .mockResolvedValueOnce([[{ ...ZONE_ROW, name: 'Renamed' }]])
      .mockResolvedValueOnce([[{ ...AREAS_ROW, catalog_version: 8 }]]);

    const second = await request(app).get('/api/delivery-zones').set('If-None-Match', firstEtag);
    expect(second.statusCode).toEqual(200); // stale ETag, not a 304
    expect(second.headers.etag).not.toEqual(firstEtag);
  });
});
