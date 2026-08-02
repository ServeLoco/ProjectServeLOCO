const request = require('supertest');
const express = require('express');
const cartRoutes = require('../src/routes/cartRoutes');
const orderRoutes = require('../src/routes/orderRoutes');
const { pool } = require('../src/db/mysql');
const jwt = require('jsonwebtoken');

jest.mock('../src/db/mysql', () => ({
  pool: { query: jest.fn().mockResolvedValue([[]]), getConnection: jest.fn() }
}));

jest.mock('../src/utils/coupons', () => ({
  validateCoupon: jest.fn().mockResolvedValue({ ok: false, reason: 'No coupon' }),
  validateCouponById: jest.fn().mockResolvedValue({ ok: false, reason: 'Coupon not found' }),
  pickBestAutoApply: jest.fn().mockResolvedValue(null),
  findApplicableCoupons: jest.fn().mockResolvedValue([]),
  getNextFreeDeliveryThreshold: jest.fn().mockResolvedValue(null),
  getNearestUnlockableCoupon: jest.fn().mockResolvedValue(null),
  computeDiscount: jest.fn().mockReturnValue(0),
  checkEligibility: jest.fn().mockResolvedValue({ ok: false, reason: 'No coupon' }),
}));

const { pickBestAutoApply, validateCouponById, getNextFreeDeliveryThreshold, getNearestUnlockableCoupon } = require('../src/utils/coupons');
const areaScope = require('../src/utils/areaScope');

const app = express();
app.use(express.json());
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);

const token = jwt.sign({ id: 1, role: 'customer' }, process.env.JWT_SECRET || 'secret');

