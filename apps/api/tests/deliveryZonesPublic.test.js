const request = require('supertest');
const express = require('express');
const deliveryZonesRoutes = require('../src/routes/deliveryZonesRoutes');
const { pool } = require('../src/db/mysql');
const microCache = require('../src/utils/microCache');

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

describe('GET /api/delivery-zones (public, geometry only)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    microCache.clearAll();
  });

  it('returns geometry without any pricing, ETA or COD fields', async () => {
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

  it('only selects active zones', async () => {
    pool.query.mockResolvedValueOnce([[]]);

    await request(app).get('/api/delivery-zones');

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('active = 1'));
  });

  // Unauthenticated endpoint hit by every app that opens the map — it must not
  // scan the table once per request.
  it('serves repeat requests from the micro-cache', async () => {
    pool.query.mockResolvedValueOnce([[ZONE_ROW]]);

    const first = await request(app).get('/api/delivery-zones');
    const second = await request(app).get('/api/delivery-zones');

    expect(first.body.data).toEqual(second.body.data);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('re-reads after the cache is busted by a zone write', async () => {
    pool.query
      .mockResolvedValueOnce([[ZONE_ROW]])
      .mockResolvedValueOnce([[{ ...ZONE_ROW, name: 'Renamed' }]]);

    await request(app).get('/api/delivery-zones');
    microCache.bust('delivery-zones'); // what notifyZonesChanged() does
    const res = await request(app).get('/api/delivery-zones');

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(res.body.data[0].name).toEqual('Renamed');
  });
});
