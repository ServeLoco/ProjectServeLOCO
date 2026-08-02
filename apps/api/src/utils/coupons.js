/**
 * Coupon rule engine — single source of truth for all coupon validation,
 * discount computation, auto-apply selection, and eligibility listing.
 *
 * Design rules (locked):
 *  - Only ONE coupon applies per order (no stacking). If the user enters a
 *    code it wins; otherwise the best auto-apply offer is picked.
 *  - A coupon never overrides any charge line — it only adds a Discount line
 *    that subtracts from the grand total.
 *  - free_delivery (and also_free_delivery) applies to STANDARD delivery
 *    only. On a fast-delivery order free delivery is not granted — the
 *    customer pays the full fast fee (owner decision, 2026-07-15). Item
 *    discounts from flat/percent coupons still apply on fast orders.
 *  - All time-window math is in Asia/Kolkata (matches order numbering).
 */

const { pool } = require('../db/mysql');
const { roundMoney, toMoney } = require('./money');
const { getNowMinutesInZone, DEFAULT_TIMEZONE } = require('./nightDelivery');

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Returns true if `now` falls inside the coupon's date window.
 * NULL starts_at / ends_at mean open-ended on that side.
 */
const isWithinDateWindow = (coupon, now = new Date()) => {
  if (coupon.starts_at) {
    const start = new Date(coupon.starts_at);
    if (now < start) return false;
  }
  if (coupon.ends_at) {
    const end = new Date(coupon.ends_at);
    // ends_at is inclusive — allow redemptions up to the end of that minute.
    if (now > new Date(end.getTime() + 60_000)) return false;
  }
  return true;
};

/**
 * Returns true if today's day-of-week is allowed by the coupon's
 * active_days_mask. The mask is a 7-bit value: bit 0 = Sunday, bit 1 = Monday,
 * … bit 6 = Saturday (mirrors JS Date.getDay()). NULL means all days allowed.
 */
const isWithinActiveDays = (coupon, now = new Date()) => {
  if (coupon.active_days_mask === null || coupon.active_days_mask === undefined) return true;
  const dayBit = 1 << now.getDay();
  return (coupon.active_days_mask & dayBit) !== 0;
};

/**
 * Returns true if the current time-of-day falls inside the coupon's
 * active_time_start / active_time_end window. Supports overnight windows
 * (e.g. 21:00 → 07:00). NULL on either side means no time restriction.
 */
const isWithinActiveTime = (coupon, now = new Date()) => {
  const start = coupon.active_time_start;
  const end = coupon.active_time_end;
  if (!start || !end) return true;

  const nowMin = getNowMinutesInZone(now, DEFAULT_TIMEZONE);
  const [sh, sm] = String(start).split(':').map(Number);
  const [eh, em] = String(end).split(':').map(Number);
  const startMin = sh * 60 + (sm || 0);
  const endMin = eh * 60 + (em || 0);

  if (startMin === endMin) return true; // no real window
  if (startMin < endMin) {
    return nowMin >= startMin && nowMin < endMin;
  }
  // Overnight window
  return nowMin >= startMin || nowMin < endMin;
};

/**
 * True when the effective delivery charge is the fast fee (fast fully
 * replaces standard). Used so free-delivery is never granted on Fast.
 * When standardDeliveryCharge is omitted we treat the order as standard.
 */
const isFastDeliveryOrder = (deliveryCharge, standardDeliveryCharge) => {
  if (standardDeliveryCharge === undefined || standardDeliveryCharge === null) return false;
  return toMoney(deliveryCharge) > toMoney(standardDeliveryCharge);
};

/**
 * Computes the discount amount for a given coupon based on its type.
 * Always returns a non-negative, rounded money value.
 *
 * @param {Object} coupon - The coupon row.
 * @param {Object} ctx - { subtotal, deliveryCharge, standardDeliveryCharge }
 *   deliveryCharge is the EFFECTIVE charge on the order (fast fee when fast
 *   delivery is selected); standardDeliveryCharge is the plain standard fee.
 *   When omitted, standardDeliveryCharge falls back to deliveryCharge.
 * @returns {number} Discount amount (≥ 0).
 */
const computeDiscount = (coupon, { subtotal, deliveryCharge, standardDeliveryCharge }) => {
  if (!coupon) return 0;
  // Item count is eligibility-only; it is never used as a discount input.
  const sub = toMoney(subtotal);
  const del = toMoney(deliveryCharge);
  const stdDel = standardDeliveryCharge === undefined || standardDeliveryCharge === null
    ? del
    : toMoney(standardDeliveryCharge);

  switch (coupon.discount_type) {
    case 'flat': {
      return roundMoney(Math.min(toMoney(coupon.discount_value), sub));
    }
    case 'percent': {
      const pct = toMoney(coupon.discount_value);
      let raw = roundMoney((sub * pct) / 100);
      if (coupon.max_discount_amount !== null && coupon.max_discount_amount !== undefined) {
        raw = Math.min(raw, toMoney(coupon.max_discount_amount));
      }
      return roundMoney(Math.min(raw, sub));
    }
    case 'free_delivery': {
      // Free delivery is for Standard only. Fast pays the full fast fee.
      if (isFastDeliveryOrder(deliveryCharge, standardDeliveryCharge)) {
        return 0;
      }
      return roundMoney(Math.min(stdDel, sub + del));
    }
    default:
      return 0;
  }
};

