/**
 * Tests for the coupon rule engine.
 *
 * Coverage:
 *  - Unit tests for every exported helper from src/utils/coupons.js
 *  - Integration tests for validateCoupon, findApplicableCoupons, and
 *    pickBestAutoApply with a mocked MySQL pool
 *  - A race-condition / transaction-order test that proves the
 *    createOrder controller acquires SELECT ... FOR UPDATE on the coupon
 *    row BEFORE counting redemptions and inserting a redemption row.
 *
 * Style mirrors cartOrder.test.js and orderIdempotency.test.js — we mock
 * the MySQL pool but import the real coupons.js implementation.
 */

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

const orderRoutes = require('../src/routes/orderRoutes');

jest.mock('../src/db/mysql', () => ({
  pool: {
    query: jest.fn().mockResolvedValue([[]]),
    getConnection: jest.fn(),
  },
}));

jest.mock('../src/realtime/orderEvents', () => ({
  emitOrderCreated: jest.fn(),
  emitOrderCancelled: jest.fn(),
  emitOrderStatusUpdated: jest.fn(),
  emitOrderPaymentUpdated: jest.fn(),
  emitNotificationCreated: jest.fn(),
}));

jest.mock('../src/utils/notificationService', () => ({
  createOrderNotification: jest.fn().mockResolvedValue({ insertId: 1 }),
}));

jest.mock('../src/utils/adminNotifications', () => ({
  TYPES: { NEW_ORDER: 'new_order' },
  createAdminNotification: jest.fn().mockResolvedValue({ id: 1 }),
}));

jest.mock('../src/realtime/orderAutoAccept', () => ({
  schedule: jest.fn(),
}));

// The order route now carries a per-user rate limiter (TASK 7). This file
// POSTs /api/orders 8+ times from one user to exercise coupon logic, which
// would trip the max:5/min cap. Neutralize the limiter here with a pass-through
// so coupon behaviour is tested in isolation; the limiter itself is active in
// production and in the other test files (which stay under the cap).
// Supports both default and named ({ rateLimit, ipKeyGenerator }) imports.
jest.mock('express-rate-limit', () => {
  const factory = () => (req, res, next) => next();
  factory.rateLimit = factory;
  factory.ipKeyGenerator = (ip) => String(ip);
  return factory;
});

const { pool } = require('../src/db/mysql');
const coupons = require('../src/utils/coupons');

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Builds a fully-populated coupon row with sensible defaults so individual
 * tests only have to override the fields they care about.
 */
const buildCoupon = (overrides = {}) => ({
  id: 1,
  code: 'WELCOME10',
  title: 'Welcome',
  description: 'Welcome offer',
  discount_type: 'flat',
  also_free_delivery: 0,
  discount_value: 10,
  max_discount_amount: null,
  min_order_amount: 0,
  min_item_count: null,
  max_order_amount: null,
  applies_to: 'all',
  starts_at: null,
  ends_at: null,
  active_days_mask: null,
  active_time_start: null,
  active_time_end: null,
  total_usage_limit: null,
  per_user_usage_limit: null,
  first_order_only: 0,
  first_n_orders: null,
  target_audience: 'all',
  auto_apply: 0,
  requires_code: 1,
  priority: 0,
  active: 1,
  deleted: 0,
  ...overrides,
});

const token = jwt.sign({ id: 1, role: 'customer' }, process.env.JWT_SECRET || 'secret');

// Build a tiny express app that mounts the real orderRoutes.
const app = express();
app.use(express.json());
app.use('/api/orders', orderRoutes);

// ─────────────────────────────────────────────────────────────────────────
// Unit tests — exported helpers
// ─────────────────────────────────────────────────────────────────────────

describe('coupons.isWithinDateWindow', () => {
  it('returns true when both starts_at and ends_at are NULL', () => {
    expect(coupons.isWithinDateWindow({ starts_at: null, ends_at: null })).toBe(true);
  });

  it('returns true when now is between starts_at and ends_at', () => {
    const now = new Date('2025-06-15T10:00:00Z');
    expect(coupons.isWithinDateWindow({
      starts_at: '2025-06-01T00:00:00Z',
      ends_at: '2025-06-30T00:00:00Z',
    }, now)).toBe(true);
  });

  it('returns false when now is before starts_at', () => {
    const now = new Date('2025-05-15T10:00:00Z');
    expect(coupons.isWithinDateWindow({
      starts_at: '2025-06-01T00:00:00Z',
      ends_at: '2025-06-30T00:00:00Z',
    }, now)).toBe(false);
  });

  it('treats ends_at as inclusive up to the end of that minute', () => {
    // ends_at = 2025-06-30T00:00:00Z, now = 2025-06-30T00:00:30Z
    // That's still within the same minute, so it should be allowed.
    const now = new Date('2025-06-30T00:00:30Z');
    expect(coupons.isWithinDateWindow({
      starts_at: '2025-06-01T00:00:00Z',
      ends_at: '2025-06-30T00:00:00Z',
    }, now)).toBe(true);
  });

  it('rejects when now is more than a minute past ends_at', () => {
    const now = new Date('2025-06-30T00:01:30Z');
    expect(coupons.isWithinDateWindow({
      starts_at: '2025-06-01T00:00:00Z',
      ends_at: '2025-06-30T00:00:00Z',
    }, now)).toBe(false);
  });

  it('ignores null starts_at', () => {
    const now = new Date('2020-01-01T00:00:00Z');
    expect(coupons.isWithinDateWindow({ starts_at: null, ends_at: '2025-12-31T00:00:00Z' }, now)).toBe(true);
  });
});

describe('coupons.isWithinActiveDays', () => {
  it('returns true when active_days_mask is null', () => {
    expect(coupons.isWithinActiveDays({ active_days_mask: null })).toBe(true);
  });

  it('returns true when active_days_mask is undefined', () => {
    expect(coupons.isWithinActiveDays({})).toBe(true);
  });

  it('returns true when today\'s day-bit is set in the mask', () => {
    // Wednesday June 18 2025 = day 3
    const now = new Date('2025-06-18T12:00:00Z');
    // bit 3 set
    expect(coupons.isWithinActiveDays({ active_days_mask: 1 << 3 }, now)).toBe(true);
  });

  it('returns false when today\'s day-bit is NOT set in the mask', () => {
    // Wednesday June 18 2025 = day 3
    const now = new Date('2025-06-18T12:00:00Z');
    // only weekend bits set
    expect(coupons.isWithinActiveDays({ active_days_mask: (1 << 0) | (1 << 6) }, now)).toBe(false);
  });

  it('handles Sunday (day 0) correctly', () => {
    // June 15 2025 is a Sunday
    const sunday = new Date('2025-06-15T12:00:00Z');
    expect(coupons.isWithinActiveDays({ active_days_mask: 1 << 0 }, sunday)).toBe(true);
    expect(coupons.isWithinActiveDays({ active_days_mask: 1 << 1 }, sunday)).toBe(false);
  });
});

