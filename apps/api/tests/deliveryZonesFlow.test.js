const request = require('supertest');
const express = require('express');
const cartRoutes = require('../src/routes/cartRoutes');
const orderRoutes = require('../src/routes/orderRoutes');
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

// area 1, no bbox computed yet (matches every real install until a zone
// write recomputes it) — bboxCandidateAreas treats that as "always a
// candidate", same as production today.
const AREA_ROW = { id: 1, code: 'A1', name: 'Area 1', active: 1, is_default: 1, min_lat: null, max_lat: null, min_lng: null, max_lng: null };

// TASK 10: calculateCart/createOrder now resolve which area a pin belongs
// to (via the outer `pool`, never the transaction connection — see
// orderController.js's comment) before loading that area's pricing zones.
// That's 2 extra pool.query calls ahead of the real zones/exclusion-zones
// queries: the areas list, then a zone-match check against the same
// geometry the pricing step will use next.
const queueAreaResolution = () => {
  pool.query
    .mockResolvedValueOnce([[AREA_ROW]])
    .mockResolvedValueOnce([ZONE_ROWS]);
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
    areaScope._resetCachesForTests();
  });

  it('prices from the matched zone with dual-cased zone fields', async () => {
    const p = pointAtKm(3);
    pool.query
      .mockResolvedValueOnce([[ZONE_SETTINGS]]) // settings
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]]); // products
    queueAreaResolution();
    pool.query
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
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]]);
    queueAreaResolution();
    pool.query
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
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]]);
    // No zone matches this pin, so resolveAreaForPoint returns null and
    // resolveAreaIdForPricing falls back to the default area — but that
    // fallback reuses the SAME cached areas list from the bbox check
    // (areaScope's 60s areasCache), so it's still exactly 2 extra calls,
    // not 3.
    queueAreaResolution();
    pool.query
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
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]]);
    // No pin at all: resolveAreaForPoint short-circuits before touching the
    // DB (Number(undefined) isn't finite), so resolveAreaIdForPricing goes
    // straight to getDefaultArea() — only 1 extra call, not 2.
    pool.query.mockResolvedValueOnce([[AREA_ROW]]);
    pool.query
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
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]]);
    queueAreaResolution();
    pool.query
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

  // TASK 10.6 — the biggest perf win in the spec (§3.2): before this task,
  // loadActiveZones had no area filter at all and a single cart preview
  // walked every active zone platform-wide. This proves the opposite is
  // now true with two REAL areas in play: area 2's zone data exists (a
  // huge boundary that would happily swallow this test's pin too, if
  // fetched) but the query for area 1's pin is scoped to area_id = 1 and
  // never touches it.
  it('a cart preview in area 1 loads only area 1\'s zones — area 2 is never queried at all', async () => {
    const p = pointAtKm(3);
    // Both areas are real bbox candidates (area 2 covers this same region
    // at a huge scale) — the bbox prefilter alone can't rule area 2 out,
    // so this actually exercises resolveAreaForPoint's per-area loop, not
    // just a single-candidate happy path.
    const AREA_1 = { id: 1, code: 'A1', name: 'Area 1', active: 1, is_default: 1, min_lat: null, max_lat: null, min_lng: null, max_lng: null };
    const AREA_2 = { id: 2, code: 'A2', name: 'Area 2', active: 1, is_default: 0, min_lat: null, max_lat: null, min_lng: null, max_lng: null };

    pool.query
      .mockResolvedValueOnce([[ZONE_SETTINGS]]) // settings
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]]) // products
      .mockResolvedValueOnce([[AREA_1, AREA_2]]) // bbox candidate areas — both, area 1 listed first
      .mockResolvedValueOnce([ZONE_ROWS]) // resolveAreaForPoint's zone-match query for area 1 — matches
      .mockResolvedValueOnce([ZONE_ROWS]) // the REAL pricing zones query, scoped to area 1
      .mockResolvedValueOnce([[]]) // active exclusion zones
      .mockResolvedValueOnce([[{ type: 'packed' }]]); // store-type derivation from items — unrelated to zones
    // Deliberately NOT mocking an 8th call: if area 2 were ever queried for
    // its zones (the isolation this task exists to guarantee), the mock
    // queue runs dry and loadActiveZones' destructure throws — this test
    // would fail with a 500, not a wrong-price assertion.

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({ latitude: p.lat, longitude: p.lng, items: [{ productId: 1, quantity: 2 }] });

    expect(res.statusCode).toEqual(200);
    // Priced from Near Village (id 1, charge 10) — area 1's zone.
    expect(res.body.deliveryCharge).toBe(10);
    expect(res.body.deliveryZone.id).toBe(1);

    // 7 total: settings, products, areas, area-1 zone-match, area-1 pricing
    // zones, exclusion zones, store-type derivation. Area 2's zones were
    // never fetched — resolveAreaForPoint's loop returned as soon as area 1
    // matched, and every actual delivery_zones query carries area_id = 1.
    expect(pool.query).toHaveBeenCalledTimes(7);
    const zoneQueryCalls = pool.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('FROM delivery_zones')
    );
    expect(zoneQueryCalls).toHaveLength(2); // zone-match + real pricing zones
    for (const [sql, params] of zoneQueryCalls) {
      expect(sql).toContain('area_id = ?');
      expect(params).toContain(1);
      expect(params).not.toContain(2);
    }
  });
});

describe('Delivery zone pricing — order creation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    areaScope._resetCachesForTests();
  });

  it('rejects an out-of-range pin with OUT_OF_DELIVERY_RANGE', async () => {
    const p = pointAtKm(15);
    const mockConnection = makeConnection();
    pool.getConnection.mockResolvedValue(mockConnection);
    // Area resolution reads through the outer `pool`, never the transaction
    // connection — see orderController.js's comment.
    queueAreaResolution();
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
    queueAreaResolution();
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
    queueAreaResolution();
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
    // Unlike cartController (which reads req.body directly, staying
    // undefined when absent), the order route's validator normalizes a
    // missing latitude/longitude to `null` before the controller ever sees
    // it — Number(null) is 0, which IS finite, so resolveAreaForPoint does
    // NOT short-circuit here. It runs its full 2-query check (against
    // 0°N 0°E, which matches nothing), then resolveAreaIdForPricing falls
    // back to the default area from that same cached areas list.
    queueAreaResolution();
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
