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
const DEFAULT_AREA = { id: 1, code: 'A1', name: 'Area 1', active: 1, is_default: 1 };

// This route is unauthenticated and carries no pin in these tests, so
// resolveCustomerArea (TASK 10) resolves via the default-area fallback —
// one `SELECT * FROM areas` before the zones query itself.
const mockDefaultAreaLookup = () => pool.query.mockResolvedValueOnce([[DEFAULT_AREA]]);

describe('GET /api/delivery-zones (public, geometry only)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    microCache.clearAll();
    areaScope._resetCachesForTests();
  });

  it('returns geometry without any pricing, ETA or COD fields', async () => {
    mockDefaultAreaLookup();
    pool.query.mockResolvedValueOnce([[{
      ...ZONE_ROW,
      // Even if the query were widened by accident, the mapper must not leak these.
      normal_charge: '10.00', fast_charge: '25.00', cod_enabled: 1,
    }]]);

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

  it('only selects active zones for the resolved area', async () => {
    mockDefaultAreaLookup();
    pool.query.mockResolvedValueOnce([[]]);

    await request(app).get('/api/delivery-zones');

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('active = 1'),
      [DEFAULT_AREA.id]
    );
  });

  // Unauthenticated endpoint hit by every app that opens the map — it must not
  // scan the table once per request.
  it('serves repeat requests from the micro-cache', async () => {
    mockDefaultAreaLookup();
    pool.query.mockResolvedValueOnce([[ZONE_ROW]]);

    const first = await request(app).get('/api/delivery-zones');
    // areasCache (60s) keeps the default-area lookup warm across requests too,
    // so the second request makes zero new pool.query calls at all.
    const second = await request(app).get('/api/delivery-zones');

    expect(first.body.data).toEqual(second.body.data);
    expect(pool.query).toHaveBeenCalledTimes(2); // 1 areas lookup + 1 zones query, total
  });

  it('re-reads after the cache is busted by a zone write', async () => {
    mockDefaultAreaLookup();
    pool.query
      .mockResolvedValueOnce([[ZONE_ROW]])
      .mockResolvedValueOnce([[{ ...ZONE_ROW, name: 'Renamed' }]]);

    await request(app).get('/api/delivery-zones');
    microCache.bust('delivery-zones', DEFAULT_AREA.id); // what notifyZonesChanged() does
    const res = await request(app).get('/api/delivery-zones');

    // 1 areas lookup (cached across both requests) + 2 zones queries.
    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(res.body.data[0].name).toEqual('Renamed');
  });

  it('a pin outside every zone shows no shapes rather than another area\'s', async () => {
    // resolveAreaForPoint's own two queries (bbox areas, then that area's
    // zones) both resolve to "nothing matches" for this pin.
    pool.query
      .mockResolvedValueOnce([[DEFAULT_AREA]])
      .mockResolvedValueOnce([[]]);

    const res = await request(app).get('/api/delivery-zones?latitude=10&longitude=10');

    expect(res.statusCode).toEqual(200);
    expect(res.body.data).toEqual([]);
  });
});