/**
 * Wraps computeDiscount to also account for `also_free_delivery` — a flat
 * or percent coupon that ALSO waives standard delivery. Returns the pieces
 * separately so callers (bill summary UI) can show "Delivery: FREE" plus
 * only the remaining item-level discount, instead of one merged number.
 *
 * Free-delivery waiver is never applied on Fast orders (full fast fee stays
 * on the bill); item discounts still apply.
 *
 * @returns {{ discount: number, itemDiscount: number, freeDeliveryWaiver: number }}
 */
const computeDiscountBreakdown = (coupon, { subtotal, deliveryCharge, standardDeliveryCharge }) => {
  const itemDiscount = computeDiscount(coupon, { subtotal, deliveryCharge, standardDeliveryCharge });
  const fastOrder = isFastDeliveryOrder(deliveryCharge, standardDeliveryCharge);

  if (coupon.discount_type === 'free_delivery') {
    // itemDiscount from computeDiscount is already 0 on fast.
    return { discount: itemDiscount, itemDiscount: 0, freeDeliveryWaiver: itemDiscount };
  }

  if (!coupon.also_free_delivery || fastOrder) {
    return { discount: itemDiscount, itemDiscount, freeDeliveryWaiver: 0 };
  }

  const sub = toMoney(subtotal);
  const del = toMoney(deliveryCharge);
  const stdDel = standardDeliveryCharge === undefined || standardDeliveryCharge === null
    ? del
    : toMoney(standardDeliveryCharge);
  const remaining = Math.max(0, roundMoney(sub + del - itemDiscount));
  const freeDeliveryWaiver = roundMoney(Math.min(stdDel, remaining));

  return {
    discount: roundMoney(itemDiscount + freeDeliveryWaiver),
    itemDiscount,
    freeDeliveryWaiver,
  };
};

/**
 * Counts a user's lifetime non-cancelled orders. Used for first-order /
 * first-N-order checks.
 */
const getUserOrderCount = async (connection, userId) => {
  const [rows] = await connection.query(
    "SELECT COUNT(*) as count FROM orders WHERE customer_id = ? AND status != 'Cancelled'",
    [userId]
  );
  return Number(rows[0]?.count) || 0;
};

/**
 * Counts how many times a user has redeemed a coupon. Redemptions from
 * cancelled orders are soft-marked status='cancelled' (not deleted) and
 * don't count toward the limit.
 */
const getUserRedemptionCount = async (connection, couponId, userId) => {
  const [rows] = await connection.query(
    "SELECT COUNT(*) as count FROM coupon_redemptions WHERE coupon_id = ? AND user_id = ? AND status = 'active'",
    [couponId, userId]
  );
  return Number(rows[0]?.count) || 0;
};

/**
 * Counts total global active redemptions for a coupon.
 */
const getGlobalRedemptionCount = async (connection, couponId) => {
  const [rows] = await connection.query(
    "SELECT COUNT(*) as count FROM coupon_redemptions WHERE coupon_id = ? AND status = 'active'",
    [couponId]
  );
  return Number(rows[0]?.count) || 0;
};

/**
 * Checks whether a user is in the coupon's target audience.
 * - 'all' → always true.
 * - 'selected' → true if a row exists in coupon_users.
 */
const isUserTargeted = async (connection, coupon, userId) => {
  if (!coupon || coupon.target_audience === 'all') return true;
  const [rows] = await connection.query(
    'SELECT 1 FROM coupon_users WHERE coupon_id = ? AND user_id = ? LIMIT 1',
    [coupon.id, userId]
  );
  return rows.length > 0;
};

// Safety valve for the ancestor walk below — a corrupt parent_zone_id chain
// must not spin forever. Nesting is villages inside villages; single digits.
const MAX_ZONE_NESTING_DEPTH = 20;

/**
 * The matched zone plus every zone it is nested inside, innermost first.
 *
 * Zone matching resolves to the MOST nested zone containing the customer, so
 * a coupon targeted at the big "village" zone would otherwise miss every
 * customer standing in one of its sub-village children. Selecting a parent
 * zone therefore covers its descendants too; to exclude a child, give the
 * child its own coupon.
 */
