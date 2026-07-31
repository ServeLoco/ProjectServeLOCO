import { getApiBaseUrl } from '../api/config';

const LOCAL_IMAGE_HOSTS = new Set(['10.0.2.2', 'localhost', '127.0.0.1']);

function pickFirst(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

/**
 * Stringifies a value into an id, returning null when there is no real value.
 * Avoids the previous "undefined"/"null" stringification bug where missing ids
 * silently collided with each other in equality checks.
 */
function toIdString(value) {
  if (value === undefined || value === null || value === '') return null;
  const str = String(value);
  if (str === 'undefined' || str === 'null') return null;
  return str;
}

function getApiOrigin() {
  try {
    return new URL(getApiBaseUrl()).origin;
  } catch {
    return '';
  }
}

function normalizeImageUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmedUrl = url.trim();
  if (!trimmedUrl) return null;

  if (trimmedUrl.startsWith('/')) {
    const origin = getApiOrigin();
    const encodedPath = encodeURI(trimmedUrl);
    return origin ? `${origin}${encodedPath}` : encodedPath;
  }

  try {
    const parsed = new URL(trimmedUrl);
    if (LOCAL_IMAGE_HOSTS.has(parsed.hostname)) {
      const origin = getApiOrigin();
      const encodedPath = encodeURI(`${parsed.pathname}${parsed.search}`);
      return origin ? `${origin}${encodedPath}` : encodeURI(trimmedUrl);
    }
    return encodeURI(trimmedUrl);
  } catch {
    return encodeURI(trimmedUrl);
  }
}

function imageRecordToUrl(image) {
  if (!image || typeof image !== 'object') return null;
  const directUrl = normalizeImageUrl(pickFirst(image.url, image.imageUrl, image.image_url));
  if (directUrl) return directUrl;

  const filename = pickFirst(image.filename, image.file_name);
  if (!filename) return null;

  const origin = getApiOrigin();
  if (!origin) return null;
  return `${origin}/uploads/${encodeURIComponent(filename)}`;
}

function asArray(payload, keys = []) {
  if (Array.isArray(payload)) return payload;

  const candidates = [
    payload?.data,
    payload?.items,
    payload?.results,
    ...keys.map(key => payload?.[key]),
    ...keys.map(key => payload?.data?.[key]),
  ];

  return candidates.find(Array.isArray) || [];
}

function asBoolean(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', '1', 'available', 'active', 'open'].includes(normalized)) return true;
    if (['false', 'no', '0', 'unavailable', 'inactive', 'closed'].includes(normalized)) return false;
  }
  return fallback;
}

