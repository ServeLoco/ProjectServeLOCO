import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Image as ExpoImage } from 'expo-image';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Animated,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  LayoutAnimation,
  Platform,
  UIManager,
  KeyboardAvoidingView,
  AppState,
  Dimensions,
  PanResponder,
  Easing,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Location from 'expo-location';
import { CommonActions, useFocusEffect, useNavigation } from '@react-navigation/native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  AppIcon,
  PressableScale,
  LoadingSkeleton,
  ConfirmModal,
  LocationPicker,
} from '../../../components';
import { colors, typography, spacing, radius, shadows, smallMs, easing } from '../../../theme';
import { useCartStore, useSettingsStore, useAuthStore, useDeliveryLocationStore, useDeliveryZonesStore } from '../../../stores';
import { cartApi, ordersApi, imagesApi, settingsApi, riderCapacityApi, subscribeRiderCapacityEvents } from '../../../api';
import { trackEvent } from '../../../api/analyticsClient';
import { asArray, buildProgressHintText, imageRecordToUrl, normalizeCartCalculation, normalizeOrder, normalizeSettings } from '../../../utils';
import { isCodBlockedDuringNight } from '../../../utils/nightDelivery';
import { formatEtaMinutes } from '../../../utils/formatEta';
import { uuidv4 } from '../../../utils/uuid';
import {
  requestPreciseLocationPermission,
  openAppLocationSettings,
} from '../../../hooks/usePreciseLocationPermissionOnStart';
import { mapboxAvailable } from '../../../utils/mapbox';

const isCodNightBlockError = (message = '') => {
  const lower = String(message).toLowerCase();
  return lower.includes('cash on delivery') && (lower.includes('night') || lower.includes('upi'));
};

// Radius-zone rejections from order creation. Prefer the machine code the API
// sends (ApiError.code); fall back to message matching for older servers.
const isOutOfRangeOrderError = (error) =>
  error?.code === 'OUT_OF_DELIVERY_RANGE'
  || String(error?.message || '').toLowerCase().includes('not available at this location');
const isCodZoneBlockError = (error) =>
  error?.code === 'COD_NOT_AVAILABLE'
  || (String(error?.message || '').toLowerCase().includes('cash on delivery')
    && String(error?.message || '').toLowerCase().includes('your location'));

// How often to re-ask whether this area's riders are still at capacity, while
// the checkout screen is focused and the app is foregrounded.
const CAPACITY_POLL_MS = 45000;

const GPS_ERROR_TIMEOUT = 'GPS_TIMEOUT';
const GPS_ERROR_DENIED = 'GPS_DENIED';
const GPS_ERROR_SETTINGS = 'GPS_SETTINGS';

const WIN_H = Dimensions.get('window').height;
// Default drawer height (collapsed). Raise this fraction to start the sheet higher.
// Pull up further to expand payment / summary.
const SHEET_COLLAPSED = Math.round(WIN_H * 0.45);
// Fallback expanded height before the root container reports its real
// measured height via onLayout (see expandedHeightRef below) — Dimensions
// 'window' height is only an estimate and can leave a gap or overshoot the
// status bar depending on device/edge-to-edge behavior.
const SHEET_EXPANDED_FALLBACK = WIN_H;