const getZoneAndAncestorIds = async (connection, zoneId) => {
  const ids = [];
  let currentId = zoneId;
  const seen = new Set();
  while (currentId != null && !seen.has(currentId) && ids.length < MAX_ZONE_NESTING_DEPTH) {
    seen.add(currentId);
    ids.push(currentId);
    const [rows] = await connection.query(
      'SELECT parent_zone_id FROM delivery_zones WHERE id = ?',
      [currentId]
    );
    currentId = rows[0]?.parent_zone_id ?? null;
  }
  return ids;
};

/**
 * Checks whether a delivery zone is in the coupon's target zone list.
 * - 'all' → always true (also true for orders with no matched zone — flat
 *   pricing or radius pricing disabled — since an 'all' coupon should not
 *   care about zones at all).
 * - 'selected' → false when the order has no matched zone (nothing to match
 *   against); otherwise true if coupon_zones names the matched zone OR any
 *   zone it is nested inside (see getZoneAndAncestorIds).
 */
const isZoneTargeted = async (connection, coupon, zoneId) => {
  if (!coupon || coupon.target_zones !== 'selected') return true;
  if (!zoneId) return false;
  const zoneIds = await getZoneAndAncestorIds(connection, zoneId);
  if (zoneIds.length === 0) return false;
  const [rows] = await connection.query(
    'SELECT 1 FROM coupon_zones WHERE coupon_id = ? AND delivery_zone_id IN (?) LIMIT 1',
    [coupon.id, zoneIds]
  );
  return rows.length > 0;
};

// ─────────────────────────────────────────────────────────────────────────
// Core validation
// ─────────────────────────────────────────────────────────────────────────

/**
 * Runs ALL eligibility checks for a coupon against the given context.
 * Returns { ok: true, coupon, discount } on success, or
 * { ok: false, reason } on failure.
 *
 * @param {Object} params - { coupon, subtotal, deliveryCharge, storeType, userId, now, connection }
 * @param {Object} params.coupon - The coupon row (already fetched from DB).
 */
