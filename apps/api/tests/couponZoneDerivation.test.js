const request = require('supertest');
const express = require('express');
const cartRoutes = require('../src/routes/cartRoutes');
const { pool } = require('../src/db/mysql');
const jwt = require('jsonwebtoken');
const areaScope = require('../src/utils/areaScope');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn(), getConnection: jest.fn() }
}));

jest.mock('../src/utils/coupons', () => ({
  validateCoupon: jest.fn().mockResolvedValue({ ok: false, reason: 'No coupon' }),
  validateCouponById: jest.fn().mockResolvedValue({ ok: false, reason: 'Coupon not found' }),
  pickBestAutoApply: jest.fn().mockResolvedValue(null),
  findApplicableCoupons: jest.fn().mockResolvedValue([]),
  getNextFreeDeliveryThreshold: jest.fn().mockResolvedValue(null),
  getNearestUnlockableCoupon: jest.fn().mockResolvedValue(null),
}));

const { validateCoupon, findApplicableCoupons } = require('../src/utils/coupons');

const app = express();
app.use(express.json());
app.use('/api/cart', cartRoutes);

const token = jwt.sign({ id: 1, role: 'customer' }, process.env.JWT_SECRET || 'secret');

const CENTER = { lat: 29.5152, lng: 75.4548 };
const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LNG_AT_EQUATOR = 111.320;

const offsetPoint = (lat, lng, dLatKm, dLngKm) => ({
  lat: lat + dLatKm / KM_PER_DEG_LAT,
  lng: lng + dLngKm / (KM_PER_DEG_LNG_AT_EQUATOR * Math.cos(lat * Math.PI / 180)),
});

const squareBoundary = (sideKm) => {
  const half = sideKm / 2;
  return [
    offsetPoint(CENTER.lat, CENTER.lng, -half, -half),
    offsetPoint(CENTER.lat, CENTER.lng, -half, half),
    offsetPoint(CENTER.lat, CENTER.lng, half, half),
    offsetPoint(CENTER.lat, CENTER.lng, half, -half),
  ];
};

const ZONE_ROW = {
  id: 7, name: 'Main Village', parent_zone_id: null, boundary: squareBoundary(10),
  normal_charge: '10.00', fast_charge: '25.00',
  normal_eta_minutes: 45, fast_eta_minutes: 20, night_charge: '0.00',
  cod_enabled: 1, active: 1,
};

const AREA_ROW = { id: 1, code: 'A1', name: 'Area 1', active: 1, is_default: 1, min_lat: null, max_lat: null, min_lng: null, max_lng: null };

// TASK 10: a request carrying a pin now resolves which area it belongs to
// (via the outer pool, 2 queries: the areas list, then a zone-match check)
// before loading that area's pricing zones.
const queueAreaResolution = () => {
  pool.query
    .mockResolvedValueOnce([[AREA_ROW]])
    .mockResolvedValueOnce([[ZONE_ROW]]);
};

const ZONE_SETTINGS = {
  delivery_charge: '20.00',
  night_charge: 0,
  night_charge_start: null,
  night_charge_end: null,
  fast_delivery_enabled: 0,
  fast_delivery_charge: '40.00',
  standard_delivery_minutes: 60,
  fast_delivery_minutes: 30,
  shop_latitude: String(CENTER.lat),
  shop_longitude: String(CENTER.lng),
  radius_pricing_active: 1,
};