describe('Cart and Order Tests', () => {
  // None of these tests configure a real delivery-zone polygon, so
  // resolveAreaIdForPricing (TASK 13) always falls through to
  // getDefaultArea() for the AREA itself — but a request that DOES send a
  // pin still makes resolveAreaForPoint try a zone match first, hitting
  // loadActiveZones' own (separate, 15s-TTL) cache. Prime both caches ONCE,
  // up front, so neither ever consumes a query slot meant for a test's own
  // settings/product mocks. (Not reset per-test on purpose: resetting would
  // reintroduce exactly that mock-slot collision on every test in this file.)
  beforeAll(async () => {
    pool.query.mockResolvedValueOnce([[{ id: 1, code: 'A1', name: 'Area 1', active: 1, is_default: 1 }]]);
    await areaScope.getDefaultArea();
    pool.query.mockResolvedValueOnce([[]]);
    await areaScope.resolveAreaForPoint(12.9716, 77.6046);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should always charge the flat settings.delivery_charge regardless of subtotal', async () => {
    pool.query.mockResolvedValueOnce([[{ shop_open: 1, delivery_charge: 10, night_charge: 0 }]]); // settings
    pool.query.mockResolvedValueOnce([[{ id: 1, price: 100, available: 1 }]]); // product query

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [{ productId: 1, quantity: 2 }]
      });

    expect(res.statusCode).toEqual(200);
    expect(res.body.subtotal).toEqual(200);
    expect(res.body.deliveryCharge).toEqual(10);
    expect(res.body.total).toEqual(210);
    expect(res.body.valid).toEqual(true);
  });

  it('adds the fast delivery fee on top of the standard delivery charge instead of replacing it', async () => {
    pool.query.mockResolvedValueOnce([[{
      shop_open: 1,
      delivery_charge: 10,
      night_charge: 0,
      fast_delivery_enabled: 1,
      fast_delivery_charge: 25,
    }]]);
    pool.query.mockResolvedValueOnce([[{ id: 1, price: 100, available: 1 }]]);

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [{ productId: 1, quantity: 2 }],
        delivery_type: 'fast',
      });

    expect(res.statusCode).toEqual(200);
    expect(res.body.subtotal).toEqual(200);
    expect(res.body.deliveryCharge).toEqual(10);
    expect(res.body.fastDeliveryFee).toEqual(25);
    expect(res.body.total).toEqual(235);
  });

  it('keeps the free_delivery waiver on the standard fee when fast delivery is added on top', async () => {
    pool.query.mockResolvedValueOnce([[{
      shop_open: 1,
      delivery_charge: 10,
      night_charge: 0,
      fast_delivery_enabled: 1,
      fast_delivery_charge: 25,
    }]]);
    pool.query.mockResolvedValueOnce([[{ id: 1, price: 100, available: 1 }]]);
    pickBestAutoApply.mockResolvedValueOnce({
      coupon: { id: 5, code: null, title: 'Free Delivery', discount_type: 'free_delivery' },
      discount: 10,
      itemDiscount: 0,
      freeDeliveryWaiver: 10,
    });

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [{ productId: 1, quantity: 2 }],
        delivery_type: 'fast',
      });

    expect(res.statusCode).toEqual(200);
    expect(res.body.deliveryCharge).toEqual(10);
    expect(res.body.fastDeliveryFee).toEqual(25);
    expect(res.body.discount).toEqual(10);
    // 200 + 10 (std, waived by discount) + 25 (fast add-on, never discounted)
    expect(res.body.total).toEqual(225);
    expect(res.body.isFreeDeliveryApplied).toBe(true);
  });

  it('should net delivery to zero via discount when an auto-apply free_delivery coupon applies', async () => {
    pool.query.mockResolvedValueOnce([[{
      shop_open: 1,
      delivery_charge: 10,
      night_charge: 0,
    }]]);
    pool.query.mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]]);
    pickBestAutoApply.mockResolvedValueOnce({
      coupon: { id: 5, code: null, title: 'Free Delivery', discount_type: 'free_delivery' },
      discount: 10,
    });

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        latitude: 12.9716,
        longitude: 77.6046,
        items: [{ productId: 1, quantity: 2 }]
      });

    expect(res.statusCode).toEqual(200);
    expect(res.body.subtotal).toEqual(200);
    expect(res.body.deliveryDistanceKm).toBeNull();
    expect(res.body.deliveryWithinRange).toBe(true);
    expect(res.body.requiresLocation).toBe(false);
    expect(res.body.deliveryCharge).toBe(10);
    expect(res.body.discount).toBe(10);
    expect(res.body.deliveryMessage).toBe('Free delivery unlocked!');
  });

  // Regression test: auto-apply-only offers can have code = NULL (the admin
  // "no code" offer type — see apps/admin/src/pages/Coupons.jsx). Tapping
  // such an offer in the cart sends coupon_id (not coupon_code) so the
  // backend can force-apply that exact offer instead of falling back to
  // "the best auto-apply offer", which would silently override the tap.
  it('force-applies a specific no-code offer via coupon_id instead of picking the best one', async () => {
    pool.query.mockResolvedValueOnce([[{
      shop_open: 1,
      delivery_charge: 10,
      night_charge: 0,
    }]]);
    pool.query.mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]]);
    validateCouponById.mockResolvedValueOnce({
      ok: true,
      coupon: { id: 2, code: null, title: 'Flat 15', discount_type: 'flat' },
      discount: 15,
    });

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        latitude: 12.9716,
        longitude: 77.6046,
        coupon_id: 2,
        items: [{ productId: 1, quantity: 2 }]
      });

    expect(res.statusCode).toEqual(200);
    expect(validateCouponById).toHaveBeenCalledWith(expect.objectContaining({ couponId: 2 }));
    expect(pickBestAutoApply).not.toHaveBeenCalled();
    expect(res.body.discount).toBe(15);
    expect(res.body.appliedCoupon).toEqual(expect.objectContaining({ id: 2, code: null, autoApplied: false }));
  });

  it('should surface a free-delivery progress hint when no coupon applies yet', async () => {
    pool.query.mockResolvedValueOnce([[{
      shop_open: 1,
      delivery_charge: 35,
      night_charge: 0,
    }]]);
    pool.query.mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]]);
    getNextFreeDeliveryThreshold.mockResolvedValueOnce({ minOrder: 300, amountRemaining: 100, minItemCount: 0, itemsRemaining: 0, thresholdType: 'amount' });

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        latitude: 12.9716,
        longitude: 77.6046,
        items: [{ productId: 1, quantity: 2 }]
      });

    expect(res.statusCode).toEqual(200);
    expect(res.body.subtotal).toEqual(200);
    expect(res.body.deliveryCharge).toBe(35);
    expect(res.body.freeDeliveryProgress).toEqual({ minOrder: 300, amountRemaining: 100, minItemCount: 0, itemsRemaining: 0, thresholdType: 'amount' });
    expect(res.body.deliveryMessage).toBe('Add ₹100 more for free delivery. ₹35 delivery applied.');
  });

  it('should surface an item-count free-delivery hint when amount is met but items are short', async () => {
    pool.query.mockResolvedValueOnce([[{
      shop_open: 1,
      delivery_charge: 35,
      night_charge: 0,
    }]]);
    pool.query.mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]]);
    getNextFreeDeliveryThreshold.mockResolvedValueOnce({ minOrder: 0, amountRemaining: 0, minItemCount: 3, itemsRemaining: 1, thresholdType: 'item_count' });

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        latitude: 12.9716,
        longitude: 77.6046,
        items: [{ productId: 1, quantity: 2 }]
      });

    expect(res.statusCode).toEqual(200);
    expect(res.body.freeDeliveryProgress).toEqual({ minOrder: 0, amountRemaining: 0, minItemCount: 3, itemsRemaining: 1, thresholdType: 'item_count' });
    expect(res.body.deliveryMessage).toBe('Add 1 more item(s) for free delivery. ₹35 delivery applied.');
  });

  it('should join amount and item-count shortfalls in the free-delivery hint', async () => {
    pool.query.mockResolvedValueOnce([[{
      shop_open: 1,
      delivery_charge: 35,
      night_charge: 0,
    }]]);
    pool.query.mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]]);
    getNextFreeDeliveryThreshold.mockResolvedValueOnce({ minOrder: 300, amountRemaining: 100, minItemCount: 3, itemsRemaining: 1, thresholdType: 'both' });

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        latitude: 12.9716,
        longitude: 77.6046,
        items: [{ productId: 1, quantity: 2 }]
      });

    expect(res.statusCode).toEqual(200);
    expect(res.body.deliveryMessage).toBe('Add ₹100 more and 1 more item(s) for free delivery. ₹35 delivery applied.');
  });

  it('should surface a nearest-unlockable-offer progress hint alongside the bill', async () => {
    pool.query.mockResolvedValueOnce([[{
      shop_open: 1,
      delivery_charge: 10,
      night_charge: 0,
    }]]);
    pool.query.mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]]);
    getNearestUnlockableCoupon.mockResolvedValueOnce({
      couponId: 7,
      code: 'SAVE20',
      title: '20% Off',
      discountType: 'percent',
      minOrder: 250,
      amountRemaining: 50,
      savingsText: 'You save ₹40',
      requiresCode: false,
      autoApply: true,
    });

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        latitude: 12.9716,
        longitude: 77.6046,
        items: [{ productId: 1, quantity: 2 }]
      });

    expect(res.statusCode).toEqual(200);
    expect(res.body.nearestOfferProgress).toEqual({
      couponId: 7,
      code: 'SAVE20',
      title: '20% Off',
      discountType: 'percent',
      minOrder: 250,
      amountRemaining: 50,
      savingsText: 'You save ₹40',
      requiresCode: false,
      autoApply: true,
    });
  });

  it('should not surface a nearest-offer hint when nothing is eligible', async () => {
    pool.query.mockResolvedValueOnce([[{
      shop_open: 1,
      delivery_charge: 10,
      night_charge: 0,
    }]]);
    pool.query.mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]]);
    getNearestUnlockableCoupon.mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        latitude: 12.9716,
        longitude: 77.6046,
        items: [{ productId: 1, quantity: 2 }]
      });

    expect(res.statusCode).toEqual(200);
    expect(res.body.nearestOfferProgress).toBeNull();
  });

  it('should exclude the currently applied coupon when looking up the nearest-offer hint', async () => {
    pool.query.mockResolvedValueOnce([[{
      shop_open: 1,
      delivery_charge: 10,
      night_charge: 0,
    }]]);
    pool.query.mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]]);
    pickBestAutoApply.mockResolvedValueOnce({
      coupon: { id: 9, code: 'FLAT10', title: 'Flat 10', discount_type: 'flat' },
      discount: 10,
    });
    getNearestUnlockableCoupon.mockResolvedValueOnce(null);

    await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        latitude: 12.9716,
        longitude: 77.6046,
        items: [{ productId: 1, quantity: 2 }]
      });

    expect(getNearestUnlockableCoupon).toHaveBeenCalledWith(
      expect.objectContaining({ excludeCouponId: 9 })
    );
  });

  it('should create an order when customer is inside delivery radius', async () => {
    const mockConnection = {
      beginTransaction: jest.fn(),
      query: jest.fn((sql, _params) => { console.log('QUERY:', sql); return Promise.resolve(); }),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn()
    };
    pool.getConnection.mockResolvedValue(mockConnection);

    mockConnection.query
      .mockResolvedValueOnce([[{ blocked: 0 }]]) // user check
      .mockResolvedValueOnce([[{
        shop_open: 1,
        delivery_available: 1,
        delivery_charge: 10,
        night_charge: 0,
        shop_latitude: 12.9716,
        shop_longitude: 77.5946,
        delivery_radius_km: 8,
        delivery_cost_per_km: 5
      }]]) // settings
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]]) // product check
      .mockResolvedValueOnce([[]]) // exclusion zones
      .mockResolvedValueOnce([{ insertId: 1001 }])
      .mockResolvedValueOnce([[{ COLUMN_NAME: "item_type" }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // insert order

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: '123 Test St',
        paymentMethod: 'Cash',
        latitude: 12.9716,
        longitude: 77.5946,
        items: [{ productId: 1, quantity: 2 }]
      });

    expect(res.statusCode).toEqual(201);
    expect(res.body).toHaveProperty('orderId', 1001);
    expect(res.body.order).toHaveProperty('deliveryDistanceKm', 0); // cosmetic shop-distance figure — customer coords match shop pin exactly
    expect(res.body.order).toHaveProperty('deliveryRadiusKmSnapshot', null);
    expect(res.body.order).toHaveProperty('deliveryCostPerKmSnapshot', null);
    expect(mockConnection.commit).toHaveBeenCalledTimes(1);
    expect(mockConnection.release).toHaveBeenCalledTimes(1);
  });

  it('should create matching delivery charge between cart preview and order creation', async () => {
    const settings = {
      shop_open: 1,
      delivery_available: 1,
      delivery_charge: 10,
      night_charge: 0,
      shop_latitude: 12.9716,
      shop_longitude: 77.5946,
      delivery_radius_km: 8,
      delivery_cost_per_km: 10,
    };

    pool.query.mockResolvedValueOnce([[settings]]);
    pool.query.mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]]);

    const cartRes = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        latitude: 12.9716,
        longitude: 77.6046,
        items: [{ productId: 1, quantity: 2 }]
      });

    const mockConnection = {
      beginTransaction: jest.fn(),
      query: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn()
    };
    pool.getConnection.mockResolvedValue(mockConnection);

    mockConnection.query
      .mockResolvedValueOnce([[{ blocked: 0 }]])
      .mockResolvedValueOnce([[settings]])
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]])
      .mockResolvedValueOnce([[]]) // exclusion zones
      .mockResolvedValueOnce([{ insertId: 1002 }])
      .mockResolvedValueOnce([[{ COLUMN_NAME: "item_type" }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const orderRes = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: '123 Test St',
        paymentMethod: 'Cash',
        latitude: 12.9716,
        longitude: 77.6046,
        items: [{ productId: 1, quantity: 2 }]
      });

    expect(orderRes.statusCode).toEqual(201);
    expect(orderRes.body.order.deliveryCharge).toBe(cartRes.body.deliveryCharge);
    expect(orderRes.body.order.deliveryCharge).toBe(10);
    expect(orderRes.body.order.deliveryDistanceKm).toBe(1.0836); // cosmetic shop-distance figure, not zone-based
  });

  it('should charge the flat delivery_charge with no discount when subtotal is below any coupon threshold', async () => {
    const mockConnection = {
      beginTransaction: jest.fn(),
      query: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn()
    };
    pool.getConnection.mockResolvedValue(mockConnection);

    mockConnection.query
      .mockResolvedValueOnce([[{ blocked: 0 }]])
      .mockResolvedValueOnce([[{
        shop_open: 1,
        delivery_available: 1,
        delivery_charge: 35,
        shop_latitude: 12.9716,
        shop_longitude: 77.5946,
        delivery_radius_km: 8,
        delivery_cost_per_km: 5
      }]])
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test Product' }]])
      .mockResolvedValueOnce([[]]) // exclusion zones
      .mockResolvedValueOnce([{ insertId: 1002 }])
      .mockResolvedValueOnce([[{ COLUMN_NAME: 'item_type' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: '123 Test St',
        paymentMethod: 'Cash',
        latitude: 12.9816,
        longitude: 77.5946,
        items: [{ productId: 1, quantity: 2 }]
      });

    expect(res.statusCode).toEqual(201);
    expect(res.body).toHaveProperty('orderId', 1002);
    expect(res.body.order.subtotal).toBe(200);
    expect(res.body.order.deliveryCharge).toBe(35);
    expect(res.body.order.discount).toBe(0);
    expect(res.body.order.total).toBe(235);
    expect(mockConnection.commit).toHaveBeenCalledTimes(1);
  });

  it.skip('should allow order creation without coordinates (location optional)', async () => {
    // TODO: Fix this test - currently failing due to test environment setup
    // Location is now optional in production, test needs database migration
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: '123 Test St',
        paymentMethod: 'Cash',
        items: [{ productId: 1, quantity: 2 }]
      });

    if (res.statusCode !== 201) {
      console.log('Test failed with response:', res.body);
    }

    expect(res.statusCode).toEqual(201);
    expect(res.body.order).toBeDefined();
  });

  it('should fail order creation when coordinates are invalid', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: '123 Test St',
        paymentMethod: 'Cash',
        latitude: 200,
        longitude: 77.5946,
        items: [{ productId: 1, quantity: 2 }]
      });

    expect(res.statusCode).toEqual(400);
    expect(res.body.code).toEqual('VALIDATION_ERROR');
    expect(res.body.details).toHaveProperty('latitude', 'Invalid GPS coordinates provided');
  });


});

