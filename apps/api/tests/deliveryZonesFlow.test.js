const request = require('supertest');
const express = require('express');
const cartRoutes = require('../src/routes/cartRoutes');
const orderRoutes = require('../src/routes/orderRoutes');
const { pool } = require('../src/db/mysql');
const jwt = require('jsonwebtoken');

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

const { pickBestAutoApply } = require('../src/utils/coupons');

const app = express();
app.use(express.json());
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);

const token = jwt.sign({ id: 1, role: 'customer' }, process.env.JWT_SECRET || 'secret');

// Center: Fatehabad, Haryana — same fixture geometry as deliveryPricing.test.js.
const CENTER = { lat: 29.5152, lng: 75.4548 };
const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LNG_AT_EQUATOR = 111.320;

function offsetPoint(lat, lng, dLatKm, dLngKm) {
  return {
    lat: lat + dLatKm / KM_PER_DEG_LAT,
    lng: lng + dLngKm / (KM_PER_DEG_LNG_AT_EQUATOR * Math.cos(lat * Math.PI / 180)),
  };
}
const pointAtKm = (km) => offsetPoint(CENTER.lat, CENTER.lng, 0, km);
const squareBoundary = (sideKm) => {
  const half = sideKm / 2;
  return [
    offsetPoint(CENTER.lat, CENTER.lng, -half, -half),
    offsetPoint(CENTER.lat, CENTER.lng, -half, half),
    offsetPoint(CENTER.lat, CENTER.lng, half, half),
    offsetPoint(CENTER.lat, CENTER.lng, half, -half),
  ];
};
// Radius of the circle with the same area as a `sideKm` square — mirrors
// areaEquivalentRadiusKm() in deliveryPricing.js, used only to compute the
// expected "extent" figures below.
const equivalentRadiusOfSquare = (sideKm) => Math.sqrt((sideKm * sideKm) / Math.PI);

const ZONE_ROWS = [
  {
    id: 1, name: 'Near Village', parent_zone_id: null, boundary: squareBoundary(10),
    normal_charge: '10.00', fast_charge: '25.00',
    normal_eta_minutes: 45, fast_eta_minutes: 20, night_charge: '5.00',
    cod_enabled: 1, active: 1,
  },
  {
    id: 2, name: 'Far Village', parent_zone_id: null, boundary: squareBoundary(20),
    normal_charge: '30.00', fast_charge: '50.00',
    normal_eta_minutes: 90, fast_eta_minutes: 40, night_charge: '15.00',
    cod_enabled: 0, active: 1,
  },
];

const ZONE_SETTINGS = {
  shop_open: 1,
  delivery_available: 1,
  delivery_charge: '20.00',
  night_charge: 0,
  night_charge_start: null,
  night_charge_end: null,
  fast_delivery_enabled: 0,
  fast_delivery_charge: '40.00',
  standard_delivery_minutes: 60,
  fast_delivery_minutes: 30,
  delivery_radius_km: 8,
  shop_latitude: String(CENTER.lat),
  shop_longitude: String(CENTER.lng),
  radius_pricing_active: 1,
};

const makeConnection = () => ({
  beginTransaction: jest.fn(),
  query: jest.fn(),
  commit: jest.fn(),
  rollback: jest.fn(),
  release: jest.fn(),
});