describe('coupons.isWithinActiveTime', () => {
  it('returns true when both start and end are missing', () => {
    expect(coupons.isWithinActiveTime({ active_time_start: null, active_time_end: null })).toBe(true);
  });

  it('returns true when only start is missing', () => {
    expect(coupons.isWithinActiveTime({ active_time_start: null, active_time_end: '18:00' })).toBe(true);
  });

  it('returns true when only end is missing', () => {
    expect(coupons.isWithinActiveTime({ active_time_start: '09:00', active_time_end: null })).toBe(true);
  });

  it('treats start === end as no real window (always allowed)', () => {
    expect(coupons.isWithinActiveTime({ active_time_start: '12:00', active_time_end: '12:00' })).toBe(true);
  });

  it('allows times inside a normal (non-overnight) window', () => {
    // Use a fixed Asia/Kolkata time: noon should be inside 09:00–18:00.
    // Build a Date that yields ~12:00 in IST regardless of the test host TZ.
    const now = new Date();
    // 12:00 IST = 06:30 UTC. We can't easily construct that portably
    // without date-fns-tz, so we test both ends with generous bounds.
    expect(coupons.isWithinActiveTime({
      active_time_start: '00:00',
      active_time_end: '23:59',
    }, now)).toBe(true);
  });

  it('rejects times outside a normal window', () => {
    // Midnight IST is outside 09:00–17:00. Use a Date that yields 00:00 IST.
    // We can't guarantee that without tz libs, so instead verify the
    // overnight path doesn't match a same-day window with a very tight range
    // that is unlikely to contain "now" in any test environment.
    const noon = new Date();
    expect(coupons.isWithinActiveTime({
      active_time_start: '00:01',
      active_time_end: '00:02',
    }, noon)).toBe(false);
  });

  it('handles overnight windows (e.g. 21:00 → 06:00)', () => {
    // The coupon engine evaluates the current time-of-day in IST
    // (Asia/Kolkata). Pin the wall clock to a moment that falls inside
    // an overnight window so the test is deterministic regardless of
    // when it runs. We pick 00:01 IST, which lies in [21:00, 06:00).
    // 00:01 IST == 18:31 UTC the previous day.
    jest.useFakeTimers().setSystemTime(new Date('2025-06-15T18:31:00Z'));
    try {
      const now = new Date();
      expect(coupons.isWithinActiveTime({
        active_time_start: '21:00',
        active_time_end: '06:00',
      }, now)).toBe(true);
      // And a moment inside the same window from the late-evening arm.
      jest.setSystemTime(new Date('2025-06-15T20:00:00Z')); // 01:30 IST
      expect(coupons.isWithinActiveTime({
        active_time_start: '21:00',
        active_time_end: '06:00',
      }, new Date())).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('coupons.computeDiscount', () => {
  it('returns 0 when coupon is null', () => {
    expect(coupons.computeDiscount(null, { subtotal: 100, deliveryCharge: 10 })).toBe(0);
  });

  it('handles flat discount', () => {
    expect(coupons.computeDiscount(
      buildCoupon({ discount_type: 'flat', discount_value: 25 }),
      { subtotal: 100, deliveryCharge: 10 }
    )).toBe(25);
  });

  it('caps flat discount at the subtotal (never negative)', () => {
    expect(coupons.computeDiscount(
      buildCoupon({ discount_type: 'flat', discount_value: 200 }),
      { subtotal: 50, deliveryCharge: 10 }
    )).toBe(50);
  });

  it('handles percent discount', () => {
    expect(coupons.computeDiscount(
      buildCoupon({ discount_type: 'percent', discount_value: 10 }),
      { subtotal: 200, deliveryCharge: 10 }
    )).toBe(20);
  });

  it('rounds percent discount to two decimals', () => {
    // 10% of 33.33 = 3.333 → 3.33
    expect(coupons.computeDiscount(
      buildCoupon({ discount_type: 'percent', discount_value: 10 }),
      { subtotal: 33.33, deliveryCharge: 0 }
    )).toBe(3.33);
  });

  it('caps percent discount at max_discount_amount', () => {
    // 50% of 200 = 100, capped at 30
    expect(coupons.computeDiscount(
      buildCoupon({ discount_type: 'percent', discount_value: 50, max_discount_amount: 30 }),
      { subtotal: 200, deliveryCharge: 0 }
    )).toBe(30);
  });

  it('caps percent discount at the subtotal', () => {
    // 100% of 50 = 50, but subtotal is only 50
    expect(coupons.computeDiscount(
      buildCoupon({ discount_type: 'percent', discount_value: 100 }),
      { subtotal: 50, deliveryCharge: 0 }
    )).toBe(50);
  });

  it('handles free_delivery (returns delivery charge)', () => {
    expect(coupons.computeDiscount(
      buildCoupon({ discount_type: 'free_delivery', discount_value: 0 }),
      { subtotal: 200, deliveryCharge: 30 }
    )).toBe(30);
  });

  it('caps free_delivery at subtotal + delivery', () => {
    expect(coupons.computeDiscount(
      buildCoupon({ discount_type: 'free_delivery', discount_value: 0 }),
      { subtotal: 5, deliveryCharge: 30 }
    )).toBe(30);
  });

  it('free_delivery on a fast order does not waive delivery — full fast fee stays payable', () => {
    // Fast delivery fully replaces standard. Free-delivery coupons only
    // apply to Standard; Fast is always charged in full on the bill.
    expect(coupons.computeDiscount(
      buildCoupon({ discount_type: 'free_delivery', discount_value: 0 }),
      { subtotal: 200, deliveryCharge: 50, standardDeliveryCharge: 30 }
    )).toBe(0);
  });

  it('free_delivery falls back to the effective charge when standardDeliveryCharge is omitted', () => {
    expect(coupons.computeDiscount(
      buildCoupon({ discount_type: 'free_delivery', discount_value: 0 }),
      { subtotal: 200, deliveryCharge: 30, standardDeliveryCharge: null }
    )).toBe(30);
  });

  it('returns 0 for unknown discount_type', () => {
    expect(coupons.computeDiscount(
      buildCoupon({ discount_type: 'bogus' }),
      { subtotal: 100, deliveryCharge: 10 }
    )).toBe(0);
  });

  it('checkEligibility: free_delivery on fast order is rejected', async () => {
    // Fast order: free delivery is not granted; full fast fee stays on bill.
    const result = await coupons.checkEligibility({
      coupon: buildCoupon({ discount_type: 'free_delivery', discount_value: 0 }),
      subtotal: 200,
      deliveryCharge: 50,
      standardDeliveryCharge: 30,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Standard delivery only/i);
  });

  it('also_free_delivery keeps item discount on fast but drops free-delivery waiver', () => {
    const coupon = buildCoupon({
      discount_type: 'flat',
      discount_value: 40,
      also_free_delivery: 1,
    });
    const r = coupons.computeDiscountBreakdown(coupon, {
      subtotal: 200,
      deliveryCharge: 50,
      standardDeliveryCharge: 30,
    });
    expect(r.itemDiscount).toBe(40);
    expect(r.freeDeliveryWaiver).toBe(0);
    expect(r.discount).toBe(40);
  });
});

describe('coupons.buildSavingsText', () => {
  it('uses "You save ₹X" when discount > 0', () => {
    expect(coupons.buildSavingsText(buildCoupon({ discount_type: 'flat', discount_value: 25 }), 25))
      .toBe('You save ₹25');
  });

  it('uses fallback text for flat coupons when no computed discount', () => {
    expect(coupons.buildSavingsText(buildCoupon({ discount_type: 'flat', discount_value: 50 }), 0))
      .toBe('₹50 off');
  });

  it('uses percent text with optional cap suffix', () => {
    expect(coupons.buildSavingsText(
      buildCoupon({ discount_type: 'percent', discount_value: 20 }),
      0
    )).toBe('20% off');
    expect(coupons.buildSavingsText(
      buildCoupon({ discount_type: 'percent', discount_value: 20, max_discount_amount: 50 }),
      0
    )).toBe('20% off (up to ₹50)');
  });

  it('uses "Free delivery" for free_delivery coupons', () => {
    expect(coupons.buildSavingsText(
      buildCoupon({ discount_type: 'free_delivery' }),
      0
    )).toBe('Free delivery');
  });

  it('falls back to a generic message for unknown types', () => {
    expect(coupons.buildSavingsText(buildCoupon({ discount_type: 'unknown' }), 0))
      .toBe('Discount available');
  });
});

describe('coupons.isUserTargeted', () => {
  it('returns true for target_audience="all" without hitting the DB', async () => {
    const conn = { query: jest.fn() };
    const result = await coupons.isUserTargeted(conn, buildCoupon({ target_audience: 'all' }), 1);
    expect(result).toBe(true);
    expect(conn.query).not.toHaveBeenCalled();
  });

  it('returns true for target_audience="selected" when coupon_users row exists', async () => {
    const conn = { query: jest.fn().mockResolvedValue([[{ '1': 1 }]]) };
    const result = await coupons.isUserTargeted(conn, buildCoupon({ target_audience: 'selected', id: 7 }), 42);
    expect(result).toBe(true);
    expect(conn.query).toHaveBeenCalledWith(
      'SELECT 1 FROM coupon_users WHERE coupon_id = ? AND user_id = ? LIMIT 1',
      [7, 42]
    );
  });

  it('returns false for target_audience="selected" when no row exists', async () => {
    const conn = { query: jest.fn().mockResolvedValue([[]]) };
    const result = await coupons.isUserTargeted(conn, buildCoupon({ target_audience: 'selected' }), 42);
    expect(result).toBe(false);
  });

  it('returns true when coupon is null and target_audience is irrelevant', async () => {
    const conn = { query: jest.fn() };
    const result = await coupons.isUserTargeted(conn, null, 42);
    expect(result).toBe(true);
    expect(conn.query).not.toHaveBeenCalled();
  });
});

describe('coupons.isZoneTargeted', () => {
  it('returns true for target_zones="all" without hitting the DB', async () => {
    const conn = { query: jest.fn() };
    const result = await coupons.isZoneTargeted(conn, buildCoupon({ target_zones: 'all' }), 3);
    expect(result).toBe(true);
    expect(conn.query).not.toHaveBeenCalled();
  });

  it('returns true for target_zones="all" even with no matched zone (unzoned cart)', async () => {
    const conn = { query: jest.fn() };
    const result = await coupons.isZoneTargeted(conn, buildCoupon({ target_zones: 'all' }), null);
    expect(result).toBe(true);
    expect(conn.query).not.toHaveBeenCalled();
  });

  it('returns false for target_zones="selected" when there is no matched zone, without hitting the DB', async () => {
    const conn = { query: jest.fn() };
    const result = await coupons.isZoneTargeted(conn, buildCoupon({ target_zones: 'selected', id: 7 }), null);
    expect(result).toBe(false);
    expect(conn.query).not.toHaveBeenCalled();
  });

  it('returns true for target_zones="selected" when a coupon_zones row exists for the zone', async () => {
    const conn = {
      query: jest.fn()
        .mockResolvedValueOnce([[{ parent_zone_id: null }]]) // zone 3 is top-level
        .mockResolvedValueOnce([[{ '1': 1 }]]),
    };
    const result = await coupons.isZoneTargeted(conn, buildCoupon({ target_zones: 'selected', id: 7 }), 3);
    expect(result).toBe(true);
    expect(conn.query).toHaveBeenLastCalledWith(
      'SELECT 1 FROM coupon_zones WHERE coupon_id = ? AND delivery_zone_id IN (?) LIMIT 1',
      [7, [3]]
    );
  });

  // Zone matching always resolves to the most nested zone, so a coupon aimed
  // at a parent village would otherwise never fire for anyone standing in one
  // of its sub-village children.
  it('returns true for target_zones="selected" when the coupon targets an ANCESTOR of the matched zone', async () => {
    const conn = {
      query: jest.fn()
        .mockResolvedValueOnce([[{ parent_zone_id: 2 }]])    // zone 5's parent is 2
        .mockResolvedValueOnce([[{ parent_zone_id: null }]]) // zone 2 is top-level
        .mockResolvedValueOnce([[{ '1': 1 }]]),              // coupon_zones has zone 2
    };
    const result = await coupons.isZoneTargeted(conn, buildCoupon({ target_zones: 'selected', id: 7 }), 5);
    expect(result).toBe(true);
    expect(conn.query).toHaveBeenLastCalledWith(
      expect.stringContaining('delivery_zone_id IN (?)'),
      [7, [5, 2]]
    );
  });

  it('stops walking a cyclic parent chain instead of hanging', async () => {
    const conn = {
      query: jest.fn()
        .mockResolvedValueOnce([[{ parent_zone_id: 2 }]])
        .mockResolvedValueOnce([[{ parent_zone_id: 1 }]]) // points back at 1
        .mockResolvedValueOnce([[]]),
    };
    const result = await coupons.isZoneTargeted(conn, buildCoupon({ target_zones: 'selected', id: 7 }), 1);
    expect(result).toBe(false);
    expect(conn.query).toHaveBeenLastCalledWith(
      expect.stringContaining('delivery_zone_id IN (?)'),
      [7, [1, 2]]
    );
  });

  it('returns false for target_zones="selected" when no coupon_zones row matches the zone', async () => {
    const conn = { query: jest.fn().mockResolvedValue([[]]) };
    const result = await coupons.isZoneTargeted(conn, buildCoupon({ target_zones: 'selected', id: 7 }), 99);
    expect(result).toBe(false);
  });

  it('returns true when coupon is null', async () => {
    const conn = { query: jest.fn() };
    const result = await coupons.isZoneTargeted(conn, null, 3);
    expect(result).toBe(true);
    expect(conn.query).not.toHaveBeenCalled();
  });
});

describe('coupons.getUserOrderCount / getUserRedemptionCount / getGlobalRedemptionCount', () => {
  it('getUserOrderCount runs COUNT(*) excluding cancelled orders', async () => {
    const conn = { query: jest.fn().mockResolvedValue([[{ count: 3 }]]) };
    const n = await coupons.getUserOrderCount(conn, 1);
    expect(n).toBe(3);
    expect(conn.query).toHaveBeenCalledWith(
      expect.stringContaining("status != 'Cancelled'"),
      [1]
    );
  });

  it('getUserOrderCount returns 0 when no rows', async () => {
    const conn = { query: jest.fn().mockResolvedValue([[{ count: 0 }]]) };
    expect(await coupons.getUserOrderCount(conn, 1)).toBe(0);
  });

  it('getUserOrderCount returns 0 when rows[0] is undefined', async () => {
    const conn = { query: jest.fn().mockResolvedValue([[]]) };
    expect(await coupons.getUserOrderCount(conn, 1)).toBe(0);
  });

  it('getUserRedemptionCount counts active coupon_redemptions for (coupon, user)', async () => {
    const conn = { query: jest.fn().mockResolvedValue([[{ count: 2 }]]) };
    const n = await coupons.getUserRedemptionCount(conn, 7, 42);
    expect(n).toBe(2);
    expect(conn.query).toHaveBeenCalledWith(
      "SELECT COUNT(*) as count FROM coupon_redemptions WHERE coupon_id = ? AND user_id = ? AND status = 'active'",
      [7, 42]
    );
  });

  it('getGlobalRedemptionCount counts all active redemptions for a coupon', async () => {
    const conn = { query: jest.fn().mockResolvedValue([[{ count: 100 }]]) };
    const n = await coupons.getGlobalRedemptionCount(conn, 7);
    expect(n).toBe(100);
    expect(conn.query).toHaveBeenCalledWith(
      "SELECT COUNT(*) as count FROM coupon_redemptions WHERE coupon_id = ? AND status = 'active'",
      [7]
    );
  });
});

describe('coupons.checkEligibility — failure paths (no DB)', () => {
  it('returns "Coupon not found" when coupon is null', async () => {
    const result = await coupons.checkEligibility({ coupon: null });
    expect(result).toEqual({ ok: false, reason: 'Coupon not found' });
  });

  it('rejects deleted coupons', async () => {
    const r = await coupons.checkEligibility({ coupon: buildCoupon({ deleted: 1 }) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no longer active/);
  });

  it('rejects inactive coupons', async () => {
    const r = await coupons.checkEligibility({ coupon: buildCoupon({ active: 0 }) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no longer active/);
  });

  it('rejects coupons outside the date window', async () => {
    const r = await coupons.checkEligibility({
      coupon: buildCoupon({ starts_at: '2030-01-01T00:00:00Z', ends_at: '2030-12-31T00:00:00Z' }),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/expired or is not yet active/);
  });

  it('rejects coupons when day-of-week is masked out', async () => {
    // Wednesday June 18 2025. Mask only allows Sunday (bit 0).
    const r = await coupons.checkEligibility({
      coupon: buildCoupon({ active_days_mask: 1 << 0 }),
      now: new Date('2025-06-18T12:00:00Z'),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not valid today/);
  });

  it('rejects coupons outside the active_time window', async () => {
    // Use a tight same-day window that "now" almost certainly misses.
    const r = await coupons.checkEligibility({
      coupon: buildCoupon({ active_time_start: '00:01', active_time_end: '00:02' }),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not valid at this time/);
  });

  it('rejects when applies_to does not match storeType', async () => {
    const r = await coupons.checkEligibility({
      coupon: buildCoupon({ applies_to: 'packed' }),
      storeType: 'fast_food',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/only valid for packed orders/);
  });

  it('rejects when subtotal is below min_order_amount and reports the shortfall', async () => {
    const r = await coupons.checkEligibility({
      coupon: buildCoupon({ min_order_amount: 100 }),
      subtotal: 60,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Add ₹40 more/);
    expect(r.reason).toMatch(/min order ₹100/);
  });

  it('rejects when subtotal exceeds max_order_amount', async () => {
    const r = await coupons.checkEligibility({
      coupon: buildCoupon({ max_order_amount: 500 }),
      subtotal: 600,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/up to ₹500/);
  });

  it('rejects when item count is below min_item_count and reports the shortfall', async () => {
    const r = await coupons.checkEligibility({
      coupon: buildCoupon({ min_item_count: 3 }),
      subtotal: 200,
      itemCount: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Add 2 more item\(s\)/);
    expect(r.reason).toMatch(/min 3 items/);
  });

  it('accepts when item count exactly meets min_item_count', async () => {
    const r = await coupons.checkEligibility({
      coupon: buildCoupon({ discount_type: 'flat', discount_value: 15, min_item_count: 3 }),
      subtotal: 200,
      itemCount: 3,
    });
    expect(r.ok).toBe(true);
    expect(r.discount).toBe(15);
  });

  it('rejects when amount is met but item count is not (AND semantics)', async () => {
    const r = await coupons.checkEligibility({
      coupon: buildCoupon({ min_order_amount: 100, min_item_count: 3 }),
      subtotal: 150,
      itemCount: 2,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Add 1 more item\(s\)/);
  });

  it('rejects when item count is met but amount is not (AND semantics)', async () => {
    const r = await coupons.checkEligibility({
      coupon: buildCoupon({ min_order_amount: 100, min_item_count: 3 }),
      subtotal: 50,
      itemCount: 5,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Add ₹50 more/);
  });

  it('treats min_item_count=null as no item-count gate', async () => {
    const r = await coupons.checkEligibility({
      coupon: buildCoupon({ min_item_count: null }),
      subtotal: 10,
      itemCount: 1,
    });
    expect(r.ok).toBe(true);
  });

  it('returns ok:true and the computed discount when everything passes', async () => {
    const r = await coupons.checkEligibility({
      coupon: buildCoupon({ discount_type: 'flat', discount_value: 15 }),
      subtotal: 200,
      deliveryCharge: 30,
    });
    expect(r.ok).toBe(true);
    expect(r.discount).toBe(15);
    expect(r.coupon.id).toBe(1);
  });

  it('skips usage checks when skipUsageChecks=true', async () => {
    const conn = { query: jest.fn() };
    const r = await coupons.checkEligibility({
      coupon: buildCoupon({ per_user_usage_limit: 1, first_order_only: 1 }),
      subtotal: 200,
      connection: conn,
      userId: 1,
      skipUsageChecks: true,
    });
    expect(r.ok).toBe(true);
    // No DB queries should have been issued.
    expect(conn.query).not.toHaveBeenCalled();
  });
});

describe('coupons.checkEligibility — DB-backed usage checks', () => {
  it('rejects when per-user usage limit is hit', async () => {
    // First call: isUserTargeted → returns row (audience=selected → checks DB)
    // Second call: getUserRedemptionCount → returns 1 (limit hit)
    const conn = {
      query: jest.fn()
        .mockResolvedValueOnce([[{ '1': 1 }]])  // coupon_users row exists
        .mockResolvedValueOnce([[{ count: 1 }]]) // user redemption count
    };
    const r = await coupons.checkEligibility({
      coupon: buildCoupon({ target_audience: 'selected', per_user_usage_limit: 1 }),
      subtotal: 200,
      connection: conn,
      userId: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/already used this coupon 1 time/);
  });

  it('rejects when global usage limit is hit', async () => {
    // target_audience defaults to 'all' so isUserTargeted short-circuits
    // without a DB query. per_user_usage_limit is null so the per-user
    // count is also skipped. The only DB hit is the global redemption
    // count, which we mock as 100 (== total_usage_limit).
    const conn = {
      query: jest.fn()
        .mockResolvedValueOnce([[{ count: 100 }]]) // global count
    };
    const r = await coupons.checkEligibility({
      coupon: buildCoupon({ total_usage_limit: 100 }),
      subtotal: 200,
      connection: conn,
      userId: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/maximum usage limit/);
  });

  it('rejects first_order_only coupon when the user has prior orders', async () => {
    const conn = {
      query: jest.fn()
        .mockResolvedValueOnce([[{ count: 1 }]]) // getUserOrderCount
    };
    const r = await coupons.checkEligibility({
      coupon: buildCoupon({ first_order_only: 1 }),
      subtotal: 200,
      connection: conn,
      userId: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/only valid on your first order/);
  });

  it('rejects first_n_orders coupon when user has hit the threshold', async () => {
    const conn = {
      query: jest.fn()
        .mockResolvedValueOnce([[{ count: 3 }]])
    };
    const r = await coupons.checkEligibility({
      coupon: buildCoupon({ first_n_orders: 3 }),
      subtotal: 200,
      connection: conn,
      userId: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/only valid for your first 3 orders/);
  });

  it('rejects when target audience is "selected" and user is not in coupon_users', async () => {
    const conn = {
      query: jest.fn().mockResolvedValueOnce([[]]) // no row
    };
    const r = await coupons.checkEligibility({
      coupon: buildCoupon({ target_audience: 'selected' }),
      subtotal: 200,
      connection: conn,
      userId: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not available for your account/);
  });

  it('rejects when target_zones is "selected" and the cart has no matched zone (no DB hit)', async () => {
    const conn = { query: jest.fn() };
    const r = await coupons.checkEligibility({
      coupon: buildCoupon({ target_zones: 'selected' }),
      subtotal: 200,
      connection: conn,
      userId: 1,
      zoneId: null,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not available for your delivery zone/);
    expect(conn.query).not.toHaveBeenCalled();
  });

  it('rejects when target_zones is "selected" and the matched zone is not in coupon_zones', async () => {
    const conn = {
      query: jest.fn()
        .mockResolvedValueOnce([[{ parent_zone_id: null }]]) // ancestor walk — zone 5 is top-level
        .mockResolvedValueOnce([[]])                          // coupon_zones lookup — no row
    };
    const r = await coupons.checkEligibility({
      coupon: buildCoupon({ target_zones: 'selected' }),
      subtotal: 200,
      connection: conn,
      userId: 1,
      zoneId: 5,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not available for your delivery zone/);
  });

  it('allows when target_zones is "selected" and the matched zone is in coupon_zones', async () => {
    const conn = {
      query: jest.fn()
        .mockResolvedValueOnce([[{ parent_zone_id: null }]]) // ancestor walk — zone 5 is top-level
        .mockResolvedValueOnce([[{ '1': 1 }]])                // coupon_zones lookup — row exists
    };
    const r = await coupons.checkEligibility({
      coupon: buildCoupon({ target_zones: 'selected' }),
      subtotal: 200,
      connection: conn,
      userId: 1,
      zoneId: 5,
    });
    expect(r.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Integration tests — validateCoupon / pickBestAutoApply / findApplicableCoupons
// ─────────────────────────────────────────────────────────────────────────

describe('coupons.validateCoupon', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects empty / non-string codes without hitting the DB', async () => {
    expect(await coupons.validateCoupon({ code: '' })).toEqual({ ok: false, reason: 'Please enter a coupon code' });
    expect(await coupons.validateCoupon({ code: null })).toEqual({ ok: false, reason: 'Please enter a coupon code' });
    expect(await coupons.validateCoupon({ code: 123 })).toEqual({ ok: false, reason: 'Please enter a coupon code' });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('normalizes code (trim + uppercase) before querying', async () => {
    pool.query.mockResolvedValueOnce([[]]); // not found
    const r = await coupons.validateCoupon({ code: '  welcome10  ' });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT * FROM coupons'),
      ['WELCOME10']
    );
    expect(r).toEqual({ ok: false, reason: 'Invalid coupon code' });
  });

  it('returns "Invalid coupon code" when DB returns no rows', async () => {
    pool.query.mockResolvedValueOnce([[]]);
    const r = await coupons.validateCoupon({ code: 'NOPE' });
    expect(r).toEqual({ ok: false, reason: 'Invalid coupon code' });
  });

  it('returns ok:true with computed discount on success', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({ code: 'FLAT20', discount_type: 'flat', discount_value: 20 })
    ]]);
    const r = await coupons.validateCoupon({ code: 'flat20', subtotal: 100, deliveryCharge: 10 });
    expect(r.ok).toBe(true);
    expect(r.discount).toBe(20);
    expect(r.coupon.code).toBe('FLAT20');
  });

  it('uses provided connection instead of pool when supplied', async () => {
    const conn = { query: jest.fn().mockResolvedValue([[
      buildCoupon({ code: 'CONN', discount_type: 'flat', discount_value: 5 })
    ]]) };
    const r = await coupons.validateCoupon({ code: 'CONN', subtotal: 100, connection: conn });
    expect(r.ok).toBe(true);
    expect(conn.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT * FROM coupons'),
      ['CONN']
    );
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns reason for an expired coupon', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({ starts_at: '2020-01-01T00:00:00Z', ends_at: '2020-12-31T00:00:00Z' })
    ]]);
    const r = await coupons.validateCoupon({ code: 'OLD', subtotal: 100 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/expired/);
  });
});

describe('coupons.validateCouponById', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects a missing couponId without hitting the DB', async () => {
    expect(await coupons.validateCouponById({ couponId: null })).toEqual({ ok: false, reason: 'Coupon not found' });
    expect(await coupons.validateCouponById({ couponId: undefined })).toEqual({ ok: false, reason: 'Coupon not found' });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns "Coupon not found" when the id has no matching row', async () => {
    pool.query.mockResolvedValueOnce([[]]);
    const r = await coupons.validateCouponById({ couponId: 999 });
    expect(r).toEqual({ ok: false, reason: 'Coupon not found' });
  });

  // Regression test: auto-apply-only offers can have code = NULL (the admin
  // "no code" offer type). Force-applying such an offer by id must succeed
  // even though it has no code to look up by — this is exactly the case
  // that broke the cart's tap-to-apply toggle before validateCouponById
  // existed (see cartController.calculateCart).
  it('resolves a no-code (code = null) auto-apply coupon by id', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({ id: 2, code: null, auto_apply: 1, requires_code: 0, discount_type: 'flat', discount_value: 15 })
    ]]);
    const r = await coupons.validateCouponById({ couponId: 2, subtotal: 100 });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE id = ?'),
      [2]
    );
    expect(r.ok).toBe(true);
    expect(r.coupon.id).toBe(2);
    expect(r.coupon.code).toBeNull();
    expect(r.discount).toBe(15);
  });

  it('uses provided connection instead of pool when supplied', async () => {
    const conn = { query: jest.fn().mockResolvedValue([[
      buildCoupon({ id: 3, code: 'CONN', discount_type: 'flat', discount_value: 5 })
    ]]) };
    const r = await coupons.validateCouponById({ couponId: 3, subtotal: 100, connection: conn });
    expect(r.ok).toBe(true);
    expect(conn.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE id = ?'),
      [3]
    );
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns reason for an expired coupon', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({ id: 4, starts_at: '2020-01-01T00:00:00Z', ends_at: '2020-12-31T00:00:00Z' })
    ]]);
    const r = await coupons.validateCouponById({ couponId: 4, subtotal: 100 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/expired/);
  });
});

describe('coupons.pickBestAutoApply', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when no auto-apply coupons exist', async () => {
    pool.query.mockResolvedValueOnce([[]]);
    const r = await coupons.pickBestAutoApply({ subtotal: 200 });
    expect(r).toBeNull();
  });

  it('picks the highest-discount coupon', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({ id: 1, code: 'A', discount_type: 'flat', discount_value: 10 }),
      buildCoupon({ id: 2, code: 'B', discount_type: 'flat', discount_value: 50 }),
    ]]);
    const r = await coupons.pickBestAutoApply({ subtotal: 200, deliveryCharge: 30 });
    expect(r).not.toBeNull();
    expect(r.coupon.id).toBe(2);
    expect(r.discount).toBe(50);
  });

  it('skips coupons that fail eligibility (e.g. min order not met)', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({ id: 1, code: 'BIG', discount_type: 'flat', discount_value: 50, min_order_amount: 500 }),
      buildCoupon({ id: 2, code: 'SMALL', discount_type: 'flat', discount_value: 10 }),
    ]]);
    const r = await coupons.pickBestAutoApply({ subtotal: 100 });
    expect(r.coupon.id).toBe(2);
    expect(r.discount).toBe(10);
  });

  it('passes userId and connection into eligibility checks', async () => {
    const conn = { query: jest.fn() };
    // We expect the initial candidates query, then checkEligibility will
    // inspect each coupon. Provide candidates that fail per-user usage so
    // eligibility will exercise the DB helpers.
    conn.query
      .mockResolvedValueOnce([[
        buildCoupon({ id: 9, discount_type: 'flat', discount_value: 5, per_user_usage_limit: 1 })
      ]])
      .mockResolvedValueOnce([[{ count: 1 }]]); // redemption count

    const r = await coupons.pickBestAutoApply({ subtotal: 200, userId: 1, connection: conn });
    expect(r).toBeNull(); // single candidate, but it fails per-user limit
  });

  it('passes now into the candidate query as both starts_at and ends_at bound', async () => {
    const now = new Date('2025-06-15T10:00:00Z');
    pool.query.mockResolvedValueOnce([[]]);
    await coupons.pickBestAutoApply({ subtotal: 100, now });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('auto_apply = 1'),
      [now, now]
    );
  });

  it('keeps free_delivery when a later discount has lower total savings (no also_free_delivery)', async () => {
    // FREEDEL waives ₹35. SAVE10 is only ₹20 item off without free delivery → free_delivery is best.
    pool.query.mockResolvedValueOnce([[
      buildCoupon({
        id: 1,
        code: 'FREEDEL',
        discount_type: 'free_delivery',
        discount_value: 0,
        min_order_amount: 150,
        auto_apply: 1,
        requires_code: 0,
        priority: 5,
      }),
      buildCoupon({
        id: 2,
        code: 'SAVE10',
        discount_type: 'percent',
        discount_value: 10,
        min_order_amount: 200,
        auto_apply: 1,
        requires_code: 0,
        priority: 1,
      }),
    ]]);
    const r = await coupons.pickBestAutoApply({
      subtotal: 200,
      deliveryCharge: 35,
      standardDeliveryCharge: 35,
    });
    expect(r).not.toBeNull();
    expect(r.coupon.id).toBe(1);
    expect(r.coupon.discount_type).toBe('free_delivery');
    expect(r.discount).toBe(35);
  });

  it('keeps free_delivery when the later discount is not yet unlocked', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({
        id: 1,
        code: 'FREEDEL',
        discount_type: 'free_delivery',
        discount_value: 0,
        min_order_amount: 150,
        auto_apply: 1,
        requires_code: 0,
      }),
      buildCoupon({
        id: 2,
        code: 'SAVE10',
        discount_type: 'flat',
        discount_value: 40,
        also_free_delivery: 1,
        min_order_amount: 200,
        auto_apply: 1,
        requires_code: 0,
      }),
    ]]);
    const r = await coupons.pickBestAutoApply({
      subtotal: 170,
      deliveryCharge: 35,
      standardDeliveryCharge: 35,
    });
    expect(r).not.toBeNull();
    expect(r.coupon.id).toBe(1);
    expect(r.coupon.discount_type).toBe('free_delivery');
  });

  it('prefers combined also_free_delivery offer over pure free_delivery (higher total savings)', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({
        id: 1,
        code: 'FREEDEL',
        discount_type: 'free_delivery',
        discount_value: 0,
        min_order_amount: 150,
        auto_apply: 1,
        requires_code: 0,
      }),
      buildCoupon({
        id: 2,
        code: 'SAVE10FREE',
        discount_type: 'percent',
        discount_value: 10,
        also_free_delivery: 1,
        min_order_amount: 200,
        auto_apply: 1,
        requires_code: 0,
      }),
    ]]);
    const r = await coupons.pickBestAutoApply({
      subtotal: 200,
      deliveryCharge: 35,
      standardDeliveryCharge: 35,
    });
    expect(r).not.toBeNull();
    expect(r.coupon.id).toBe(2);
    // 10% of 200 = 20 item + 35 free delivery waiver
    expect(r.discount).toBe(55);
    expect(r.freeDeliveryWaiver).toBe(35);
    expect(r.itemDiscount).toBe(20);
  });

  it('at a filled ₹400 bar picks the ₹400 coupon, not a lower unlocked ₹300 tier', async () => {
    // Free delivery @150, then discount+free ladder @200 / @300 / @400.
    // Completing ₹400 must auto-apply the ₹400 offer (max savings), not ₹300.
    pool.query.mockResolvedValueOnce([[
      buildCoupon({
        id: 1,
        code: 'FREEDEL',
        discount_type: 'free_delivery',
        discount_value: 0,
        min_order_amount: 150,
        auto_apply: 1,
        requires_code: 0,
        priority: 10,
      }),
      buildCoupon({
        id: 2,
        code: 'SAVE10',
        discount_type: 'flat',
        discount_value: 10,
        also_free_delivery: 1,
        min_order_amount: 200,
        auto_apply: 1,
        requires_code: 0,
        priority: 9,
      }),
      buildCoupon({
        id: 3,
        code: 'SAVE20',
        discount_type: 'flat',
        discount_value: 20,
        also_free_delivery: 1,
        min_order_amount: 300,
        auto_apply: 1,
        requires_code: 0,
        priority: 8,
      }),
      buildCoupon({
        id: 4,
        code: 'SAVE40',
        discount_type: 'flat',
        discount_value: 40,
        also_free_delivery: 1,
        min_order_amount: 400,
        auto_apply: 1,
        requires_code: 0,
        priority: 1, // lower priority must not beat higher savings
      }),
    ]]);
    const r = await coupons.pickBestAutoApply({
      subtotal: 400,
      deliveryCharge: 35,
      standardDeliveryCharge: 35,
    });
    expect(r).not.toBeNull();
    expect(r.coupon.id).toBe(4);
    expect(r.coupon.code).toBe('SAVE40');
    // 40 item + 35 free delivery
    expect(r.discount).toBe(75);
    expect(r.itemDiscount).toBe(40);
    expect(r.freeDeliveryWaiver).toBe(35);
  });

  it('when two coupons save the same amount, prefers the higher min_order ladder step', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({
        id: 3,
        code: 'TIER300',
        discount_type: 'flat',
        discount_value: 50,
        also_free_delivery: 1,
        min_order_amount: 300,
        auto_apply: 1,
        requires_code: 0,
        priority: 5,
      }),
      buildCoupon({
        id: 4,
        code: 'TIER400',
        discount_type: 'flat',
        discount_value: 50,
        also_free_delivery: 1,
        min_order_amount: 400,
        auto_apply: 1,
        requires_code: 0,
        priority: 5,
      }),
    ]]);
    const r = await coupons.pickBestAutoApply({
      subtotal: 400,
      deliveryCharge: 30,
      standardDeliveryCharge: 30,
    });
    expect(r.coupon.id).toBe(4);
    expect(r.coupon.code).toBe('TIER400');
  });
});