// ─────────────────────────────────────────────────────────────────────────
// C6 — a failed typed code must not cost the customer the auto-apply
// discount: calculateCart falls back to the best auto-apply offer and
// returns BOTH couponError and the applied coupon.
// ─────────────────────────────────────────────────────────────────────────

describe('calculateCart typed-code failure falls back to auto-apply', () => {
  const { validateCoupon } = require('../src/utils/coupons');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps the auto-apply discount and surfaces couponError when the typed code is invalid', async () => {
    pool.query.mockResolvedValueOnce([[{ shop_open: 1, delivery_charge: 10, night_charge: 0 }]]); // settings
    pool.query.mockResolvedValueOnce([[{ id: 1, price: 100, available: 1 }]]); // product
    pool.query.mockResolvedValue([[]]); // store-type lookups etc.

    validateCoupon.mockResolvedValueOnce({ ok: false, reason: 'Invalid coupon code' });
    pickBestAutoApply.mockResolvedValueOnce({
      coupon: { id: 3, code: null, title: 'Auto ₹20 off', discount_type: 'flat' },
      discount: 20,
    });

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [{ productId: 1, quantity: 2 }],
        coupon_code: 'BOGUS',
      });

    expect(res.statusCode).toEqual(200);
    expect(res.body.couponError).toEqual('Invalid coupon code');
    expect(res.body.appliedCoupon).toMatchObject({ id: 3, autoApplied: true, discount: 20 });
    expect(res.body.discount).toEqual(20);
    expect(res.body.total).toEqual(190); // 200 + 10 delivery - 20
  });

  it('does NOT fall back when the user explicitly removed their coupon (no_auto_apply)', async () => {
    pool.query.mockResolvedValueOnce([[{ shop_open: 1, delivery_charge: 10, night_charge: 0 }]]); // settings
    pool.query.mockResolvedValueOnce([[{ id: 1, price: 100, available: 1 }]]); // product
    pool.query.mockResolvedValue([[]]);

    validateCoupon.mockResolvedValueOnce({ ok: false, reason: 'Invalid coupon code' });

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [{ productId: 1, quantity: 2 }],
        coupon_code: 'BOGUS',
        no_auto_apply: true,
      });

    expect(res.statusCode).toEqual(200);
    expect(res.body.couponError).toEqual('Invalid coupon code');
    expect(res.body.appliedCoupon).toBeNull();
    expect(res.body.discount).toEqual(0);
    expect(pickBestAutoApply).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// VARIANTS TASK 5 — cart calc with variantId
