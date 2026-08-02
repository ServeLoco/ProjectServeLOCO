const { pool } = require('../db/mysql');
const { isId, isPositiveInteger, validateCoordinates } = require('../validators');
const { resolveDeliveryPricing, loadActiveZones, loadActiveExclusionZones, parseBoundary, polygonAreaKm2 } = require('../utils/deliveryPricing');
const { roundMoney, toMoney } = require('../utils/money');
const { calculateRainCharge } = require('../utils/rainCharge');
const { validateCoupon, validateCouponById, pickBestAutoApply, findApplicableCoupons, getNextFreeDeliveryThreshold, getNearestUnlockableCoupon } = require('../utils/coupons');

const calculateCart = async (req, res) => {
  const { items, delivery_type: rawDeliveryType } = req.body;
  const deliveryTypeInput = rawDeliveryType === 'fast' ? 'fast' : 'standard';
  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Items array is required' });
  }
  if (items.length > 100) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Too many items in one order (max 100).' });
  }

  const [settingRows] = await pool.query(
    'SELECT shop_open, delivery_charge, night_charge, night_charge_start, night_charge_end, rain_charge_enabled, rain_charge, fast_delivery_enabled, fast_delivery_charge, standard_delivery_minutes, fast_delivery_minutes, delivery_radius_km, shop_latitude, shop_longitude, radius_pricing_active FROM settings WHERE area_id = 1 LIMIT 1' // stopgap area 1 (TASK 13 threads the resolved area through cart/order pricing)
  );
  const settings = settingRows[0] || {
    shop_open: 1, delivery_charge: 0, night_charge: 0,
    standard_delivery_minutes: 60, fast_delivery_minutes: 30,
  };

  // Validate all items first before touching the DB
  const normalizedItems = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const productId = item.product_id || item.productId;
    const isCombo = item.type === 'combo' || item.isCombo || item.is_combo;
    const rawVariantId = item.variant_id || item.variantId || null;

    if (!isId(productId)) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Item ${index + 1}: valid product_id is required` });
    }
    if (rawVariantId !== null && rawVariantId !== undefined && !isId(rawVariantId)) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Item ${index + 1}: valid variant_id is required` });
    }
    if (!isPositiveInteger(item.quantity)) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: `Item ${index + 1}: quantity must be a whole number between 1 and 999` });
    }
    normalizedItems.push({ productId: Number(productId), variantId: rawVariantId !== null && rawVariantId !== undefined ? Number(rawVariantId) : null, quantity: Number(item.quantity), isCombo });
  }
  // Batch fetch products and combos in 2 queries instead of N queries
  const productIds = normalizedItems.filter(i => !i.isCombo).map(i => i.productId);
  const comboIds = normalizedItems.filter(i => i.isCombo).map(i => i.productId);

  const productMap = {};
  if (productIds.length > 0) {
    const [prodRows] = await pool.query(
      'SELECT id, name, price FROM products WHERE id IN (?) AND available = 1 AND deleted = 0 AND (shop_id IS NULL OR EXISTS (SELECT 1 FROM shops s WHERE s.id = products.shop_id AND s.is_open = 1 AND s.active = 1)) AND (group_id IS NULL OR EXISTS (SELECT 1 FROM product_groups g WHERE g.id = products.group_id AND g.active = 1))',
      [productIds]
    );
    prodRows.forEach(p => { productMap[p.id] = p; });
  }

  // A product missing from productMap is ambiguous: OOS/deleted (soft-droppable),
  // shop-closed/group-inactive (must still hard-block checkout), and a
  // never-existed/hard-deleted id (stale or tampered client cart, also
  // soft-droppable) all land here, since the query above filters on all four
  // at once. Disambiguate with a second, narrower existence check on only the
  // missing ids — fetch every matching row regardless of status so a
  // genuinely-nonexistent id (no row at all) can be told apart from one that
  // exists but is excluded only by the shop/group gate.
  const missingProductIds = productIds.filter((id) => !productMap[id]);
  const existingProductIds = new Set();
  const genuinelyUnavailableProductIds = new Set();
  if (missingProductIds.length > 0) {
    const [unavailRows] = await pool.query(
      'SELECT id, deleted, available FROM products WHERE id IN (?)',
      [missingProductIds]
    );
    unavailRows.forEach((r) => {
      existingProductIds.add(r.id);
      if (r.deleted === 1 || r.available === 0) genuinelyUnavailableProductIds.add(r.id);
    });
  }

  const comboMap = {};
  if (comboIds.length > 0) {
    const [comboRows] = await pool.query(
      'SELECT id, name, price FROM combos WHERE id IN (?) AND available = 1 AND deleted = 0',
      [comboIds]
    );
    comboRows.forEach(c => { comboMap[c.id] = c; });
  }

  // Batch fetch variants referenced by the cart (one query for all distinct
  // non-null variant ids). Two lines with the same productId but different
  // variantIds are legal — no dedup is done on variants, only on ids.
  const variantIds = [...new Set(normalizedItems.filter(i => i.variantId !== null).map(i => i.variantId))];
  const variantMap = {};
  if (variantIds.length > 0) {
    const [variantRows] = await pool.query(
      'SELECT id, product_id, label, price, available, deleted FROM product_variants WHERE id IN (?)',
      [variantIds]
    );
    variantRows.forEach(v => { variantMap[v.id] = v; });
  }

  let subtotal = 0;
  const processedItems = [];
  // Soft-drop genuinely OOS/deleted lines so cart preview still works for
  // remaining items. Client removes these from the local cart (see
  // unavailableItems). Shop-closed / group-inactive items are NOT soft-dropped
  // (see hard 400 below) — order placement still hard-validates separately.
  const unavailableItems = [];

  for (let index = 0; index < normalizedItems.length; index++) {
    const { productId, variantId, quantity, isCombo } = normalizedItems[index];
    const product = isCombo ? comboMap[productId] : productMap[productId];

    if (!product) {
      if (
        !isCombo
        && existingProductIds.has(productId)
        && !genuinelyUnavailableProductIds.has(productId)
      ) {
        // Product row exists (available, not deleted) but was excluded by the
        // shop-open/group-active gate — do not silently drop it, the customer
        // must know the whole shop/group is unavailable, not just this item.
        return res.status(400).json({
          code: 'SHOP_CLOSED',
          message: `Item ${index + 1}: this shop is currently closed`,
        });
      }
      // Either genuinely OOS/deleted, or the id never existed at all (stale/
      // tampered client cart) — both are soft-droppable, same as before this
      // disambiguation existed.
      unavailableItems.push({
        productId,
        product_id: productId,
        variantId: isCombo ? null : variantId,
        variant_id: isCombo ? null : variantId,
        type: isCombo ? 'combo' : 'product',
        quantity,
        reason: isCombo ? 'combo_unavailable' : 'product_unavailable',
      });
      continue;
    }

    let unitPrice;
    let lineName = product.name;
    let variantLabel = null;

    if (variantId !== null && !isCombo) {
      // Server-authoritative variant pricing: ALL four conditions must hold.
      const variant = variantMap[variantId];
      if (!variant || variant.deleted || !variant.available || Number(variant.product_id) !== productId) {
        unavailableItems.push({
          productId,
          product_id: productId,
          variantId,
          variant_id: variantId,
          type: 'product',
          quantity,
          reason: 'variant_unavailable',
        });
        continue;
      }
      unitPrice = toMoney(variant.price);
      variantLabel = variant.label;
      lineName = `${product.name} (${variant.label})`;
    } else {
      // No variantId (old-client path) or a combo → base product/combo price.
      unitPrice = toMoney(product.price);
    }

    const lineTotal = roundMoney(unitPrice * quantity);
    subtotal += lineTotal;
    // Combos never carry a variant — force null so an unvalidated client-sent
    // variantId is never echoed back as if it had been checked.
    const effectiveVariantId = isCombo ? null : variantId;
    const effectiveVariantLabel = isCombo ? null : variantLabel;
    processedItems.push({
      id: product.id,
      name: lineName,
      quantity,
      unitPrice,
      lineTotal,
      type: isCombo ? 'combo' : 'product',
      variantId: effectiveVariantId,
      variant_id: effectiveVariantId,
      variantLabel: effectiveVariantLabel,
      variant_label: effectiveVariantLabel,
    });
  }

  // Free-delivery / coupon thresholds use remaining (available) lines only.
  const totalItemCount = processedItems.reduce((sum, i) => sum + i.quantity, 0);

  const { latitude, longitude, lat, lng } = req.body;
  const customerLat = latitude !== undefined ? latitude : lat;
  const customerLng = longitude !== undefined ? longitude : lng;

  if (customerLat !== undefined && customerLng !== undefined &&
      customerLat !== null && customerLng !== null &&
      customerLat !== '' && customerLng !== '') {
    if (!validateCoordinates(customerLat, customerLng)) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Invalid GPS coordinates provided'
      });
    }
  }

  let deliveryDistanceKm = null;
  let deliveryWithinRange = true;
  let requiresLocation = false;
  let deliveryMessage = '';

  // Radius-zone pricing: when active (flag + center pin + coords + zones), the
  // matched zone's charges/ETAs/COD policy replace the flat settings values.
  // Any missing precondition falls back to the legacy flat pricing inside the
  // resolver, so the rest of this function (incl. the coupon block) is
  // agnostic to which mode priced the cart.
  const zones = settings.radius_pricing_active ? await loadActiveZones(pool) : [];
  // Exclusion squares block delivery regardless of zone/flat pricing mode,
  // so they're always loaded (small table) — not gated by radius_pricing_active.
  const exclusionZones = await loadActiveExclusionZones(pool);
  const pricing = resolveDeliveryPricing({
    customerLat,
    customerLng,
    deliveryType: deliveryTypeInput,
    settings,
    zones,
    exclusionZones,
  });

  // Fast delivery is an ADD-ON, not a replacement: the standard delivery
  // charge always stays on the bill — with its coupon/free-delivery rules
  // untouched — and the fast fee is added on top when chosen.
  //
  // `deliveryCharge` therefore stays the STANDARD fee even on fast orders,
  // including for every coupon-engine call: free-delivery coupons keep
  // waiving the standard fee exactly as on a standard order. The fast fee
  // is never passed into the engine, so it can never be discounted.
  const fastDeliveryEnabled = Boolean(settings.fast_delivery_enabled);
  const fastDeliveryAvailable = fastDeliveryEnabled;
  const isFast = deliveryTypeInput === 'fast' && fastDeliveryAvailable;
  // deliveryCharge always stays the STANDARD fee (zone-aware via the
  // resolver) even on fast orders — fast is additive, not a swap. See the
  // add-on note above.
  let deliveryCharge = pricing.standardDeliveryCharge;
  const standardDeliveryCharge = pricing.standardDeliveryCharge;
  const fastDeliveryCharge = pricing.fastDeliveryCharge;
  const standardDeliveryMinutes = pricing.standardDeliveryMinutes;
  const fastDeliveryMinutes = pricing.fastDeliveryMinutes;
  deliveryDistanceKm = pricing.distanceKm;
  // Additive fast-delivery fee actually charged on this order (0 unless Fast
  // is selected).
  let fastDeliveryFee = isFast ? fastDeliveryCharge : 0;

  const missingCoords = customerLat === undefined || customerLat === null || customerLat === ''
    || customerLng === undefined || customerLng === null || customerLng === '';
  if (missingCoords) {
    requiresLocation = true;
    deliveryMessage = 'Customer GPS location is required.';
  }
  // Checked independently of missingCoords, not as its else-branch: with zone
  // pricing ON the resolver reports outOfRange for a cart with no
  // coordinates, and that has to make the quote invalid. Previously the
  // missing-coords branch swallowed it and still returned valid: true with a
  // full flat-priced breakdown for an address nobody had checked. With zone
  // pricing OFF the resolver reports outOfRange: false, so flat-pricing
  // installs keep quoting as before and only see requiresLocation.
  if (pricing.outOfRange) {
    deliveryWithinRange = false;
    if (!requiresLocation) deliveryMessage = 'Delivery is not available at this location.';
  } else if (pricing.excluded) {
    deliveryWithinRange = false;
    deliveryMessage = pricing.exclusionMessage;
  }

  let nightCharge = pricing.nightCharge > 0 ? toMoney(pricing.nightCharge) : 0;

  let rainCharge = 0;
  if (settings.rain_charge_enabled) {
    const raw = calculateRainCharge(settings);
    if (raw > 0) rainCharge = toMoney(raw);
  }

  subtotal = roundMoney(subtotal);
  deliveryCharge = roundMoney(deliveryCharge);
  nightCharge = roundMoney(nightCharge);
  rainCharge = roundMoney(rainCharge);
  fastDeliveryFee = roundMoney(fastDeliveryFee);

  // ───────────────────────────────────────────────────────────────────
  // Coupon / offer application
  // Only ONE coupon applies per order (no stacking):
  //  - If the user entered a code, validate it. On failure, surface the
  //    error but keep discount = 0 so checkout can still proceed.
  //  - Otherwise, pick the best auto-apply offer (if any).
  // The coupon only adds a Discount line — it never overrides any charge.
  // ───────────────────────────────────────────────────────────────────
  const couponCode = req.body.coupon_code || req.body.couponCode || null;
  // Identifies a specific offer the user tapped that has no code at all
  // (auto-apply-only coupons can have code = NULL) — used to force-apply
  // that exact offer instead of falling back to "the best available one".
  const couponId = req.body.coupon_id || req.body.couponId || null;
  // Matched delivery zone (null when unzoned/flat pricing) — used to gate
  // zone-specific coupons (target_zones = 'selected').
  const zoneId = pricing.zone ? pricing.zone.id : null;
  // Set once the user explicitly removes their applied coupon — distinguishes
  // "no code given yet" (auto-apply the best offer) from "user chose no
  // coupon" (must not silently re-apply another one on recalculation).
  const noAutoApply = req.body.no_auto_apply === true || req.body.noAutoApply === true;
  const userId = req.user?.id || null;

  // Determine the cart's store type from the items' categories so we can
  // filter coupons by applies_to. We look up the category type for each
  // product; combos carry their own store_type column. Uses processedItems
  // (post soft-drop) so a dropped unavailable line from another category
  // can't wrongly bucket an otherwise single-category cart as 'mixed'.
  let cartStoreType = null;
  try {
    const productIdsForStoreType = processedItems.filter(i => i.type !== 'combo').map(i => i.id);
    const comboIdsForStoreType = processedItems.filter(i => i.type === 'combo').map(i => i.id);
    const storeTypes = new Set();

    if (productIdsForStoreType.length > 0) {
      const [rows] = await pool.query(
        `SELECT DISTINCT c.type FROM products p
         LEFT JOIN categories c ON p.category_id = c.id
         WHERE p.id IN (?)`,
        [productIdsForStoreType]
      );
      rows.forEach(r => { if (r.type) storeTypes.add(r.type); });
    }
    if (comboIdsForStoreType.length > 0) {
      const [rows] = await pool.query(
        'SELECT DISTINCT store_type FROM combos WHERE id IN (?)',
        [comboIdsForStoreType]
      );
      rows.forEach(r => { if (r.store_type) storeTypes.add(r.store_type); });
    }

    if (storeTypes.size === 1) {
      cartStoreType = [...storeTypes][0];
    } else if (storeTypes.size > 1) {
      // Mixed cart — only 'all' coupons apply.
      cartStoreType = 'mixed';
    }
  } catch (_) {
    // Non-fatal: if store-type detection fails, just skip store-type filtering.
  }

  // Builds the appliedCoupon payload from a checkEligibility/pickBestAutoApply
  // result, carrying the itemDiscount / freeDeliveryWaiver split forward so
  // the bill summary can show "Delivery: FREE" separately from the
  // remaining flat/percent discount instead of one merged number.
  const buildAppliedCoupon = (result, { autoApplied }) => {
    // itemDiscount/freeDeliveryWaiver come from computeDiscountBreakdown via
    // checkEligibility; fall back to discount_type when a caller only sends
    // the plain { coupon, discount } shape (e.g. older mocks/tests).
    const freeDeliveryWaiver = result.freeDeliveryWaiver !== undefined
      ? roundMoney(result.freeDeliveryWaiver)
      : (result.coupon.discount_type === 'free_delivery' ? roundMoney(result.discount) : 0);
    const itemDiscount = result.itemDiscount !== undefined
      ? roundMoney(result.itemDiscount)
      : roundMoney(result.discount - freeDeliveryWaiver);
    return {
      id: result.coupon.id,
      code: result.coupon.code,
      title: result.coupon.title,
      discountType: result.coupon.discount_type,
      alsoFreeDelivery: Boolean(result.coupon.also_free_delivery),
      discount: roundMoney(result.discount),
      itemDiscount,
      freeDeliveryWaiver,
      autoApplied,
    };
  };

  let discount = 0;
  let appliedCoupon = null;
  let couponError = null;
  let availableCoupons = [];

  if (couponCode) {
    // User entered a code — validate it. User's code always wins over auto-apply.
    const result = await validateCoupon({
      code: couponCode,
      subtotal,
      deliveryCharge,
      standardDeliveryCharge,
      storeType: cartStoreType,
      userId,
      zoneId,
      itemCount: totalItemCount,
    });
    if (result.ok) {
      discount = roundMoney(result.discount);
      appliedCoupon = buildAppliedCoupon(result, { autoApplied: false });
    } else {
      couponError = result.reason;
    }
  } else if (couponId) {
    // User tapped a specific offer that has no code — force-apply that
    // exact coupon rather than falling back to auto-picking the best one.
    const result = await validateCouponById({
      couponId,
      subtotal,
      deliveryCharge,
      standardDeliveryCharge,
      storeType: cartStoreType,
      userId,
      zoneId,
      itemCount: totalItemCount,
    });
    if (result.ok) {
      discount = roundMoney(result.discount);
      appliedCoupon = buildAppliedCoupon(result, { autoApplied: false });
    } else {
      couponError = result.reason;
    }
  } else if (!noAutoApply) {
    // No code entered and the user hasn't explicitly removed a coupon —
    // try auto-apply.
    const best = await pickBestAutoApply({
      subtotal,
      deliveryCharge,
      standardDeliveryCharge,
      storeType: cartStoreType,
      userId,
      zoneId,
      itemCount: totalItemCount,
    });
    if (best) {
      discount = roundMoney(best.discount);
      appliedCoupon = buildAppliedCoupon(best, { autoApplied: true });
    }
  }

  // A failed typed code (or tapped offer) must not silently cost the
  // customer the auto-apply discount they already had — fall back to the
  // best auto-apply offer while still surfacing couponError, so the UI can
  // show "code invalid" alongside the still-applied auto discount.
  if (!appliedCoupon && couponError && !noAutoApply) {
    const best = await pickBestAutoApply({
      subtotal,
      deliveryCharge,
      standardDeliveryCharge,
      storeType: cartStoreType,
      userId,
      zoneId,
      itemCount: totalItemCount,
    });
    if (best) {
      discount = roundMoney(best.discount);
      appliedCoupon = buildAppliedCoupon(best, { autoApplied: true });
    }
  }

  // Always fetch the list of applicable coupons for the offers dropdown.
  // We do this even when a coupon is already applied so the user can see
  // alternatives and switch.
  try {
    availableCoupons = await findApplicableCoupons({
      subtotal,
      deliveryCharge,
      standardDeliveryCharge,
      storeType: cartStoreType,
      userId,
      zoneId,
      itemCount: totalItemCount,
    });
  } catch (_) {
    // Non-fatal: empty list on error.
  }

  discount = roundMoney(discount);
  // Clamp grand total so it never goes negative (discount can't exceed the
  // sum of subtotal + delivery + night charge + rain charge). Bill delivery
  // is always the standard fee (free-delivery-eligible); the fast fee is a
  // separate additive line that's never discounted.
  const rawTotal = subtotal + standardDeliveryCharge + fastDeliveryFee + nightCharge + rainCharge - discount;
  const grandTotal = roundMoney(Math.max(0, rawTotal));

  // Free-delivery progress hint: only relevant when no free_delivery coupon
  // is already applied. Drives "add ₹X more for free delivery" UI. Uses the
  // waiver amount rather than discountType so a flat/percent coupon with
  // also_free_delivery counts too.
  const isFreeDeliveryApplied = Boolean(appliedCoupon && appliedCoupon.freeDeliveryWaiver > 0);
  let freeDeliveryProgress = null;
  if (!isFreeDeliveryApplied) {
    try {
      freeDeliveryProgress = await getNextFreeDeliveryThreshold({ subtotal, storeType: cartStoreType, userId, zoneId, itemCount: totalItemCount });
    } catch (err) {
      // Non-fatal: no progress hint on error, but log so a broken hint
      // (e.g. missing migration column) doesn't fail silently in prod.
      console.error('[cart] getNextFreeDeliveryThreshold failed:', err.message);
    }
  }

  // Nearest-unlockable-offer progress hint: generalizes the free-delivery
  // hint above to flat/percent coupons. Excludes the currently applied
  // coupon (already unlocked, no reason to hint it) and free_delivery
  // coupons (already covered by freeDeliveryProgress above).
  let nearestOfferProgress = null;
  try {
    nearestOfferProgress = await getNearestUnlockableCoupon({
      subtotal,
      storeType: cartStoreType,
      userId,
      zoneId,
      excludeCouponId: appliedCoupon?.id || null,
      itemCount: totalItemCount,
    });
  } catch (err) {
    console.error('[cart] getNearestUnlockableCoupon failed:', err.message);
  }

  if (!requiresLocation && deliveryWithinRange) {
    if (isFreeDeliveryApplied) {
      deliveryMessage = 'Free delivery unlocked!';
    } else if (freeDeliveryProgress) {
      const parts = [];
      if (freeDeliveryProgress.amountRemaining > 0) {
        parts.push(`₹${freeDeliveryProgress.amountRemaining} more`);
      }
      if (freeDeliveryProgress.itemsRemaining > 0) {
        parts.push(`${freeDeliveryProgress.itemsRemaining} more item(s)`);
      }
      const addHint = parts.join(' and ');
      deliveryMessage = `Add ${addHint} for free delivery. ₹${standardDeliveryCharge} delivery applied.`;
    } else {
      deliveryMessage = `₹${standardDeliveryCharge} delivery applied.`;
    }
  }

  const calculation = {
    subtotal,
    deliveryCharge: standardDeliveryCharge,
    nightCharge,
    rainCharge,
    fastDeliveryFee,
    discount,
    grandTotal,
    total: grandTotal,
    items: processedItems,
    // Lines dropped because product/combo/variant is OOS or deleted (shop-closed
    // and group-inactive items hard-fail the whole request instead — see above).
    // Empty array when every requested line is orderable.
    unavailableItems,
    unavailable_items: unavailableItems,
    isValid: deliveryWithinRange,
    valid: deliveryWithinRange,
    message: !deliveryWithinRange ? deliveryMessage : '',

    // Location delivery details
    deliveryDistanceKm: deliveryDistanceKm !== null ? Number(deliveryDistanceKm.toFixed(4)) : null,
    delivery_distance_km: deliveryDistanceKm !== null ? Number(deliveryDistanceKm.toFixed(4)) : null,
    deliveryRadiusKm: pricing.mode === 'zone' ? pricing.maxRadiusKm : (Number(settings.delivery_radius_km) || 8.00),
    deliveryWithinRange,
    requiresLocation,
    freeDeliveryProgress,
    nearestOfferProgress,
    deliveryMessage,

    // Radius-zone pricing (additive; both casings per API contract)
    outOfRange: pricing.outOfRange,
    out_of_range: pricing.outOfRange,
    // Only set when outOfRange — the nearest zone the pin could move into.
    nearestZoneName: pricing.nearestZoneName || null,
    nearest_zone_name: pricing.nearestZoneName || null,
    excluded: pricing.excluded,
    exclusionMessage: pricing.exclusionMessage,
    exclusion_message: pricing.exclusionMessage,
    codAllowed: pricing.codAllowed,
    cod_allowed: pricing.codAllowed,
    radiusPricingApplied: pricing.mode === 'zone',
    radius_pricing_applied: pricing.mode === 'zone',
    maxDeliveryRadiusKm: pricing.maxRadiusKm,
    max_delivery_radius_km: pricing.maxRadiusKm,
    deliveryZone: pricing.zone ? {
      id: pricing.zone.id,
      name: pricing.zone.name || null,
      boundary: parseBoundary(pricing.zone.boundary),
      parentZoneId: pricing.zone.parent_zone_id != null ? pricing.zone.parent_zone_id : null,
      parent_zone_id: pricing.zone.parent_zone_id != null ? pricing.zone.parent_zone_id : null,
      areaKm2: Math.round(polygonAreaKm2(parseBoundary(pricing.zone.boundary)) * 100) / 100,
      area_km2: Math.round(polygonAreaKm2(parseBoundary(pricing.zone.boundary)) * 100) / 100,
      extentKm: pricing.zoneExtentKm,
      extent_km: pricing.zoneExtentKm,
      codEnabled: Boolean(Number(pricing.zone.cod_enabled)),
      cod_enabled: Boolean(Number(pricing.zone.cod_enabled)),
      nightCharge: Number(pricing.zone.night_charge),
      night_charge: Number(pricing.zone.night_charge),
    } : null,
    delivery_zone: pricing.zone ? {
      id: pricing.zone.id,
      name: pricing.zone.name || null,
      boundary: parseBoundary(pricing.zone.boundary),
      parentZoneId: pricing.zone.parent_zone_id != null ? pricing.zone.parent_zone_id : null,
      parent_zone_id: pricing.zone.parent_zone_id != null ? pricing.zone.parent_zone_id : null,
      areaKm2: Math.round(polygonAreaKm2(parseBoundary(pricing.zone.boundary)) * 100) / 100,
      area_km2: Math.round(polygonAreaKm2(parseBoundary(pricing.zone.boundary)) * 100) / 100,
      extentKm: pricing.zoneExtentKm,
      extent_km: pricing.zoneExtentKm,
      codEnabled: Boolean(Number(pricing.zone.cod_enabled)),
      cod_enabled: Boolean(Number(pricing.zone.cod_enabled)),
      nightCharge: Number(pricing.zone.night_charge),
      night_charge: Number(pricing.zone.night_charge),
    } : null,

    // Fast delivery
    deliveryType: isFast ? 'fast' : 'standard',
    fastDeliveryEnabled,
    fastDeliveryAvailable,
    fastDeliveryCharge,
    standardDeliveryCharge,
    standardDeliveryMinutes,
    fastDeliveryMinutes,

    // Coupon / offer
    appliedCoupon,
    couponError,
    availableCoupons,
    // Bill-summary display: whether delivery should render as "FREE"
    // (whole discount when discount_type is free_delivery, or the delivery
    // slice of a combined flat/percent + also_free_delivery coupon), and the
    // remaining item-level discount to show on the Discount line.
    isFreeDeliveryApplied,
    itemDiscount: appliedCoupon ? appliedCoupon.itemDiscount : discount,
  };

  res.status(200).json({
    ...calculation,
    data: calculation
  });
};