describe('Delivery zone pricing — cart preview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('prices from the matched zone with dual-cased zone fields', async () => {
    const p = pointAtKm(3);
    pool.query
      .mockResolvedValueOnce([[ZONE_SETTINGS]]) // settings
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]]) // products
      .mockResolvedValueOnce([ZONE_ROWS]) // active zones
      .mockResolvedValueOnce([[]]); // active exclusion zones

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({ latitude: p.lat, longitude: p.lng, items: [{ productId: 1, quantity: 2 }] });

    expect(res.statusCode).toEqual(200);
    expect(res.body.deliveryCharge).toBe(10);
    expect(res.body.standardDeliveryMinutes).toBe(45);
    expect(res.body.fastDeliveryMinutes).toBe(20);
    expect(res.body.total).toBe(210);
    expect(res.body.valid).toBe(true);
    expect(res.body.outOfRange).toBe(false);
    expect(res.body.out_of_range).toBe(false);
    expect(res.body.codAllowed).toBe(true);
    expect(res.body.cod_allowed).toBe(true);
    expect(res.body.radiusPricingApplied).toBe(true);
    expect(res.body.radius_pricing_applied).toBe(true);
    expect(res.body.maxDeliveryRadiusKm).toBeCloseTo(equivalentRadiusOfSquare(20), 1);
    expect(res.body.max_delivery_radius_km).toBeCloseTo(equivalentRadiusOfSquare(20), 1);
    expect(res.body.deliveryDistanceKm).toBeGreaterThan(2.9);
    expect(res.body.delivery_distance_km).toBe(res.body.deliveryDistanceKm);
    expect(res.body.deliveryZone).toEqual(expect.objectContaining({ id: 1, name: 'Near Village', codEnabled: true, cod_enabled: true }));
    expect(res.body.delivery_zone).toEqual(expect.objectContaining({ id: 1, name: 'Near Village', codEnabled: true, cod_enabled: true }));
    expect(res.body.deliveryZone.areaKm2).toBeGreaterThan(0);
  });

  it('reports a COD-disabled zone for the far band', async () => {
    const p = pointAtKm(7);
    pool.query
      .mockResolvedValueOnce([[ZONE_SETTINGS]])
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]])
      .mockResolvedValueOnce([ZONE_ROWS]) // active zones
      .mockResolvedValueOnce([[]]); // active exclusion zones

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({ latitude: p.lat, longitude: p.lng, items: [{ productId: 1, quantity: 1 }] });

    expect(res.statusCode).toEqual(200);
    expect(res.body.deliveryCharge).toBe(30);
    expect(res.body.standardDeliveryMinutes).toBe(90);
    expect(res.body.codAllowed).toBe(false);
    expect(res.body.cod_allowed).toBe(false);
  });

  it('invalidates the preview when the pin is beyond the largest zone', async () => {
    const p = pointAtKm(15);
    pool.query
      .mockResolvedValueOnce([[ZONE_SETTINGS]])
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]])
      .mockResolvedValueOnce([ZONE_ROWS]) // active zones
      .mockResolvedValueOnce([[]]); // active exclusion zones

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({ latitude: p.lat, longitude: p.lng, items: [{ productId: 1, quantity: 1 }] });

    expect(res.statusCode).toEqual(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.isValid).toBe(false);
    expect(res.body.outOfRange).toBe(true);
    expect(res.body.deliveryCharge).toBe(0);
    expect(res.body.message).toBe('Delivery is not available at this location.');
  });

  // Zone pricing ON: a cart with no coordinates has no determinable zone, so
  // it must be refused rather than quoted at the flat charge. Quoting it was
  // how a customer with the location gate dismissed still got a full price
  // breakdown for an address nobody had checked.
  it('refuses to quote when no coordinates are sent and zone pricing is on', async () => {
    pool.query
      .mockResolvedValueOnce([[ZONE_SETTINGS]])
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]])
      .mockResolvedValueOnce([ZONE_ROWS]) // active zones
      .mockResolvedValueOnce([[]]); // active exclusion zones

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: 1, quantity: 1 }] });

    expect(res.statusCode).toEqual(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.isValid).toBe(false);
    expect(res.body.outOfRange).toBe(true);
    expect(res.body.deliveryCharge).toBe(0);
    expect(res.body.codAllowed).toBe(false);
  });

  it('lets a free-delivery coupon waive the zone standard charge', async () => {
    const p = pointAtKm(3);
    pool.query
      .mockResolvedValueOnce([[ZONE_SETTINGS]])
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]])
      .mockResolvedValueOnce([ZONE_ROWS]) // active zones
      .mockResolvedValueOnce([[]]); // active exclusion zones
    pickBestAutoApply.mockResolvedValueOnce({
      coupon: { id: 5, code: null, title: 'Free Delivery', discount_type: 'free_delivery' },
      discount: 10,
    });

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({ latitude: p.lat, longitude: p.lng, items: [{ productId: 1, quantity: 2 }] });

    expect(res.statusCode).toEqual(200);
    expect(res.body.deliveryCharge).toBe(10);
    expect(res.body.discount).toBe(10);
    expect(res.body.deliveryMessage).toBe('Free delivery unlocked!');
  });
});