// ─────────────────────────────────────────────────────────────────────────

describe('calculateCart with variantId', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('prices from the variant and composes product_name with label', async () => {
    pool.query.mockResolvedValueOnce([[{ shop_open: 1, delivery_charge: 10, night_charge: 0 }]]);
    pool.query.mockResolvedValueOnce([[{ id: 1, name: 'Pizza', price: 349, available: 1 }]]);
    pool.query.mockResolvedValueOnce([[{ id: 10, product_id: 1, label: 'Large', price: 349, available: 1, deleted: 0 }]]);

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: 1, variantId: 10, quantity: 2 }] });

    expect(res.statusCode).toEqual(200);
    expect(res.body.subtotal).toEqual(698);
    expect(res.body.items[0].unitPrice).toEqual(349);
    expect(res.body.items[0].name).toEqual('Pizza (Large)');
    expect(res.body.items[0].variantId).toEqual(10);
    expect(res.body.items[0].variant_id).toEqual(10);
    expect(res.body.items[0].variantLabel).toEqual('Large');
  });

  it('handles two lines of the same product with different variants', async () => {
    pool.query.mockResolvedValueOnce([[{ shop_open: 1, delivery_charge: 10, night_charge: 0 }]]);
    pool.query.mockResolvedValueOnce([[{ id: 1, name: 'Pizza', price: 349, available: 1 }]]);
    pool.query.mockResolvedValueOnce([[
      { id: 10, product_id: 1, label: 'Small', price: 149, available: 1, deleted: 0 },
      { id: 11, product_id: 1, label: 'Large', price: 349, available: 1, deleted: 0 },
    ]]);

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [
        { productId: 1, variantId: 10, quantity: 2 },
        { productId: 1, variantId: 11, quantity: 1 },
      ] });

    expect(res.statusCode).toEqual(200);
    expect(res.body.subtotal).toEqual(647);
    expect(res.body.items[0]).toMatchObject({ variantId: 10, unitPrice: 149, name: 'Pizza (Small)' });
    expect(res.body.items[1]).toMatchObject({ variantId: 11, unitPrice: 349, name: 'Pizza (Large)' });
  });

  it('soft-drops an unknown variantId and returns it in unavailableItems', async () => {
    pool.query.mockResolvedValueOnce([[{ shop_open: 1, delivery_charge: 10, night_charge: 0 }]]);
    pool.query.mockResolvedValueOnce([[{ id: 1, name: 'Pizza', price: 349, available: 1 }]]);
    pool.query.mockResolvedValueOnce([[]]);

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: 1, variantId: 999, quantity: 1 }] });

    expect(res.statusCode).toEqual(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.subtotal).toEqual(0);
    expect(res.body.unavailableItems).toEqual([
      expect.objectContaining({ productId: 1, variantId: 999, reason: 'variant_unavailable' }),
    ]);
  });

  it('soft-drops a variantId belonging to a different product', async () => {
    pool.query.mockResolvedValueOnce([[{ shop_open: 1, delivery_charge: 10, night_charge: 0 }]]);
    pool.query.mockResolvedValueOnce([[{ id: 1, name: 'Pizza', price: 349, available: 1 }]]);
    pool.query.mockResolvedValueOnce([[{ id: 10, product_id: 2, label: 'Large', price: 349, available: 1, deleted: 0 }]]);

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: 1, variantId: 10, quantity: 1 }] });

    expect(res.statusCode).toEqual(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.unavailableItems[0]).toMatchObject({ reason: 'variant_unavailable', productId: 1 });
  });

  it('soft-drops an available=0 variant and keeps remaining lines', async () => {
    pool.query.mockResolvedValueOnce([[{ shop_open: 1, delivery_charge: 10, night_charge: 0 }]]);
    // Two products: pizza available, and we only load pizza for the mixed cart
    pool.query.mockResolvedValueOnce([[
      { id: 1, name: 'Pizza', price: 349, available: 1 },
      { id: 2, name: 'Coke', price: 40, available: 1 },
    ]]);
    pool.query.mockResolvedValueOnce([[{ id: 10, product_id: 1, label: 'Large', price: 349, available: 0, deleted: 0 }]]);

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [
          { productId: 1, variantId: 10, quantity: 1 },
          { productId: 2, quantity: 2 },
        ],
      });

    expect(res.statusCode).toEqual(200);
    expect(res.body.subtotal).toEqual(80);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ id: 2, unitPrice: 40, quantity: 2 });
    expect(res.body.unavailableItems).toEqual([
      expect.objectContaining({ productId: 1, variantId: 10, reason: 'variant_unavailable' }),
    ]);
  });

  it('soft-drops a soft-deleted variant (deleted=1)', async () => {
    pool.query.mockResolvedValueOnce([[{ shop_open: 1, delivery_charge: 10, night_charge: 0 }]]);
    pool.query.mockResolvedValueOnce([[{ id: 1, name: 'Pizza', price: 349, available: 1 }]]);
    pool.query.mockResolvedValueOnce([[{ id: 10, product_id: 1, label: 'Large', price: 349, available: 1, deleted: 1 }]]);

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: 1, variantId: 10, quantity: 1 }] });

    expect(res.statusCode).toEqual(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.unavailableItems[0].reason).toBe('variant_unavailable');
  });

  it('charges base products.price when no variantId is sent (old-client path)', async () => {
    pool.query.mockResolvedValueOnce([[{ shop_open: 1, delivery_charge: 10, night_charge: 0 }]]);
    pool.query.mockResolvedValueOnce([[{ id: 1, name: 'Pizza', price: 349, available: 1 }]]);

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: 1, quantity: 2 }] });

    expect(res.statusCode).toEqual(200);
    expect(res.body.subtotal).toEqual(698);
    expect(res.body.items[0].unitPrice).toEqual(349);
    expect(res.body.items[0].name).toEqual('Pizza');
    expect(res.body.items[0].variantId).toBeNull();
    expect(res.body.items[0].variantLabel).toBeNull();
  });
});