// A client-supplied delivery_zone_id would let anyone unlock a zone-restricted
// coupon (and enumerate which zones each coupon covers) by guessing ids.
describe('POST /api/cart/validate-coupon — zone is derived server-side', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    areaScope._resetCachesForTests();
  });

  it('ignores a delivery_zone_id supplied in the request body', async () => {
    // TASK 13: area is resolved BEFORE settings now (settings itself is
    // area-scoped), so the order here is areas/zone-match, then settings,
    // then active zones.
    queueAreaResolution();
    pool.query.mockResolvedValueOnce([[ZONE_SETTINGS]]); // settings
    pool.query.mockResolvedValueOnce([[ZONE_ROW]]);     // active zones

    const res = await request(app)
      .post('/api/cart/validate-coupon')
      .set('Authorization', `Bearer ${token}`)
      .send({
        code: 'SAVE10',
        subtotal: 500,
        latitude: CENTER.lat,
        longitude: CENTER.lng,
        delivery_zone_id: 999, // attacker-chosen — must not reach the engine
      });

    expect(res.statusCode).toEqual(200);
    expect(validateCoupon).toHaveBeenCalledWith(
      expect.objectContaining({ zoneId: 7 })
    );
  });

  it('resolves no zone when the pin is outside every zone', async () => {
    queueAreaResolution();
    pool.query.mockResolvedValueOnce([[ZONE_SETTINGS]]);
    pool.query.mockResolvedValueOnce([[ZONE_ROW]]);

    const far = offsetPoint(CENTER.lat, CENTER.lng, 0, 50);
    const res = await request(app)
      .post('/api/cart/validate-coupon')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'SAVE10', subtotal: 500, latitude: far.lat, longitude: far.lng, delivery_zone_id: 7 });

    expect(res.statusCode).toEqual(200);
    expect(validateCoupon).toHaveBeenCalledWith(
      expect.objectContaining({ zoneId: null })
    );
  });

  it('skips the zone lookup entirely when no coordinates are sent', async () => {
    const res = await request(app)
      .post('/api/cart/validate-coupon')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'SAVE10', subtotal: 500, delivery_zone_id: 7 });

    expect(res.statusCode).toEqual(200);
    expect(validateCoupon).toHaveBeenCalledWith(
      expect.objectContaining({ zoneId: null })
    );
    // No settings/zone queries at all — only the store-type lookup is skipped
    // too because no items were sent.
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects malformed coordinates instead of silently ignoring them', async () => {
    const res = await request(app)
      .post('/api/cart/validate-coupon')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'SAVE10', subtotal: 500, latitude: 999, longitude: 75.4 });

    expect(res.statusCode).toEqual(400);
    expect(res.body.message).toMatch(/Invalid GPS coordinates/i);
  });
});

// Same bypass, same fix, on the sibling endpoint that lists zone-restricted
// coupons/offers — it must derive zoneId from coordinates too, not trust a
// client-supplied delivery_zone_id.
describe('GET /api/cart/available-coupons — zone is derived server-side', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    areaScope._resetCachesForTests();
  });

  it('ignores a delivery_zone_id supplied as a query param', async () => {
    // TASK 13: area is resolved BEFORE settings now (settings itself is
    // area-scoped), so the order here is areas/zone-match, then settings,
    // then active zones.
    queueAreaResolution();
    pool.query.mockResolvedValueOnce([[ZONE_SETTINGS]]); // settings
    pool.query.mockResolvedValueOnce([[ZONE_ROW]]);     // active zones

    const res = await request(app)
      .get('/api/cart/available-coupons')
      .set('Authorization', `Bearer ${token}`)
      .query({
        subtotal: 500,
        latitude: CENTER.lat,
        longitude: CENTER.lng,
        delivery_zone_id: 999, // attacker-chosen — must not reach the engine
      });

    expect(res.statusCode).toEqual(200);
    expect(findApplicableCoupons).toHaveBeenCalledWith(
      expect.objectContaining({ zoneId: 7 })
    );
  });

  it('resolves no zone when the pin is outside every zone', async () => {
    queueAreaResolution();
    pool.query.mockResolvedValueOnce([[ZONE_SETTINGS]]);
    pool.query.mockResolvedValueOnce([[ZONE_ROW]]);

    const far = offsetPoint(CENTER.lat, CENTER.lng, 0, 50);
    const res = await request(app)
      .get('/api/cart/available-coupons')
      .set('Authorization', `Bearer ${token}`)
      .query({ subtotal: 500, latitude: far.lat, longitude: far.lng, delivery_zone_id: 7 });

    expect(res.statusCode).toEqual(200);
    expect(findApplicableCoupons).toHaveBeenCalledWith(
      expect.objectContaining({ zoneId: null })
    );
  });

  it('skips the zone lookup entirely when no coordinates are sent', async () => {
    const res = await request(app)
      .get('/api/cart/available-coupons')
      .set('Authorization', `Bearer ${token}`)
      .query({ subtotal: 500, delivery_zone_id: 7 });

    expect(res.statusCode).toEqual(200);
    expect(findApplicableCoupons).toHaveBeenCalledWith(
      expect.objectContaining({ zoneId: null })
    );
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('rejects malformed coordinates instead of silently ignoring them', async () => {
    const res = await request(app)
      .get('/api/cart/available-coupons')
      .set('Authorization', `Bearer ${token}`)
      .query({ subtotal: 500, latitude: 999, longitude: 75.4 });

    expect(res.statusCode).toEqual(400);
    expect(res.body.message).toMatch(/Invalid GPS coordinates/i);
  });
});