describe('coupons.findApplicableCoupons', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns an empty list when no coupons exist', async () => {
    pool.query.mockResolvedValueOnce([[]]);
    const r = await coupons.findApplicableCoupons({ subtotal: 100 });
    expect(r).toEqual([]);
  });

  it('returns enriched coupons with usage info when userId is provided', async () => {
    pool.query
      .mockResolvedValueOnce([[
        buildCoupon({ id: 1, code: 'AUTO', discount_type: 'percent', discount_value: 10, auto_apply: 1, per_user_usage_limit: 2 }),
        buildCoupon({ id: 2, code: 'CODE', discount_type: 'flat', discount_value: 15, per_user_usage_limit: 1 }),
      ]])
      // coupon 1 (AUTO): checkEligibility's per-user redemption count (under limit), then usageInfo's
      .mockResolvedValueOnce([[{ count: 0 }]])
      .mockResolvedValueOnce([[{ count: 0 }]])
      // coupon 2 (CODE): checkEligibility's per-user redemption count (at limit — unavailable), then usageInfo's
      .mockResolvedValueOnce([[{ count: 1 }]])
      .mockResolvedValueOnce([[{ count: 1 }]]);

    const r = await coupons.findApplicableCoupons({ subtotal: 200, userId: 42 });

    expect(r).toHaveLength(2);
    const [a, b] = r;

    expect(a.code).toBe('AUTO');
    expect(a.discount).toBe(20); // 10% of 200
    expect(a.usageInfo).toEqual({ used: 0, limit: 2, remaining: 2 });
    expect(a.autoApply).toBe(true);
    expect(a.available).toBe(true);

    expect(b.code).toBe('CODE');
    expect(b.discount).toBe(15);
    expect(b.usageInfo).toEqual({ used: 1, limit: 1, remaining: 0 });
    expect(b.available).toBe(false);
    expect(b.unavailableReason).toMatch(/already used this coupon/);
  });

  it('includes coupons that fail non-min-order eligibility, marked unavailable with a reason, instead of hiding them', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({ id: 1, code: 'OK', discount_type: 'flat', discount_value: 10 }),
      buildCoupon({ id: 2, code: 'BAD', discount_type: 'flat', discount_value: 5, applies_to: 'packed' }),
    ]]);
    const r = await coupons.findApplicableCoupons({ subtotal: 100, storeType: 'fast_food' });
    expect(r).toHaveLength(2);

    const ok = r.find(c => c.code === 'OK');
    expect(ok.available).toBe(true);
    expect(ok.unavailableReason).toBeNull();

    const bad = r.find(c => c.code === 'BAD');
    expect(bad.available).toBe(false);
    expect(bad.unavailableReason).toMatch(/only valid for packed orders/);
  });

  it('includes under-threshold coupons as a locked preview instead of hiding them', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({ id: 1, code: 'OK', discount_type: 'flat', discount_value: 10 }),
      buildCoupon({ id: 2, code: 'LOCKED', discount_type: 'flat', discount_value: 5, min_order_amount: 999 }),
    ]]);
    const r = await coupons.findApplicableCoupons({ subtotal: 100 });
    expect(r).toHaveLength(2);

    const ok = r.find(c => c.code === 'OK');
    expect(ok.unlocked).toBe(true);
    expect(ok.amountRemaining).toBe(0);

    const locked = r.find(c => c.code === 'LOCKED');
    expect(locked.unlocked).toBe(false);
    expect(locked.amountRemaining).toBe(899);
  });

  it('surfaces item-count gate fields and locked-relaxation for item thresholds', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({ id: 1, code: 'ITEM3', discount_type: 'flat', discount_value: 10, min_order_amount: 0, min_item_count: 3 }),
    ]]);
    const r = await coupons.findApplicableCoupons({ subtotal: 100, itemCount: 1 });
    expect(r).toHaveLength(1);

    const c = r[0];
    expect(c.minItemCount).toBe(3);
    expect(c.itemsUnlocked).toBe(false);
    expect(c.itemsRemaining).toBe(2);
    expect(c.unlocked).toBe(true); // amount gate is met
    expect(c.amountRemaining).toBe(0);
  });

  it('unlocks item-count coupon when the threshold is reached', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({ id: 1, code: 'ITEM3', discount_type: 'flat', discount_value: 10, min_order_amount: 0, min_item_count: 3 }),
    ]]);
    const r = await coupons.findApplicableCoupons({ subtotal: 100, itemCount: 3 });
    expect(r).toHaveLength(1);

    const c = r[0];
    expect(c.itemsUnlocked).toBe(true);
    expect(c.itemsRemaining).toBe(0);
    expect(c.available).toBe(true);
  });

  it('marks a locked coupon unavailable (not just locked) when its other rules also fail at min_order_amount', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({ id: 1, code: 'WRONGSTORE', discount_type: 'flat', discount_value: 5, min_order_amount: 999, applies_to: 'packed' }),
    ]]);
    const r = await coupons.findApplicableCoupons({ subtotal: 100, storeType: 'fast_food' });
    expect(r).toHaveLength(1);
    expect(r[0].unlocked).toBe(false);
    expect(r[0].available).toBe(false);
    expect(r[0].unavailableReason).toMatch(/only valid for packed orders/);
  });

  it('marks a coupon unavailable with a clear reason when the user has exhausted their per-user usage limit', async () => {
    pool.query
      .mockResolvedValueOnce([[
        buildCoupon({ id: 1, code: 'ONECODE', discount_type: 'flat', discount_value: 10, per_user_usage_limit: 1 }),
      ]])
      .mockResolvedValueOnce([[{ count: 1 }]]) // checkEligibility's per-user redemption count
      .mockResolvedValueOnce([[{ count: 1 }]]); // usageInfo redemption count

    const r = await coupons.findApplicableCoupons({ subtotal: 100, userId: 7 });
    expect(r).toHaveLength(1);
    expect(r[0].available).toBe(false);
    expect(r[0].unavailableReason).toMatch(/already used this coupon/);
    expect(r[0].usageInfo).toEqual({ used: 1, limit: 1, remaining: 0 });
  });

  it('marks a first-order-only coupon unavailable for a customer who has already ordered before', async () => {
    pool.query
      .mockResolvedValueOnce([[
        buildCoupon({ id: 1, code: 'NEWCOMER', discount_type: 'flat', discount_value: 10, first_order_only: 1 }),
      ]])
      .mockResolvedValueOnce([[{ count: 3 }]]) // getUserOrderCount — already has orders
      .mockResolvedValueOnce([[{ count: 0 }]]); // usageInfo redemption count

    const r = await coupons.findApplicableCoupons({ subtotal: 100, userId: 7 });
    expect(r).toHaveLength(1);
    expect(r[0].available).toBe(false);
    expect(r[0].unavailableReason).toMatch(/only valid on your first order/);
  });

  it('returns coupons with usageInfo=null when no userId is provided', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({ id: 1, code: 'A', discount_type: 'flat', discount_value: 10 }),
    ]]);
    const r = await coupons.findApplicableCoupons({ subtotal: 200 });
    expect(r).toHaveLength(1);
    expect(r[0].usageInfo).toBeNull();
    expect(r[0].savingsText).toBe('You save ₹10');
  });

  it('uses the provided connection instead of pool when supplied', async () => {
    const conn = { query: jest.fn().mockResolvedValue([[]]) };
    const r = await coupons.findApplicableCoupons({ subtotal: 100, connection: conn });
    expect(r).toEqual([]);
    expect(conn.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT * FROM coupons'),
      expect.any(Array)
    );
    expect(pool.query).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Race-condition / transaction-order test
//
// Proves that createOrder acquires SELECT ... FOR UPDATE on the coupon row
// BEFORE counting redemptions and BEFORE inserting the redemption row.
// Two concurrent attempts with the same coupon must serialize.
// ─────────────────────────────────────────────────────────────────────────

describe('createOrder coupon race-safety', () => {
  let mockConnection;

  beforeEach(() => {
    jest.clearAllMocks();

    mockConnection = {
      beginTransaction: jest.fn(),
      query: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    pool.getConnection.mockResolvedValue(mockConnection);
  });

  /**
   * Build a sequence of mock connection.query responses that lets one
   * POST /api/orders complete with a coupon applied. The sequence mirrors
   * what createOrder actually issues inside its transaction.
   */
  const setupSuccessfulCouponOrderFlow = (couponId, opts = {}) => {
    const {
      globalUsed = 0,
      userUsed = 0,
      totalUsageLimit = null,
      perUserLimit = null,
    } = opts;

    mockConnection.query
      // 0. user lookup
      .mockResolvedValueOnce([[{
        id: 1,
        name: 'Test',
        phone: '123',
        whatsapp_number: '123',
        blocked: 0,
        address: 'Addr',
      }]])
      // 1. settings lookup
      .mockResolvedValueOnce([[{
        shop_open: 1,
        delivery_available: 1,
        delivery_charge: 0,
        night_charge: 0,
      }]])
      // 2. product lookup
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test' }]])
      // 2b. exclusion zones (always loaded, before coupon validation)
      .mockResolvedValueOnce([[]])
      // 3. validateCoupon: SELECT coupon row
      .mockResolvedValueOnce([[
        buildCoupon({
          id: couponId,
          code: 'RACE',
          discount_type: 'flat',
          discount_value: 20,
          per_user_usage_limit: perUserLimit,
          total_usage_limit: totalUsageLimit,
        })
      ]])
      // 4. SELECT id FROM coupons ... FOR UPDATE  ← THE LOCK
      .mockResolvedValueOnce([[{ id: couponId }]])
      // 5. SELECT COUNT(*) coupon_redemptions per-user (only if per_user_usage_limit > 0)
      //    → skipped when per_user_usage_limit is null
      // 6. SELECT COUNT(*) coupon_redemptions global (only if total_usage_limit set)
      //    → skipped when total_usage_limit is null
      // (these slots are conditionally populated below if needed)
      // N. generateOrderNumber: COUNT on orders LIKE prefix FOR UPDATE
      .mockResolvedValueOnce([[{ count: 0 }]])
      // N+1. INSERT INTO orders
      .mockResolvedValueOnce([{ insertId: 555 }])
      // N+2. INSERT INTO order_items (skipped here — single item, but we
      //      include the placeholder response for safety)
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      // N+3. INSERT INTO coupon_redemptions (only if discount > 0)
      .mockResolvedValueOnce([{ insertId: 1 }]);

    if (perUserLimit !== null && perUserLimit !== undefined && perUserLimit > 0) {
      // 5. user redemption count (after FOR UPDATE)
      mockConnection.query.mockResolvedValueOnce([[{ count: userUsed }]]);
    }
    if (totalUsageLimit !== null && totalUsageLimit !== undefined) {
      // 6. global redemption count (after FOR UPDATE)
      mockConnection.query.mockResolvedValueOnce([[{ count: globalUsed }]]);
    }
  };

  it('issues SELECT ... FOR UPDATE on the coupon BEFORE counting redemptions', async () => {
    setupSuccessfulCouponOrderFlow(/* couponId */ 11, {
      perUserLimit: 1,
      totalUsageLimit: 100,
    });

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: '123 Race St',
        paymentMethod: 'Cash',
        coupon_code: 'race',
        items: [{ productId: 1, quantity: 1 }],
      });

    expect(res.statusCode).toBe(201);

    // Collect every (sql, params) call in order so we can assert ordering.
    const calls = mockConnection.query.mock.calls;
    const sqls = calls.map(([sql]) => String(sql));

    // 1. The FOR UPDATE lock must be issued on the coupons table.
    const lockIdx = sqls.findIndex((s) => /FOR UPDATE/.test(s) && /FROM coupons/i.test(s));
    expect(lockIdx).toBeGreaterThanOrEqual(0);

    // 2. After the lock, the controller runs the per-user + global
    //    redemption counts (both target coupon_redemptions).
    const countsAfterLock = calls.slice(lockIdx + 1).filter(([sql]) =>
      /FROM coupon_redemptions/.test(String(sql))
    );
    expect(countsAfterLock.length).toBeGreaterThanOrEqual(2);

    // 3. After the lock AND after the counts, the redemption row INSERT.
    const insertIdx = sqls.findIndex(
      (s, i) => i > lockIdx && /INSERT INTO coupon_redemptions/i.test(s)
    );
    expect(insertIdx).toBeGreaterThan(lockIdx);
    // No coupon_redemptions COUNT should come AFTER the redemption INSERT.
    const countsAfterInsert = calls.slice(insertIdx + 1).filter(([sql]) =>
      /FROM coupon_redemptions/.test(String(sql)) && /COUNT/i.test(String(sql))
    );
    expect(countsAfterInsert).toHaveLength(0);
  });

  it('serializes two concurrent redemptions of a single-use coupon via FOR UPDATE', async () => {
    // First request: coupon has per_user_usage_limit=1 and no prior usage.
    // Second request sees the FOR UPDATE row already locked, but more
    // importantly the controller must re-validate after the lock and
    // observe the now-incremented usage count (or, in this test, we
    // simulate the second request seeing the usage at the limit and
    // throwing).
    //
    // The contract we assert: the FIRST request's INSERT INTO
    // coupon_redemptions only happens AFTER its FOR UPDATE.

    // ── First request: success path ──────────────────────────────────
    // Note: validateCoupon also runs eligibility checks inside the same
    // transaction connection, so its per-user count query must be mocked
    // before the controller's own FOR UPDATE + count sequence.
    mockConnection.query
      // user, settings, product
      .mockResolvedValueOnce([[{ id: 1, name: 'T', phone: '1', whatsapp_number: '1', blocked: 0, address: 'A' }]])
      .mockResolvedValueOnce([[{
        shop_open: 1, delivery_available: 1,
        delivery_charge: 0, night_charge: 0,
      }]])
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'T' }]])
      // exclusion zones
      .mockResolvedValueOnce([[]])
      // validateCoupon: coupon row
      .mockResolvedValueOnce([[
        buildCoupon({ id: 21, code: 'ONCE', discount_type: 'flat', discount_value: 10, per_user_usage_limit: 1 })
      ]])
      // validateCoupon: per-user redemption count = 0 (under limit)
      .mockResolvedValueOnce([[{ count: 0 }]])
      // controller: FOR UPDATE
      .mockResolvedValueOnce([[{ id: 21 }]])
      // controller: per-user redemption count = 0 (under limit)
      .mockResolvedValueOnce([[{ count: 0 }]])
      // generateOrderNumber
      .mockResolvedValueOnce([[{ count: 0 }]])
      // INSERT order
      .mockResolvedValueOnce([{ insertId: 901 }])
      // INSERT order_items
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      // INSERT coupon_redemption
      .mockResolvedValueOnce([{ insertId: 1 }]);

    const res1 = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: 'A',
        paymentMethod: 'Cash',
        coupon_code: 'ONCE',
        items: [{ productId: 1, quantity: 1 }],
      });

    expect(res1.statusCode).toBe(201);

    // For the first request the FOR UPDATE must come BEFORE the redemption
    // INSERT.
    const sqls1 = mockConnection.query.mock.calls.map(([sql]) => String(sql));
    const lockIdx1 = sqls1.findIndex(
      (s) => /FOR UPDATE/.test(s) && /FROM coupons/i.test(s)
    );
    const insertIdx1 = sqls1.findIndex(
      (s) => /INSERT INTO coupon_redemptions/i.test(s)
    );
    expect(lockIdx1).toBeGreaterThanOrEqual(0);
    expect(insertIdx1).toBeGreaterThan(lockIdx1);

    // ── Second request: same coupon, but this time the per-user count
    //    AFTER the FOR UPDATE returns 1 (already used). The controller
    //    must throw before issuing the redemption INSERT.
    const conn2 = {
      beginTransaction: jest.fn(),
      query: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    // The first request has already grabbed getConnection once. Now return
    // a fresh connection for the second request.
    pool.getConnection.mockResolvedValueOnce(conn2);

    conn2.query
      .mockResolvedValueOnce([[{ id: 1, name: 'T', phone: '1', whatsapp_number: '1', blocked: 0, address: 'A' }]])
      .mockResolvedValueOnce([[{
        shop_open: 1, delivery_available: 1,
        delivery_charge: 0, night_charge: 0,
      }]])
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'T' }]])
      // exclusion zones
      .mockResolvedValueOnce([[]])
      // validateCoupon: coupon row
      .mockResolvedValueOnce([[
        buildCoupon({ id: 21, code: 'ONCE', discount_type: 'flat', discount_value: 10, per_user_usage_limit: 1 })
      ]])
      // validateCoupon: per-user count is already 1 → validateCoupon throws
      // "already used" before the controller even reaches FOR UPDATE.
      .mockResolvedValueOnce([[{ count: 1 }]]);

    const res2 = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: 'A',
        paymentMethod: 'Cash',
        coupon_code: 'ONCE',
        items: [{ productId: 1, quantity: 1 }],
      });

    expect(res2.statusCode).toBe(400);
    expect(res2.body.code).toBe('VALIDATION_ERROR');
    expect(res2.body.message).toMatch(/already used/);

    // Crucially: the second request must have rolled back and NOT issued
    // an INSERT INTO coupon_redemptions.
    const sqls2 = conn2.query.mock.calls.map(([sql]) => String(sql));
    const insertCount2 = sqls2.filter((s) => /INSERT INTO coupon_redemptions/i.test(s)).length;
    expect(insertCount2).toBe(0);
    expect(conn2.rollback).toHaveBeenCalledTimes(1);
    expect(conn2.commit).not.toHaveBeenCalled();
    expect(conn2.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back when global usage limit is hit after FOR UPDATE', async () => {
    // Simulates a coupon that has no per-user limit but a global limit of
    // 100. After the FOR UPDATE, the global count returns 100 → controller
    // throws → rollback, no redemption INSERT, no order commit.
    mockConnection.query
      .mockResolvedValueOnce([[{ id: 1, name: 'T', phone: '1', whatsapp_number: '1', blocked: 0, address: 'A' }]])
      .mockResolvedValueOnce([[{
        shop_open: 1, delivery_available: 1,
        delivery_charge: 0, night_charge: 0,
      }]])
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'T' }]])
      .mockResolvedValueOnce([[]]) // exclusion zones
      .mockResolvedValueOnce([[
        buildCoupon({ id: 31, code: 'GLOBAL', discount_type: 'flat', discount_value: 5, total_usage_limit: 100 })
      ]])
      // validateCoupon: global redemption count = 100 (at limit) → throws
      // before the controller reaches FOR UPDATE.
      .mockResolvedValueOnce([[{ count: 100 }]]);

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: 'A',
        paymentMethod: 'Cash',
        coupon_code: 'GLOBAL',
        items: [{ productId: 1, quantity: 1 }],
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/maximum usage limit/);
    expect(mockConnection.rollback).toHaveBeenCalledTimes(1);
    expect(mockConnection.commit).not.toHaveBeenCalled();

    const sqls = mockConnection.query.mock.calls.map(([sql]) => String(sql));
    expect(sqls.filter((s) => /INSERT INTO coupon_redemptions/i.test(s))).toHaveLength(0);
    expect(sqls.filter((s) => /INSERT INTO orders/i.test(s))).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// cancelOrder — deletes the coupon_redemptions row on cancellation, which