const checkEligibility = async ({
  coupon,
  subtotal,
  deliveryCharge = 0,
  standardDeliveryCharge = null, // standard fee when deliveryCharge is the fast fee
  storeType = null,
  userId = null,
  zoneId = null, // matched delivery zone id (pricing.zone.id), null when unzoned
  now = new Date(),
  connection,
  skipUsageChecks = false, // when true, skips per-user/global/first-order checks (for listing)
  itemCount = null,
}) => {
  if (!coupon) {
    return { ok: false, reason: 'Coupon not found' };
  }

  // 1. Active & not deleted
  if (coupon.deleted || !coupon.active) {
    return { ok: false, reason: 'This coupon is no longer active' };
  }

  // 2. Date window
  if (!isWithinDateWindow(coupon, now)) {
    return { ok: false, reason: 'This coupon has expired or is not yet active' };
  }

  // 3. Day-of-week
  if (!isWithinActiveDays(coupon, now)) {
    return { ok: false, reason: 'This coupon is not valid today' };
  }

  // 4. Time-of-day window
  if (!isWithinActiveTime(coupon, now)) {
    return { ok: false, reason: 'This coupon is not valid at this time' };
  }

  // 5. Store type
  if (storeType && coupon.applies_to !== 'all' && coupon.applies_to !== storeType) {
    return { ok: false, reason: `This coupon is only valid for ${coupon.applies_to.replace('_', ' ')} orders` };
  }

  // 6. Min order amount
  const sub = toMoney(subtotal);
  if (sub < toMoney(coupon.min_order_amount)) {
    const diff = roundMoney(toMoney(coupon.min_order_amount) - sub);
    return { ok: false, reason: `Add ₹${diff} more to use this coupon (min order ₹${toMoney(coupon.min_order_amount)})` };
  }

  // 6a. Min item count
  if (coupon.min_item_count !== null && coupon.min_item_count !== undefined) {
    const currentItems = Number(itemCount) || 0;
    const requiredItems = Number(coupon.min_item_count);
    if (currentItems < requiredItems) {
      const shortfall = requiredItems - currentItems;
      return { ok: false, reason: `Add ${shortfall} more item(s) to use this coupon (min ${requiredItems} items)` };
    }
  }

  // 7. Max order amount (if set)
  if (coupon.max_order_amount !== null && coupon.max_order_amount !== undefined) {
    if (sub > toMoney(coupon.max_order_amount)) {
      return { ok: false, reason: `This coupon is only valid for orders up to ₹${toMoney(coupon.max_order_amount)}` };
    }
  }

  // 7a. Zone targeting — independent of user identity, so checked whenever a
  // connection is available (not just when userId is present). Must NOT be
  // gated by skipUsageChecks: that flag exists to skip per-user/global usage
  // limits for listing/hint purposes, not zone eligibility — a hint query
  // skipping this would surface zone-restricted coupons as reachable from
  // any zone (only the real apply path enforces the zone, confusingly).
  if (connection) {
    const zoneTargeted = await isZoneTargeted(connection, coupon, zoneId);
    if (!zoneTargeted) {
      return { ok: false, reason: 'This coupon is not available for your delivery zone' };
    }
  }

  // From here on we need a DB connection + userId for usage checks.
  if (!skipUsageChecks && connection && userId) {
    // 8. Target audience
    const targeted = await isUserTargeted(connection, coupon, userId);
    if (!targeted) {
      return { ok: false, reason: 'This coupon is not available for your account' };
    }

    // 9. First-order-only
    if (coupon.first_order_only) {
      const orderCount = await getUserOrderCount(connection, userId);
      if (orderCount > 0) {
        return { ok: false, reason: 'This coupon is only valid on your first order' };
      }
    }

    // 10. First-N-orders
    if (coupon.first_n_orders !== null && coupon.first_n_orders !== undefined) {
      const orderCount = await getUserOrderCount(connection, userId);
      if (orderCount >= coupon.first_n_orders) {
        return { ok: false, reason: `This coupon is only valid for your first ${coupon.first_n_orders} orders` };
      }
    }

    // 11. Per-user usage limit
    if (coupon.per_user_usage_limit !== null && coupon.per_user_usage_limit !== undefined && coupon.per_user_usage_limit > 0) {
      const used = await getUserRedemptionCount(connection, coupon.id, userId);
      if (used >= coupon.per_user_usage_limit) {
        return { ok: false, reason: `You've already used this coupon ${used} time(s) (limit: ${coupon.per_user_usage_limit})` };
      }
    }

    // 12. Global usage limit
    if (coupon.total_usage_limit !== null && coupon.total_usage_limit !== undefined) {
      const globalUsed = await getGlobalRedemptionCount(connection, coupon.id);
      if (globalUsed >= coupon.total_usage_limit) {
        return { ok: false, reason: 'This coupon has reached its maximum usage limit' };
      }
    }
  }

  const { discount, itemDiscount, freeDeliveryWaiver } = computeDiscountBreakdown(coupon, { subtotal, deliveryCharge, standardDeliveryCharge });
  // Pure free_delivery has no value on Fast — reject so auto-apply picks
  // another offer (or none) and place-order does not attach a zero-value coupon.
  // Do NOT reject when deliveryCharge is 0 / standard is omitted (threshold-hint
  // probes call checkEligibility with deliveryCharge: 0 to test schedule/store
  // eligibility only — free_delivery waiver is computed later at apply time).
  if (
    coupon.discount_type === 'free_delivery'
    && freeDeliveryWaiver <= 0
    && isFastDeliveryOrder(deliveryCharge, standardDeliveryCharge)
  ) {
    return {
      ok: false,
      reason: 'Free delivery applies to Standard delivery only',
    };
  }
  return { ok: true, coupon, discount, itemDiscount, freeDeliveryWaiver };
};

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/**
 * Validates a coupon by its code. Used by the manual "Apply" button and
 * by order creation (server-side re-validation).
 *
 * @param {Object} params - { code, subtotal, deliveryCharge, storeType, userId, now, connection }
 * @returns {Promise<{ ok, coupon?, discount?, reason? }>}
 */
const validateCoupon = async ({
  code,
  subtotal,
  deliveryCharge = 0,
  standardDeliveryCharge = null,
  storeType = null,
  userId = null,
  zoneId = null,
  now = new Date(),
  connection = null,
  itemCount = null,
  areaId = null,
}) => {
  if (!code || typeof code !== 'string') {
    return { ok: false, reason: 'Please enter a coupon code' };
  }

  const normalizedCode = code.trim().toUpperCase();
  const conn = connection || pool;

  // areaId is an input to the rule engine, not logic inside it (§14.2) —
  // omitted only by callers that haven't been threaded through yet (their
  // owning stopgap, not this file's).
  const [rows] = areaId !== null
    ? await conn.query('SELECT * FROM coupons WHERE code = ? AND deleted = 0 AND area_id = ? LIMIT 1', [normalizedCode, areaId])
    : await conn.query('SELECT * FROM coupons WHERE code = ? AND deleted = 0 LIMIT 1', [normalizedCode]);

  if (rows.length === 0) {
    return { ok: false, reason: 'Invalid coupon code' };
  }

  return checkEligibility({
    coupon: rows[0],
    subtotal,
    deliveryCharge,
    standardDeliveryCharge,
    storeType,
    userId,
    zoneId,
    now,
    connection: conn,
    itemCount,
  });
};

/**
 * Validates a coupon by its id rather than its code. Used to force-apply a
 * specific offer the user explicitly tapped in the offers list — including
 * auto-apply-only offers that have no code at all (code IS NULL), which
 * `validateCoupon` can never look up. Without this, tapping a no-code offer
 * has no way to tell the backend which one was picked, so the next
 * recalculation just falls back to auto-picking the single best offer again.
 *
 * @param {Object} params - { couponId, subtotal, deliveryCharge, storeType, userId, now, connection }
 * @returns {Promise<{ ok, coupon?, discount?, reason? }>}
 */