const validateCouponHandler = async (req, res) => {
  const { code, subtotal, delivery_charge, deliveryCharge, standard_delivery_charge, standardDeliveryCharge, items } = req.body;
  const userId = req.user?.id || null;

  if (!code || typeof code !== 'string') {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Coupon code is required' });
  }

  // The zone is resolved HERE from the customer's coordinates, never taken
  // from the request body: a client-supplied delivery_zone_id would let
  // anyone unlock a zone-restricted coupon (and enumerate which zones each
  // coupon covers) by guessing ids. Same derivation order-creation uses.
  const { latitude, longitude, lat, lng } = req.body;
  const customerLat = latitude !== undefined ? latitude : lat;
  const customerLng = longitude !== undefined ? longitude : lng;
  const hasCoords = customerLat !== undefined && customerLat !== null && customerLat !== ''
    && customerLng !== undefined && customerLng !== null && customerLng !== '';
  if (hasCoords && !validateCoordinates(customerLat, customerLng)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid GPS coordinates provided' });
  }

  let zoneId = null;
  if (hasCoords) {
    const [settingRows] = await pool.query(
      'SELECT delivery_charge, night_charge, night_charge_start, night_charge_end, fast_delivery_enabled, fast_delivery_charge, standard_delivery_minutes, fast_delivery_minutes, shop_latitude, shop_longitude, radius_pricing_active FROM settings WHERE area_id = 1 LIMIT 1' // stopgap area 1 (TASK 13 threads the resolved area through cart/order pricing)
    );
    const zoneSettings = settingRows[0] || {};
    if (zoneSettings.radius_pricing_active) {
      const pricing = resolveDeliveryPricing({
        customerLat,
        customerLng,
        deliveryType: 'standard',
        settings: zoneSettings,
        zones: await loadActiveZones(pool),
      });
      zoneId = pricing.zone ? pricing.zone.id : null;
    }
  }

  // Determine store type from items (same logic as calculateCart).
  let cartStoreType = null;
  try {
    const normalizedItems = (items || []).map(item => ({
      productId: Number(item.product_id || item.productId),
      isCombo: item.type === 'combo' || item.isCombo || item.is_combo,
    })).filter(i => i.productId);

    const productIdsForStoreType = normalizedItems.filter(i => !i.isCombo).map(i => i.productId);
    const comboIdsForStoreType = normalizedItems.filter(i => i.isCombo).map(i => i.productId);
    const storeTypes = new Set();

    if (productIdsForStoreType.length > 0) {
      const [rows] = await pool.query(
        `SELECT DISTINCT c.type FROM products p
         LEFT JOIN categories c ON p.category_id = c.id
         WHERE p.id IN (?)`,
        [productIdsForStoreType]
      );
      rows.forEach(r => { if (r.type) storeTypes.add(r.type); });
    }
    if (comboIdsForStoreType.length > 0) {
      const [rows] = await pool.query(
        'SELECT DISTINCT store_type FROM combos WHERE id IN (?)',
        [comboIdsForStoreType]
      );
      rows.forEach(r => { if (r.store_type) storeTypes.add(r.store_type); });
    }

    if (storeTypes.size === 1) {
      cartStoreType = [...storeTypes][0];
    } else if (storeTypes.size > 1) {
      cartStoreType = 'mixed';
    }
  } catch (_) {
    // Non-fatal.
  }

  const stdCharge = standard_delivery_charge !== undefined || standardDeliveryCharge !== undefined
    ? Number(standard_delivery_charge !== undefined ? standard_delivery_charge : standardDeliveryCharge) || 0
    : null;
  const result = await validateCoupon({
    code,
    subtotal: Number(subtotal) || 0,
    deliveryCharge: Number(delivery_charge || deliveryCharge) || 0,
    standardDeliveryCharge: stdCharge,
    storeType: cartStoreType,
    userId,
    zoneId,
  });

  if (result.ok) {
    return res.status(200).json({
      ok: true,
      coupon: {
        id: result.coupon.id,
        code: result.coupon.code,
        title: result.coupon.title,
        discountType: result.coupon.discount_type,
        alsoFreeDelivery: Boolean(result.coupon.also_free_delivery),
        discount: roundMoney(result.discount),
        itemDiscount: roundMoney(result.itemDiscount),
        freeDeliveryWaiver: roundMoney(result.freeDeliveryWaiver),
      },
      discount: roundMoney(result.discount),
    });
  }

  return res.status(200).json({ ok: false, reason: result.reason });
};