function numberOrZero(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function getCancelledPaymentStatus(paymentMethod) {
  return paymentMethod === 'UPI' ? 'Refunded' : 'Failed';
}

function getDiscountLabel(item) {
  return pickFirst(
    item.discountLabel,
    item.discount_label,
    item.offerLabel,
    item.offer_label,
    item.discountPercent ? `${item.discountPercent}% OFF` : null,
    item.discount_percentage ? `${item.discount_percentage}% OFF` : null,
    item.discount ? `Rs. ${item.discount} OFF` : null,
  );
}

function getComboItems(item = {}) {
  const rawItems = asArray(
    item.comboItems ||
    item.combo_items ||
    item.includedItems ||
    item.included_items ||
    item.bundleItems ||
    item.bundle_items,
    ['comboItems', 'combo_items', 'items', 'products']
  );

  return rawItems.map((comboItem, index) => {
    const source = comboItem.product || comboItem.item || comboItem;
    return {
      ...normalizeProduct(source),
      quantity: Math.max(1, numberOrZero(pickFirst(comboItem.quantity, comboItem.qty, 1)) || 1),
      displayOrder: numberOrZero(pickFirst(comboItem.displayOrder, comboItem.display_order, index)),
    };
  });
}

function normalizeVariant(v = {}) {
  return {
    id: toIdString(pickFirst(v.id, v.variantId, v.variant_id)),
    label: pickFirst(v.label, ''),
    price: numberOrZero(pickFirst(v.price)),
    originalPrice: pickFirst(v.originalPrice, v.original_price, null),
    available: asBoolean(pickFirst(v.available), true),
    isDefault: asBoolean(pickFirst(v.isDefault, v.is_default), false),
    displayOrder: numberOrZero(pickFirst(v.displayOrder, v.display_order, 0)),
  };
}

function normalizeProduct(item = {}) {
  const id = toIdString(pickFirst(item.id, item._id, item.productId, item.product_id, item.slug));
  const isCombo = asBoolean(pickFirst(item.isCombo, item.is_combo), false);
  const comboItems = getComboItems(item);
  const imageUrl = normalizeImageUrl(pickFirst(item.imageUrl, item.image_url, item.image, item.url, null));
  // Thumbnail for list cards (null when legacy image has no thumb yet).
  const thumbUrl = normalizeImageUrl(pickFirst(item.thumbUrl, item.thumb_url, null));
  const variants = asArray(item.variants, ['variants'])
    .map(normalizeVariant)
    .sort((a, b) => a.displayOrder - b.displayOrder);
  const hasVariants = asBoolean(pickFirst(item.hasVariants, item.has_variants), variants.length > 0);
  const basePrice = numberOrZero(pickFirst(item.price, item.salePrice, item.sale_price, item.unitPrice));
  const minPrice = numberOrZero(pickFirst(item.minPrice, item.min_price, basePrice));

  return {
    ...item,
    id,
    name: pickFirst(item.name, item.productName, item.product_name, 'Product'),
    price: basePrice,
    originalPrice: pickFirst(item.originalPrice, item.original_price, item.mrp, null),
    discountLabel: getDiscountLabel(item),
    unit: pickFirst(item.unit, item.size, item.unitSize, item.unit_size, ''),
    category: pickFirst(item.category, item.categoryName, item.category_name, ''),
    categoryId: pickFirst(item.categoryId, item.category_id, null),
    available: asBoolean(pickFirst(item.available, item.isAvailable, item.is_available, item.inStock), true),
    imageUrl,
    imageUri: imageUrl,
    thumbUrl,
    thumb_url: thumbUrl,
    description: pickFirst(item.description, item.shortDescription, item.short_description, ''),
    isCombo,
    is_combo: isCombo,
    comboItems,
    combo_items: comboItems,
    variants,
    hasVariants,
    has_variants: hasVariants,
    minPrice,
    min_price: minPrice,
    variantPrompt: pickFirst(item.variantPrompt, item.variant_prompt, null),
    shopId: pickFirst(item.shopId, item.shop_id, null),
    shopIsOpen: asBoolean(pickFirst(item.shopIsOpen, item.shop_is_open), true),
    shop_is_open: asBoolean(pickFirst(item.shopIsOpen, item.shop_is_open), true),
    inTimeWindow: item.in_time_window !== undefined ? Boolean(item.in_time_window) : true,
    availableFromTime: item.available_from_time || null,
    availableUntilTime: item.available_until_time || null,
    relatedProducts: asArray(item.relatedProducts || item.related_products || item.related, ['products']).map(normalizeProduct),
  };
}

function normalizeCategory(item = {}) {
  const id = toIdString(pickFirst(item.id, item._id, item.categoryId, item.category_id, item.name));
  const imageUrl = normalizeImageUrl(pickFirst(item.imageUrl, item.image_url, item.image, null));
  const thumbUrl = normalizeImageUrl(pickFirst(item.thumbUrl, item.thumb_url, null));

  return {
    ...item,
    id,
    name: pickFirst(item.name, item.categoryName, item.category_name, 'Category'),
    count: pickFirst(item.count, item.productCount, item.product_count, item.productsCount, 0),
    productCount: pickFirst(item.count, item.productCount, item.product_count, item.productsCount, 0),
    imageUrl,
    imageUri: imageUrl,
    thumbUrl,
    thumb_url: thumbUrl,
    type: pickFirst(item.type, item.storeType, item.store_type, ''),
    displayOrder: numberOrZero(pickFirst(item.displayOrder, item.display_order, item.order, 0)),
    subcategories: asArray(item.subcategories || item.children || item.chips, ['subcategories']),
  };
}

function normalizeSettings(payload = {}) {
  const settings = payload?.settings || payload?.data || payload;
  const activeOffer = settings?.activeOffer || settings?.active_offer || settings?.offer || null;

  return {
    shopStatus: asBoolean(pickFirst(settings.shopOpen, settings.shop_open, settings.isShopOpen), true) ? 'open' : 'closed',
    deliveryAvailable: asBoolean(pickFirst(settings.deliveryAvailable, settings.delivery_available), true),
    supportPhone: pickFirst(settings.supportPhone, settings.support_phone, settings.whatsapp_number, null),
    upiId: pickFirst(settings.upiId, settings.upi_id, null),
    upiQrImageId: toIdString(pickFirst(settings.upiQrImageId, settings.upi_qr_image_id, null)),
    upiQrImageUrl: normalizeImageUrl(pickFirst(settings.upiQrImageUrl, settings.upi_qr_image_url, settings.upiQrUrl, settings.upi_qr_url, null)),
    activeOffer,
    nightCharge: numberOrZero(pickFirst(settings.nightCharge, settings.night_charge)),
    nightChargeStart: pickFirst(settings.nightChargeStart, settings.night_charge_start, null),
    nightChargeEnd: pickFirst(settings.nightChargeEnd, settings.night_charge_end, null),
    shopLatitude: (() => {
      const v = pickFirst(settings.shopLatitude, settings.shop_latitude, null);
      const n = Number(v);
      return v == null || v === '' || !Number.isFinite(n) ? null : n;
    })(),
    shopLongitude: (() => {
      const v = pickFirst(settings.shopLongitude, settings.shop_longitude, null);
      const n = Number(v);
      return v == null || v === '' || !Number.isFinite(n) ? null : n;
    })(),
  };
}

function normalizeCartCalculation(payload = {}) {
  const bill = payload?.bill || payload?.totals || payload?.data || payload;

  return {
    subtotal: numberOrZero(pickFirst(bill.subtotal, bill.itemTotal, bill.item_total)),
    deliveryCharge: numberOrZero(pickFirst(bill.deliveryCharge, bill.delivery_charge)),
    nightCharge: numberOrZero(pickFirst(bill.nightCharge, bill.night_charge)),
    rainCharge: numberOrZero(pickFirst(bill.rainCharge, bill.rain_charge)),
    fastDeliveryFee: numberOrZero(pickFirst(bill.fastDeliveryFee, bill.fast_delivery_fee)),
    discount: numberOrZero(pickFirst(bill.discount, bill.discountAmount, bill.discount_amount)),
    itemDiscount: numberOrZero(pickFirst(bill.itemDiscount, bill.item_discount)),
    isFreeDeliveryApplied: asBoolean(pickFirst(bill.isFreeDeliveryApplied, bill.is_free_delivery_applied), false),
    grandTotal: numberOrZero(pickFirst(bill.grandTotal, bill.grand_total, bill.total, bill.payableAmount)),
    paymentStatus: pickFirst(bill.paymentStatus, bill.payment_status, 'Pending'),
    deliveryDistanceKm: pickFirst(bill.deliveryDistanceKm, bill.delivery_distance_km, null),
    deliveryRadiusKm: pickFirst(bill.deliveryRadiusKm, bill.delivery_radius_km, null),
    deliveryWithinRange: asBoolean(pickFirst(bill.deliveryWithinRange, bill.delivery_within_range), true),
    requiresLocation: asBoolean(pickFirst(bill.requiresLocation, bill.requires_location), false),
    // Radius-zone pricing: pin beyond the largest zone (order blocked) and
    // per-zone Cash-on-Delivery policy. Defaults keep old servers harmless.
    outOfRange: asBoolean(pickFirst(bill.outOfRange, bill.out_of_range), false),
    nearestZoneName: pickFirst(bill.nearestZoneName, bill.nearest_zone_name, null),
    // Separate from outOfRange: the pin sits inside a no-delivery exclusion
    // square (e.g. a restricted compound) that the server blocks outright.
    // The server reports outOfRange: false for these, so anything that only
    // checks outOfRange would wrongly show delivery as available and let the
    // customer reach Place Order before failing.
    excluded: asBoolean(pickFirst(bill.excluded, bill.is_excluded), false),
    exclusionMessage: pickFirst(bill.exclusionMessage, bill.exclusion_message, null),
    codAllowed: asBoolean(pickFirst(bill.codAllowed, bill.cod_allowed), true),
    radiusPricingApplied: asBoolean(pickFirst(bill.radiusPricingApplied, bill.radius_pricing_applied), false),
    maxDeliveryRadiusKm: pickFirst(bill.maxDeliveryRadiusKm, bill.max_delivery_radius_km, null),
    // Free-delivery progress toward the nearest eligible free_delivery coupon
    // threshold, e.g. { minOrder: 149, amountRemaining: 30 }. Null when a
    // free_delivery coupon is already applied (see appliedCoupon) or none exists.
    freeDeliveryProgress: (() => {
      const progress = pickFirst(bill.freeDeliveryProgress, bill.free_delivery_progress, null);
      if (!progress) return null;
      return {
        minOrder: numberOrZero(pickFirst(progress.minOrder, progress.min_order)),
        amountRemaining: numberOrZero(pickFirst(progress.amountRemaining, progress.amount_remaining)),
        minItemCount: numberOrZero(pickFirst(progress.minItemCount, progress.min_item_count)),
        itemsRemaining: numberOrZero(pickFirst(progress.itemsRemaining, progress.items_remaining)),
        thresholdType: pickFirst(progress.thresholdType, progress.threshold_type, 'amount'),
      };
    })(),
    deliveryMessage: pickFirst(bill.deliveryMessage, bill.delivery_message, bill.message, ''),
    deliveryType: pickFirst(bill.deliveryType, bill.delivery_type, 'standard'),
    fastDeliveryEnabled: asBoolean(pickFirst(bill.fastDeliveryEnabled, bill.fast_delivery_enabled), false),
    fastDeliveryAvailable: asBoolean(pickFirst(bill.fastDeliveryAvailable, bill.fast_delivery_available), false),
    fastDeliveryCharge: numberOrZero(pickFirst(bill.fastDeliveryCharge, bill.fast_delivery_charge)),
    fastDeliveryMinutes: numberOrZero(pickFirst(bill.fastDeliveryMinutes, bill.fast_delivery_minutes)),
    standardDeliveryCharge: numberOrZero(pickFirst(bill.standardDeliveryCharge, bill.standard_delivery_charge, bill.deliveryCharge, bill.delivery_charge)),
    standardDeliveryMinutes: numberOrZero(pickFirst(bill.standardDeliveryMinutes, bill.standard_delivery_minutes)),
    // Server-priced line items from /cart/calculate. Cart UI snapshots product
    // prices at add-to-cart time; these unitPrices are the live admin prices
    // and must be written back into the cart store so list + sticky mini-cart
    // stay in sync with Item Total on the bill.
    items: asArray(bill.items, []).map((item) => ({
      id: toIdString(pickFirst(item.id, item.productId, item.product_id)),
      name: pickFirst(item.name, item.productName, item.product_name, ''),
      quantity: numberOrZero(pickFirst(item.quantity, item.qty, 0)),
      unitPrice: numberOrZero(pickFirst(item.unitPrice, item.unit_price, item.price)),
      lineTotal: numberOrZero(pickFirst(item.lineTotal, item.line_total)),
      type: pickFirst(item.type, item.isCombo || item.is_combo ? 'combo' : 'product'),
      variantId: (() => {
        const raw = pickFirst(item.variantId, item.variant_id, null);
        return raw == null || raw === '' ? null : raw;
      })(),
      variantLabel: pickFirst(item.variantLabel, item.variant_label) ?? null,
    })),
    // Soft-dropped OOS / deleted / closed-shop lines — client removes matching
    // cart rows so the cart never shows "something went wrong" for dead items.
    unavailableItems: asArray(
      pickFirst(bill.unavailableItems, bill.unavailable_items, []),
      [],
    ).map((item) => ({
      productId: toIdString(pickFirst(item.productId, item.product_id, item.id)),
      variantId: (() => {
        const raw = pickFirst(item.variantId, item.variant_id, null);
        return raw == null || raw === '' ? null : raw;
      })(),
      type: pickFirst(item.type, item.isCombo || item.is_combo ? 'combo' : 'product'),
      quantity: numberOrZero(pickFirst(item.quantity, item.qty, 0)),
      reason: pickFirst(item.reason, 'unavailable'),
    })),
    appliedCoupon: (() => {
      const coupon = bill.appliedCoupon || bill.applied_coupon || null;
      if (!coupon) return null;
      return {
        ...coupon,
        id: coupon.id,
        code: pickFirst(coupon.code, null),
        title: pickFirst(coupon.title, ''),
        discountType: pickFirst(coupon.discountType, coupon.discount_type, null),
        alsoFreeDelivery: asBoolean(pickFirst(coupon.alsoFreeDelivery, coupon.also_free_delivery), false),
        discount: numberOrZero(pickFirst(coupon.discount, 0)),
        itemDiscount: numberOrZero(pickFirst(coupon.itemDiscount, coupon.item_discount, 0)),
        freeDeliveryWaiver: numberOrZero(pickFirst(coupon.freeDeliveryWaiver, coupon.free_delivery_waiver, 0)),
        // Critical for auto-apply ladder: if this flag is lost, the client
        // re-sends coupon_code/id and locks free_delivery forever.
        autoApplied: asBoolean(pickFirst(coupon.autoApplied, coupon.auto_applied), false),
      };
    })(),
    couponError: pickFirst(bill.couponError, bill.coupon_error, null),
    availableCoupons: asArray(bill.availableCoupons || bill.available_coupons, []),
    // Nearest not-yet-unlocked coupon (any type except free_delivery, which
    // has its own freeDeliveryProgress hint above). Null when nothing
    // qualifies, a coupon is already applied, or the threshold is already met.
    nearestOfferProgress: (() => {
      const progress = pickFirst(bill.nearestOfferProgress, bill.nearest_offer_progress, null);
      if (!progress) return null;
      return {
        title: pickFirst(progress.title, ''),
        discountType: pickFirst(progress.discountType, progress.discount_type, null),
        minOrder: numberOrZero(pickFirst(progress.minOrder, progress.min_order)),
        amountRemaining: numberOrZero(pickFirst(progress.amountRemaining, progress.amount_remaining)),
        minItemCount: numberOrZero(pickFirst(progress.minItemCount, progress.min_item_count)),
        itemsRemaining: numberOrZero(pickFirst(progress.itemsRemaining, progress.items_remaining)),
        thresholdType: pickFirst(progress.thresholdType, progress.threshold_type, 'amount'),
        savingsText: pickFirst(progress.savingsText, progress.savings_text, ''),
        requiresCode: asBoolean(pickFirst(progress.requiresCode, progress.requires_code), false),
        autoApply: asBoolean(pickFirst(progress.autoApply, progress.auto_apply), false),
      };
    })(),
  };
}

function buildProgressHintText(progress, { suffix = '', includeWorth = false } = {}) {
  if (!progress) return '';
  const parts = [];
  if (progress.amountRemaining > 0) parts.push(`₹${progress.amountRemaining.toFixed(0)} more`);
  if (progress.itemsRemaining > 0) parts.push(`${progress.itemsRemaining} more item(s)`);
  if (parts.length === 0) return '';
  const joined = parts.join(' and ');
  if (includeWorth) {
    return `Add items worth ${joined}${suffix}`;
  }
  return `Add ${joined}${suffix}`;
}

function normalizeProfile(user = {}) {
  if (!user) return user;
  return {
    ...user,
    id: toIdString(pickFirst(user.id, user._id, user.userId, user.user_id)),
    name: pickFirst(user.name, user.fullName, user.full_name, 'User'),
    phone: pickFirst(user.phone, user.phoneNumber, user.phone_number, ''),
    whatsapp: pickFirst(user.whatsapp, user.whatsappNumber, user.whatsapp_number, ''),
    address: pickFirst(user.address, user.deliveryAddress, user.delivery_address, ''),
    email: pickFirst(user.email, user.emailAddress, user.email_address, ''),
    // Soft-delete state — non-null means the user scheduled deletion; the
    // grace period ends at deletionScheduledFor. Frontend shows a banner +
    // Cancel button.
    deletionRequestedAt: user.deletion_requested_at || user.deletionRequestedAt || null,
  };
}

function normalizeRider(rider) {
  if (!rider || typeof rider !== 'object') return null;
  const lastLat = pickFirst(rider.lastLat, rider.last_lat, null);
  const lastLng = pickFirst(rider.lastLng, rider.last_lng, null);
  const lastLocationAt = pickFirst(rider.lastLocationAt, rider.last_location_at, null);
  const latNum = lastLat == null || lastLat === '' ? null : Number(lastLat);
  const lngNum = lastLng == null || lastLng === '' ? null : Number(lastLng);
  return {
    id: rider.id,
    userId: pickFirst(rider.userId, rider.user_id, null),
    user_id: pickFirst(rider.userId, rider.user_id, null),
    displayName: pickFirst(rider.displayName, rider.display_name, null),
    display_name: pickFirst(rider.displayName, rider.display_name, null),
    isOnline: asBoolean(pickFirst(rider.isOnline, rider.is_online), false),
    is_online: asBoolean(pickFirst(rider.isOnline, rider.is_online), false),
    active: asBoolean(rider.active, true),
    phone: rider.phone || null,
    // Live tracking last-known position (TASK 4 / MAP tracking screen).
    lastLat: Number.isFinite(latNum) ? latNum : null,
    lastLng: Number.isFinite(lngNum) ? lngNum : null,
    lastLocationAt,
    last_lat: Number.isFinite(latNum) ? latNum : null,
    last_lng: Number.isFinite(lngNum) ? lngNum : null,
    last_location_at: lastLocationAt,
  };
}

function normalizeSession(payload = {}) {
  const data = payload?.data || payload;
  const user = data.user || data.customer || data.profile || data;

  return {
    token: pickFirst(data.token, data.jwt, data.accessToken, data.access_token),
    user: normalizeProfile(user),
    shop: data.shop ?? null,
    rider: normalizeRider(data.rider),
    admin: data.admin ?? null,
  };
}

function getCustomerName(order = {}) {
  return pickFirst(
    order.customerName,
    order.customer_name,
    order.customer?.name,
    order.user?.name,
    'Customer',
  );
}

function getOrderItems(order = {}) {
  return asArray(order.items || order.orderItems || order.order_items, ['items']).map(item => ({
    ...item,
    id: toIdString(pickFirst(item.id, item._id, item.productId, item.product_id, item.name)),
    name: pickFirst(item.name, item.productName, item.product_name, item.product?.name, 'Item'),
    quantity: numberOrZero(pickFirst(item.quantity, item.qty, 1)),
    price: numberOrZero(pickFirst(item.price, item.unitPrice, item.unit_price, item.line_total)),
    unit: pickFirst(item.unit, item.size, item.product?.unit, ''),
  }));
}

function normalizeOrder(order = {}) {
  const items = getOrderItems(order);
  const bill = order.bill || order.totals || {};
  const subtotal = numberOrZero(pickFirst(bill.subtotal, order.subtotal, order.itemTotal, order.item_total));
  const delivery = numberOrZero(pickFirst(bill.delivery, bill.deliveryCharge, bill.delivery_charge, order.deliveryCharge, order.delivery_charge));
  const nightCharge = numberOrZero(pickFirst(bill.nightCharge, bill.night_charge, order.nightCharge, order.night_charge));
  const rainCharge = numberOrZero(pickFirst(bill.rainCharge, bill.rain_charge, order.rainCharge, order.rain_charge));
  const fastDeliveryFee = numberOrZero(pickFirst(bill.fastDeliveryFee, bill.fast_delivery_fee, order.fastDeliveryFee, order.fast_delivery_charge));
  const discount = numberOrZero(pickFirst(bill.discount, bill.discountAmount, order.discount, order.discount_amount));
  const freeDeliveryWaiver = numberOrZero(pickFirst(
    bill.freeDeliveryWaiver, bill.free_delivery_waiver_amount,
    order.freeDeliveryWaiver, order.free_delivery_waiver_amount,
  ));
  const itemDiscount = numberOrZero(pickFirst(
    bill.itemDiscount, order.itemDiscount, Math.max(0, discount - freeDeliveryWaiver),
  ));
  const grandTotal = numberOrZero(pickFirst(
    bill.grandTotal,
    bill.grand_total,
    order.grandTotal,
    order.grand_total,
    order.total,
    order.totalAmount,
  ));
  const status = pickFirst(order.status, order.orderStatus, order.order_status, 'Pending');
  const paymentMethod = pickFirst(order.paymentMethod, order.payment_method, 'Cash');
  const paymentStatus = status === 'Cancelled'
    ? getCancelledPaymentStatus(paymentMethod)
    : pickFirst(order.paymentStatus, order.payment_status, 'Pending');

  const riderId = pickFirst(order.riderId, order.rider_id, order.rider?.id, null);
  const latitudeRaw = pickFirst(order.latitude, order.lat, null);
  const longitudeRaw = pickFirst(order.longitude, order.lng, null);
  const latitude = latitudeRaw == null || latitudeRaw === '' ? null : Number(latitudeRaw);
  const longitude = longitudeRaw == null || longitudeRaw === '' ? null : Number(longitudeRaw);

  return {
    ...order,
    id: toIdString(pickFirst(order.id, order._id, order.orderId, order.order_id)),
    date: pickFirst(order.date, order.createdAt, order.created_at, order.updatedAt, ''),
    status,
    paymentStatus,
    paymentMethod,
    itemCount: numberOrZero(pickFirst(order.itemCount, order.item_count, items.length)),
    total: grandTotal,
    canCancel: asBoolean(pickFirst(order.canCancel, order.can_cancel, order.cancellable), false),
    cancelReason: pickFirst(order.cancelReason, order.cancel_reason, null),
    cancel_reason: pickFirst(order.cancelReason, order.cancel_reason, null),
    previewImg: pickFirst(order.previewImg, order.previewImage, order.imageUrl, items[0]?.imageUrl, null),
    address: pickFirst(order.address, order.deliveryAddress, order.delivery_address, ''),
    mapUrl: pickFirst(order.mapUrl, order.map_url, order.googleMapsUrl, order.google_maps_url, ''),
    // Delivery pin for tracking / maps
    latitude: Number.isFinite(latitude) ? latitude : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    riderId: riderId != null ? riderId : null,
    rider_id: riderId != null ? riderId : null,
    rider: order.rider ? normalizeRider(order.rider) : null,
    // Shop pins for Track Order map (API only after status leaves Pending).
    shops: Array.isArray(order.shops) ? order.shops : [],
    deliveryDistanceKm: pickFirst(order.deliveryDistanceKm, order.delivery_distance_km, null),
    deliveryRadiusKmSnapshot: pickFirst(order.deliveryRadiusKmSnapshot, order.delivery_radius_km_snapshot, null),
    deliveryCostPerKmSnapshot: pickFirst(order.deliveryCostPerKmSnapshot, order.delivery_cost_per_km_snapshot, null),
    freeDeliveryOfferSnapshot: asBoolean(pickFirst(order.freeDeliveryOfferSnapshot, order.free_delivery_offer_snapshot), false),
    belowThresholdDelivery: asBoolean(pickFirst(order.belowThresholdDelivery, order.below_threshold_delivery), false),
    belowThresholdDeliveryCharge: numberOrZero(pickFirst(order.belowThresholdDeliveryCharge, order.below_threshold_delivery_charge)),
    deliveryMessage: pickFirst(order.deliveryMessage, order.delivery_message, ''),
    customer: {
      name: getCustomerName(order),
      phone: pickFirst(order.phone, order.customerPhone, order.customer_phone, order.customer?.phone, ''),
      whatsapp: pickFirst(order.whatsapp, order.whatsappNumber, order.customer?.whatsapp, order.customer?.whatsappNumber, ''),
      address: pickFirst(order.address, order.deliveryAddress, order.delivery_address, order.customer?.address, ''),
    },
    items,
    bill: {
      subtotal,
      delivery,
      nightCharge,
      rainCharge,
      fastDeliveryFee,
      discount,
      freeDeliveryWaiver,
      itemDiscount,
      freeDeliveryApplied: freeDeliveryWaiver > 0,
      grandTotal,
      deliveryType: pickFirst(order.deliveryType, order.delivery_type, 'standard'),
      belowThresholdDelivery: asBoolean(pickFirst(order.belowThresholdDelivery, order.below_threshold_delivery), false),
      belowThresholdDeliveryCharge: numberOrZero(pickFirst(order.belowThresholdDeliveryCharge, order.below_threshold_delivery_charge)),
    },
  };
}

function normalizeDashboard(payload = {}) {
  const data = payload?.data || payload?.dashboard || payload;
  const metrics = data.metrics || {};
  const reports = data.reports || data.salesReport || {};

  return {
    isShopOpen: asBoolean(pickFirst(data.isShopOpen, data.shopOpen, data.shop_open), true),
    metrics: {
      todayOrders: numberOrZero(pickFirst(metrics.todayOrders, metrics.today_orders, data.todayOrders)),
      todaySales: numberOrZero(pickFirst(metrics.todaySales, metrics.today_sales, data.todaySales)),
      pendingOrders: numberOrZero(pickFirst(metrics.pendingOrders, metrics.pending_orders, data.pendingOrders)),
      deliveredOrders: numberOrZero(pickFirst(metrics.deliveredOrders, metrics.delivered_orders, data.deliveredOrders)),
      cashTotal: numberOrZero(pickFirst(metrics.cashTotal, metrics.cash_total, data.cashTotal)),
      upiTotal: numberOrZero(pickFirst(metrics.upiTotal, metrics.upi_total, data.upiTotal)),
      pendingPaymentTotal: numberOrZero(pickFirst(metrics.pendingPaymentTotal, metrics.pending_payment_total, data.pendingPaymentTotal)),
    },
    reports: {
      weekSales: numberOrZero(pickFirst(reports.weekSales, reports.week_sales, data.weekSales)),
      monthSales: numberOrZero(pickFirst(reports.monthSales, reports.month_sales, data.monthSales)),
    },
    latestOrders: asArray(data.latestOrders || data.latest_orders, ['latestOrders', 'orders']).map(normalizeOrder),
    productAlerts: {
      outOfStock: numberOrZero(pickFirst(data.productAlerts?.outOfStock, data.product_alerts?.out_of_stock, data.outOfStock)),
      lowStock: numberOrZero(pickFirst(data.productAlerts?.lowStock, data.product_alerts?.low_stock, data.lowStock)),
    },
    topProducts: asArray(data.topProducts || data.top_products, ['topProducts']).map(product => ({
      ...product,
      id: toIdString(pickFirst(product.id, product._id, product.productId, product.name)),
      name: pickFirst(product.name, product.productName, product.product_name, 'Product'),
      sales: numberOrZero(pickFirst(product.sales, product.salesCount, product.sales_count, product.quantity)),
      amount: numberOrZero(pickFirst(product.amount, product.salesAmount, product.sales_amount, product.total)),
    })),
  };
}

function normalizeNotification(item = {}) {
  const id = toIdString(pickFirst(item.id, item._id));
  const read = asBoolean(pickFirst(item.read, item.isRead, item.is_read), false);
  const createdAt = pickFirst(item.createdAt, item.created_at, item.timestamp);
  
  // Calculate simple timeLabel if missing
  let timeLabel = item.timeLabel || item.time_ago || item.timeAgo;
  if (!timeLabel && createdAt) {
    const diff = Math.max(0, new Date() - new Date(createdAt));
    const mins = Math.floor(diff / 60000);
    const hrs = Math.floor(mins / 60);
    const days = Math.floor(hrs / 24);
    
    if (days > 0) timeLabel = `${days}d ago`;
    else if (hrs > 0) timeLabel = `${hrs}h ago`;
    else if (mins > 0) timeLabel = `${mins}m ago`;
    else timeLabel = 'Just now';
  }

  return {
    ...item,
    id,
    title: pickFirst(item.title, item.heading, ''),
    body: pickFirst(item.body, item.message, item.text, ''),
    type: pickFirst(item.type, item.status, 'info'),
    sourceType: pickFirst(item.sourceType, item.source_type, null),
    sourceId: pickFirst(item.sourceId, item.source_id, null),
    actionType: pickFirst(item.actionType, item.action_type, null),
    actionPayload: pickFirst(item.actionPayload, item.action_payload, null),
    read,
    createdAt,
    timeLabel,
  };
}

export const mapNotification = normalizeNotification;


export {
  asArray,
  buildProgressHintText,
  normalizeCartCalculation,
  normalizeCategory,
  normalizeDashboard,
  normalizeImageUrl,
  imageRecordToUrl,
  normalizeOrder,
  normalizeProduct,
  normalizeProfile,
  normalizeSession,
  normalizeSettings,
  normalizeNotification,
  pickFirst,
};