const validateCouponById = async ({
  couponId,
  subtotal,
  deliveryCharge = 0,
  standardDeliveryCharge = null,
  storeType = null,
  userId = null,
  zoneId = null,
  now = new Date(),
  connection = null,
  itemCount = null,
  areaId = null,
}) => {
  if (!couponId) {
    return { ok: false, reason: 'Coupon not found' };
  }

  const conn = connection || pool;

  const [rows] = areaId !== null
    ? await conn.query('SELECT * FROM coupons WHERE id = ? AND deleted = 0 AND area_id = ? LIMIT 1', [couponId, areaId])
    : await conn.query('SELECT * FROM coupons WHERE id = ? AND deleted = 0 LIMIT 1', [couponId]);

  if (rows.length === 0) {
    return { ok: false, reason: 'Coupon not found' };
  }

  return checkEligibility({
    coupon: rows[0],
    subtotal,
    deliveryCharge,
    standardDeliveryCharge,
    storeType,
    userId,
    zoneId,
    now,
    connection: conn,
    itemCount,
  });
};

/**
 * Finds the single best auto-apply coupon for the given context.
 *
 * Coupon model (product):
 *  - free_delivery: pure free-delivery unlock (lower min order, e.g. ₹150)
 *  - flat/percent: item discount; optional also_free_delivery checkbox adds
 *    free delivery on the same coupon (higher min order, e.g. ₹200 / ₹300 / ₹400)
 *
 * Selection = maximum customer savings among currently eligible auto-apply
 * coupons. Total discount already includes freeDeliveryWaiver when
 * also_free_delivery is set, so a ₹400 "₹40 off + free delivery" beats both
 * pure free delivery and a lower-tier ₹300 offer.
 *
 * Tie-breakers (after equal total savings):
 *  1. Higher min_order (prefer the furthest unlocked ladder step, e.g. ₹400 > ₹300)
 *  2. Higher min_item_count
 *  3. Higher priority
 *  4. Higher id
 *
 * Returns { coupon, discount, itemDiscount, freeDeliveryWaiver } or null.
 *
 * @param {Object} params - { subtotal, deliveryCharge, storeType, userId, now, connection }
 */
const pickBestAutoApply = async ({
  subtotal,
  deliveryCharge = 0,
  standardDeliveryCharge = null,
  storeType = null,
  userId = null,
  zoneId = null,
  now = new Date(),
  connection = null,
  itemCount = null,
  areaId = null,
}) => {
  const conn = connection || pool;

  // Fetch all active, non-deleted auto-apply coupons within the date window.
  // We can't fully filter by day-of-week / time-of-day in SQL, so we fetch
  // candidates and then check in JS.
  const [rows] = areaId !== null
    ? await conn.query(
        `SELECT * FROM coupons
         WHERE auto_apply = 1 AND active = 1 AND deleted = 0 AND area_id = ?
           AND (starts_at IS NULL OR starts_at <= ?)
           AND (ends_at IS NULL OR ends_at >= ?)
         ORDER BY priority DESC, id DESC`,
        [areaId, now, now]
      )
    : await conn.query(
        `SELECT * FROM coupons
         WHERE auto_apply = 1 AND active = 1 AND deleted = 0
           AND (starts_at IS NULL OR starts_at <= ?)
           AND (ends_at IS NULL OR ends_at >= ?)
         ORDER BY priority DESC, id DESC`,
        [now, now]
      );

  const eligible = [];
  for (const coupon of rows) {
    const result = await checkEligibility({
      coupon,
      subtotal,
      deliveryCharge,
      standardDeliveryCharge,
      storeType,
      userId,
      zoneId,
      now,
      connection: conn,
      itemCount,
    });
    if (result.ok) eligible.push(result);
  }

  if (eligible.length === 0) return null;

  // Max savings first; on a tie prefer the furthest ladder step the cart has
  // unlocked (highest min_order), so completing the ₹400 bar applies the ₹400
  // coupon — not a lower unlocked tier that happens to share priority.
  const compareRank = (a, b) => {
    if (a.discount !== b.discount) return b.discount - a.discount;

    const ma = toMoney(a.coupon.min_order_amount);
    const mb = toMoney(b.coupon.min_order_amount);
    if (ma !== mb) return mb - ma;

    const ia = Number(a.coupon.min_item_count) || 0;
    const ib = Number(b.coupon.min_item_count) || 0;
    if (ia !== ib) return ib - ia;

    const pa = Number(a.coupon.priority) || 0;
    const pb = Number(b.coupon.priority) || 0;
    if (pa !== pb) return pb - pa;

    return (Number(b.coupon.id) || 0) - (Number(a.coupon.id) || 0);
  };

  eligible.sort(compareRank);
  return eligible[0];
};