describe('createOrder with variantId', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  // Separate user ID to avoid the orderLimiter (5 orders/min) shared with
  // the existing order-creation tests above.
  const variantToken = jwt.sign({ id: 999, role: 'customer' }, process.env.JWT_SECRET || 'secret');

  it('snapshots variant_id, variant_label, and composite product_name', async () => {
    const mockConnection = {
      beginTransaction: jest.fn(),
      query: jest.fn()
        .mockResolvedValueOnce([[{ blocked: 0 }]])
        .mockResolvedValueOnce([[{ shop_open: 1, delivery_available: 1, delivery_charge: 10, night_charge: 0, fast_delivery_enabled: 0 }]])
        .mockResolvedValueOnce([[{ id: 1, name: 'Pizza', price: 349, available: 1 }]])
        .mockResolvedValueOnce([[{ id: 10, product_id: 1, label: 'Large', price: 349, available: 1, deleted: 0 }]])
        .mockResolvedValueOnce([[]]) // exclusion zones
        .mockResolvedValueOnce([{ insertId: 2001 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }]),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn()
    };
    pool.getConnection.mockResolvedValue(mockConnection);

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${variantToken}`)
      .send({
        address: '123 Test St',
        paymentMethod: 'Cash',
        items: [{ productId: 1, variantId: 10, quantity: 2 }]
      });

    expect(res.statusCode).toEqual(201);
    expect(res.body.orderId).toBe(2001);
    expect(res.body.order.subtotal).toBe(698);
    expect(res.body.order.items[0].variantId).toBe(10);
    expect(res.body.order.items[0].variant_id).toBe(10);
    expect(res.body.order.items[0].variantLabel).toBe('Large');
    expect(res.body.order.items[0].variant_label).toBe('Large');
    expect(res.body.order.items[0].name).toBe('Pizza (Large)');
    expect(mockConnection.commit).toHaveBeenCalledTimes(1);
  });

  it('rejects a forged cross-product variantId in order creation', async () => {
    const mockConnection = {
      beginTransaction: jest.fn(),
      query: jest.fn()
        .mockResolvedValueOnce([[{ blocked: 0 }]])
        .mockResolvedValueOnce([[{ shop_open: 1, delivery_available: 1, delivery_charge: 10, night_charge: 0, fast_delivery_enabled: 0 }]])
        .mockResolvedValueOnce([[{ id: 1, name: 'Pizza', price: 349, available: 1 }]])
        .mockResolvedValueOnce([[{ id: 10, product_id: 2, label: 'Large', price: 349, available: 1, deleted: 0 }]]),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn()
    };
    pool.getConnection.mockReset();
    pool.getConnection.mockResolvedValue(mockConnection);

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${variantToken}`)
      .send({
        address: '123 Test St',
        paymentMethod: 'Cash',
        items: [{ productId: 1, variantId: 10, quantity: 2 }]
      });

    expect(res.statusCode).toEqual(400);
    expect(res.body.code).toEqual('VALIDATION_ERROR');
    expect(res.body.message).toContain('option is unavailable');
    expect(mockConnection.rollback).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Regression: a combo line item must never carry a client-supplied variantId
// through unvalidated. Combos skip the variant validation branch entirely
// (it only runs when !isCombo), so variantId must be forced to null rather
// than echoed/persisted as-is.
// ─────────────────────────────────────────────────────────────────────────

describe('combo items ignore a forged variantId', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('calculateCart nulls out variantId/variantLabel for a combo line', async () => {
    pool.query.mockResolvedValueOnce([[{ shop_open: 1, delivery_charge: 10, night_charge: 0 }]]);
    pool.query.mockResolvedValueOnce([[{ id: 40, name: 'Party Combo', price: 499, available: 1 }]]); // combo fetch

    const res = await request(app)
      .post('/api/cart/calculate')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ productId: 40, type: 'combo', variantId: 999999, quantity: 1 }] });

    expect(res.statusCode).toEqual(200);
    expect(res.body.items[0].unitPrice).toEqual(499);
    expect(res.body.items[0].variantId).toBeNull();
    expect(res.body.items[0].variant_id).toBeNull();
    expect(res.body.items[0].variantLabel).toBeNull();
  });

  it('createOrder nulls out variant_id/variant_label for a combo line', async () => {
    const comboToken = jwt.sign({ id: 998, role: 'customer' }, process.env.JWT_SECRET || 'secret');
    const mockConnection = {
      beginTransaction: jest.fn(),
      query: jest.fn()
        .mockResolvedValueOnce([[{ blocked: 0 }]])
        .mockResolvedValueOnce([[{ shop_open: 1, delivery_available: 1, delivery_charge: 10, night_charge: 0, fast_delivery_enabled: 0 }]])
        .mockResolvedValueOnce([[{ id: 40, name: 'Party Combo', price: 499, available: 1 }]]) // combo fetch
        .mockResolvedValueOnce([{ insertId: 3001 }])
        .mockResolvedValueOnce([{ affectedRows: 1 }]),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn()
    };
    pool.getConnection.mockResolvedValue(mockConnection);

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${comboToken}`)
      .send({
        address: '123 Test St',
        paymentMethod: 'Cash',
        items: [{ productId: 40, type: 'combo', variantId: 999999, quantity: 1 }]
      });

    expect(res.statusCode).toEqual(201);
    expect(res.body.order.items[0].unitPrice).toEqual(499);
    expect(res.body.order.items[0].variantId).toBeNull();
    expect(res.body.order.items[0].variant_id).toBeNull();

    const insertCall = mockConnection.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('INSERT INTO order_items')
    );
    expect(insertCall).toBeDefined();
    // values array layout: (area_id, order_id, product_id, variant_id, variant_label, item_type, product_name, quantity, unit_price, line_total)
    expect(insertCall[1][3]).toBeNull(); // variant_id must be null, not 999999
    expect(insertCall[1][4]).toBeNull(); // variant_label
  });
});