/** Rider-order-style gradient action button for the checkout sheet. */
function SheetActionBtn({ label, icon, onPress, busy, disabled, variant = 'saffron' }) {
  const grad = variant === 'success'
    ? [colors.btnSuccessStart, colors.btnSuccessEnd]
    : variant === 'ghost'
      ? null
      : [colors.btnHighlightStart, colors.btnHighlightEnd];

  if (variant === 'ghost') {
    return (
      <TouchableOpacity
        onPress={onPress}
        disabled={Boolean(busy) || disabled}
        activeOpacity={0.85}
        style={styles.sheetGhostBtn}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        {busy ? (
          <ActivityIndicator color={colors.textSecondary} />
        ) : (
          <>
            {icon ? <AppIcon name={icon} size={16} color={colors.textSecondary} /> : null}
            <Text style={styles.sheetGhostBtnText}>{label}</Text>
          </>
        )}
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={Boolean(busy) || disabled}
      activeOpacity={0.9}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <LinearGradient colors={grad} style={[styles.sheetPrimaryBtn, disabled && styles.sheetPrimaryBtnDisabled]}>
        {busy ? (
          <ActivityIndicator color={colors.textInverse} />
        ) : (
          <>
            {icon ? <AppIcon name={icon} size={18} color={colors.textInverse} /> : null}
            <Text style={styles.sheetPrimaryBtnText}>{label}</Text>
          </>
        )}
      </LinearGradient>
    </TouchableOpacity>
  );
}

const getGpsErrorCopy = (code) => {
  switch (code) {
    case GPS_ERROR_TIMEOUT:
      return {
        title: "Couldn't get your location",
        detail: 'GPS didn\'t respond in time. Drag the map to pin your address instead.',
      };
    case GPS_ERROR_SETTINGS:
      return {
        title: 'Location blocked',
        detail: 'Open Settings → Permissions → Location → Allow (Precise).',
      };
    case GPS_ERROR_DENIED:
      return {
        title: 'Location permission denied',
        detail: 'Allow location access to pin your delivery address.',
      };
    default:
      return {
        title: "Couldn't get your location",
        detail: typeof code === 'string' && code ? code : 'Something went wrong. Please try again.',
      };
  }
};

export default function CheckoutScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const items = useCartStore(state => state.items);
  const clearCart = useCartStore(state => state.clearCart);
  const appliedCouponCode = useCartStore(state => state.appliedCouponCode);
  const appliedCouponId = useCartStore(state => state.appliedCouponId);
  const appliedCoupon = useCartStore(state => state.appliedCoupon);
  const couponAutoApplyDisabled = useCartStore(state => state.couponAutoApplyDisabled);
  const setFreeDeliveryProgress = useCartStore(state => state.setFreeDeliveryProgress);
  const setFreeDeliveryUnlocked = useCartStore(state => state.setFreeDeliveryUnlocked);
  const syncItemPricesFromServer = useCartStore(state => state.syncItemPricesFromServer);
  const removeUnavailableItems = useCartStore(state => state.removeUnavailableItems);
  const shopStatus = useSettingsStore(state => state.shopStatus);
  // Bumped by useDeliveryZoneSync on a delivery_zones.updated push (admin
  // saved a zone) — included below purely to retrigger the bill recompute.
  const deliveryZonesVersion = useDeliveryZonesStore(state => state.version);
  const deliveryAvailable = useSettingsStore(state => state.deliveryAvailable);
  const upiQrImageId = useSettingsStore(state => state.upiQrImageId);
  const upiQrImageUrl = useSettingsStore(state => state.upiQrImageUrl);
  const nightChargeStart = useSettingsStore(state => state.nightChargeStart);
  const nightChargeEnd = useSettingsStore(state => state.nightChargeEnd);
  const nightCharge = useSettingsStore(state => state.nightCharge);
  const setSettings = useSettingsStore(state => state.setSettings);
  const userProfile = useAuthStore(state => state.profile);
  // This is populated by the app-start sync and updated when Home's Change
  // Location flow saves a manual pin. Used as map fallback center only —
  // the checkout map itself auto-locates to live GPS on open.
  const savedDeliveryLocation = useDeliveryLocationStore(state => state.coords);
  const savedDeliveryLocationSource = useDeliveryLocationStore(state => state.source);

  const [now, setNow] = React.useState(() => new Date());
  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 60 * 1000);
    return () => clearInterval(tick);
  }, []);

  const codBlockedByNight = isCodBlockedDuringNight({
    night_charge_start: nightChargeStart,
    night_charge_end: nightChargeEnd,
    night_charge: nightCharge,
  }, now);

  const codNightWindowLabel = nightChargeStart && nightChargeEnd
    ? `${nightChargeStart} to ${nightChargeEnd}`
    : 'night hours';
  const codNightModalMessage = `Cash on Delivery is not available during night delivery hours (${codNightWindowLabel}). Please select UPI payment to place your order.`;

  // Form State
  const [address, setAddress] = useState(userProfile?.address || '');
  const [coordinates, setCoordinates] = useState(null);
  const coordinatesRef = useRef(null);
  // Guards the empty-cart bounce-out below from firing more than once —
  // checkoutItems.length flips to 0 exactly once per empty-out, but the
  // effect it lives in re-runs on every calculationPayload change.
  const emptyCartHandledRef = useRef(false);
  // Last delivery area a successful calculate() resolved to. Products are
  // area-scoped (not zone-scoped) — moving the pin between zones inside the
  // SAME area must never drop cart items. It only should when the pin
  // actually crosses into a different area's catalog, which this ref lets
  // the effect below tell apart from an item simply going out of stock.
  const lastAreaIdRef = useRef(null);
  // Which of the two cases the most recent removeUnavailableItems() call was
  // — set right before that call, read once by the empty-cart bounce-out
  // below so its Alert says the right thing, then reset.
  const removalReasonRef = useRef('unavailable');
  // Live pin position before Confirm — lets the bill (and its delivery charge)
  // preview whichever zone the pin currently sits over as the user drags.
  const [previewCoordinates, setPreviewCoordinates] = useState(null);
  const handleLiveCenterChange = useCallback((lat, lng) => {
    setPreviewCoordinates({ lat, lng });
  }, []);
  // Tracks the manual saved-location the checkout-local pin was last synced
  // against. Initialized from the current value so mount never fires a reset.
  const lastManualLocationKeyRef = useRef(
    savedDeliveryLocationSource === 'manual' && savedDeliveryLocation
      ? `${savedDeliveryLocation.lat},${savedDeliveryLocation.lng}`
      : null,
  );
  // Once the user confirms a pin inside Checkout's own map, that local
  // `coordinates` wins over `savedDeliveryLocation` in calculationPayload
  // (see below) — otherwise dragging the map wouldn't preview live. But if
  // Home's "Change Location" flow saves a NEW manual pin while Checkout is
  // still mounted, that local override is now stale and would silently keep
  // pricing/coupons off the old spot. Drop it so the fresh saved location
  // (and a full bill/coupon recalculation) takes over immediately — the same
  // reset handlePinMoved does when the user drags the in-screen map.
  useEffect(() => {
    if (savedDeliveryLocationSource !== 'manual' || !savedDeliveryLocation) return;
    const nextKey = `${savedDeliveryLocation.lat},${savedDeliveryLocation.lng}`;
    if (nextKey === lastManualLocationKeyRef.current) return;
    lastManualLocationKeyRef.current = nextKey;
    coordinatesRef.current = null;
    setCoordinates(null);
    setPreviewCoordinates(null);
    // Drop the old bill immediately rather than leaving it on screen while the
    // recalculation round-trips — on a slow connection that request can take
    // seconds, and a stale total (priced for the old zone, discounting a
    // coupon that may no longer apply) sitting there with only the disabled
    // Place Order button as protection is easy to miss. isCalculating (set by
    // the fetch effect below once it actually fires) drives the loading UI;
    // clearing bill here means there's nothing stale to render meanwhile.
    setBill(null);
    setCalcError(null);
    setFreeDeliveryProgress(null);
    setFreeDeliveryUnlocked(false);
  }, [savedDeliveryLocation, savedDeliveryLocationSource, setFreeDeliveryProgress, setFreeDeliveryUnlocked]);
  // idle | loading | success (delivery pin confirmed) | error
  const [gpsStatus, setGpsStatus] = useState('idle');
  const [gpsError, setGpsError] = useState(null);
  // Ephemeral map popup: locating live GPS, live snap, or delivery confirmed.
  const [mapToast, setMapToast] = useState(null); // null | 'locating' | 'live' | 'pinned'
  const mapToastTimerRef = useRef(null);
  const reverseGeoTimerRef = useRef(null);
  // Manual address entry has been removed — GPS pin is now the only way to
  // set delivery location. Kept as a constant (rather than inlining `true`
  // everywhere) so mapMode below reads the same as before.
  const locationMode = 'gps';
  // Sheet scroll only — map is a sibling behind the sheet (no scroll conflict).
  const scrollRef = useRef(null);
  const locationPickerRef = useRef(null);
  // Draggable bottom sheet: collapsed = big map; expanded = full checkout form.
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const sheetExpandedRef = useRef(false);
  const sheetHeightAnim = useRef(new Animated.Value(SHEET_COLLAPSED)).current;
  const sheetHeightNum = useRef(SHEET_COLLAPSED);
  const sheetDragStart = useRef(SHEET_COLLAPSED);
  // Real measured height of the sheet's container — set via onLayout so the
  // fully-expanded sheet lands pixel-exact at the top, no map sliver and no
  // overshoot into the status bar.
  const expandedHeightRef = useRef(SHEET_EXPANDED_FALLBACK);
  // Collapsed (pre-address) sheet hugs its real content — drag handle/header
  // plus the Confirm/Enter-manually buttons — instead of a fixed screen
  // fraction, so there's no dead white space below the buttons.
  const collapsedHeaderHeightRef = useRef(0);
  const collapsedContentHeightRef = useRef(0);
  const scrollYRef = useRef(0);
  const [sheetReserve, setSheetReserve] = useState(SHEET_COLLAPSED);
  const [paymentMethod, setPaymentMethod] = useState(null); // UPI | Cash
  const [deliveryType, setDeliveryType] = useState(null); // standard | fast

  // Submission State
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  // Rider capacity — polled every 45s so the Place Order button opens back up
  // on its own once riders free up, instead of the user only finding out
  // after a rejected checkout attempt (RIDERS_AT_CAPACITY).
  const [atCapacity, setAtCapacity] = useState(false);
  // Area the last capacity read resolved to — the pushed verdict is matched
  // against it, since the socket room can still be a different area's.
  const capacityAreaIdRef = useRef(null);
  // null until the first poll answers — the wait is a server-side config
  // value, so guessing one here would show a number that may not be true.
  const [capacityCooldownMin, setCapacityCooldownMin] = useState(null);
  // Inline section error (payment) — not the bottom red banner. Delivery has
  // no equivalent: Fast is an optional add-on, nothing to validate there.
  const [paymentError, setPaymentError] = useState(null);
  const sectionOffsetsRef = useRef({ delivery: 0, payment: 0 });
  const [showCodNightModal, setShowCodNightModal] = useState(false);
  const showCodNightWarning = () => {
    setSubmitError(null);
    setShowCodNightModal(true);
  };
  const handleSwitchToUpi = () => {
    setPaymentMethod('UPI');
    setPaymentError(null);
    setShowCodNightModal(false);
    setSubmitError(null);
  };
  const [isCalculating, setIsCalculating] = useState(false);
  const [bill, setBill] = useState(null);
  // Radius-zone gating from the server-priced bill: pin beyond the largest
  // zone blocks the order; a COD-off zone forces UPI (mirrors the night rule).
  const outOfRange = Boolean(bill?.outOfRange);
  // A no-delivery exclusion square reports outOfRange: false but still blocks
  // the order outright, so gating on outOfRange alone left Place Order
  // enabled and the server rejected it with DELIVERY_EXCLUDED at submit.
  // deliveryBlocked is what every gate below uses; the two stay separate only
  // where the wording differs (an exclusion has its own admin-set message and
  // no "move the pin closer" advice to give).
  const excluded = Boolean(bill?.excluded);
  const exclusionMessage = bill?.exclusionMessage || null;
  const deliveryBlocked = outOfRange || excluded;
  const codBlockedByZone = bill?.codAllowed === false;
  const codUnavailable = codBlockedByNight || codBlockedByZone;
  const [calcError, setCalcError] = useState(null);
  const checkoutItems = useMemo(() => items.map(item => {
    const type = item.type || (item.product?.isCombo || item.product?.is_combo ? 'combo' : 'product');
    return {
      productId: item.product.id,
      variantId: item.variant?.id ?? null,
      quantity: item.quantity,
      type,
      isCombo: type === 'combo',
    };
  }), [items]);
  const calculationPayload = useMemo(() => ({
    items: checkoutItems,
    // Confirmed coords win once set; until then, preview the moved pin so the
    // delivery charge updates live. Before either, price the app's saved
    // delivery location from startup/Home rather than device GPS.
    latitude: coordinates?.lat ?? previewCoordinates?.lat ?? savedDeliveryLocation?.lat,
    longitude: coordinates?.lng ?? previewCoordinates?.lng ?? savedDeliveryLocation?.lng,
    delivery_type: deliveryType || 'standard',
    coupon_code: appliedCouponCode || undefined,
    coupon_id: !appliedCouponCode && appliedCouponId ? appliedCouponId : undefined,
    no_auto_apply: couponAutoApplyDisabled,
  }), [checkoutItems, coordinates, previewCoordinates, savedDeliveryLocation, deliveryType, appliedCouponCode, appliedCouponId, couponAutoApplyDisabled, deliveryZonesVersion]);

  // The pin this order will actually be PLACED with — the same chain
  // handlePlaceOrder commits (previewCoordinates deliberately excluded: it
  // tracks a finger mid-drag, and re-resolving the area on every frame of a
  // drag would thrash these fetches).
  //
  // Everything area-derived that isn't the bill must key off this, NOT off
  // savedDeliveryLocation. Confirming a pin in checkout updates `coordinates`
  // only — it never writes the delivery-location store — so anything still
  // reading savedDeliveryLocation stays pinned to wherever the user was
  // BEFORE they opened checkout. For settings that means showing the previous
  // area's UPI id and QR: the customer would pay area A's bank account for an
  // order priced, gated and delivered in area B (plans/multi-area.md §9.4
  // item 4 — money routing must always follow the resolved area).
  const effectivePinLat = coordinates?.lat ?? savedDeliveryLocation?.lat;
  const effectivePinLng = coordinates?.lng ?? savedDeliveryLocation?.lng;

  // Animations
  const deliverySlide = useRef(new Animated.Value(24)).current;
  const paymentSlide = useRef(new Animated.Value(24)).current;
  const summarySlide = useRef(new Animated.Value(24)).current;
  const deliveryOpacity = useRef(new Animated.Value(0)).current;
  const paymentOpacity = useRef(new Animated.Value(0)).current;
  const summaryOpacity = useRef(new Animated.Value(0)).current;
  const paymentShakeX = useRef(new Animated.Value(0)).current;
  const paymentErrorPulse = useRef(new Animated.Value(0)).current;
  const btnScale = useRef(new Animated.Value(1)).current;
  const arrowAnim = useRef(new Animated.Value(0)).current;
  const locationWarnPulse = useRef(new Animated.Value(0)).current;
  // Fast Delivery energetic pulse: a small glowing ⚡ bolt bounce.
  // Single native-driver value (opacity/transform only) — minimal by design.
  const fastEnergy = useRef(new Animated.Value(0)).current;
  const addressTouchedRef = useRef(false);

  const animateSectionChoice = useCallback(() => {
    // Paper (old arch) Android needs this flag once so LayoutAnimation runs.
    // Fabric / New Architecture implements the method as a no-op that WARN-logs
    // every call — skip it so delivery/payment taps stay quiet.
    const isNewArch = Boolean(
      global?.nativeFabricUIManager || global?.RN$Bridgeless === true,
    );
    if (
      Platform.OS === 'android'
      && !isNewArch
      && typeof UIManager?.setLayoutAnimationEnabledExperimental === 'function'
    ) {
      UIManager.setLayoutAnimationEnabledExperimental(true);
    }
    LayoutAnimation.configureNext(
      LayoutAnimation.create(smallMs, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.opacity),
    );
  }, []);

  const runSectionErrorAnim = useCallback((shakeX, pulse) => {
    shakeX.setValue(0);
    pulse.setValue(0);
    Animated.parallel([
      Animated.sequence([
        Animated.timing(shakeX, { toValue: 10, duration: 45, useNativeDriver: true }),
        Animated.timing(shakeX, { toValue: -10, duration: 45, useNativeDriver: true }),
        Animated.timing(shakeX, { toValue: 8, duration: 45, useNativeDriver: true }),
        Animated.timing(shakeX, { toValue: -8, duration: 45, useNativeDriver: true }),
        Animated.timing(shakeX, { toValue: 4, duration: 40, useNativeDriver: true }),
        Animated.timing(shakeX, { toValue: 0, duration: 40, useNativeDriver: true }),
      ]),
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 180, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.35, duration: 220, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 180, useNativeDriver: true }),
      ]),
    ]).start();
  }, []);

  const scrollToCheckoutSection = useCallback((key) => {
    const y = sectionOffsetsRef.current[key] ?? 0;
    setTimeout(() => {
      scrollRef.current?.scrollTo?.({ y: Math.max(0, y - 8), animated: true });
    }, 0);
  }, []);

  const pickDeliveryType = useCallback((type) => {
    animateSectionChoice();
    setDeliveryType(type);
  }, [animateSectionChoice]);

  const pickPaymentMethod = useCallback((method) => {
    animateSectionChoice();
    setPaymentMethod(method);
    setPaymentError(null);
    if (method === 'UPI') {
      // QR block only mounts now (conditional on paymentMethod) — give it a
      // beat to render + lay out before measuring/scrolling to it.
      setTimeout(() => scrollToCheckoutSection('upiQr'), 120);
    } else if (method === 'Cash') {
      // Order Summary is the last section — pinning its top edge to the
      // viewport top (like scrollToCheckoutSection does) leaves the section's
      // own short height as blank space below it, above the footer. Scroll
      // to the true end of content instead so the summary sits flush with
      // the bottom of the sheet, no dead space.
      setTimeout(() => {
        scrollRef.current?.scrollToEnd?.({ animated: true });
      }, 0);
    }
  }, [animateSectionChoice, scrollToCheckoutSection]);

  // Profile has no saved address — fall back to the address on the user's
  // most recent order so they don't have to retype it from scratch.
  useEffect(() => {
    if (userProfile?.address) return;

    ordersApi.getOrders({ limit: 1 })
      .then(response => {
        if (addressTouchedRef.current) return;
        const lastOrder = asArray(response, ['orders']).map(normalizeOrder)[0];
        if (lastOrder?.address) {
          setAddress(lastOrder.address);
        }
      })
      .catch(() => {});
    // Only ever needed once, right after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Synchronous double-submit guard. React state is async, so isSubmitting alone
  // does not protect against a fast double-tap on Place Order.
  const isSubmittingRef = useRef(false);
  const orderPlacedRef = useRef(false);

  // Analytics: checkout_start on mount, checkout_abandon on unmount if no order
  // was placed. Fire-and-forget — never blocks the checkout flow.
  useEffect(() => {
    trackEvent('checkout_start');
    return () => {
      if (!orderPlacedRef.current) trackEvent('checkout_abandon');
    };
  }, []);

  // Idempotency-Key for this Place Order attempt. Kept across retries so
  // the server can recognise "same attempt, please don't double-charge".
  // Reset to null once the order is created so a fresh checkout session
  // gets a fresh key.
  const idempotencyKeyRef = useRef(null);

  // Block hardware-back / gesture-back / programmatic navigation away
  // while a Place Order is in flight. Without this, the user can swipe
  // back or hit the system back button while the order is being created,
  // unmount the screen, and end up with a "ghost" order on the server
  // with no way to see it in the app.
  useEffect(() => {
    const unsub = navigation.addListener('beforeRemove', (e) => {
      if (!isSubmittingRef.current) return;
      e.preventDefault();
    });
    return unsub;
  }, [navigation]);

  useEffect(() => {
    // Staggered fade + slide entrance for checkout sections
    Animated.stagger(90, [
      Animated.parallel([
        Animated.timing(deliverySlide, { toValue: 0, duration: 380, easing, useNativeDriver: true }),
        Animated.timing(deliveryOpacity, { toValue: 1, duration: 380, easing, useNativeDriver: true }),
      ]),
      Animated.parallel([
        Animated.timing(paymentSlide, { toValue: 0, duration: 380, easing, useNativeDriver: true }),
        Animated.timing(paymentOpacity, { toValue: 1, duration: 380, easing, useNativeDriver: true }),
      ]),
      Animated.parallel([
        Animated.timing(summarySlide, { toValue: 0, duration: 380, easing, useNativeDriver: true }),
        Animated.timing(summaryOpacity, { toValue: 1, duration: 380, easing, useNativeDriver: true }),
      ]),
    ]).start();
  }, [deliverySlide, paymentSlide, summarySlide, deliveryOpacity, paymentOpacity, summaryOpacity]);

  // If the admin disables fast delivery, clear a stale fast selection.
  useEffect(() => {
    if (deliveryType === 'fast' && bill && bill.fastDeliveryEnabled === false) {
      setDeliveryType(null);
    }
  }, [bill, deliveryType]);

  // If the current time is inside the night delivery window, or the pinned
  // location's zone disallows Cash, COD is unavailable — force the user to UPI.
  useEffect(() => {
    if (codUnavailable && paymentMethod === 'Cash') {
      setPaymentMethod('UPI');
    }
  }, [codUnavailable, paymentMethod]);

  // Always refresh payment settings on checkout — the home screen caches them
  // for up to 5 minutes, so a newly uploaded UPI QR would otherwise stay hidden.
  // 28.6 — pin-aware too: the UPI target decides which bank account the
  // payment reaches (§9.4 item 4), so this must resolve the delivery pin's
  // own area, not fall back to users.last_area_id/default.
  useEffect(() => {
    let isActive = true;

    settingsApi.getSettings({ latitude: effectivePinLat, longitude: effectivePinLng })
      .then((response) => {
        if (!isActive) return;
        setSettings(normalizeSettings(response));
      })
      .catch(() => {});

    return () => {
      isActive = false;
    };
  }, [setSettings, effectivePinLat, effectivePinLng]);

  // Rider capacity — same pin the order will be placed with, re-checked every
  // 45s so the button re-enables on its own as soon as the area frees up.
  //
  // Scoped to focus (useFocusEffect, not useEffect) and gated on AppState:
  // this screen stays mounted when another is pushed over it, so a plain
  // interval would keep polling from a screen the user left, and keep firing
  // while the app is backgrounded. That is exactly the shape of the
  // useNetworkStatus ping-storm that produced "the app is down" reports with
  // zero 5xx — one stranded timer per visit, never cleaned up.
  useFocusEffect(
    useCallback(() => {
      let isActive = true;

      const checkCapacity = () => {
        // Backgrounded: skip the round trip, but leave the interval running
        // so a resumed app refreshes on its own within one period.
        if (AppState.currentState !== 'active') return;
        riderCapacityApi.getCapacityStatus({ latitude: effectivePinLat, longitude: effectivePinLng })
          .then((response) => {
            if (!isActive) return;
            const data = response?.data || response;
            // Remember which area answered, so the pushed events below can be
            // matched against it.
            capacityAreaIdRef.current = data?.areaId ?? data?.area_id ?? null;
            setAtCapacity(Boolean(data?.atCapacity ?? data?.at_capacity));
            const cooldown = Number(data?.cooldownMinutes ?? data?.cooldown_minutes);
            if (Number.isFinite(cooldown) && cooldown > 0) setCapacityCooldownMin(cooldown);
          })
          .catch(() => {});
      };

      checkCapacity();
      const intervalId = setInterval(checkCapacity, CAPACITY_POLL_MS);

      // The server pushes the same verdict the moment it flips (an order
      // delivered, a rider coming online, the admin re-tuning the
      // multiplier), so the button re-enables immediately instead of at the
      // next tick. The poll above stays as the reconciler: an order simply
      // ageing out of the capacity lookback window fires no event at all.
      const unsubscribe = subscribeRiderCapacityEvents(({ payload }) => {
        if (!isActive || !payload) return;
        // The socket room follows the delivery-location store's area, and
        // confirming a pin here never writes that store — so while the pin
        // sits in another area, this room is still the OLD area's and its
        // verdict does not apply to the order being placed. Drop anything
        // that doesn't match the area the poll above actually resolved; the
        // poll (which uses the right pin) remains the source of truth.
        const eventAreaId = payload.areaId ?? payload.area_id ?? null;
        if (capacityAreaIdRef.current != null && eventAreaId !== capacityAreaIdRef.current) return;
        setAtCapacity(Boolean(payload.atCapacity ?? payload.at_capacity));
        const cooldown = Number(payload.cooldownMinutes ?? payload.cooldown_minutes);
        if (Number.isFinite(cooldown) && cooldown > 0) setCapacityCooldownMin(cooldown);
      });

      return () => {
        isActive = false;
        clearInterval(intervalId);
        unsubscribe();
      };
    }, [effectivePinLat, effectivePinLng]),
  );

  useEffect(() => {
    if (upiQrImageUrl || !upiQrImageId) return undefined;

    let isActive = true;

    imagesApi.getImage(upiQrImageId)
      .then(response => {
        const image = response?.data || response?.image || response;
        const imageUrl = imageRecordToUrl(image);
        if (isActive && imageUrl) {
          setSettings({ upiQrImageUrl: imageUrl });
        }
      })
      .catch(() => {});

    return () => {
      isActive = false;
    };
  }, [setSettings, upiQrImageId, upiQrImageUrl]);

  useEffect(() => {
    const arrowLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(arrowAnim, {
          toValue: 5,
          duration: 650,
          useNativeDriver: true,
        }),
        Animated.timing(arrowAnim, {
          toValue: 0,
          duration: 650,
          useNativeDriver: true,
        }),
      ])
    );
    arrowLoop.start();
    return () => {
      arrowLoop.stop();
    };
  }, [arrowAnim]);

  // Energetic Fast Delivery bolt: quick bounce-pulse, runs while fast option available.
  useEffect(() => {
    if (!bill?.fastDeliveryEnabled) return undefined;
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(fastEnergy, { toValue: 1, duration: 380, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(fastEnergy, { toValue: 0, duration: 420, easing: Easing.in(Easing.quad), useNativeDriver: true }),
        Animated.delay(260),
      ])
    );
    pulse.start();
    return () => {
      pulse.stop();
    };
  }, [bill?.fastDeliveryEnabled, fastEnergy]);

  // Pulsing warning loop for the top-of-map "location off" chip.
  useEffect(() => {
    if (hasLocationPermission) return undefined;
    locationWarnPulse.setValue(0);
    // useNativeDriver: false — this value drives borderColor/shadowOpacity
    // (non-transform props), which the native driver can't animate.
    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(locationWarnPulse, { toValue: 1, duration: 550, useNativeDriver: false }),
        Animated.timing(locationWarnPulse, { toValue: 0, duration: 550, useNativeDriver: false }),
      ])
    );
    pulseLoop.start();
    return () => {
      pulseLoop.stop();
    };
  }, [hasLocationPermission, locationWarnPulse]);

  useEffect(() => {
    let isActive = true;

    if (checkoutItems.length === 0) {
      // Reachable mid-checkout, not just on entry: dragging the pin into a
      // zone that doesn't stock the item currently in cart returns it in
      // unavailableItems, removeUnavailableItems empties the cart, and this
      // effect re-fires with checkoutItems.length === 0. isCalculating was
      // left true by whichever run is currently in flight — without
      // resetting it here, "Please wait, checking delivery…" spins forever
      // with nothing left to calculate (reproduced live: dragged the pin,
      // watched the cart's only item get silently dropped, checked
      // isCalculating in the debugger — stuck true with zero pending work).
      setIsCalculating(false);
      setBill(null);
      setCalcError(null);
      setFreeDeliveryProgress(null);
      setFreeDeliveryUnlocked(false);
      // The screen above this state was just a dead end: no items, no bill,
      // no error text, Confirm permanently disabled — the user has no way to
      // tell what happened or how to leave short of finding the header back
      // button. Bounce out to Cart (whose own empty state already explains
      // things) instead of leaving them stranded.
      if (!emptyCartHandledRef.current) {
        emptyCartHandledRef.current = true;
        const areaChanged = removalReasonRef.current === 'area_changed';
        removalReasonRef.current = 'unavailable';
        Alert.alert(
          areaChanged ? 'Delivery area changed' : 'Cart is empty',
          areaChanged
            ? 'You moved to a different delivery area, so items from your previous area were removed from your cart.'
            : 'The item(s) in your cart aren’t available at this delivery location, so they were removed.',
          [{ text: 'OK', onPress: () => navigation.goBack() }],
        );
      }
      return undefined;
    }
    emptyCartHandledRef.current = false;

    // Flips the instant the payload changes (new pin, coupon, etc) — not
    // after the debounce below. On a slow connection there's otherwise a gap
    // between the pin settling on a new (possibly out-of-zone) spot and the
    // debounce timer firing, where isCalculating is still false and the old
    // bill/deliveryBlocked (priced for the PREVIOUS pin) is what Confirm
    // reads — enabling it against a location that was never actually priced.
    setIsCalculating(true);

    // Debounce so rapid toggles (delivery type, coordinates updates) don't fire
    // a burst of parallel cart/calculate requests. Kept short so the delivery
    // charge preview tracks the pin in near real-time while it's being dragged
    // — map idle events (not raw drag frames) are what actually pace this.
    const debounceMs = 80;
    const timer = setTimeout(() => {
      setCalcError(null);

      cartApi.calculate(calculationPayload)
        .then(response => {
          if (!isActive) return;
          const normalized = normalizeCartCalculation(response);
          setBill(normalized);
          setFreeDeliveryProgress(normalized.freeDeliveryProgress);
          setFreeDeliveryUnlocked(Boolean(
            normalized.appliedCoupon
            && Number(normalized.appliedCoupon.freeDeliveryWaiver || 0) > 0,
          ));
          syncItemPricesFromServer(normalized.items);
          // Products are area-scoped, not zone-scoped — moving the pin between
          // zones inside the same area must never drop cart items. Only flag
          // "area changed" once we've actually seen a prior area to compare
          // against (skips the very first calculate() of the session).
          const areaChanged = normalized.areaId != null
            && lastAreaIdRef.current != null
            && normalized.areaId !== lastAreaIdRef.current;
          if (normalized.areaId != null) lastAreaIdRef.current = normalized.areaId;
          if (normalized.unavailableItems?.length) {
            removalReasonRef.current = areaChanged ? 'area_changed' : 'unavailable';
            removeUnavailableItems(normalized.unavailableItems);
          } else {
            // A removal that did NOT empty the cart leaves the reason set,
            // because only the empty-cart branch consumes it. Clear it on the
            // next clean calculate so a later, unrelated empty-out doesn't
            // inherit a stale "Delivery area changed".
            removalReasonRef.current = 'unavailable';
          }
        })
        .catch(error => {
          if (!isActive) return;
          setBill(null);
          setCalcError(error?.message || 'Unable to calculate checkout total.');
        })
        .finally(() => {
          if (isActive) setIsCalculating(false);
        });
    }, debounceMs);

    return () => {
      isActive = false;
      clearTimeout(timer);
    };
  }, [calculationPayload, checkoutItems.length]);

  // Ephemeral map toast: locating stays until ready/error; live/pinned auto-hide.
  const showMapToast = useCallback((kind) => {
    if (mapToastTimerRef.current) {
      clearTimeout(mapToastTimerRef.current);
      mapToastTimerRef.current = null;
    }
    setMapToast(kind);
    if (kind === 'live' || kind === 'pinned') {
      mapToastTimerRef.current = setTimeout(() => {
        setMapToast(null);
        mapToastTimerRef.current = null;
      }, 1600);
    }
  }, []);

  // Confirm button / place-order commit: pin under the marker = delivery location.
  // Live GPS alone never sets delivery — only recenter moves the map to live.
  const applyPickedLocation = useCallback(async (latitude, longitude) => {
    setGpsError(null);
    setSubmitError(null);
    const next = { lat: latitude, lng: longitude };
    coordinatesRef.current = next;
    setCoordinates(next);
    setGpsStatus('success');
    showMapToast('pinned');

    if (reverseGeoTimerRef.current) {
      clearTimeout(reverseGeoTimerRef.current);
      reverseGeoTimerRef.current = null;
    }
    reverseGeoTimerRef.current = setTimeout(async () => {
      reverseGeoTimerRef.current = null;
      try {
        const places = await Location.reverseGeocodeAsync({ latitude, longitude });
        const place = places?.[0];
        if (!place) {
          setAddress((prev) => prev || `Pinned location (${latitude.toFixed(5)}, ${longitude.toFixed(5)})`);
          return;
        }
        const resolvedAddress = [place.name, place.street, place.district || place.subregion, place.city, place.region, place.postalCode]
          .filter(Boolean)
          .join(', ');
        if (resolvedAddress) setAddress(resolvedAddress);
      } catch {
        setAddress((prev) => prev || `Pinned location (${latitude.toFixed(5)}, ${longitude.toFixed(5)})`);
      }
    }, 280);
  }, [showMapToast]);

  useEffect(() => () => {
    if (mapToastTimerRef.current) clearTimeout(mapToastTimerRef.current);
    if (reverseGeoTimerRef.current) clearTimeout(reverseGeoTimerRef.current);
  }, []);

  // Recenter / auto-locate status only — does not confirm delivery pin.
  const handleLocateStatus = useCallback((status, reason) => {
    if (status === 'loading') {
      setGpsError(null);
      showMapToast('locating');
      return;
    }
    if (status === 'ready') {
      setGpsError(null);
      showMapToast('live');
      return;
    }
    if (status === 'error') {
      setGpsStatus('error');
      // Only blame permissions when the picker actually reported a permission
      // problem. Collapsing every failure to DENIED told iPhone users whose
      // GPS fix merely timed out to grant a permission they already had —
      // so retrying showed the same error forever.
      setGpsError(
        reason === 'permission' ? GPS_ERROR_DENIED
          : reason === 'settings' ? GPS_ERROR_SETTINGS
            : GPS_ERROR_TIMEOUT
      );
      if (mapToastTimerRef.current) {
        clearTimeout(mapToastTimerRef.current);
        mapToastTimerRef.current = null;
      }
      setMapToast(null);
    }
  }, [showMapToast]);

  // User panned or recentered — previous Confirm is invalid until they confirm again.
  const handlePinMoved = useCallback(() => {
    coordinatesRef.current = null;
    setCoordinates(null);
    setGpsStatus((prev) => (prev === 'error' ? prev : 'idle'));
  }, []);

  // Collapsed height hugs the real drag-handle/header + button content
  // (measured via onLayout/onContentSizeChange below) instead of a fixed
  // screen fraction, falling back to SHEET_COLLAPSED until first measured.
  const getCollapsedHeight = useCallback(() => {
    const header = collapsedHeaderHeightRef.current;
    const content = collapsedContentHeightRef.current;
    if (!header || !content) return SHEET_COLLAPSED;
    return Math.ceil(header + content + insets.bottom + spacing.md);
  }, [insets.bottom]);

  const applyMeasuredCollapsedHeight = useCallback(() => {
    if (!mapMode || sheetExpandedRef.current) return;
    const h = getCollapsedHeight();
    sheetHeightNum.current = h;
    setSheetReserve(h);
    sheetHeightAnim.setValue(h);
  }, [mapMode, getCollapsedHeight, sheetHeightAnim]);

  const snapSheet = useCallback((expanded) => {
    const h = expanded ? expandedHeightRef.current : getCollapsedHeight();
    sheetHeightNum.current = h;
    sheetExpandedRef.current = expanded;
    setSheetExpanded(expanded);
    setSheetReserve(h);
    if (!expanded) {
      scrollYRef.current = 0;
      scrollRef.current?.scrollTo?.({ y: 0, animated: false });
    }
    Animated.spring(sheetHeightAnim, {
      toValue: h,
      friction: 9,
      tension: 80,
      useNativeDriver: false,
    }).start();
  }, [sheetHeightAnim, getCollapsedHeight]);

  // Only the payment section has an inline validation error now — Fast
  // Delivery is an optional add-on with nothing to require.
  const focusSectionError = useCallback((message) => {
    snapSheet(true);
    setSubmitError(null);
    setPaymentError(message);
    runSectionErrorAnim(paymentShakeX, paymentErrorPulse);
    setTimeout(() => scrollToCheckoutSection('payment'), 300);
  }, [
    paymentErrorPulse,
    paymentShakeX,
    runSectionErrorAnim,
    scrollToCheckoutSection,
    snapSheet,
  ]);

  // Drag the sheet from anywhere (not only the handle). When fully expanded,
  // vertical drags at scroll-top collapse; otherwise ScrollView owns the gesture.
  const sheetPanResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_, g) => {
      if (Math.abs(g.dy) < 6) return false;
      if (Math.abs(g.dy) < Math.abs(g.dx) * 1.1) return false;
      // Collapsed / mid: drag sheet up or down from any point on the drawer.
      if (!sheetExpandedRef.current) return true;
      if (sheetHeightNum.current < expandedHeightRef.current - 4) return true;
      // Fully expanded: only claim when at top of list and pulling down to collapse.
      if (scrollYRef.current <= 2 && g.dy > 4) return true;
      return false;
    },
    onMoveShouldSetPanResponderCapture: (_, g) => {
      if (Math.abs(g.dy) < 6) return false;
      if (Math.abs(g.dy) < Math.abs(g.dx) * 1.1) return false;
      if (!sheetExpandedRef.current) return true;
      if (sheetHeightNum.current < expandedHeightRef.current - 4) return true;
      if (scrollYRef.current <= 2 && g.dy > 4) return true;
      return false;
    },
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => {
      sheetDragStart.current = sheetHeightNum.current;
    },
    onPanResponderMove: (_, g) => {
      // Finger up (dy < 0) → taller sheet; finger down → shorter sheet.
      const floor = getCollapsedHeight();
      const next = Math.min(
        expandedHeightRef.current,
        Math.max(floor, sheetDragStart.current - g.dy),
      );
      sheetHeightAnim.setValue(next);
      sheetHeightNum.current = next;
      sheetExpandedRef.current = next >= (floor + expandedHeightRef.current) / 2;
    },
    onPanResponderRelease: (_, g) => {
      const current = sheetHeightNum.current;
      const mid = (getCollapsedHeight() + expandedHeightRef.current) / 2;
      const flingUp = g.vy < -0.55;
      const flingDown = g.vy > 0.55;
      if (flingUp) snapSheet(true);
      else if (flingDown) snapSheet(false);
      else snapSheet(current >= mid);
    },
    onPanResponderTerminate: () => {
      snapSheet(sheetHeightNum.current >= (getCollapsedHeight() + expandedHeightRef.current) / 2);
    },
  }), [sheetHeightAnim, snapSheet, getCollapsedHeight]);

  // Location is mandatory for checkout — if it's not granted, block with a
  // modal (Give Permission / Back to cart) instead of letting the user
  // proceed pin-less. No auto OS-dialog on mount — only the modal's own
  // "Give Permission" button (handleEnableLocationPress) triggers the prompt.
  const [showLocationRequiredModal, setShowLocationRequiredModal] = useState(false);

  // After Settings: clear blocked state only. Live GPS still requires recenter tap.
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (next) => {
      if (next !== 'active') return;
      if (gpsError !== GPS_ERROR_SETTINGS) return;
      try {
        const existing = await Location.getForegroundPermissionsAsync();
        if (!existing?.granted) return;
        setGpsError(null);
        setGpsStatus('idle');
      } catch (_) { /* ignore */ }
    });
    return () => sub.remove();
  }, [gpsError]);

  // Standalone permission check for the top-of-map "Enable location" chip —
  // independent of gpsStatus/gpsError, which only populate after the user
  // has already tried an action (recenter, confirm). Re-checked whenever the
  // app comes back to foreground (e.g. returning from device Settings).
  const [hasLocationPermission, setHasLocationPermission] = useState(true);
  useEffect(() => {
    let isActive = true;
    const checkPermission = async () => {
      try {
        const existing = await Location.getForegroundPermissionsAsync();
        if (!isActive) return;
        const granted = Boolean(existing?.granted);
        setHasLocationPermission(granted);
        setShowLocationRequiredModal(!granted);
      } catch (_) { /* ignore */ }
    };
    checkPermission();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') checkPermission();
    });
    return () => {
      isActive = false;
      sub.remove();
    };
  }, []);

  const handleEnableLocationPress = useCallback(async () => {
    const result = await requestPreciseLocationPermission();
    if (result.granted) {
      setHasLocationPermission(true);
      locationPickerRef.current?.locateToLive?.();
      return;
    }
    openAppLocationSettings();
  }, []);

  // Error bar: open Settings or clear error so user can tap recenter FAB.
  const openLocationPicker = async () => {
    setGpsError(null);
    const result = await requestPreciseLocationPermission();
    if (!result.granted) {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setGpsStatus('error');
      if (result.needsSettings) {
        setGpsError(GPS_ERROR_SETTINGS);
        openAppLocationSettings();
      } else {
        setGpsError(GPS_ERROR_DENIED);
      }
      return;
    }
    // Permission ok — try live GPS via map picker; user can also tap recenter FAB.
    setGpsStatus('idle');
    locationPickerRef.current?.locateToLive?.();
  };

  // Lock map-center pin as delivery location, then open payment methods.
  const [confirmingContinue, setConfirmingContinue] = useState(false);
  // Confirm reads whatever's under the pin — on slow internet the tiles (and
  // the pin's real position) aren't in yet, so this stays true (blocking
  // Confirm) until LocationPicker's onMapReady fires. Starts pre-satisfied
  // when Mapbox itself isn't configured, since onMapReady would never fire.
  const [mapStyleLoaded, setMapStyleLoaded] = useState(!mapboxAvailable);
  const handleConfirmLocationContinue = useCallback(async () => {
    if (confirmingContinue) return;
    setConfirmingContinue(true);
    setSubmitError(null);
    try {
      await locationPickerRef.current?.confirmLocation?.();
      if (!coordinatesRef.current) {
        setSubmitError('Move the map to set your pin, then tap Confirm location.');
        return;
      }
      snapSheet(true);
    } finally {
      setConfirmingContinue(false);
    }
  }, [confirmingContinue, snapSheet]);


  const createOrder = async (currentBill) => {
    // The footer already swaps Place Order for a disabled "riders busy" state,
    // but not every route here goes through that button: the "total changed"
    // confirmation below re-enters createOrder directly, and capacity can flip
    // while that dialog is open. Guard the funnel itself so the customer gets
    // the same plain message either way, instead of a raw RIDERS_AT_CAPACITY
    // from the server after the tap.
    if (atCapacity) {
      // handlePlaceOrder has no finally — it only clears these in catch — and
      // it sets isSubmittingRef before calling here. Returning without the
      // reset would leave the button stuck "Processing..." forever.
      isSubmittingRef.current = false;
      setIsSubmitting(false);
      Animated.spring(btnScale, { toValue: 1, useNativeDriver: true }).start();
      setSubmitError(
        capacityCooldownMin
          ? `All our riders are busy right now. Please try again in about ${capacityCooldownMin} minutes.`
          : 'All our riders are busy right now. Please try again shortly.'
      );
      snapSheet(false);
      return;
    }

    isSubmittingRef.current = true;
    setIsSubmitting(true);
    Animated.spring(btnScale, { toValue: 0.95, useNativeDriver: true }).start();

    try {
      // savedDeliveryLocation is the same fallback the bill above prices with
      // (calculationPayload). Without it here, a customer who arrived with a
      // saved location and never re-confirmed a pin on this screen got a bill
      // priced from that location but an order posted with NO coordinates —
      // which the server now refuses as out of range. Priced one way,
      // submitted another: the order failed at the very last tap.
      // previewCoordinates is deliberately NOT in this chain: it tracks the
      // live map centre as it drifts and is preview-only, never a commitment.
      const pin = coordinatesRef.current || coordinates || savedDeliveryLocation;
      const pinLat = pin?.lat != null ? Number(pin.lat) : null;
      const pinLng = pin?.lng != null ? Number(pin.lng) : null;
      const hasPin = Number.isFinite(pinLat) && Number.isFinite(pinLng);

      // checkoutItems is a memo off store state from this component's last
      // render — a removeUnavailableItems() call earlier in this same submit
      // doesn't flow into it until the next render. Filter currentBill's
      // just-verified unavailableItems out here directly so an item that
      // went unavailable seconds ago can't still ride along in this request.
      const unavailableVariantKeys = new Set();
      const unavailableProductKeys = new Set();
      (currentBill?.unavailableItems || []).forEach((entry) => {
        const productId = entry?.productId;
        if (productId == null || productId === '') return;
        const type = entry.type || 'product';
        if (entry.variantId == null || entry.variantId === '') {
          unavailableProductKeys.add(`${type}:${String(productId)}`);
        } else {
          unavailableVariantKeys.add(`${type}:${String(productId)}:${String(entry.variantId)}`);
        }
      });
      const orderItems = (unavailableProductKeys.size === 0 && unavailableVariantKeys.size === 0)
        ? checkoutItems
        : checkoutItems.filter((item) => {
          const productKey = `${item.type}:${String(item.productId)}`;
          if (unavailableProductKeys.has(productKey)) return false;
          if (item.variantId != null && unavailableVariantKeys.has(`${productKey}:${String(item.variantId)}`)) return false;
          return true;
        });

      const orderResponse = await ordersApi.createOrder(
        {
          items: orderItems,
          deliveryAddress: address.trim(),
          address: address.trim(),
          // Explicit numbers + aliases so the API never drops the delivery pin.
          latitude: hasPin ? pinLat : undefined,
          longitude: hasPin ? pinLng : undefined,
          lat: hasPin ? pinLat : undefined,
          lng: hasPin ? pinLng : undefined,
          mapUrl: hasPin
            ? `https://www.google.com/maps/search/?api=1&query=${pinLat},${pinLng}`
            : undefined,
          map_url: hasPin
            ? `https://www.google.com/maps/search/?api=1&query=${pinLat},${pinLng}`
            : undefined,
          paymentMethod,
          delivery_type: deliveryType || 'standard',
          coupon_code: appliedCouponCode || undefined,
          coupon_id: !appliedCouponCode && appliedCouponId ? appliedCouponId : undefined,
          no_auto_apply: couponAutoApplyDisabled,
          // Lets the server distinguish an auto-applied offer (drop silently
          // if it lapsed since the cart) from a typed/tapped one (hard error).
          coupon_auto_applied: appliedCoupon?.autoApplied === true,
        },
        { headers: { 'Idempotency-Key': idempotencyKeyRef.current } }
      );
      const responseOrder = orderResponse?.order || orderResponse?.data || orderResponse;
      const orderId = responseOrder?.id || responseOrder?.orderId || orderResponse?.orderId;
      const confirmationParams = {
        orderId,
        order: {
          ...responseOrder,
          id: orderId,
          address: address.trim(),
          total: responseOrder?.total || currentBill.grandTotal,
          paymentMethod,
        },
      };

      // Clear the submit guard BEFORE dispatching the stack reset so the
      // beforeRemove listener (which blocks back-gestures mid-submission)
      // doesn't intercept and cancel this programmatic navigation.
      isSubmittingRef.current = false;

      navigation.dispatch(
        CommonActions.reset({
          index: 1,
          routes: [
            { name: 'MainTabs', params: { screen: 'Orders' } },
            { name: 'OrderConfirmation', params: confirmationParams },
          ],
        })
      );
      clearCart();
      orderPlacedRef.current = true;
      trackEvent('order_placed', { orderId: Number(orderId) || undefined });
      // Order created successfully — clear the key so a future checkout
      // session generates a fresh one.
      idempotencyKeyRef.current = null;
    } catch (error) {
      const message = error.message || 'Unable to place order. Please try again.';
      if (isOutOfRangeOrderError(error)) {
        setSubmitError('Sorry, we do not deliver to this location yet. Try a closer address.');
        snapSheet(false);
      } else if (isCodZoneBlockError(error)) {
        focusSectionError('payment', 'Cash on Delivery is not available at your location. Please pay via UPI.');
      } else if (isCodNightBlockError(message)) {
        showCodNightWarning();
      } else {
        setSubmitError(message);
      }
      // Keep the key on failure so a retry reuses it (server will dedupe).
    } finally {
      isSubmittingRef.current = false;
      setIsSubmitting(false);
      Animated.spring(btnScale, { toValue: 1, useNativeDriver: true }).start();
    }
  };

  const handlePlaceOrder = async () => {
    // Synchronous re-entry guard.
    if (isSubmittingRef.current) return;
    if (!locationMode) {
      setSubmitError('Please choose how to provide your delivery address');
      return;
    }
    // Map mode: delivery = confirmed pin under the marker (not live GPS by itself).
    if (locationMode === 'gps') {
      try {
        await locationPickerRef.current?.confirmLocation?.();
      } catch (_) { /* ignore */ }
      if (!coordinatesRef.current) {
        setSubmitError('Pin your delivery location on the map, then tap Confirm location.');
        snapSheet(false);
        return;
      }
    }
    if (!address.trim()) {
      if (locationMode === 'gps') {
        setSubmitError('Waiting for address… try again in a moment.');
        return;
      }
      setSubmitError('Please enter a delivery address');
      return;
    }
    // Section-first validation: inline errors + scroll, not the bottom red box.
    // Fast Delivery is an optional add-on now (Standard always applies), so
    // there's nothing to require here — only payment method is mandatory.
    if (!paymentMethod) {
      focusSectionError('Please choose how you would like to pay');
      return;
    }
    if (shopStatus === 'closed') {
      setSubmitError('The shop is currently closed. We cannot accept orders right now.');
      return;
    }
    if (codBlockedByNight && paymentMethod === 'Cash') {
      showCodNightWarning();
      return;
    }
    if (codBlockedByZone && paymentMethod === 'Cash') {
      focusSectionError('payment', 'Cash on Delivery is not available at your location. Please pay via UPI.');
      return;
    }
    // Location is now optional - removed coordinate requirement
    if (isCalculating || calcError || !bill) {
      setSubmitError('Please wait while we verify the order total.');
      return;
    }
    // Zone pricing: pin beyond the largest delivery zone — hard block (the
    // server would reject with OUT_OF_DELIVERY_RANGE anyway).
    if (outOfRange) {
      setSubmitError('Sorry, we do not deliver to this location yet. Try a closer address.');
      snapSheet(false);
      return;
    }
    // Exclusion square — same hard block, but the admin's own message says
    // why (server rejects with DELIVERY_EXCLUDED).
    if (excluded) {
      setSubmitError(exclusionMessage || 'Delivery is not available at this location.');
      snapSheet(false);
      return;
    }
    // Removed requiresLocation check - location is optional

    isSubmittingRef.current = true;
    setSubmitError(null);
    setPaymentError(null);
    setIsSubmitting(true);

    // Generate a fresh Idempotency-Key for this Place Order attempt. If the
    // request fails on a flaky connection and the user retries, we'll keep
    // the SAME key (stored in this ref) so the server can recognise the
    // retry and return the original order instead of creating a duplicate.
    const idempotencyKey = idempotencyKeyRef.current || uuidv4();
    idempotencyKeyRef.current = idempotencyKey;

    // Animate button loading state
    Animated.spring(btnScale, { toValue: 0.95, useNativeDriver: true }).start();

    try {
      const verifiedBill = normalizeCartCalculation(await cartApi.calculate(calculationPayload));
      setBill(verifiedBill);
      syncItemPricesFromServer(verifiedBill.items);
      const verifiedAreaChanged = verifiedBill.areaId != null
        && lastAreaIdRef.current != null
        && verifiedBill.areaId !== lastAreaIdRef.current;
      if (verifiedBill.areaId != null) lastAreaIdRef.current = verifiedBill.areaId;
      if (verifiedBill.unavailableItems?.length) {
        removalReasonRef.current = verifiedAreaChanged ? 'area_changed' : 'unavailable';
        removeUnavailableItems(verifiedBill.unavailableItems);
      }

      // Re-check zone gating against the FRESH bill, not the stale one the
      // earlier guard (line ~1105) ran against. A pin dragged out of zone
      // right before tapping Place Order still passes that stale check on a
      // slow connection — the debounced recalculation hasn't landed yet —
      // so without this, only the total-mismatch check below would catch it,
      // and it doesn't look at zone/exclusion/COD flags at all.
      if (verifiedBill.outOfRange) {
        isSubmittingRef.current = false;
        setIsSubmitting(false);
        Animated.spring(btnScale, { toValue: 1, useNativeDriver: true }).start();
        setSubmitError('Sorry, we do not deliver to this location yet. Try a closer address.');
        snapSheet(false);
        return;
      }
      if (verifiedBill.excluded) {
        isSubmittingRef.current = false;
        setIsSubmitting(false);
        Animated.spring(btnScale, { toValue: 1, useNativeDriver: true }).start();
        setSubmitError(verifiedBill.exclusionMessage || 'Delivery is not available at this location.');
        snapSheet(false);
        return;
      }
      if (verifiedBill.codAllowed === false && paymentMethod === 'Cash') {
        isSubmittingRef.current = false;
        setIsSubmitting(false);
        Animated.spring(btnScale, { toValue: 1, useNativeDriver: true }).start();
        focusSectionError('payment', 'Cash on Delivery is not available at your location. Please pay via UPI.');
        return;
      }

      const oldGrandTotal = bill?.grandTotal;
      if (oldGrandTotal !== undefined && verifiedBill.grandTotal !== oldGrandTotal) {
        setBill(verifiedBill);
        setFreeDeliveryProgress(verifiedBill.freeDeliveryProgress);
        setFreeDeliveryUnlocked(Boolean(
          verifiedBill.appliedCoupon
          && Number(verifiedBill.appliedCoupon.freeDeliveryWaiver || 0) > 0,
        ));
        isSubmittingRef.current = false;
        setIsSubmitting(false);
        Animated.spring(btnScale, { toValue: 1, useNativeDriver: true }).start();
        Alert.alert(
          'Total changed',
          `The total has changed from ₹${oldGrandTotal} to ₹${verifiedBill.grandTotal} (prices or charges were updated). Place order at the new total?`,
          [
            {
              text: 'Cancel',
              style: 'cancel',
              onPress: () => {},
            },
            {
              text: 'Place Order',
              onPress: () => createOrder(verifiedBill),
            },
          ],
          { cancelable: false }
        );
        return;
      }

      await createOrder(verifiedBill);
    } catch (error) {
      const message = error.message || 'Unable to place order. Please try again.';
      if (isOutOfRangeOrderError(error)) {
        setSubmitError('Sorry, we do not deliver to this location yet. Try a closer address.');
        snapSheet(false);
      } else if (isCodZoneBlockError(error)) {
        focusSectionError('payment', 'Cash on Delivery is not available at your location. Please pay via UPI.');
      } else if (isCodNightBlockError(message)) {
        showCodNightWarning();
      } else {
        setSubmitError(message);
      }
      isSubmittingRef.current = false;
      setIsSubmitting(false);
      Animated.spring(btnScale, { toValue: 1, useNativeDriver: true }).start();
    }
  };

  const freeDeliveryProgress = bill?.freeDeliveryProgress || null;
  const totalQuantity = items.reduce((total, item) => total + (Number(item.quantity) || 0), 0);
  const isModeSelectDisabled = isSubmitting || items.length === 0 || gpsStatus === 'loading';
  const gpsErrorCopy = gpsStatus === 'error' ? getGpsErrorCopy(gpsError) : null;
  const isPlaceOrderDisabled = isSubmitting || isCalculating || items.length === 0 || !bill || Boolean(calcError) || deliveryBlocked;
  const placeOrderLabel = isSubmitting
    ? 'Processing...'
    : isCalculating
    ? 'Calculating total...'
    : deliveryBlocked
    ? 'Delivery not available here'
    : bill
    ? `Place Order • ₹${bill.grandTotal}`
    : 'Place Order';
  // An exclusion square can sit well inside a delivery zone, so "move the pin
  // to a covered location" is wrong advice there — show the admin's reason.
  const deliveryBlockedMessage = excluded
    ? (exclusionMessage || 'Delivery is not available at this location.')
    : bill?.nearestZoneName
    ? `Outside delivery area. Move pin inside ${bill.nearestZoneName} to order.`
    : 'Outside delivery area. Move the pin to a covered location.';
  const mapMode = locationMode !== 'manual';

  return (
    <View
      style={styles.immersiveRoot}
      onLayout={(e) => {
        expandedHeightRef.current = e.nativeEvent.layout.height;
      }}
    >
      {/* Full-screen map behind the sheet (rider delivery style). */}
      {mapMode ? (
        <View style={styles.mapLayer} pointerEvents="box-none">
          <LocationPicker
            apiRef={locationPickerRef}
            inline
            immersive
            hideActions
            fullBleed
            // Checkout opens straight to live GPS so the pin lands on the
            // user's current spot instantly, not the last saved manual pin.
            autoLocateOnMount
            initialCenter={savedDeliveryLocation
              ? { latitude: savedDeliveryLocation.lat, longitude: savedDeliveryLocation.lng }
              : undefined}
            initialZoom={14.5}
            sheetReserve={sheetReserve}
            onConfirm={applyPickedLocation}
            onLocateStatus={handleLocateStatus}
            onPinMoved={handlePinMoved}
            onLiveCenterChange={handleLiveCenterChange}
            onMapReady={() => setMapStyleLoaded(true)}
            // Only shade zones while the pin needs guidance — once it's
            // already inside a valid zone, the overlay is just clutter.
            showZoneOverlay={outOfRange}
          />
          {!hasLocationPermission ? (
            <View
              style={[styles.locationPermissionRow, { top: Math.max(insets.top, spacing.md) + spacing.sm }]}
              pointerEvents="box-none"
            >
              <TouchableOpacity
                onPress={handleEnableLocationPress}
                activeOpacity={0.9}
                accessibilityRole="button"
                accessibilityLabel="Enable location access"
              >
                <Animated.View
                  style={[
                    styles.locationPermissionBtn,
                    {
                      transform: [
                        {
                          scale: locationWarnPulse.interpolate({
                            inputRange: [0, 1],
                            outputRange: [1, 1.06],
                          }),
                        },
                      ],
                      shadowOpacity: locationWarnPulse.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0.12, 0.35],
                      }),
                      borderColor: locationWarnPulse.interpolate({
                        inputRange: [0, 1],
                        outputRange: [colors.error + '30', colors.error],
                      }),
                    },
                  ]}
                >
                  <Animated.View
                    style={{
                      opacity: locationWarnPulse.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0.55, 1],
                      }),
                    }}
                  >
                    <AppIcon name="warning" size={14} color={colors.error} />
                  </Animated.View>
                  <Text style={styles.locationPermissionBtnText}>Location permission off — Tap to enable</Text>
                </Animated.View>
              </TouchableOpacity>
            </View>
          ) : null}
          {mapToast ? (
            <View
              style={[styles.mapStatusChipRow, { top: Math.max(insets.top, spacing.md) + spacing.sm }]}
              pointerEvents="none"
            >
              {mapToast === 'locating' ? (
                <View style={styles.mapStatusChip}>
                  <ActivityIndicator size="small" color={colors.textPrimary} />
                  <Text style={styles.mapStatusChipText}>Finding live location…</Text>
                </View>
              ) : mapToast === 'live' ? (
                <View style={[styles.mapStatusChip, styles.mapStatusChipSuccess]}>
                  <View style={styles.mapStatusChipDot}>
                    <AppIcon name="navigation" size={10} color={colors.textInverse} />
                  </View>
                  <Text style={[styles.mapStatusChipText, styles.mapStatusChipTextSuccess]}>
                    Moved to live location — adjust pin, then Confirm
                  </Text>
                </View>
              ) : (
                <View style={[styles.mapStatusChip, styles.mapStatusChipSuccess]}>
                  <View style={styles.mapStatusChipDot}>
                    <AppIcon name="check" size={10} color={colors.textInverse} />
                  </View>
                  <Text style={[styles.mapStatusChipText, styles.mapStatusChipTextSuccess]}>
                    Delivery pin saved
                  </Text>
                </View>
              )}
            </View>
          ) : null}
        </View>
      ) : (
        <View style={styles.manualBackdrop} />
      )}

      {/* Bottom sheet — drag up/down from anywhere on the drawer. */}
      <Animated.View
        style={[
          styles.checkoutSheet,
          !mapMode && styles.checkoutSheetManual,
          mapMode && { height: sheetHeightAnim },
        ]}
        {...(mapMode ? sheetPanResponder.panHandlers : {})}
      >
        <SafeAreaView
          style={styles.sheetSafe}
          // Top inset whenever the sheet reaches the status bar — full-screen
          // manual mode, or the map sheet pulled up to its expanded height.
          edges={(!mapMode || sheetExpanded) ? ['top'] : []}
        >
          <View
            style={styles.sheetDragZone}
            onLayout={(e) => {
              collapsedHeaderHeightRef.current = e.nativeEvent.layout.height;
              applyMeasuredCollapsedHeight();
            }}
          >
            {mapMode ? <View style={styles.sheetHandle} /> : null}
            <View style={[styles.sheetHeader, !mapMode && styles.sheetHeaderManual]}>
              <View style={styles.sheetHeaderText}>
                <Text style={styles.sheetTitle}>Checkout</Text>
              </View>
              <TouchableOpacity
                onPress={() => navigation.goBack()}
                style={styles.sheetIconBtn}
                accessibilityRole="button"
                accessibilityLabel="Go back"
              >
                <AppIcon name="back" size={22} color={colors.textPrimary} />
              </TouchableOpacity>
            </View>
          </View>

          <KeyboardAvoidingView
            style={styles.keyboardAvoid}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
          >
            <ScrollView
              ref={scrollRef}
              style={styles.sheetScroll}
              contentContainerStyle={styles.sheetScrollContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="always"
              keyboardDismissMode="none"
              nestedScrollEnabled
              scrollEnabled={sheetExpanded || !mapMode}
              onScroll={(e) => {
                scrollYRef.current = e.nativeEvent.contentOffset.y;
              }}
              scrollEventThrottle={16}
              bounces={sheetExpanded || !mapMode}
              onContentSizeChange={(_w, h) => {
                if (!mapMode || sheetExpanded) return;
                collapsedContentHeightRef.current = h;
                applyMeasuredCollapsedHeight();
              }}
            >
              {mapMode && !sheetExpanded ? (
                <View style={styles.sheetActions}>
                  {/* isCalculating/mapStyleLoaded checked FIRST — deliveryBlocked and
                      bill are both leftovers from the pin's old position, and would
                      otherwise flash a stale blocked-warning or stale charge while
                      the new position is still being priced (e.g. slow connection). */}
                  {(isCalculating || !mapStyleLoaded) ? (
                    <View style={styles.deliveryChargePreviewRow} accessibilityRole="text">
                      <ActivityIndicator size="small" color={colors.textSecondary} />
                      <Text style={styles.deliveryChargePreviewText}>Please wait, checking delivery…</Text>
                    </View>
                  ) : deliveryBlocked ? (
                    // marginTop override: sectionErrorRow's negative marginTop
                    // assumes it follows other content (its other use sites) —
                    // here it's the first child under the sheet header, so the
                    // negative margin pulled it up into the drag-handle area
                    // and clipped the icon/text.
                    <View style={[styles.sectionErrorRow, { marginTop: 0 }]} accessibilityLiveRegion="polite">
                      <AppIcon name="warning" size={14} color={colors.error} />
                      <Text style={styles.sectionErrorText}>{deliveryBlockedMessage}</Text>
                    </View>
                  ) : calcError ? (
                    <View style={[styles.sectionErrorRow, { marginTop: 0 }]} accessibilityLiveRegion="polite">
                      <AppIcon name="warning" size={14} color={colors.error} />
                      <Text style={styles.sectionErrorText}>{calcError}</Text>
                    </View>
                  ) : bill ? (
                    <View style={styles.deliveryChargePreviewRow} accessibilityRole="text">
                      <Text style={styles.deliveryChargePreviewText}>
                        {Boolean(bill.isFreeDeliveryApplied) || !Number(bill.deliveryCharge)
                          ? 'Delivery charge: FREE'
                          : `Delivery charge: ₹${bill.deliveryCharge}`}
                      </Text>
                    </View>
                  ) : null}
                  <SheetActionBtn
                    label={confirmingContinue ? 'Saving…' : 'Confirm location'}
                    icon="check"
                    variant="saffron"
                    busy={confirmingContinue}
                    disabled={isModeSelectDisabled || confirmingContinue || deliveryBlocked || isCalculating || !mapStyleLoaded || !bill || Boolean(calcError)}
                    onPress={handleConfirmLocationContinue}
                  />
                </View>
              ) : null}

            {mapMode && gpsStatus === 'error' && gpsErrorCopy ? (
              <View style={styles.gpsContainer}>
                <View style={styles.gpsBarError}>
                  <View style={styles.gpsBarErrorIconWrap}>
                    <AppIcon name="warning" size={12} color={colors.error} />
                  </View>
                  <View style={styles.gpsBarErrorBody}>
                    <Text style={styles.gpsBarErrorTitle}>{gpsErrorCopy.title}</Text>
                    <Text style={styles.gpsBarErrorText}>{gpsErrorCopy.detail}</Text>
                    <View style={styles.gpsBarErrorActions}>
                      {gpsError === GPS_ERROR_SETTINGS ? (
                        <PressableScale
                          onPress={() => openAppLocationSettings()}
                          disabled={gpsStatus === 'loading'}
                          style={[styles.gpsBarActionBtn, styles.gpsBarRetryBtn]}
                          scaleTo={0.97}
                          accessibilityRole="button"
                          accessibilityLabel="Open settings for location"
                        >
                          <AppIcon name="settings" size={14} color={colors.textPrimary} />
                          <Text style={styles.gpsBarRetryBtnText}>Open Settings</Text>
                        </PressableScale>
                      ) : (
                        <PressableScale
                          onPress={openLocationPicker}
                          disabled={gpsStatus === 'loading'}
                          style={[styles.gpsBarActionBtn, styles.gpsBarRetryBtn]}
                          scaleTo={0.97}
                          accessibilityRole="button"
                          accessibilityLabel="Retry getting location"
                        >
                          <AppIcon name="navigation" size={14} color={colors.textPrimary} />
                          <Text style={styles.gpsBarRetryBtnText}>Retry</Text>
                        </PressableScale>
                      )}
                    </View>
                  </View>
                </View>
              </View>
            ) : null}

        {/* Zone pricing: pin is beyond the largest delivery zone, or sits in a
            no-delivery exclusion square — hard block either way.
            Skipped while the map pin-picking view is showing (mapMode &&
            !sheetExpanded) — that view already renders its own copy above
            the Confirm location button; showing both overlapped the sheet's
            drag handle. */}
        {deliveryBlocked && !(mapMode && !sheetExpanded) ? (
          <View style={styles.sectionErrorRow} accessibilityLiveRegion="polite">
            <AppIcon name="warning" size={14} color={colors.error} />
            <Text style={styles.sectionErrorText}>{deliveryBlockedMessage}</Text>
          </View>
        ) : null}

        {/* Full form only when sheet is pulled up (or manual mode fills the screen). */}
        {(sheetExpanded || !mapMode) ? (
        <>
        {/* Delivery options — Standard (default, always applies) + optional Fast.
            Standard is selected whenever Fast isn't; free-delivery coupons waive
            the standard fee (shown as FREE). Fast just adds its fee on top. */}
        {bill && (
          <Animated.View
            onLayout={(e) => {
              sectionOffsetsRef.current.delivery = e.nativeEvent.layout.y;
            }}
            style={[
              styles.deliverySpeedSection,
              {
                opacity: deliveryOpacity,
                transform: [{ translateY: deliverySlide }],
              },
            ]}
          >
            <View style={styles.sectionHead}>
              <View style={styles.sectionAccent} />
              <View style={styles.sectionHeadText}>
                <Text style={styles.sectionTitle}>Delivery</Text>
                <Text style={styles.sectionSubtitle}>
                  {bill.fastDeliveryEnabled
                    ? 'Standard delivery applies. Add Fast for priority.'
                    : 'Standard delivery applies to your order.'}
                </Text>
              </View>
            </View>

            {/* Standard Delivery — fixed baseline, always applies; informational only. */}
            {(() => {
              const standardIsFree = Boolean(bill.isFreeDeliveryApplied) || !Number(bill.deliveryCharge);
              const renderStandardPrice = (priceStyle) => (
                standardIsFree ? (
                  <View style={styles.deliveryFreePriceRow}>
                    {Number(bill.deliveryCharge) > 0 && (
                      <Text numberOfLines={1} style={[priceStyle, styles.deliveryPriceStrike]}>
                        ₹{bill.deliveryCharge}
                      </Text>
                    )}
                    <Text numberOfLines={1} style={priceStyle}>FREE</Text>
                  </View>
                ) : (
                  <Text numberOfLines={1} style={priceStyle}>₹{bill.deliveryCharge}</Text>
                )
              );
              return (
                <View style={styles.standardDeliveryRow} accessibilityRole="text" accessibilityLabel="Standard Delivery, included">
                  <View style={styles.standardDeliveryIconBadge}>
                    <Text style={styles.standardDeliveryIcon}>🛵</Text>
                  </View>
                  <View style={styles.standardDeliveryTextBlock}>
                    <Text numberOfLines={1} style={styles.standardDeliveryTitle}>Standard Delivery</Text>
                    <Text numberOfLines={1} style={styles.standardDeliveryMeta}>
                      Arrives in {formatEtaMinutes(bill.standardDeliveryMinutes) || '—'}
                    </Text>
                  </View>
                  <View style={styles.standardDeliveryRight}>
                    {renderStandardPrice(styles.standardDeliveryPrice)}
                    <Text style={styles.standardDeliveryIncludedTag}>APPLIED</Text>
                  </View>
                </View>
              );
            })()}

            {/* Fast Delivery — optional priority add-on, only when admin-enabled */}
            {bill.fastDeliveryEnabled && (
              <PressableScale
                style={styles.fastTogglePressable}
                onPress={() => pickDeliveryType(deliveryType === 'fast' ? 'standard' : 'fast')}
                scaleTo={0.98}
                accessibilityRole="switch"
                accessibilityLabel={`Add Fast Delivery, plus ₹${bill.fastDeliveryCharge}`}
                accessibilityState={{ checked: deliveryType === 'fast' }}
              >
                {deliveryType === 'fast' ? (
                  <LinearGradient
                    colors={[colors.btnHighlightStart, colors.btnHighlightEnd]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={[styles.fastToggleCard, styles.chip3dSelected]}
                  >
                    <Animated.Text
                      style={[
                        styles.deliveryTypeEmojiOn,
                        {
                          opacity: fastEnergy.interpolate({ inputRange: [0, 1], outputRange: [0.75, 1] }),
                          transform: [{ scale: fastEnergy.interpolate({ inputRange: [0, 1], outputRange: [1, 1.28] }) }],
                        },
                      ]}
                    >
                      ⚡
                    </Animated.Text>
                    <View style={styles.fastToggleTextBlock}>
                      <Text numberOfLines={1} style={styles.deliveryTypeTitleOn}>Add Fast Delivery</Text>
                      <Text numberOfLines={1} style={styles.deliveryTypeTimeOn}>
                        Arrives in {formatEtaMinutes(bill.fastDeliveryMinutes) || '—'}
                      </Text>
                    </View>
                    <Text numberOfLines={1} style={styles.deliveryTypePriceOn}>
                      Extra ₹{bill.fastDeliveryCharge}
                    </Text>
                    <View style={styles.fastToggleCheck}>
                      <AppIcon name="check" size={14} color={colors.btnHighlightEnd} />
                    </View>
                  </LinearGradient>
                ) : (
                  <View style={[styles.fastToggleCard, styles.chip3dIdle]}>
                    <Animated.Text
                      style={[
                        styles.deliveryTypeEmoji,
                        {
                          opacity: fastEnergy.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }),
                          transform: [{ scale: fastEnergy.interpolate({ inputRange: [0, 1], outputRange: [1, 1.22] }) }],
                        },
                      ]}
                    >
                      ⚡
                    </Animated.Text>
                    <View style={styles.fastToggleTextBlock}>
                      <Text numberOfLines={1} style={styles.deliveryTypeTitle}>Add Fast Delivery</Text>
                      <Text numberOfLines={1} style={styles.deliveryTypeTime}>
                        Arrives in {formatEtaMinutes(bill.fastDeliveryMinutes) || '—'}
                      </Text>
                    </View>
                    <Text numberOfLines={1} style={styles.deliveryTypePrice}>
                      Extra ₹{bill.fastDeliveryCharge}
                    </Text>
                    <View style={styles.fastToggleCheckOff} />
                  </View>
                )}
              </PressableScale>
            )}
            {bill.fastDeliveryEnabled && (
              <Text style={styles.fastDeliveryHint}>
                Add Fast Delivery if your order has hot, fresh, or fast-food items — this keeps them hot on arrival.
              </Text>
            )}
          </Animated.View>
        )}

        {/* Payment Method — unboxed bold chips */}
        <Animated.View
          onLayout={(e) => {
            sectionOffsetsRef.current.payment = e.nativeEvent.layout.y;
          }}
          style={[
            styles.paymentSection,
            paymentError && styles.sectionErrorWrap,
            {
              opacity: paymentOpacity,
              transform: [
                { translateY: paymentSlide },
                { translateX: paymentShakeX },
              ],
            },
          ]}
        >
            <View style={styles.sectionHead}>
              <Animated.View
                style={[
                  styles.sectionAccent,
                  styles.sectionAccentSuccess,
                  paymentError && styles.sectionAccentError,
                  paymentError && {
                    opacity: paymentErrorPulse.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.45, 1],
                    }),
                  },
                ]}
              />
              <View style={styles.sectionHeadText}>
                <Text style={[styles.sectionTitle, paymentError && styles.sectionTitleError]}>
                  Payment Method
                </Text>
                <Text style={styles.sectionSubtitle}>How would you like to pay?</Text>
              </View>
            </View>

            {paymentError ? (
              <View style={styles.sectionErrorRow} accessibilityLiveRegion="polite">
                <AppIcon name="warning" size={14} color={colors.error} />
                <Text style={styles.sectionErrorText}>{paymentError}</Text>
              </View>
            ) : null}

            {codBlockedByNight && (
              <View style={styles.paymentNightBar}>
                <AppIcon name="clock" size={14} color={colors.saffronDark} />
                <Text style={styles.paymentNightBarText}>
                  COD unavailable {nightChargeStart || '—'}–{nightChargeEnd || '—'}. Use UPI.
                </Text>
              </View>
            )}

            {codBlockedByZone && !codBlockedByNight && (
              <View style={styles.paymentNightBar}>
                <AppIcon name="navigation" size={14} color={colors.saffronDark} />
                <Text style={styles.paymentNightBarText}>
                  COD unavailable at your delivery location. Use UPI.
                </Text>
              </View>
            )}

            <View style={styles.optionCardRow}>
              <View style={styles.optionColumn}>
                <PressableScale
                  style={styles.paymentChipPressable}
                  onPress={() => pickPaymentMethod('UPI')}
                  scaleTo={0.96}
                  accessibilityRole="button"
                  accessibilityLabel="UPI / Online"
                  accessibilityState={{ selected: paymentMethod === 'UPI' }}
                >
                  {paymentMethod === 'UPI' ? (
                    <LinearGradient
                      colors={[colors.btnHighlightStart, colors.btnHighlightEnd]}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={[styles.paymentChip, styles.chip3dSelected]}
                    >
                      <View style={styles.paymentChipTopRow}>
                        <View style={styles.recommendPillOnChipSelected}>
                          <Text style={styles.recommendPillTextSelected}>
                            {codBlockedByNight ? 'Recommend' : 'Popular'}
                          </Text>
                        </View>
                        <View style={styles.paymentChipCheck}>
                          <AppIcon name="check" size={11} color={colors.saffronDark} />
                        </View>
                      </View>
                      <View style={styles.paymentChipBody}>
                        <View style={styles.paymentChipIconSlot}>
                          <AppIcon name="creditCard" size={20} color={colors.textInverse} />
                        </View>
                        <Text numberOfLines={2} style={styles.paymentChipTitleOn}>UPI / Online</Text>
                      </View>
                    </LinearGradient>
                  ) : (
                    <View style={[
                      styles.paymentChip,
                      styles.chip3dIdle,
                      paymentError && styles.chip3dIdleError,
                    ]}>
                      <View style={styles.paymentChipTopRow}>
                        <View style={styles.recommendPillOnChip}>
                          <Text style={styles.recommendPillText}>
                            {codBlockedByNight ? 'Recommend' : 'Popular'}
                          </Text>
                        </View>
                        <View style={styles.paymentChipTopSpacer} />
                      </View>
                      <View style={styles.paymentChipBody}>
                        <View style={styles.paymentChipIconSlot}>
                          <AppIcon name="creditCard" size={20} color={colors.textPrimary} />
                        </View>
                        <Text numberOfLines={2} style={styles.paymentChipTitle}>UPI / Online</Text>
                      </View>
                    </View>
                  )}
                </PressableScale>
              </View>

              <View style={styles.optionColumn}>
                <PressableScale
                  style={styles.paymentChipPressable}
                  onPress={() => {
                    if (!codUnavailable) pickPaymentMethod('Cash');
                  }}
                  disabled={codUnavailable}
                  scaleTo={codUnavailable ? 1 : 0.96}
                  accessibilityRole="button"
                  accessibilityLabel="Cash on Delivery"
                  accessibilityState={{ disabled: codUnavailable, selected: paymentMethod === 'Cash' && !codUnavailable }}
                >
                  {paymentMethod === 'Cash' && !codUnavailable ? (
                    <LinearGradient
                      colors={[colors.btnHighlightStart, colors.btnHighlightEnd]}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={[styles.paymentChip, styles.chip3dSelected]}
                    >
                      <View style={styles.paymentChipTopRow}>
                        <View style={styles.paymentChipTopSpacer} />
                        <View style={styles.paymentChipCheck}>
                          <AppIcon name="check" size={11} color={colors.saffronDark} />
                        </View>
                      </View>
                      <View style={styles.paymentChipBody}>
                        <View style={styles.paymentChipIconSlot}>
                          <AppIcon name="rupee" size={20} color={colors.textInverse} />
                        </View>
                        <Text numberOfLines={2} style={styles.paymentChipTitleOn}>Cash on Delivery</Text>
                      </View>
                    </LinearGradient>
                  ) : (
                    <View style={[
                      styles.paymentChip,
                      styles.chip3dIdle,
                      paymentError && styles.chip3dIdleError,
                      codUnavailable && styles.optionCardDisabled,
                    ]}>
                      <View style={styles.paymentChipTopRow}>
                        <View style={styles.paymentChipTopSpacer} />
                      </View>
                      <View style={styles.paymentChipBody}>
                        <View style={styles.paymentChipIconSlot}>
                          <AppIcon
                            name="rupee"
                            size={20}
                            color={codUnavailable ? colors.textDisabled : colors.textPrimary}
                          />
                        </View>
                        <Text
                          numberOfLines={2}
                          style={[
                            styles.paymentChipTitle,
                            codUnavailable && styles.paymentCardTitleDisabled,
                          ]}
                        >
                          Cash on Delivery
                        </Text>
                        {codBlockedByNight ? (
                          <Text style={styles.paymentCardHint}>Unavailable at night</Text>
                        ) : codBlockedByZone ? (
                          <Text style={styles.paymentCardHint}>Unavailable at your location</Text>
                        ) : null}
                      </View>
                    </View>
                  )}
                </PressableScale>
              </View>
            </View>

            {paymentMethod === 'UPI' && (
              <Text style={styles.paymentMethodNote}>Complete UPI payment before placing your order.</Text>
            )}
            {paymentMethod === 'Cash' && (
              <Text style={styles.paymentMethodNote}>Pay cash to the delivery executive.</Text>
            )}
            {!paymentMethod && (
              <Text style={styles.paymentMethodNote}>Select how you would like to pay.</Text>
            )}

            {paymentMethod === 'UPI' && (
              <View
                style={styles.upiBlock}
                onLayout={(e) => {
                  // Relative to the payment section (its own parent), not the
                  // scroll content root — add the payment section's own
                  // offset (already captured) to get an absolute scroll-to Y.
                  sectionOffsetsRef.current.upiQr =
                    (sectionOffsetsRef.current.payment || 0) + e.nativeEvent.layout.y;
                }}
              >
                <Text style={styles.upiBlockTitle}>Complete UPI Payment</Text>
                <Text style={styles.upiBlockSubtitle}>
                  Scan with PhonePe, GPay, Paytm, or any UPI app
                </Text>

                <View style={styles.upiAmountRow}>
                  <Text style={styles.upiAmountLabel}>Amount to pay</Text>
                  <Text style={styles.upiAmountValue}>
                    {isCalculating ? '...' : bill ? `₹${bill.grandTotal}` : '—'}
                  </Text>
                </View>

                <View style={styles.upiQrBlock}>
                  <Text style={styles.upiQrBlockLabel}>Merchant QR Code</Text>
                  <View style={styles.qrShell}>
                    {upiQrImageUrl ? (
                      <ExpoImage
                        source={{ uri: upiQrImageUrl }}
                        style={styles.qrImage}
                        contentFit="contain"
                        transition={200}
                      />
                    ) : (
                      <View style={styles.qrPlaceholder}>
                        <AppIcon name="image" size={28} color={colors.textTertiary} />
                        <Text style={styles.qrPlaceholderTitle}>QR not uploaded</Text>
                        <Text style={styles.qrPlaceholderText}>
                          Ask the shop to add a UPI QR in admin settings
                        </Text>
                      </View>
                    )}
                  </View>
                </View>

                <View style={styles.upiStepsRow}>
                  <View style={styles.upiStep}>
                    <View style={styles.upiStepBadge}>
                      <Text style={styles.upiStepBadgeText}>1</Text>
                    </View>
                    <Text style={styles.upiStepText}>Scan QR</Text>
                  </View>
                  <View style={styles.upiStepLine} />
                  <View style={styles.upiStep}>
                    <View style={styles.upiStepBadge}>
                      <Text style={styles.upiStepBadgeText}>2</Text>
                    </View>
                    <Text style={styles.upiStepText}>Pay amount</Text>
                  </View>
                  <View style={styles.upiStepLine} />
                  <View style={styles.upiStep}>
                    <View style={styles.upiStepBadge}>
                      <Text style={styles.upiStepBadgeText}>3</Text>
                    </View>
                    <Text style={styles.upiStepText}>Save screenshot</Text>
                  </View>
                </View>

                <View style={styles.upiAutoCancelWarning}>
                  <AppIcon name="warning" size={14} color={colors.error} />
                  <Text style={styles.upiAutoCancelWarningText}>
                    Unpaid orders are auto-cancelled.
                  </Text>
                </View>

                <View style={styles.screenshotNote}>
                  <AppIcon name="check" size={14} color={colors.successDark} />
                  <Text style={styles.screenshotNoteText}>
                    Show payment screenshot to delivery boy.
                  </Text>
                </View>
              </View>
            )}
        </Animated.View>

        {/* Order Summary — open bill, bold total */}
        <Animated.View
          onLayout={(e) => {
            sectionOffsetsRef.current.summary = e.nativeEvent.layout.y;
          }}
          style={[
            styles.summarySection,
            { opacity: summaryOpacity, transform: [{ translateY: summarySlide }] },
          ]}
        >
            <View style={styles.sectionHead}>
              <View style={[styles.sectionAccent, styles.sectionAccentInk]} />
              <View style={styles.sectionHeadText}>
                <Text style={styles.sectionTitle}>Order Summary</Text>
                <Text style={styles.sectionSubtitle}>Review your bill breakdown</Text>
              </View>
            </View>

            {isCalculating ? (
              <View style={styles.calcSkeleton}>
                <LoadingSkeleton style={{ height: 18, width: '60%', marginBottom: 10 }} />
                <LoadingSkeleton style={{ height: 14, width: '40%', marginBottom: 10 }} />
                <LoadingSkeleton style={{ height: 14, width: '50%', marginBottom: 10 }} />
                <LoadingSkeleton style={{ height: 22, width: '70%', marginTop: 6 }} />
              </View>
            ) : calcError ? (
              <Text style={styles.calcErrorText}>{calcError}</Text>
            ) : bill ? (
              <>
                <View style={[styles.summaryRow, styles.summaryRowFirst]}>
                  <Text style={styles.summaryLabel}>Items ({totalQuantity})</Text>
                  <Text style={styles.summaryValue}>₹{bill.subtotal}</Text>
                </View>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>Delivery Charge</Text>
                  {/* Delivery Charge is always the standard fee — Fast is a
                      separate additive line below, never discounted. */}
                  {bill.isFreeDeliveryApplied ? (
                    <View style={styles.freeDeliveryValueRow}>
                      <Text style={styles.summaryStrikethrough}>₹{bill.deliveryCharge}</Text>
                      <Text style={[styles.summaryValue, styles.freeDeliveryText]}>FREE</Text>
                    </View>
                  ) : (
                    <Text style={styles.summaryValue}>₹{bill.deliveryCharge}</Text>
                  )}
                </View>
                {bill.fastDeliveryFee > 0 && (
                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>Fast Delivery Add-on</Text>
                    <Text style={styles.summaryValue}>₹{bill.fastDeliveryFee}</Text>
                  </View>
                )}
                {bill.nightCharge > 0 && (
                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>Night Charge</Text>
                    <Text style={styles.summaryValue}>₹{bill.nightCharge}</Text>
                  </View>
                )}
                {bill.rainCharge > 0 && (
                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryLabel}>Rain Charge</Text>
                    <Text style={styles.summaryValue}>₹{bill.rainCharge}</Text>
                  </View>
                )}
                {(() => {
                  // When free-del fully covers delivery, Discount row is item-only
                  // (free-del is shown on the Delivery line as FREE).
                  const discountToShow = bill.isFreeDeliveryApplied
                    ? bill.itemDiscount
                    : bill.discount;
                  if (!(discountToShow > 0)) return null;
                  return (
                    <View style={styles.summaryRow}>
                      <Text style={styles.summaryLabel}>Discount</Text>
                      <Text style={[styles.summaryValue, styles.summaryDiscountValue]}>- ₹{discountToShow}</Text>
                    </View>
                  );
                })()}

                {(() => {
                  const isFreeDeliveryApplied = Boolean(bill.isFreeDeliveryApplied);
                  if (!deliveryAvailable) {
                    return (
                      <View style={[styles.summaryStatusNote, styles.summaryStatusNoteError]}>
                        <Text style={[styles.deliveryStatusText, styles.deliveryStatusError]}>
                          Delivery is currently unavailable in your area.
                        </Text>
                      </View>
                    );
                  }
                  if (bill.deliveryMessage || bill.requiresLocation || !bill.deliveryWithinRange || isFreeDeliveryApplied) {
                    return (
                      <View style={[
                        styles.summaryStatusNote,
                        !bill.deliveryWithinRange && styles.summaryStatusNoteError,
                        isFreeDeliveryApplied && styles.summaryStatusNoteSuccess,
                      ]}>
                        <Text style={[
                          styles.deliveryStatusText,
                          !bill.deliveryWithinRange && styles.deliveryStatusError,
                          isFreeDeliveryApplied && styles.deliveryStatusSuccess,
                        ]}>
                          {bill.deliveryMessage || (bill.requiresLocation ? 'Pin location to continue.' : 'Delivery available.')}
                        </Text>
                      </View>
                    );
                  }
                  return null;
                })()}

                <LinearGradient
                  colors={[colors.btnHighlightStart, colors.btnHighlightEnd]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={styles.summaryGrandTotalRow}
                >
                  <Text style={styles.summaryTotalLabel}>Total to Pay</Text>
                  <Text style={styles.summaryTotalValue}>₹{bill.grandTotal}</Text>
                </LinearGradient>
              </>
            ) : (
              <Text style={styles.calcText}>Add items to view total.</Text>
            )}

            {bill && freeDeliveryProgress && (
              <View style={styles.summaryProgressNote}>
                <AppIcon name="box" size={14} color={colors.saffron} />
                <Text style={styles.summaryProgressNoteText}>
                  {buildProgressHintText(freeDeliveryProgress, {
                    includeWorth: true,
                    suffix: ` to unlock Free Delivery (₹${bill.deliveryCharge} delivery fee currently applied).`,
                  })}
                </Text>
              </View>
            )}
        </Animated.View>

        {/* Global Error Banner */}
        {submitError && (
          <View style={styles.errorBanner}>
            <AppIcon name="delete" size={16} color={colors.error} style={{ marginRight: spacing.sm }} />
            <Text style={styles.errorBannerText}>{submitError}</Text>
          </View>
        )}
        </>
        ) : (
          submitError ? (
            <View style={styles.errorBanner}>
              <AppIcon name="delete" size={16} color={colors.error} style={{ marginRight: spacing.sm }} />
              <Text style={styles.errorBannerText}>{submitError}</Text>
            </View>
          ) : null
        )}

          </ScrollView>

            {/* Sheet footer — Place Order / Back to Cart, only once the full
                form is showing (address confirmed). The map-pick step shows
                just Confirm location instead. */}
            {(!mapMode || sheetExpanded) && (
              <View
                style={[
                  styles.sheetFooter,
                  // Keep CTA above the system gesture / nav bar (Android edge-to-edge).
                  { paddingBottom: Math.max(insets.bottom, spacing.sm) },
                ]}
                collapsable={false}
              >
                {shopStatus === 'closed' ? (
                  <View style={[styles.customPlaceOrderBtn, styles.customPlaceOrderBtnDisabled]}>
                    <Text style={styles.placeOrderBtnTextDisabled}>Shop is Closed</Text>
                  </View>
                ) : !deliveryAvailable ? (
                  <View style={[styles.customPlaceOrderBtn, styles.customPlaceOrderBtnDisabled]}>
                    <Text style={styles.placeOrderBtnTextDisabled}>Delivery Unavailable</Text>
                  </View>
                ) : atCapacity ? (
                  <View style={[styles.customPlaceOrderBtn, styles.customPlaceOrderBtnDisabled]}>
                    <Text style={styles.placeOrderBtnTextDisabled}>
                      {capacityCooldownMin
                        ? `All Riders Busy — Try Again in ${capacityCooldownMin} min`
                        : 'All Riders Busy — Please Try Again Shortly'}
                    </Text>
                  </View>
                ) : (
                  <SheetActionBtn
                    label={placeOrderLabel}
                    icon={isSubmitting || isCalculating ? null : 'check'}
                    variant="success"
                    busy={isSubmitting || isCalculating}
                    disabled={isPlaceOrderDisabled || shopStatus === 'closed' || !deliveryAvailable || atCapacity}
                    onPress={handlePlaceOrder}
                  />
                )}
                <TouchableOpacity
                  style={styles.backToCartBtn}
                  onPress={() => navigation.goBack()}
                  disabled={isSubmitting}
                >
                  <Text style={styles.backToCartText}>Back to Cart</Text>
                </TouchableOpacity>
              </View>
            )}
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Animated.View>

      <ConfirmModal
        visible={showCodNightModal}
        title="COD not available at night"
        message={codNightModalMessage}
        confirmLabel="Switch to UPI"
        cancelLabel="Cancel"
        confirmVariant="primary"
        onCancel={() => setShowCodNightModal(false)}
        onConfirm={handleSwitchToUpi}
      />

      {/* Location is required to check out — no dismiss, just the two ways
          out: grant it via Settings, or leave checkout back to the cart. */}
      <ConfirmModal
        visible={showLocationRequiredModal}
        title="Location access needed"
        message="We need your location to pin your delivery address and calculate delivery charges. Enable location access to continue checkout."
        confirmLabel="Open Settings"
        cancelLabel="Back to Cart"
        confirmVariant="primary"
        onConfirm={() => openAppLocationSettings()}
        onCancel={() => navigation.goBack()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  immersiveRoot: {
    flex: 1,
    backgroundColor: colors.bgApp,
  },
  mapLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  manualBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.bgApp,
  },
  // Rider-order-style bottom sheet over the map (height animated).
  checkoutSheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.bgSurface,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    ...shadows.cardRaised,
    overflow: 'hidden',
  },
  checkoutSheetManual: {
    // Fill the parent (not window height) so nothing peeks under the nav bar.
    top: 0,
    bottom: 0,
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
  },
  sheetSafe: {
    flex: 1,
    minHeight: 0,
  },
  sheetDragZone: {
    paddingBottom: spacing.xs,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  sheetScroll: {
    flexGrow: 1,
    flexShrink: 1,
  },
  sheetScrollContent: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl,
    flexGrow: 0,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  sheetHeaderManual: {
    paddingTop: spacing.sm,
  },
  sheetHeaderText: {
    flex: 1,
  },
  sheetIconBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.circle,
    backgroundColor: colors.bgApp,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetTitle: {
    ...typography.h2,
    fontSize: 20,
    color: colors.textPrimary,
    textAlign: 'left',
  },
  sheetAddress: {
    ...typography.body,
    color: colors.textPrimary,
    marginBottom: spacing.sm,
    fontWeight: '600',
  },
  sheetActions: {
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  deliveryChargePreviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  deliveryChargePreviewText: {
    color: colors.textSecondary,
    fontWeight: '700',
    fontSize: 13,
  },
  sheetPrimaryBtn: {
    minHeight: 50,
    borderRadius: radius.button,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  sheetPrimaryBtnDisabled: {
    opacity: 0.55,
  },
  sheetPrimaryBtnText: {
    color: colors.textInverse,
    fontWeight: '800',
    fontSize: 15,
  },
  sheetGhostBtn: {
    minHeight: 44,
    borderRadius: radius.button,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: colors.bgApp,
  },
  sheetGhostBtnText: {
    color: colors.textSecondary,
    fontWeight: '800',
    fontSize: 14,
  },
  sheetFooter: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: spacing.xs,
    backgroundColor: colors.bgSurface,
  },
  keyboardAvoid: {
    flex: 1,
    minHeight: 0,
  },
  // Compact floating pill on the map (loading / location set).
  locationPermissionRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 6,
  },
  locationPermissionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.96)',
    borderWidth: 1,
    borderColor: colors.error + '55',
    ...shadows.sm,
  },
  locationPermissionBtnText: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '700',
    color: colors.error,
  },
  mapStatusChipRow: {
    position: 'absolute',
    top: spacing.md,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 5,
  },
  mapStatusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.08)',
    ...shadows.sm,
  },
  mapStatusChipSuccess: {
    backgroundColor: 'rgba(232, 255, 244, 0.96)',
    borderColor: colors.palette.success200,
  },
  mapStatusChipDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.success,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mapStatusChipText: {
    fontSize: 12,
    lineHeight: 15,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  mapStatusChipTextSuccess: {
    color: colors.successDark,
  },
  section: {
    marginBottom: spacing.lg,
  },
  sectionTitle: {
    ...typography.h4,
    color: colors.textPrimary,
    fontWeight: '800',
  },
  sectionSubtitle: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  deliveryInputWrap: {
    marginTop: spacing.sm,
  },
  addressFieldLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  addressFieldLabelIcon: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.saffronLight,
    borderWidth: 1,
    borderColor: colors.saffron + '35',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addressFieldLabel: {
    ...typography.labelSmall,
    color: colors.textPrimary,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  addressFieldWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 52,
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
    backgroundColor: colors.bgInput,
    borderRadius: radius.input,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  addressFieldWrapFocused: {
    backgroundColor: colors.bgSurface,
    borderWidth: 1.5,
    borderColor: colors.saffron,
    shadowColor: colors.saffron,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.14,
    shadowRadius: 8,
    elevation: 4,
  },
  addressFieldWrapFilled: {
    backgroundColor: colors.bgSurface,
    borderColor: colors.borderStrong,
  },
  addressFieldLeadingIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.bgSurface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addressFieldLeadingIconFocused: {
    backgroundColor: colors.saffronLight,
    borderColor: colors.saffron + '55',
  },
  addressFieldLeadingIconFilled: {
    backgroundColor: colors.saffronLight,
    borderColor: colors.saffron + '35',
  },
  addressFieldInput: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textPrimary,
    fontWeight: '500',
    paddingVertical: 14,
    margin: 0,
    includeFontPadding: false,
    textAlignVertical: 'center',
  },
  addressFieldClear: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.bgSurface,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.xs,
  },
  addressFieldClearHidden: {
    opacity: 0,
  },
  gpsContainer: {
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  gpsBarError: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.errorBorder,
    backgroundColor: colors.errorLight,
  },
  gpsBarErrorIconWrap: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.bgSurface,
    borderWidth: 1,
    borderColor: colors.errorBorder,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  gpsBarErrorBody: {
    flex: 1,
    flexDirection: 'column',
    gap: spacing.xs,
  },
  gpsBarErrorTitle: {
    ...typography.caption,
    color: colors.error,
    fontWeight: '700',
    lineHeight: 18,
  },
  gpsBarErrorText: {
    ...typography.caption,
    color: colors.error,
    fontWeight: '500',
    lineHeight: 18,
  },
  gpsBarErrorActions: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  gpsBarErrorManualLead: {
    ...typography.caption,
    color: colors.error,
    fontWeight: '500',
    lineHeight: 18,
    marginTop: spacing.xs,
  },
  gpsBarActionBtn: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.bgSurface,
    borderWidth: 1.5,
  },
  gpsBarRetryBtn: {
    borderColor: colors.saffron,
  },
  gpsBarRetryBtnText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  gpsBarManualBtn: {
    borderColor: colors.borderStrong,
  },
  gpsBarManualBtnText: {
    ...typography.caption,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  // Open section chrome — accent bar + title, no card boxes.
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  sectionAccent: {
    width: 4,
    height: 18,
    borderRadius: 2,
    backgroundColor: colors.saffron,
    marginTop: 3,
  },
  sectionAccentSuccess: {
    backgroundColor: colors.success,
  },
  sectionAccentInk: {
    backgroundColor: colors.textPrimary,
  },
  sectionAccentError: {
    backgroundColor: colors.error,
    width: 4,
    height: 36,
  },
  sectionHeadText: {
    flex: 1,
  },
  sectionTitleError: {
    color: colors.error,
  },
  sectionErrorWrap: {
    // keep open layout — red accent + text only (no full red card box)
  },
  sectionErrorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: -spacing.sm,
    marginBottom: spacing.sm,
    paddingBottom: spacing.xs,
    borderBottomWidth: 1.5,
    borderBottomColor: colors.error,
  },
  sectionErrorText: {
    ...typography.caption,
    color: colors.error,
    fontWeight: '700',
    flex: 1,
    lineHeight: 16,
  },

  paymentSection: {
    marginBottom: spacing.lg,
  },
  paymentNightBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  paymentNightBarText: {
    ...typography.caption,
    color: colors.saffronDark,
    flex: 1,
    fontWeight: '600',
  },
  optionCardRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'stretch',
    overflow: 'visible',
  },
  optionColumn: {
    flex: 1,
    overflow: 'visible',
  },
  paymentChipPressable: {
    width: '100%',
  },
  paymentChipTopRow: {
    height: 22,
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
    marginBottom: 4,
  },
  paymentChipTopSpacer: {
    width: 20,
    height: 20,
  },
  // Shared 3D "popped up" chip look — same idle for all option pairs.
  // Shadow is always black (not tinted by selected button color).
  chip3dIdle: {
    backgroundColor: colors.bgSurface,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)',
    borderBottomWidth: 4,
    borderBottomColor: 'rgba(0,0,0,0.18)',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.16,
    shadowRadius: 6,
    elevation: 5,
  },
  chip3dIdleError: {
    borderColor: colors.error + '55',
    borderBottomColor: colors.error + '90',
  },
  chip3dSelected: {
    borderWidth: 0,
    borderBottomWidth: 4,
    borderBottomColor: 'rgba(0,0,0,0.28)',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.22,
    shadowRadius: 8,
    elevation: 8,
  },
  recommendPillOnChip: {
    backgroundColor: colors.saffronLight,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.saffron + '40',
  },
  recommendPillText: {
    fontSize: 9,
    lineHeight: 11,
    color: colors.saffronDark,
    fontWeight: '800',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  recommendPillOnChipSelected: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  recommendPillTextSelected: {
    fontSize: 9,
    lineHeight: 11,
    color: colors.saffronDark,
    fontWeight: '800',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  optionCardDisabled: {
    opacity: 0.45,
  },
  paymentChip: {
    width: '100%',
    height: 84,
    borderRadius: radius.xl,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
  },
  paymentChipBody: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  paymentChipIconSlot: {
    height: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  paymentChipCheck: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.bgSurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  paymentChipTitle: {
    fontSize: 12,
    lineHeight: 14,
    fontWeight: '700',
    textAlign: 'center',
    color: colors.textPrimary,
    minHeight: 28,
  },
  paymentChipTitleOn: {
    fontSize: 12,
    lineHeight: 14,
    fontWeight: '800',
    textAlign: 'center',
    color: colors.textInverse,
    minHeight: 28,
  },
  paymentCardTitleDisabled: {
    color: colors.textDisabled,
  },
  paymentCardHint: {
    marginTop: 2,
    fontSize: 9,
    lineHeight: 11,
    color: colors.textTertiary,
    fontWeight: '600',
    textAlign: 'center',
  },
  paymentMethodNote: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.sm,
    fontWeight: '500',
    textAlign: 'left',
  },

  deliverySpeedSection: {
    marginBottom: spacing.lg,
  },
  fastTogglePressable: {
    width: '100%',
    marginBottom: spacing.sm,
  },
  standardDeliveryRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    marginBottom: spacing.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.successLight,
  },
  standardDeliveryIconBadge: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.bgSurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  standardDeliveryIcon: {
    fontSize: 17,
  },
  standardDeliveryTextBlock: {
    flex: 1,
    gap: 1,
  },
  standardDeliveryTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  standardDeliveryMeta: {
    ...typography.caption,
    fontSize: 12,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  standardDeliveryRight: {
    alignItems: 'flex-end',
    gap: 2,
  },
  standardDeliveryPrice: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.textPrimary,
  },
  standardDeliveryIncludedTag: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.4,
    color: colors.successDark,
  },
  deliveryFreePriceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  deliveryPriceStrike: {
    textDecorationLine: 'line-through',
    opacity: 0.55,
  },
  fastToggleCard: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.xl,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  fastToggleTextBlock: {
    flex: 1,
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: 2,
  },
  fastDeliveryHint: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
  fastToggleCheck: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.bgSurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fastToggleCheckOff: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: 'rgba(0,0,0,0.14)',
  },
  deliveryTypeEmoji: {
    fontSize: 22,
    lineHeight: 26,
    textAlign: 'center',
  },
  deliveryTypeEmojiOn: {
    fontSize: 22,
    lineHeight: 26,
    textAlign: 'center',
  },
  deliveryTypeTitle: {
    ...typography.label,
    color: colors.textPrimary,
    fontWeight: '700',
    textAlign: 'center',
  },
  deliveryTypeTitleOn: {
    ...typography.label,
    color: colors.textInverse,
    fontWeight: '800',
    textAlign: 'center',
  },
  deliveryTypeTime: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  deliveryTypeTimeOn: {
    ...typography.caption,
    color: colors.textInverse,
    opacity: 0.92,
    textAlign: 'center',
  },
  deliveryTypePrice: {
    ...typography.labelLarge,
    color: colors.textPrimary,
    fontWeight: '800',
    textAlign: 'center',
  },
  deliveryTypePriceOn: {
    ...typography.labelLarge,
    color: colors.textInverse,
    fontWeight: '900',
    textAlign: 'center',
  },
  upiBlock: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
  },
  upiBlockTitle: {
    ...typography.labelLarge,
    color: colors.textPrimary,
    fontWeight: '800',
    marginBottom: 2,
  },
  upiBlockSubtitle: {
    ...typography.caption,
    color: colors.textSecondary,
    lineHeight: 16,
    marginBottom: spacing.md,
  },
  upiAmountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  upiAmountLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  upiAmountValue: {
    ...typography.h2,
    color: colors.successDark,
    fontWeight: '900',
  },
  upiQrBlock: {
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  upiQrBlockLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  qrShell: {
    width: 188,
    height: 188,
    borderRadius: radius.xl,
    padding: spacing.sm,
    backgroundColor: colors.bgSurface,
    ...shadows.md,
  },
  qrImage: {
    width: '100%',
    height: '100%',
    borderRadius: radius.lg,
  },
  qrPlaceholder: {
    flex: 1,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.md,
    gap: spacing.xs,
  },
  qrPlaceholderTitle: {
    ...typography.labelSmall,
    color: colors.textPrimary,
    fontWeight: '700',
    textAlign: 'center',
  },
  qrPlaceholderText: {
    ...typography.caption,
    color: colors.textTertiary,
    textAlign: 'center',
    lineHeight: 16,
  },
  upiStepsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  upiStep: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
  },
  upiStepBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.saffron,
    alignItems: 'center',
    justifyContent: 'center',
  },
  upiStepBadgeText: {
    fontSize: 12,
    lineHeight: 14,
    color: colors.textInverse,
    fontWeight: '800',
  },
  upiStepText: {
    fontSize: 11,
    lineHeight: 13,
    color: colors.textSecondary,
    fontWeight: '700',
    textAlign: 'center',
  },
  upiStepLine: {
    width: 20,
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.saffronLight,
    marginBottom: 18,
  },
  upiAutoCancelWarning: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  upiAutoCancelWarningText: {
    ...typography.caption,
    color: colors.error,
    flex: 1,
    fontWeight: '700',
    lineHeight: 16,
  },
  screenshotNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  screenshotNoteText: {
    ...typography.caption,
    color: colors.successDark,
    flex: 1,
    fontWeight: '600',
    lineHeight: 16,
  },

  summarySection: {
    marginBottom: spacing.lg,
    paddingBottom: spacing.md,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 26,
    paddingVertical: 3,
  },
  summaryRowFirst: {
    paddingTop: 0,
  },
  summaryLabel: {
    ...typography.body,
    color: colors.textSecondary,
    fontWeight: '500',
    flex: 1,
    paddingRight: spacing.sm,
  },
  summaryValue: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '700',
    textAlign: 'right',
  },
  summaryDiscountValue: {
    color: colors.successDark,
  },
  freeDeliveryValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.xs,
  },
  summaryStrikethrough: {
    ...typography.body,
    color: colors.textTertiary,
    textDecorationLine: 'line-through',
  },
  freeDeliveryText: {
    color: colors.successDark,
    fontWeight: '800',
  },
  calcText: {
    ...typography.body,
    color: colors.textSecondary,
  },
  calcErrorText: {
    ...typography.body,
    color: colors.error,
  },
  summaryStatusNote: {
    paddingVertical: spacing.xs,
    marginBottom: spacing.xs,
  },
  summaryStatusNoteError: {},
  summaryStatusNoteSuccess: {},
  deliveryStatusText: {
    ...typography.caption,
    color: colors.textSecondary,
    lineHeight: 16,
    fontWeight: '500',
  },
  deliveryStatusError: {
    color: colors.error,
    fontWeight: '700',
  },
  deliveryStatusSuccess: {
    color: colors.successDark,
    fontWeight: '700',
  },
  summaryGrandTotalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.xl,
    minHeight: 56,
  },
  summaryTotalLabel: {
    ...typography.labelLarge,
    color: colors.textInverse,
    fontWeight: '800',
  },
  summaryTotalValue: {
    ...typography.h2,
    color: colors.textInverse,
    fontWeight: '900',
    textAlign: 'right',
  },
  summaryProgressNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  summaryProgressNoteText: {
    ...typography.caption,
    color: colors.saffronDark,
    flex: 1,
    fontWeight: '600',
    lineHeight: 16,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.xs,
  },
  warningHighlight: {
    fontWeight: '800',
    color: colors.saffronDark || '#E05A1A',
  },
  errorBanner: {
    marginBottom: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.errorLight,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.error + '40',
    flexDirection: 'row',
    alignItems: 'center',
  },
  errorBannerText: {
    ...typography.body,
    color: colors.error,
    flex: 1,
  },
  customPlaceOrderBtn: {
    minHeight: 50,
    backgroundColor: colors.success,
    borderRadius: radius.button,
    justifyContent: 'center',
    alignItems: 'center',
  },
  customPlaceOrderBtnDisabled: {
    backgroundColor: colors.bgDisabled || '#DFE2E6',
  },
  placeOrderBtnTextDisabled: {
    ...typography.buttonLarge,
    color: colors.textDisabled,
    fontWeight: '800',
    fontSize: 15,
  },
  backToCartBtn: {
    alignItems: 'center',
    paddingVertical: spacing.xs,
    marginTop: spacing.xs,
  },
  backToCartText: {
    ...typography.label,
    color: colors.textSecondary,
  },
});