const getAvailableCoupons = async (req, res) => {
  const { subtotal, delivery_charge, deliveryCharge, standard_delivery_charge, standardDeliveryCharge, store_type, storeType } = req.query;
  const userId = req.user?.id || null;

  // The zone is resolved HERE from the customer's coordinates, never taken
  // from the request — same reasoning as validateCouponHandler above: a
  // client-supplied delivery_zone_id would let anyone list zone-restricted
  // coupons/offers for a zone they aren't actually in (and enumerate which
  // zones each coupon covers) just by guessing ids.
  const { latitude, longitude, lat, lng } = req.query;
  const customerLat = latitude !== undefined ? latitude : lat;
  const customerLng = longitude !== undefined ? longitude : lng;
  const hasCoords = customerLat !== undefined && customerLat !== null && customerLat !== ''
    && customerLng !== undefined && customerLng !== null && customerLng !== '';
  if (hasCoords && !validateCoordinates(customerLat, customerLng)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid GPS coordinates provided' });
  }

  let zoneId = null;
  if (hasCoords) {
    const [settingRows] = await pool.query(
      'SELECT delivery_charge, night_charge, night_charge_start, night_charge_end, fast_delivery_enabled, fast_delivery_charge, standard_delivery_minutes, fast_delivery_minutes, shop_latitude, shop_longitude, radius_pricing_active FROM settings WHERE area_id = 1 LIMIT 1' // stopgap area 1 (TASK 13 threads the resolved area through cart/order pricing)
    );
    const zoneSettings = settingRows[0] || {};
    if (zoneSettings.radius_pricing_active) {
      const pricing = resolveDeliveryPricing({
        customerLat,
        customerLng,
        deliveryType: 'standard',
        settings: zoneSettings,
        zones: await loadActiveZones(pool),
      });
      zoneId = pricing.zone ? pricing.zone.id : null;
    }
  }

  let cartStoreType = store_type || storeType || null;
  if (cartStoreType && cartStoreType !== 'mixed') {
    try {
      const { normalizeStoreType } = require('../utils/storeMode');
      cartStoreType = await normalizeStoreType(cartStoreType, { allowAll: true });
    } catch (_) {
      // Keep as-is if normalization fails.
    }
  }

  const coupons = await findApplicableCoupons({
    subtotal: Number(subtotal) || 0,
    deliveryCharge: Number(delivery_charge || deliveryCharge) || 0,
    standardDeliveryCharge: standard_delivery_charge !== undefined || standardDeliveryCharge !== undefined
      ? Number(standard_delivery_charge !== undefined ? standard_delivery_charge : standardDeliveryCharge) || 0
      : null,
    storeType: cartStoreType,
    userId,
    zoneId,
  });

  res.status(200).json({ data: coupons });
};

module.exports = {
  calculateCart,
  validateCouponHandler,
  getAvailableCoupons,
};