/**
 * Returns a list of every currently-active, non-deleted, in-date-window
 * coupon (for the offers list/sheet). Nothing is silently hidden from the
 * customer beyond that: a coupon that's active but doesn't currently apply
 * (wrong store type, day/time restriction, first-order-only, already
 * exhausted, etc.) is still returned — with `available: false` and a
 * human-readable `unavailableReason` — rather than being dropped from the
 * list. `unlocked`/`amountRemaining` remain a separate, narrower signal for
 * the specific "add ₹X more" min-order gate, since that's actionable in a
 * way the other eligibility rules aren't.
 *
 * Each item is enriched with: discount (computed), savingsText, minOrder,
 * requiresCode, autoApply, usageInfo { used, limit, remaining }.
 *
 * @param {Object} params - { subtotal, deliveryCharge, storeType, userId, now, connection }
 */
const findApplicableCoupons = async ({
  subtotal,
  deliveryCharge = 0,
  standardDeliveryCharge = null,
  storeType = null,
  userId = null,
  zoneId = null,
  now = new Date(),
  connection = null,
  itemCount = null,
  areaId = null,
}) => {
  // NOTE: Owner confirmed in bugs.md (§C7) that code-required coupons appearing
  // in the in-app offers list is INTENDED BEHAVIOR. Do not filter them out.
  const conn = connection || pool;

  const [rows] = areaId !== null
    ? await conn.query(
        `SELECT * FROM coupons
         WHERE active = 1 AND deleted = 0 AND area_id = ?
           AND (starts_at IS NULL OR starts_at <= ?)
           AND (ends_at IS NULL OR ends_at >= ?)
         ORDER BY auto_apply DESC, priority DESC, id DESC`,
        [areaId, now, now]
      )
    : await conn.query(
        `SELECT * FROM coupons
         WHERE active = 1 AND deleted = 0
           AND (starts_at IS NULL OR starts_at <= ?)
           AND (ends_at IS NULL OR ends_at >= ?)
         ORDER BY auto_apply DESC, priority DESC, id DESC`,
        [now, now]
      );

  const sub = toMoney(subtotal);
  const currentItems = Number(itemCount) || 0;
  const result = [];
  for (const coupon of rows) {
    const minOrder = toMoney(coupon.min_order_amount);
    const unlocked = sub >= minOrder;
    const evalSubtotal = unlocked ? subtotal : minOrder;
    const evalDelivery = unlocked ? deliveryCharge : 0;
    const evalStandardDelivery = unlocked ? standardDeliveryCharge : 0;

    const minItemCount = coupon.min_item_count !== null && coupon.min_item_count !== undefined
      ? Number(coupon.min_item_count)
      : null;
    const itemsUnlocked = minItemCount === null || currentItems >= minItemCount;
    const evalItemCount = itemsUnlocked ? currentItems : minItemCount;

    // Full eligibility check — day/time window, store type, max order,
    // target audience, first-order/first-N, per-user/global usage limits.
    // The min-order gate itself is relaxed to `minOrder` so a locked coupon
    // can still be evaluated for every OTHER rule (a coupon that's both
    // locked AND wrong-store-type should read as "wrong store", not just
    // "add ₹X more").
    const evaluation = await checkEligibility({
      coupon,
      subtotal: evalSubtotal,
      deliveryCharge: evalDelivery,
      standardDeliveryCharge: evalStandardDelivery,
      storeType,
      userId,
      zoneId,
      now,
      connection: conn,
      skipUsageChecks: false,
      itemCount: evalItemCount,
    });

    // Compute usage info for display
    let usageInfo = null;
    if (userId) {
      const used = await getUserRedemptionCount(conn, coupon.id, userId);
      const limit = coupon.per_user_usage_limit;
      usageInfo = {
        used,
        limit: limit !== null && limit !== undefined ? limit : null,
        remaining: limit !== null && limit !== undefined ? Math.max(0, limit - used) : null,
      };
    }

    const { discount, itemDiscount, freeDeliveryWaiver } = computeDiscountBreakdown(coupon, { subtotal: evalSubtotal, deliveryCharge: evalDelivery, standardDeliveryCharge: evalStandardDelivery });
    result.push({
      id: coupon.id,
      code: coupon.code,
      title: coupon.title,
      description: coupon.description,
      discountType: coupon.discount_type,
      alsoFreeDelivery: Boolean(coupon.also_free_delivery),
      itemDiscount: roundMoney(itemDiscount),
      freeDeliveryWaiver: roundMoney(freeDeliveryWaiver),
      discountValue: Number(coupon.discount_value),
      maxDiscountAmount: coupon.max_discount_amount !== null ? Number(coupon.max_discount_amount) : null,
      minOrder: Number(coupon.min_order_amount),
      maxOrder: coupon.max_order_amount !== null ? Number(coupon.max_order_amount) : null,
      appliesTo: coupon.applies_to,
      requiresCode: Boolean(coupon.requires_code),
      autoApply: Boolean(coupon.auto_apply),
      targetAudience: coupon.target_audience,
      targetZones: coupon.target_zones,
      firstOrderOnly: Boolean(coupon.first_order_only),
      firstNOrders: coupon.first_n_orders,
      startsAt: coupon.starts_at,
      endsAt: coupon.ends_at,
      discount: roundMoney(discount),
      savingsText: buildSavingsText(coupon, discount),
      usageInfo,
      unlocked,
      amountRemaining: unlocked ? 0 : roundMoney(minOrder - sub),
      minItemCount,
      itemsUnlocked,
      itemsRemaining: itemsUnlocked ? 0 : (minItemCount - currentItems),
      available: evaluation.ok,
      unavailableReason: evaluation.ok ? null : evaluation.reason,
    });
  }

  return result;
};