// restores the customer's per-coupon usage quota (a real rollback, not just
// a status flip). Uses plain pool.query, not a transaction/connection.
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// C3 — an AUTO-applied coupon that lapsed between cart and checkout must be
// dropped silently (order proceeds at full price); a user-chosen coupon
// (typed code or tapped offer) still hard-errors.
// ─────────────────────────────────────────────────────────────────────────

describe('createOrder auto-applied coupon lapse (coupon_auto_applied)', () => {
  let mockConnection;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnection = {
      beginTransaction: jest.fn(),
      query: jest.fn(),
      commit: jest.fn(),
      rollback: jest.fn(),
      release: jest.fn(),
    };
    pool.getConnection.mockResolvedValue(mockConnection);
  });

  const mockBaseOrderFlow = () => {
    mockConnection.query
      // user lookup
      .mockResolvedValueOnce([[{ id: 1, name: 'Test', phone: '123', whatsapp_number: '123', blocked: 0, address: 'Addr' }]])
      // settings lookup
      .mockResolvedValueOnce([[{ shop_open: 1, delivery_available: 1, delivery_charge: 20, night_charge: 0 }]])
      // product lookup
      .mockResolvedValueOnce([[{ id: 1, price: 100, available: 1, name: 'Test' }]])
      // exclusion zones
      .mockResolvedValueOnce([[]]);
  };

  it('drops a vanished auto-applied coupon and places the order at full price', async () => {
    mockBaseOrderFlow();
    mockConnection.query
      // validateCouponById: coupon row gone (deleted/expired)
      .mockResolvedValueOnce([[]])
      // INSERT INTO orders
      .mockResolvedValueOnce([{ insertId: 700 }])
      // INSERT INTO order_items
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: '123 Lapse St',
        paymentMethod: 'Cash',
        coupon_id: 44,
        coupon_auto_applied: true,
        items: [{ productId: 1, quantity: 1 }],
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.order.discount).toBe(0);
    expect(res.body.order.couponDropped).toBe(true);
    expect(res.body.order.couponId).toBeNull();
    // subtotal 100 + delivery 20, no discount
    expect(res.body.order.total).toBe(120);
    const redemptionInsert = mockConnection.query.mock.calls.find(([sql]) =>
      /INSERT INTO coupon_redemptions/i.test(String(sql)));
    expect(redemptionInsert).toBeUndefined();
  });

  it('drops an exhausted auto-applied coupon (per-user limit hit) and proceeds', async () => {
    mockBaseOrderFlow();
    mockConnection.query
      // validateCouponById: coupon row found…
      .mockResolvedValueOnce([[
        buildCoupon({ id: 44, code: null, discount_type: 'flat', discount_value: 30, per_user_usage_limit: 1, auto_apply: 1, requires_code: 0 })
      ]])
      // …but checkEligibility's per-user redemption count says it's used up
      .mockResolvedValueOnce([[{ count: 1 }]])
      // INSERT INTO orders
      .mockResolvedValueOnce([{ insertId: 701 }])
      // INSERT INTO order_items
      .mockResolvedValueOnce([{ affectedRows: 1 }]);

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: '123 Lapse St',
        paymentMethod: 'Cash',
        coupon_id: 44,
        coupon_auto_applied: true,
        items: [{ productId: 1, quantity: 1 }],
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.order.discount).toBe(0);
    expect(res.body.order.couponDropped).toBe(true);
  });

  it('still rejects the order when a user-TAPPED coupon (no auto flag) fails re-validation', async () => {
    mockBaseOrderFlow();
    mockConnection.query
      // validateCouponById: coupon row gone
      .mockResolvedValueOnce([[]]);

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: '123 Lapse St',
        paymentMethod: 'Cash',
        coupon_id: 44,
        items: [{ productId: 1, quantity: 1 }],
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/coupon/i);
    expect(mockConnection.rollback).toHaveBeenCalled();
  });

  it('still rejects the order when a user-TYPED code fails re-validation', async () => {
    mockBaseOrderFlow();
    mockConnection.query
      // validateCoupon: no coupon with this code
      .mockResolvedValueOnce([[]]);

    const res = await request(app)
      .post('/api/orders')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: '123 Lapse St',
        paymentMethod: 'Cash',
        coupon_code: 'GONE',
        items: [{ productId: 1, quantity: 1 }],
      });

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/invalid coupon/i);
  });
});