describe('Delivery zone pricing — order creation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects an out-of-range pin with OUT_OF_DELIVERY_RANGE', async () => {
    const p = pointAtKm(15);
    const mockConnection = makeConnection();
    pool.getConnection.mockResolvedValue(mockConnection);
    mockConnection.query
      .mockResolvedValueOnce([[{ blocked: 0 }]]) // user
      .mockResolvedValueOnce([[ZONE_SETTINGS]]) // settings
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]]) // products
      .mockResolvedValueOnce([ZONE_ROWS]) // active zones
      .mockResolvedValueOnce([[]]); // active exclusion zones

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: '123 Test St',
        paymentMethod: 'UPI',
        latitude: p.lat,
        longitude: p.lng,
        items: [{ productId: 1, quantity: 1 }],
      });

    expect(res.statusCode).toEqual(400);
    expect(res.body.code).toBe('OUT_OF_DELIVERY_RANGE');
    expect(mockConnection.rollback).toHaveBeenCalled();
  });

  it('rejects Cash in a COD-disabled zone with COD_NOT_AVAILABLE', async () => {
    const p = pointAtKm(7);
    const mockConnection = makeConnection();
    pool.getConnection.mockResolvedValue(mockConnection);
    mockConnection.query
      .mockResolvedValueOnce([[{ blocked: 0 }]])
      .mockResolvedValueOnce([[ZONE_SETTINGS]])
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]])
      .mockResolvedValueOnce([ZONE_ROWS]) // active zones
      .mockResolvedValueOnce([[]]); // active exclusion zones

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: '123 Test St',
        paymentMethod: 'Cash',
        latitude: p.lat,
        longitude: p.lng,
        items: [{ productId: 1, quantity: 1 }],
      });

    expect(res.statusCode).toEqual(400);
    expect(res.body.code).toBe('COD_NOT_AVAILABLE');
  });

  it('creates a UPI order in the COD-disabled zone with distance/zone snapshots', async () => {
    const p = pointAtKm(7);
    const mockConnection = makeConnection();
    pool.getConnection.mockResolvedValue(mockConnection);
    mockConnection.query
      .mockResolvedValueOnce([[{ blocked: 0 }]])
      .mockResolvedValueOnce([[ZONE_SETTINGS]])
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]])
      .mockResolvedValueOnce([ZONE_ROWS]) // active zones
      .mockResolvedValueOnce([[]]) // active exclusion zones
      .mockResolvedValueOnce([{ insertId: 2001 }]) // insert order
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // insert items

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: '123 Test St',
        paymentMethod: 'UPI',
        latitude: p.lat,
        longitude: p.lng,
        items: [{ productId: 1, quantity: 2 }],
      });

    expect(res.statusCode).toEqual(201);
    expect(res.body.orderId).toBe(2001);
    expect(res.body.order.deliveryCharge).toBe(30);
    expect(res.body.order.total).toBe(230);
    expect(res.body.order.deliveryDistanceKm).toBeGreaterThan(6.9);
    expect(res.body.order.deliveryRadiusKmSnapshot).toBeCloseTo(equivalentRadiusOfSquare(20), 1);
    expect(res.body.order.deliveryZoneId).toBe(2);
    expect(res.body.order.delivery_zone_id).toBe(2);
    expect(res.body.order.deliveryEtaMinutes).toBe(90);
    expect(res.body.order.delivery_eta_minutes).toBe(90);
    expect(mockConnection.commit).toHaveBeenCalledTimes(1);

    const insertCall = mockConnection.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO orders'));
    expect(insertCall).toBeDefined();
    const params = insertCall[1];
    // ... delivery_distance_km, delivery_radius_km_snapshot, cost_per_km(null),
    // free_delivery_offer_snapshot(null), delivery_zone_id, delivery_eta_minutes_snapshot ...
    const distanceIdx = 17;
    expect(params[distanceIdx]).toBeGreaterThan(6.9); // delivery_distance_km
    expect(params[distanceIdx + 1]).toBeCloseTo(equivalentRadiusOfSquare(20), 1); // delivery_radius_km_snapshot
    expect(params[distanceIdx + 2]).toBeNull(); // delivery_cost_per_km_snapshot
    expect(params[distanceIdx + 3]).toBeNull(); // free_delivery_offer_snapshot
    expect(params[distanceIdx + 4]).toBe(2); // delivery_zone_id
    expect(params[distanceIdx + 5]).toBe(90); // delivery_eta_minutes_snapshot
  });

  // The route validator deliberately treats latitude/longitude as optional,
  // so an order can reach the controller with none. With zone pricing on
  // that used to resolve to flat pricing and persist with delivery_zone_id
  // NULL — an order belonging to no zone, priced by nobody's rules. The
  // resolver now reports outOfRange for that state and createOrder rejects
  // it, which closes the bypass without touching the validator.
  it('rejects an order with no coordinates while zone pricing is on', async () => {
    const mockConnection = makeConnection();
    pool.getConnection.mockResolvedValue(mockConnection);
    mockConnection.query
      .mockResolvedValueOnce([[{ blocked: 0 }]])
      .mockResolvedValueOnce([[ZONE_SETTINGS]])
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]])
      .mockResolvedValueOnce([ZONE_ROWS]) // active zones
      .mockResolvedValueOnce([[]]); // active exclusion zones

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: '123 Test St',
        paymentMethod: 'Cash',
        items: [{ productId: 1, quantity: 1 }],
      });

    expect(res.statusCode).toEqual(400);
    expect(res.body.code).toBe('OUT_OF_DELIVERY_RANGE');
  });
});