/**
 * Scans coupon rows (already filtered/ordered by SQL) for the nearest
 * not-yet-met min_order_amount threshold, checking every eligibility rule
 * except the min-order gate itself by evaluating at exactly
 * min_order_amount. Shared by getNextFreeDeliveryThreshold (skips usage
 * checks — it's a lightweight hint) and getNearestUnlockableCoupon (runs
 * full usage checks so exhausted coupons are never hinted).
 *
 * @returns {Promise<{coupon: Object, minOrder: number, amountRemaining: number}|null>}
 */
const findNearestEligibleThreshold = async ({
  rows,
  subtotal,
  storeType,
  userId,
  zoneId,
  now,
  connection,
  skipUsageChecks,
  itemCount = 0,
}) => {
  const sub = toMoney(subtotal);
  const currentItems = Number(itemCount) || 0;

  for (const coupon of rows) {
    const minOrder = toMoney(coupon.min_order_amount);
    const minItemCount = Number(coupon.min_item_count) || 0;
    const amountMet = sub >= minOrder;
    const itemsMet = minItemCount === 0 || currentItems >= minItemCount;
    if (amountMet && itemsMet) continue; // already met — no hint needed for this one

    const evalSubtotal = amountMet ? subtotal : minOrder;
    const evalItemCount = itemsMet ? currentItems : minItemCount;

    const eligible = await checkEligibility({
      coupon,
      subtotal: evalSubtotal,
      deliveryCharge: 0,
      storeType,
      userId,
      zoneId,
      now,
      connection,
      skipUsageChecks,
      itemCount: evalItemCount,
    });
    if (!eligible.ok) continue;

    let thresholdType;
    if (!amountMet && !itemsMet) thresholdType = 'both';
    else if (!amountMet) thresholdType = 'amount';
    else thresholdType = 'item_count';

    return {
      coupon,
      minOrder,
      amountRemaining: amountMet ? 0 : roundMoney(minOrder - sub),
      minItemCount,
      itemsRemaining: itemsMet ? 0 : minItemCount - currentItems,
      thresholdType,
    };
  }

  return null;
};

/**
 * Finds the nearest not-yet-met auto-apply free_delivery coupon threshold,
 * for "add ₹X more for free delivery" progress hints in the cart/checkout UI.
 * Only considers coupons the cart is otherwise eligible for (date/day/time/
 * store type) but hasn't reached the min_order_amount of yet — usage-limit
 * checks are skipped since this is just a progress hint, not an application.
 *
 * @returns {Promise<{minOrder: number, amountRemaining: number}|null>}
 */
const getNextFreeDeliveryThreshold = async ({
  subtotal,
  storeType = null,
  userId = null,
  zoneId = null,
  now = new Date(),
  connection = null,
  itemCount = 0,
  areaId = null,
}) => {
  const conn = connection || pool;

  const [rows] = areaId !== null
    ? await conn.query(
        `SELECT * FROM coupons
         WHERE active = 1 AND deleted = 0 AND discount_type = 'free_delivery' AND area_id = ?
           AND auto_apply = 1 AND requires_code = 0
           AND (starts_at IS NULL OR starts_at <= ?)
           AND (ends_at IS NULL OR ends_at >= ?)
         ORDER BY min_order_amount ASC, min_item_count ASC`,
        [areaId, now, now]
      )
    : await conn.query(
        `SELECT * FROM coupons
         WHERE active = 1 AND deleted = 0 AND discount_type = 'free_delivery'
           AND auto_apply = 1 AND requires_code = 0
           AND (starts_at IS NULL OR starts_at <= ?)
           AND (ends_at IS NULL OR ends_at >= ?)
         ORDER BY min_order_amount ASC, min_item_count ASC`,
        [now, now]
      );

  const result = await findNearestEligibleThreshold({
    rows,
    subtotal,
    storeType,
    userId,
    zoneId,
    now,
    connection: conn,
    skipUsageChecks: true,
    itemCount,
  });
  if (!result) return null;

  return {
    minOrder: result.minOrder,
    amountRemaining: result.amountRemaining,
    minItemCount: result.minItemCount,
    itemsRemaining: result.itemsRemaining,
    thresholdType: result.thresholdType,
  };
};