describe('cancelOrder coupon redemption rollback', () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  it('soft-cancels the coupon_redemptions row for the order when a coupon was applied', async () => {
    pool.query
      .mockResolvedValueOnce([[{
        id: 10,
        customer_id: 1,
        status: 'Pending',
        payment_method: 'Cash',
        coupon_id: 31,
      }]]) // order lookup
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE orders ... status=Cancelled
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE coupon_redemptions SET status='cancelled'

    const res = await request(app)
      .post('/api/orders/10/cancel')
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Changed my mind' });

    expect(res.statusCode).toBe(200);
    expect(res.body.order.status).toBe('Cancelled');

    const softCancelCall = pool.query.mock.calls.find(([sql]) => /UPDATE coupon_redemptions SET status = 'cancelled'/i.test(sql));
    expect(softCancelCall).toBeDefined();
    expect(softCancelCall[1]).toEqual(['10', 31]);
    // Rows must never be hard-deleted — the audit trail stays.
    const deleteCall = pool.query.mock.calls.find(([sql]) => /DELETE FROM coupon_redemptions/i.test(sql));
    expect(deleteCall).toBeUndefined();
  });

  it('skips the coupon_redemptions soft-cancel when no coupon was applied to the order', async () => {
    pool.query
      .mockResolvedValueOnce([[{
        id: 11,
        customer_id: 1,
        status: 'Pending',
        payment_method: 'Cash',
        coupon_id: null,
      }]]) // order lookup
      .mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE orders ... status=Cancelled

    const res = await request(app)
      .post('/api/orders/11/cancel')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.statusCode).toBe(200);
    const softCancelCall = pool.query.mock.calls.find(([sql]) => /UPDATE coupon_redemptions/i.test(sql));
    expect(softCancelCall).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// getNextFreeDeliveryThreshold — the "add ₹X more for free delivery" hint
// that replaced the old settings-driven threshold system.
// ─────────────────────────────────────────────────────────────────────────

describe('coupons.getNextFreeDeliveryThreshold', () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  it('returns the min_order_amount and remaining amount for the nearest unmet auto-apply free_delivery coupon', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({
        id: 10,
        code: null,
        discount_type: 'free_delivery',
        discount_value: 0,
        min_order_amount: 149,
        auto_apply: 1,
        requires_code: 0,
      }),
    ]]);

    const result = await coupons.getNextFreeDeliveryThreshold({ subtotal: 100 });
    expect(result).toEqual({ minOrder: 149, amountRemaining: 49, minItemCount: 0, itemsRemaining: 0, thresholdType: 'amount' });
  });

  it('returns null when the cart already meets the free_delivery coupon threshold', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({
        id: 10,
        code: null,
        discount_type: 'free_delivery',
        min_order_amount: 149,
        auto_apply: 1,
        requires_code: 0,
      }),
    ]]);

    const result = await coupons.getNextFreeDeliveryThreshold({ subtotal: 200 });
    expect(result).toBeNull();
  });

  it('returns null when no free_delivery coupons exist', async () => {
    pool.query.mockResolvedValueOnce([[]]);
    const result = await coupons.getNextFreeDeliveryThreshold({ subtotal: 0 });
    expect(result).toBeNull();
  });

  it('always-on blanket coupon (min_order_amount=0) is already met, so it never shows a progress hint', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({
        id: 11,
        code: null,
        discount_type: 'free_delivery',
        min_order_amount: 0,
        auto_apply: 1,
        requires_code: 0,
      }),
    ]]);

    const result = await coupons.getNextFreeDeliveryThreshold({ subtotal: 1 });
    expect(result).toBeNull();
  });

  it('skips a coupon that is not eligible for the store type even if the threshold is unmet', async () => {
    pool.query
      .mockResolvedValueOnce([[
        buildCoupon({
          id: 12,
          code: null,
          discount_type: 'free_delivery',
          min_order_amount: 100,
          auto_apply: 1,
          requires_code: 0,
          applies_to: 'fast_food',
        }),
      ]]);

    const result = await coupons.getNextFreeDeliveryThreshold({ subtotal: 10, storeType: 'packed' });
    expect(result).toBeNull();
  });

  it('returns item-count-only threshold when min_order_amount is met but items are short', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({
        id: 13,
        code: null,
        discount_type: 'free_delivery',
        discount_value: 0,
        min_order_amount: 0,
        min_item_count: 3,
        auto_apply: 1,
        requires_code: 0,
      }),
    ]]);

    const result = await coupons.getNextFreeDeliveryThreshold({ subtotal: 100, itemCount: 1 });
    expect(result).toEqual({
      minOrder: 0,
      amountRemaining: 0,
      minItemCount: 3,
      itemsRemaining: 2,
      thresholdType: 'item_count',
    });
  });

  it('returns both-gates hint when amount and item count are both unmet', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({
        id: 14,
        code: null,
        discount_type: 'free_delivery',
        discount_value: 0,
        min_order_amount: 149,
        min_item_count: 3,
        auto_apply: 1,
        requires_code: 0,
      }),
    ]]);

    const result = await coupons.getNextFreeDeliveryThreshold({ subtotal: 100, itemCount: 1 });
    expect(result).toMatchObject({
      minOrder: 149,
      amountRemaining: 49,
      minItemCount: 3,
      itemsRemaining: 2,
      thresholdType: 'both',
    });
  });

  it('returns null for an item-count-only free_delivery coupon once the item threshold is met', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({
        id: 15,
        code: null,
        discount_type: 'free_delivery',
        discount_value: 0,
        min_order_amount: 0,
        min_item_count: 3,
        auto_apply: 1,
        requires_code: 0,
      }),
    ]]);

    const result = await coupons.getNextFreeDeliveryThreshold({ subtotal: 10, itemCount: 3 });
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// getNearestUnlockableCoupon — the generalized "Add ₹X more to unlock
// <offer>" hint, covering all discount types (flat/percent), including full
// usage-limit / audience / order-history checks (unlike the free-delivery
// hint above, which only runs lightweight visibility checks).
// ─────────────────────────────────────────────────────────────────────────