/**
 * Finds the nearest not-yet-met coupon threshold across ALL discount types
 * (flat/percent — free_delivery is excluded since it already has its own
 * dedicated hint via getNextFreeDeliveryThreshold), for the generalized
 * "Add ₹X more to unlock <offer>" progress message in the cart UI.
 *
 * Unlike getNextFreeDeliveryThreshold, this runs FULL eligibility checks
 * (audience, order-history, usage limits) — not just visibility checks —
 * so expired, exhausted, or otherwise-inapplicable coupons are never
 * surfaced as "almost there". Only the min-order gate itself is relaxed
 * (evaluated at exactly min_order_amount).
 *
 * @param {Object} params - { subtotal, storeType, userId, now, connection, excludeCouponId }
 * @param {number} [params.excludeCouponId] - Skip this coupon (e.g. the one
 *   currently applied — no point hinting an offer that's already active).
 * @returns {Promise<{couponId, code, title, discountType, minOrder, amountRemaining, savingsText, requiresCode, autoApply}|null>}
 */
const getNearestUnlockableCoupon = async ({
  subtotal,
  storeType = null,
  userId = null,
  zoneId = null,
  now = new Date(),
  connection = null,
  excludeCouponId = null,
  itemCount = 0,
  areaId = null,
}) => {
  const conn = connection || pool;

  const [rows] = areaId !== null
    ? await conn.query(
        `SELECT * FROM coupons
         WHERE active = 1 AND deleted = 0 AND discount_type != 'free_delivery' AND area_id = ?
           AND (starts_at IS NULL OR starts_at <= ?)
           AND (ends_at IS NULL OR ends_at >= ?)
         ORDER BY min_order_amount ASC, min_item_count ASC, priority DESC, id ASC`,
        [areaId, now, now]
      )
    : await conn.query(
        `SELECT * FROM coupons
         WHERE active = 1 AND deleted = 0 AND discount_type != 'free_delivery'
           AND (starts_at IS NULL OR starts_at <= ?)
           AND (ends_at IS NULL OR ends_at >= ?)
         ORDER BY min_order_amount ASC, min_item_count ASC, priority DESC, id ASC`,
        [now, now]
      );

  const candidates = excludeCouponId
    ? rows.filter(coupon => coupon.id !== excludeCouponId)
    : rows;

  const result = await findNearestEligibleThreshold({
    rows: candidates,
    subtotal,
    storeType,
    userId,
    zoneId,
    now,
    connection: conn,
    skipUsageChecks: false,
    itemCount,
  });
  if (!result) return null;

  const { coupon, minOrder, amountRemaining, minItemCount, itemsRemaining, thresholdType } = result;
  const discountAtThreshold = computeDiscount(coupon, { subtotal: minOrder, deliveryCharge: 0 });

  return {
    couponId: coupon.id,
    code: coupon.code,
    title: coupon.title,
    discountType: coupon.discount_type,
    minOrder,
    amountRemaining,
    minItemCount,
    itemsRemaining,
    thresholdType,
    savingsText: buildSavingsText(coupon, discountAtThreshold),
    requiresCode: Boolean(coupon.requires_code),
    autoApply: Boolean(coupon.auto_apply),
  };
};

/**
 * Builds a human-readable savings text for display in the UI.
 */
const buildSavingsText = (coupon, discount) => {
  if (discount > 0) {
    return `You save ₹${discount}`;
  }
  switch (coupon.discount_type) {
    case 'flat':
      return `₹${Number(coupon.discount_value)} off`;
    case 'percent':
      return `${Number(coupon.discount_value)}% off${coupon.max_discount_amount ? ` (up to ₹${Number(coupon.max_discount_amount)})` : ''}`;
    case 'free_delivery':
      return 'Free delivery';
    default:
      return 'Discount available';
  }
};

module.exports = {
  // Core
  validateCoupon,
  validateCouponById,
  pickBestAutoApply,
  findApplicableCoupons,
  getNextFreeDeliveryThreshold,
  getNearestUnlockableCoupon,
  checkEligibility,
  computeDiscount,
  computeDiscountBreakdown,

  // Helpers (exported for testing)
  isWithinDateWindow,
  isWithinActiveDays,
  isWithinActiveTime,
  getUserOrderCount,
  getUserRedemptionCount,
  getGlobalRedemptionCount,
  isUserTargeted,
  isZoneTargeted,
  buildSavingsText,
};