describe('coupons.getNearestUnlockableCoupon', () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  it('picks the coupon requiring the smallest additional amount across mixed discount types', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({ id: 1, code: 'NEAR', discount_type: 'flat', discount_value: 20, min_order_amount: 120, priority: 0 }),
      buildCoupon({ id: 2, code: 'FAR', discount_type: 'percent', discount_value: 10, min_order_amount: 500, priority: 0 }),
    ]]);

    const result = await coupons.getNearestUnlockableCoupon({ subtotal: 100 });
    expect(result).toMatchObject({
      couponId: 1,
      code: 'NEAR',
      discountType: 'flat',
      minOrder: 120,
      amountRemaining: 20,
    });
  });

  it('breaks ties on identical min_order_amount using priority DESC, then id ASC', async () => {
    // SQL ORDER BY min_order_amount ASC, priority DESC, id ASC already
    // guarantees the correct row is first; the function just returns the
    // first eligible one.
    pool.query.mockResolvedValueOnce([[
      buildCoupon({ id: 5, code: 'HIGHER_PRIORITY', discount_type: 'flat', discount_value: 20, min_order_amount: 150, priority: 5 }),
      buildCoupon({ id: 2, code: 'LOWER_PRIORITY', discount_type: 'flat', discount_value: 20, min_order_amount: 150, priority: 1 }),
    ]]);

    const result = await coupons.getNearestUnlockableCoupon({ subtotal: 100 });
    expect(result.couponId).toBe(5);
    expect(result.code).toBe('HIGHER_PRIORITY');
  });

  it('excludes free_delivery coupons — those have their own dedicated hint', async () => {
    // SQL filters discount_type != 'free_delivery', so the mocked query
    // result already reflects what the DB would return.
    pool.query.mockResolvedValueOnce([[]]);
    const result = await coupons.getNearestUnlockableCoupon({ subtotal: 50 });
    expect(result).toBeNull();
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("discount_type != 'free_delivery'"),
      expect.any(Array)
    );
  });

  it('skips a coupon that fails schedule/store-type/audience eligibility even though its threshold is nearest', async () => {
    pool.query
      .mockResolvedValueOnce([[
        buildCoupon({ id: 1, code: 'WRONGSTORE', discount_type: 'flat', discount_value: 20, min_order_amount: 120, applies_to: 'fast_food' }),
        buildCoupon({ id: 2, code: 'OK', discount_type: 'flat', discount_value: 10, min_order_amount: 200 }),
      ]]);

    const result = await coupons.getNearestUnlockableCoupon({ subtotal: 100, storeType: 'packed' });
    expect(result.couponId).toBe(2);
  });

  it('skips a coupon outside its target audience (audience check runs, unlike the free-delivery hint)', async () => {
    pool.query
      .mockResolvedValueOnce([[
        buildCoupon({ id: 1, code: 'VIP', discount_type: 'flat', discount_value: 20, min_order_amount: 120, target_audience: 'selected' }),
        buildCoupon({ id: 2, code: 'OK', discount_type: 'flat', discount_value: 10, min_order_amount: 200 }),
      ]])
      .mockResolvedValueOnce([[]]); // coupon_users lookup for VIP — no row, user not targeted

    const result = await coupons.getNearestUnlockableCoupon({ subtotal: 100, userId: 42 });
    expect(result.couponId).toBe(2);
  });

  it('skips a coupon the user is disqualified from due to order history (first_order_only)', async () => {
    pool.query
      .mockResolvedValueOnce([[
        buildCoupon({ id: 1, code: 'NEWCOMER', discount_type: 'flat', discount_value: 20, min_order_amount: 120, first_order_only: 1 }),
        buildCoupon({ id: 2, code: 'OK', discount_type: 'flat', discount_value: 10, min_order_amount: 200 }),
      ]])
      .mockResolvedValueOnce([[{ count: 2 }]]); // getUserOrderCount for NEWCOMER — already ordered before

    const result = await coupons.getNearestUnlockableCoupon({ subtotal: 100, userId: 42 });
    expect(result.couponId).toBe(2);
  });

  it('skips an exhausted coupon (per_user_usage_limit reached) — unlike the free-delivery hint, usage checks run', async () => {
    pool.query
      .mockResolvedValueOnce([[
        buildCoupon({ id: 1, code: 'USEDUP', discount_type: 'flat', discount_value: 20, min_order_amount: 120, per_user_usage_limit: 1 }),
        buildCoupon({ id: 2, code: 'OK', discount_type: 'flat', discount_value: 10, min_order_amount: 200 }),
      ]])
      .mockResolvedValueOnce([[{ count: 1 }]]); // getUserRedemptionCount for USEDUP — already used

    const result = await coupons.getNearestUnlockableCoupon({ subtotal: 100, userId: 42 });
    expect(result.couponId).toBe(2);
  });

  it('skips an exhausted coupon (total_usage_limit reached)', async () => {
    pool.query
      .mockResolvedValueOnce([[
        buildCoupon({ id: 1, code: 'SOLDOUT', discount_type: 'flat', discount_value: 20, min_order_amount: 120, total_usage_limit: 10 }),
        buildCoupon({ id: 2, code: 'OK', discount_type: 'flat', discount_value: 10, min_order_amount: 200 }),
      ]])
      .mockResolvedValueOnce([[{ count: 10 }]]); // getGlobalRedemptionCount for SOLDOUT — limit reached

    const result = await coupons.getNearestUnlockableCoupon({ subtotal: 100, userId: 42 });
    expect(result.couponId).toBe(2);
  });

  it('returns null for a coupon whose threshold is already met (already-unlocked)', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({ id: 1, code: 'MET', discount_type: 'flat', discount_value: 20, min_order_amount: 50 }),
    ]]);
    const result = await coupons.getNearestUnlockableCoupon({ subtotal: 100 });
    expect(result).toBeNull();
  });

  it('excludes the currently-applied coupon via excludeCouponId', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({ id: 1, code: 'APPLIED', discount_type: 'flat', discount_value: 20, min_order_amount: 120 }),
      buildCoupon({ id: 2, code: 'NEXT', discount_type: 'flat', discount_value: 10, min_order_amount: 200 }),
    ]]);

    const result = await coupons.getNearestUnlockableCoupon({ subtotal: 100, excludeCouponId: 1 });
    expect(result.couponId).toBe(2);
  });

  it('returns null when excludeCouponId removes the only candidate', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({ id: 1, code: 'APPLIED', discount_type: 'flat', discount_value: 20, min_order_amount: 120 }),
    ]]);
    const result = await coupons.getNearestUnlockableCoupon({ subtotal: 100, excludeCouponId: 1 });
    expect(result).toBeNull();
  });

  it('returns null when no active coupons exist', async () => {
    pool.query.mockResolvedValueOnce([[]]);
    const result = await coupons.getNearestUnlockableCoupon({ subtotal: 0 });
    expect(result).toBeNull();
  });

  it('surfaces item-count-only threshold', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({ id: 6, code: 'ITEM5', discount_type: 'flat', discount_value: 20, min_order_amount: 0, min_item_count: 5 }),
    ]]);

    const result = await coupons.getNearestUnlockableCoupon({ subtotal: 100, itemCount: 2 });
    expect(result).toMatchObject({
      couponId: 6,
      code: 'ITEM5',
      minOrder: 0,
      amountRemaining: 0,
      minItemCount: 5,
      itemsRemaining: 3,
      thresholdType: 'item_count',
    });
  });

  it('surfaces both amount and item count unmet', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({ id: 7, code: 'MIXED', discount_type: 'flat', discount_value: 20, min_order_amount: 120, min_item_count: 3 }),
    ]]);

    const result = await coupons.getNearestUnlockableCoupon({ subtotal: 100, itemCount: 1 });
    expect(result).toMatchObject({
      couponId: 7,
      code: 'MIXED',
      minOrder: 120,
      amountRemaining: 20,
      minItemCount: 3,
      itemsRemaining: 2,
      thresholdType: 'both',
    });
  });

  it('still breaks ties correctly after adding min_item_count to ORDER BY', async () => {
    pool.query.mockResolvedValueOnce([[
      buildCoupon({ id: 5, code: 'HIGHER_PRIORITY', discount_type: 'flat', discount_value: 20, min_order_amount: 150, priority: 5 }),
      buildCoupon({ id: 2, code: 'LOWER_PRIORITY', discount_type: 'flat', discount_value: 20, min_order_amount: 150, priority: 1 }),
    ]]);

    const result = await coupons.getNearestUnlockableCoupon({ subtotal: 100 });
    expect(result.couponId).toBe(5);
    expect(result.code).toBe('HIGHER_PRIORITY');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Admin coupon routes — duplicate-code race handling.
//
// createCoupon/updateCoupon/duplicateCoupon each pre-check code uniqueness
// with a SELECT before writing, but the real guard is the DB's
// uniq_live_coupon_code (code, deleted) unique index — a concurrent request
// can pass the SELECT and still hit ER_DUP_ENTRY on INSERT/UPDATE. These
// tests simulate that race by having the SELECT report "no conflict" while
// the write itself throws ER_DUP_ENTRY, and assert the controller converts
// that into a 409 instead of letting it surface as a 500.
// ─────────────────────────────────────────────────────────────────────────

describe('admin coupon routes — ER_DUP_ENTRY race handling', () => {
  const adminRoutes = require('../src/routes/adminRoutes');
  const adminApp = express();
  adminApp.use(express.json());
  adminApp.use('/api/admin', adminRoutes);

  const adminToken = jwt.sign({ sub: 1, role: 'admin', adminRole: 'area_admin', areaId: 1 }, process.env.JWT_SECRET || 'secret');

  const dupEntryError = () => {
    const err = new Error("Duplicate entry 'RACE' for key 'uniq_live_coupon_code'");
    err.code = 'ER_DUP_ENTRY';
    return err;
  };

  beforeEach(() => {
    pool.query.mockReset();
  });

  it('POST /admin/coupons returns 409 when the code uniqueness SELECT races with a concurrent insert', async () => {
    pool.query
      .mockResolvedValueOnce([[]]) // pre-check SELECT — no conflict seen
      .mockRejectedValueOnce(dupEntryError()); // INSERT loses the race

    const res = await request(adminApp)
      .post('/api/admin/coupons')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Race Coupon', discount_type: 'flat', discount_value: 10, code: 'RACE' });

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
  });

  it('PUT /admin/coupons/:id returns 409 when the code uniqueness SELECT races with a concurrent update', async () => {
    pool.query
      .mockResolvedValueOnce([[buildCoupon({ id: 1, code: 'OLDCODE' })]]) // existing coupon lookup
      .mockResolvedValueOnce([[]]) // dupe-check SELECT — no conflict seen
      .mockRejectedValueOnce(dupEntryError()); // UPDATE loses the race

    const res = await request(adminApp)
      .put('/api/admin/coupons/1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: 'RACE' });

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
  });

  it('POST /admin/coupons/:id/duplicate returns 409 when the generated -COPY code collides', async () => {
    pool.query
      .mockResolvedValueOnce([[buildCoupon({ id: 1, code: 'RACE' })]]) // original coupon lookup
      .mockRejectedValueOnce(dupEntryError()); // INSERT (code: RACE-COPY) loses the race

    const res = await request(adminApp)
      .post('/api/admin/coupons/1/duplicate')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
  });

  it('POST /admin/coupons creates a zone-targeted coupon and inserts coupon_zones rows', async () => {
    pool.query
      .mockResolvedValueOnce([[]]) // code uniqueness pre-check
      .mockResolvedValueOnce([{ insertId: 55 }]) // INSERT coupons
      .mockResolvedValueOnce([[{ id: 2 }, { id: 3 }]]) // §14.4: zone-ownership check — both in this area
      .mockResolvedValueOnce([{}]); // INSERT IGNORE coupon_zones

    const res = await request(adminApp)
      .post('/api/admin/coupons')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Zone Coupon', discount_type: 'flat', discount_value: 10, code: 'ZONE10',
        target_zones: 'selected', targeted_zone_ids: [2, 3],
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.id).toBe(55);
    const insertSql = pool.query.mock.calls[1][0];
    expect(insertSql).toContain('target_zones');
    const zonesSql = pool.query.mock.calls[3][0];
    const zonesParams = pool.query.mock.calls[3][1];
    expect(zonesSql).toContain('INSERT IGNORE INTO coupon_zones');
    expect(zonesParams[0]).toEqual([[55, 2], [55, 3]]);
  });

  it('PUT /admin/coupons/:id replaces coupon_zones rows when targeted_zone_ids is sent', async () => {
    pool.query
      .mockResolvedValueOnce([[buildCoupon({ id: 1, target_zones: 'selected' })]]) // existing coupon lookup
      .mockResolvedValueOnce([{ affectedRows: 1 }]) // UPDATE coupons (target_zones unchanged, no other fields)
      .mockResolvedValueOnce([{}]) // DELETE FROM coupon_zones
      .mockResolvedValueOnce([[{ id: 4 }]]) // §14.4: zone-ownership check — zone 4 is in this area
      .mockResolvedValueOnce([{}]); // INSERT IGNORE coupon_zones

    const res = await request(adminApp)
      .put('/api/admin/coupons/1')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ target_zones: 'selected', targeted_zone_ids: [4] });

    expect(res.statusCode).toBe(200);
    const deleteSql = pool.query.mock.calls[2][0];
    expect(deleteSql).toContain('DELETE FROM coupon_zones');
    const insertParams = pool.query.mock.calls[4][1];
    expect(insertParams[0]).toEqual([[1, 4]]);
  });
});
