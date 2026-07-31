import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Animated,
  LayoutAnimation,
  Easing as RNEasing,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import {
  AppScreen,
  AppHeader,
  AppIcon,
  ProductImage,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  QuantityStepper,
  PressableScale,
} from '../../../components';
import { colors, typography, spacing, radius, shadows, layout, borderWidth, motionConfig, entryDistance, easing, smallMs, staggerMs, screenMs } from '../../../theme';
import { useCartStore, useSettingsStore, useDeliveryZonesStore, useDeliveryLocationStore } from '../../../stores';
import { cartApi } from '../../../api';
import { showToast } from '../../../components/Toast';
import { buildProgressHintText, normalizeCartCalculation, useReducedMotion } from '../../../utils';

const getItemType = (item) =>
  item.type || (item.product?.isCombo || item.product?.is_combo ? 'combo' : 'product');
// Includes variant id — two lines of the same product with different
// variants (e.g. 2x Veg + 1x Chicken) must get distinct keys, otherwise
// React collides them and quantity controls would target the wrong line.
const getItemKey = (item) => `${getItemType(item)}-${item.product.id}-${item.variant?.id ?? 'base'}`;

export default function CartScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const items = useCartStore(state => state.items);
  const updateQuantity = useCartStore(state => state.updateQuantity);
  const removeItem = useCartStore(state => state.removeItem);
  const clearCart = useCartStore(state => state.clearCart);
  const appliedCouponCode = useCartStore(state => state.appliedCouponCode);
  const appliedCouponId = useCartStore(state => state.appliedCouponId);
  const appliedCoupon = useCartStore(state => state.appliedCoupon);
  const couponAutoApplyDisabled = useCartStore(state => state.couponAutoApplyDisabled);
  const setAppliedCoupon = useCartStore(state => state.setAppliedCoupon);
  const softClearAppliedCoupon = useCartStore(state => state.softClearAppliedCoupon);
  const setFreeDeliveryProgress = useCartStore(state => state.setFreeDeliveryProgress);
  const setFreeDeliveryUnlocked = useCartStore(state => state.setFreeDeliveryUnlocked);
  const syncItemPricesFromServer = useCartStore(state => state.syncItemPricesFromServer);
  const removeUnavailableItems = useCartStore(state => state.removeUnavailableItems);
  const shopStatus = useSettingsStore(state => state.shopStatus);
  // Bumped by useDeliveryZoneSync on a delivery_zones.updated push (admin
  // saved a zone) — included below purely to retrigger the bill recompute.
  const deliveryZonesVersion = useDeliveryZonesStore(state => state.version);

  const [isCalculating, setIsCalculating] = useState(false);
  const [bill, setBill] = useState(null);
  const [calcError, setCalcError] = useState(null);
  // Bumped on screen focus so bill + unit prices re-pull even if qty unchanged.
  const [focusTick, setFocusTick] = useState(0);

  const reducedMotion = useReducedMotion();

  useFocusEffect(
    useCallback(() => {
      // Drop the previous visit's bill immediately so the skeleton shows
      // right away instead of stale numbers lingering during the recalc
      // this bump triggers below.
      setBill(null);
      setCalcError(null);
      setFocusTick((n) => n + 1);
    }, []),
  );

  // Delivery location comes from the global store — live GPS in the
  // background (useDeliveryLocationSync) or a manually-dropped pin from
  // Home's "Change Location" flow. Permission is no longer gated by a
  // full-screen route before the dashboard (that was LocationPermissionGate);
  // Home now shows LocationPermissionCard inline instead, so coords can
  // legitimately be null here — the deliveryBlocked gate below is what stops
  // an undeliverable cart, not an upstream guarantee.
  const customerCoords = useDeliveryLocationStore(state => state.coords);

  // Animations
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const listOpacity = useRef(new Animated.Value(1)).current;
  const arrowAnim = useRef(new Animated.Value(0)).current;
  const freeDeliveryAnim = useRef(new Animated.Value(0)).current;
  const freeDeliveryEntrance = useRef(new Animated.Value(1)).current;
  const freeDeliveryShimmer = useRef(new Animated.Value(0)).current;
  const freeDeliveryBarGlow = useRef(new Animated.Value(0)).current;
  const freeDeliveryAmountPop = useRef(new Animated.Value(1)).current;
  const lastFreeDeliveryGoalKey = useRef(null);
  const lastFreeDeliveryAmountRef = useRef(null);
  const freeDeliveryLoopsRef = useRef(null);
  const [freeDeliveryTrackWidth, setFreeDeliveryTrackWidth] = useState(0);

  // Coupon card animations
  const couponEntranceAnim = useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;
  const couponContentOpacity = useRef(new Animated.Value(1)).current;
  const couponCheckScale = useRef(new Animated.Value(1)).current;
  const couponErrorShake = useRef(new Animated.Value(0)).current;
  const couponChevronNudge = useRef(new Animated.Value(0)).current;
  const prevCouponStateRef = useRef(undefined);
  const couponStateAnimRef = useRef(null);
  const validItems = useMemo(
    () => items.filter(item => item?.product?.id),
    [items],
  );

  // Cart-item entrance stagger: only the items present at mount animate in
  // with a per-index delay; items encountered later render fully visible.
  const initialItemKeysRef = useRef(null);
  if (initialItemKeysRef.current === null) {
    initialItemKeysRef.current = new Set(validItems.map(getItemKey));
  }
  const itemAnimsRef = useRef(new Map());
  const getItemAnim = (key) => {
    let anim = itemAnimsRef.current.get(key);
    if (!anim) {
      const isInitial = initialItemKeysRef.current.has(key);
      anim = new Animated.Value(isInitial && !reducedMotion ? 0 : 1);
      itemAnimsRef.current.set(key, anim);
    }
    return anim;
  };

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }).start();
  }, [fadeAnim]);

  useEffect(() => {
    if (reducedMotion) return undefined;
    const keys = Array.from(initialItemKeysRef.current);
    if (keys.length === 0) return undefined;
    const animations = keys.map((key, index) =>
      Animated.timing(getItemAnim(key), {
        toValue: 1,
        duration: screenMs,
        delay: index * staggerMs,
        easing,
        useNativeDriver: true,
      }),
    );
    const composite = Animated.parallel(animations);
    composite.start();
    return () => composite.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const arrowLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(arrowAnim, {
          toValue: 4,
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

  // Bill calculations are async and can resolve out of order (e.g. an
  // auto-apply confirmation request that was already in flight when the
  // user tapped "remove" can resolve AFTER the removal request and
  // silently re-apply the coupon it was confirming). This sequence guard
  // makes sure only the response to the MOST RECENT request is ever
  // applied to state — any earlier, now-stale response is dropped.
  const billRequestSeqRef = useRef(0);

  const calculateBill = async () => {
    const seq = ++billRequestSeqRef.current;

    if (validItems.length === 0) {
      setBill(null);
      setFreeDeliveryProgress(null);
      setFreeDeliveryUnlocked(false);
      return;
    }

    setIsCalculating(true);
    setCalcError(null);

    Animated.timing(listOpacity, { toValue: 0.5, duration: 100, useNativeDriver: true }).start();

    try {
      const payload = {
        items: validItems.map(item => ({
          productId: item.product.id,
          variantId: item.variant?.id ?? null,
          quantity: item.quantity,
          type: item.type || (item.product?.isCombo || item.product?.is_combo ? 'combo' : 'product'),
          isCombo: (item.type || (item.product?.isCombo || item.product?.is_combo ? 'combo' : 'product')) === 'combo',
        })),
        coupon_code: appliedCouponCode || undefined,
        // Identifies a specific tapped offer that has no code of its own
        // (auto-apply-only coupons can have a null code) — lets the backend
        // force-apply that exact offer instead of falling back to "the best
        // available one", which would silently override the user's tap.
        coupon_id: !appliedCouponCode && appliedCouponId ? appliedCouponId : undefined,
        // Tells the backend not to silently auto-apply the next-best offer
        // when no code is present — set once the user explicitly removes
        // their coupon, so "remove" actually zeroes out the discount.
        no_auto_apply: couponAutoApplyDisabled,
        // Without this the API can't match a delivery zone at all and
        // silently falls back to flat pricing — see customerCoords above.
        latitude: customerCoords?.lat,
        longitude: customerCoords?.lng,
      };
      const calculatedBill = normalizeCartCalculation(await cartApi.calculate(payload));
      if (seq !== billRequestSeqRef.current) return; // a newer request superseded this one
      setBill(calculatedBill);
      setFreeDeliveryProgress(calculatedBill.freeDeliveryProgress);
      setFreeDeliveryUnlocked(Boolean(
        calculatedBill.appliedCoupon
        && Number(calculatedBill.appliedCoupon.freeDeliveryWaiver || 0) > 0,
      ));
      // Refresh local cart line prices from server so list + mini-cart match
      // Item Total after an admin price change (bill already uses live prices).
      syncItemPricesFromServer(calculatedBill.items);
      // Drop OOS / deleted / closed-shop lines so cart never sticks on a dead
      // item or shows a hard "something went wrong" calculate error.
      if (calculatedBill.unavailableItems?.length) {
        const removed = removeUnavailableItems(calculatedBill.unavailableItems);
        if (removed.length > 0) {
          const names = removed.map((r) => r.product?.name).filter(Boolean);
          const label = names.length === 1 ? names[0] : `${names.length} items`;
          showToast(`${label} removed — out of stock`, { type: 'info' });
        }
      }
      // Sync applied coupon from the bill response (handles auto-apply + validation).
      // When the backend returns no coupon (free-delivery min no longer met after
      // removing items, or auto-apply has nothing eligible), soft-clear local
      // state so the green "Applied" row drops and free-delivery progress /
      // unlocked offers recalculate. Do NOT use clearAppliedCoupon here — that
      // sets couponAutoApplyDisabled and would permanently block re-auto-apply
      // until the user manually applies something again.
      if (calculatedBill.appliedCoupon) {
        setAppliedCoupon(calculatedBill.appliedCoupon.code, calculatedBill.appliedCoupon);
      } else if (appliedCoupon || appliedCouponCode || appliedCouponId) {
        softClearAppliedCoupon();
      }
      Animated.timing(listOpacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    } catch (err) {
      if (seq !== billRequestSeqRef.current) return;
      setCalcError(err.message || 'Failed to calculate bill');
      Animated.timing(listOpacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    } finally {
      if (seq === billRequestSeqRef.current) setIsCalculating(false);
    }
  };

  useEffect(() => {
    // Debounce bill recalculation to avoid rapid successive API calls.
    // focusTick re-runs on every Cart visit so live admin prices apply.
    // customerCoords re-runs this once a GPS fix lands so the flat-priced
    // first pass gets replaced by the zone-matched charge.
    const timer = setTimeout(() => {
      calculateBill();
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, appliedCouponCode, appliedCouponId, couponAutoApplyDisabled, focusTick, deliveryZonesVersion, customerCoords]);

  const handleRemove = (id, type = 'product', variantId = null) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    removeItem(id, type, variantId);
  };

  const handleClear = () => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    clearCart();
  };

  const handleCheckout = () => {
    navigation.navigate('Checkout');
  };

  const renderEmptyState = () => (
    <EmptyState
      icon={<AppIcon name="cart" size={56} color={colors.textTertiary} />}
      title="Your cart is empty"
      subtitle="Looks like you haven't added anything to your cart yet."
      actionLabel="Start Shopping"
      onAction={() => navigation.navigate('MainTabs', { screen: 'Home' })}
      style={styles.emptyState}
    />
  );

  // The server zeroes every charge when it refuses the location (pin outside
  // every zone, inside a no-delivery exclusion square, or no coordinates at
  // all while zone pricing is on). Without these the bill rendered a ₹0
  // delivery charge as a cheerful "FREE" and left Proceed to Pay enabled, so
  // the customer only discovered the refusal one screen later at Checkout.
  const outOfRange = Boolean(bill?.outOfRange);
  const excluded = Boolean(bill?.excluded);
  const deliveryBlocked = outOfRange || excluded;
  const deliveryBlockedMessage = excluded
    ? (bill?.exclusionMessage || 'Delivery is not available at this location.')
    : bill?.nearestZoneName
    ? `Outside delivery area. Move your pin inside ${bill.nearestZoneName} to order.`
    : 'Outside delivery area. Set a delivery location we cover to continue.';

  const isCheckoutDisabled =
    validItems.length === 0 ||
    isCalculating ||
    calcError ||
    shopStatus === 'closed' ||
    deliveryBlocked ||
    !bill;

  const bottomBarHeight = 78 + insets.bottom;
  const checkoutBtnText = deliveryBlocked
    ? 'Delivery not available here'
    : bill
    ? `Proceed to Pay  •  ₹${bill.grandTotal}`
    : 'Checkout';

  const freeDeliveryProgress = bill?.freeDeliveryProgress || null;
  const nearestOfferProgress = bill?.nearestOfferProgress || null;

  // Single unlock ladder: free-delivery coupon first (backend nulls this once
  // unlocked / applied), then the nearest discount offer. Same animated bar
  // under Grand Total — never two status bars.
  const unlockProgress = useMemo(() => {
    if (freeDeliveryProgress) {
      return {
        kind: 'free_delivery',
        minOrder: Number(freeDeliveryProgress.minOrder || 0),
        amountRemaining: Number(freeDeliveryProgress.amountRemaining || 0),
        minItemCount: Number(freeDeliveryProgress.minItemCount || 0),
        itemsRemaining: Number(freeDeliveryProgress.itemsRemaining || 0),
        title: 'free delivery',
      };
    }
    if (nearestOfferProgress) {
      return {
        kind: 'offer',
        minOrder: Number(nearestOfferProgress.minOrder || 0),
        amountRemaining: Number(nearestOfferProgress.amountRemaining || 0),
        minItemCount: Number(nearestOfferProgress.minItemCount || 0),
        itemsRemaining: Number(nearestOfferProgress.itemsRemaining || 0),
        title: nearestOfferProgress.title || 'offer',
      };
    }
    return null;
  }, [freeDeliveryProgress, nearestOfferProgress]);

  const unlockPercent = useMemo(() => {
    if (!unlockProgress || !unlockProgress.minOrder) return 0;
    const subtotal = bill?.subtotal || 0;
    const minOrder = unlockProgress.minOrder;
    return Math.min(100, Math.max(0, (subtotal / minOrder) * 100));
  }, [unlockProgress, bill?.subtotal]);

  // Applied-only coupon UI (auto-apply). No manual pick list under the bill.
  const couponState = appliedCoupon
    ? 'applied'
    : bill?.couponError
    ? 'error'
    : 'empty';

  const formatOfferBadge = (coupon) => {
    if (!coupon) return null;
    if (Number(coupon.discount) > 0) return `Save ₹${coupon.discount}`;
    if (coupon.discountType === 'free_delivery') return 'Free delivery';
    if (coupon.discountType === 'percent') return `${coupon.discountValue}% off`;
    if (coupon.discountType === 'flat') return `₹${coupon.discountValue} off`;
    return null;
  };

  // Higher ladder offers not yet unlocked — display-only under the applied row.
  // auto_apply only so the list matches what the system will auto-upgrade to.
  const futureOffers = useMemo(() => {
    if (!appliedCoupon) return [];
    const appliedId = appliedCoupon.id;
    const appliedSavings = Number(appliedCoupon.discount || bill?.discount || 0);
    const subtotal = Number(bill?.subtotal || 0);
    const list = bill?.availableCoupons || [];

    return list
      .filter((coupon) => {
        if (!coupon) return false;
        if (appliedId != null && coupon.id === appliedId) return false;
        if (coupon.autoApply === false) return false;
        if (coupon.available === false) return false;
        // Still locked on amount and/or item count.
        const locked = coupon.unlocked === false
          || Number(coupon.amountRemaining || 0) > 0
          || Number(coupon.itemsRemaining || 0) > 0;
        if (!locked) return false;
        const couponSavings = Number(coupon.discount || 0);
        const couponMin = Number(coupon.minOrder || 0);
        // Greater = more savings at its threshold, or min order still ahead of cart.
        return couponSavings > appliedSavings || couponMin > subtotal;
      })
      .slice()
      .sort((a, b) => {
        const minDiff = Number(a.minOrder || 0) - Number(b.minOrder || 0);
        if (minDiff !== 0) return minDiff;
        return Number(b.discount || 0) - Number(a.discount || 0);
      });
  }, [appliedCoupon, bill?.availableCoupons, bill?.discount, bill?.subtotal]);

  const formatUnlockHint = (coupon) => {
    const parts = [];
    const amountLeft = Number(coupon.amountRemaining || 0);
    const itemsLeft = Number(coupon.itemsRemaining || 0);
    if (amountLeft > 0) parts.push(`₹${amountLeft.toFixed(0)} more`);
    if (itemsLeft > 0) {
      parts.push(`${itemsLeft} more item${itemsLeft === 1 ? '' : 's'}`);
    }
    if (parts.length === 0) {
      const minOrder = Number(coupon.minOrder || 0);
      const sub = Number(bill?.subtotal || 0);
      if (minOrder > sub) parts.push(`₹${(minOrder - sub).toFixed(0)} more`);
    }
    if (parts.length === 0) return 'To be unlocked';
    return `Add ${parts.join(' and ')} to unlock`;
  };

  // Animate the unlock progress bar smoothly whenever the percentage changes.
  useEffect(() => {
    if (reducedMotion) {
      freeDeliveryAnim.setValue(unlockPercent);
      return;
    }
    Animated.spring(freeDeliveryAnim, {
      toValue: unlockPercent,
      friction: 7,
      tension: 48,
      useNativeDriver: false,
    }).start();
  }, [unlockPercent, freeDeliveryAnim, reducedMotion]);

  // Soft entrance when the active unlock goal changes (free delivery ↔ offer).
  useEffect(() => {
    const goalKey = unlockProgress
      ? `${unlockProgress.kind}:${unlockProgress.title}:${unlockProgress.minOrder}:${unlockProgress.minItemCount || 0}`
      : null;
    if (!goalKey) {
      freeDeliveryEntrance.setValue(0);
      lastFreeDeliveryGoalKey.current = null;
      return;
    }
    if (goalKey === lastFreeDeliveryGoalKey.current) {
      freeDeliveryEntrance.setValue(1);
      return;
    }
    lastFreeDeliveryGoalKey.current = goalKey;
    if (reducedMotion) {
      freeDeliveryEntrance.setValue(1);
      return;
    }
    freeDeliveryEntrance.setValue(0);
    Animated.timing(freeDeliveryEntrance, {
      toValue: 1,
      ...motionConfig.screen,
    }).start();
  }, [unlockProgress, freeDeliveryEntrance, reducedMotion]);

  // Status-bar motion: continuous shimmer + glow while unlock progress is
  // on screen. Cart recalculation swaps Bill Summary for a skeleton
  // (isCalculating), which unmounts the bar and detaches native-driver
  // loops — so we must STOP while calculating and RESTART when the bar
  // remounts. Recursive .start({ finished }) is more reliable than
  // Animated.loop({ resetBeforeIteration }) on some Android RN builds.
  const hasUnlockProgress = Boolean(unlockProgress);
  useEffect(() => {
    const stopLoops = () => {
      const active = freeDeliveryLoopsRef.current;
      if (active) {
        active.alive = false;
        freeDeliveryShimmer.stopAnimation();
        freeDeliveryBarGlow.stopAnimation();
        freeDeliveryLoopsRef.current = null;
      }
    };

    stopLoops();

    // No bar on screen (no progress, reduced motion, or skeleton loading).
    if (!hasUnlockProgress || reducedMotion || isCalculating) {
      if (!hasUnlockProgress || reducedMotion) {
        freeDeliveryShimmer.setValue(0);
        freeDeliveryBarGlow.setValue(0);
      }
      return stopLoops;
    }

    const token = { alive: true };
    freeDeliveryLoopsRef.current = token;

    const runShimmer = () => {
      if (!token.alive) return;
      freeDeliveryShimmer.setValue(0);
      Animated.timing(freeDeliveryShimmer, {
        toValue: 1,
        duration: 1400,
        easing: RNEasing.linear,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished && token.alive) runShimmer();
      });
    };

    const runGlow = () => {
      if (!token.alive) return;
      Animated.sequence([
        Animated.timing(freeDeliveryBarGlow, {
          toValue: 1,
          duration: 900,
          easing,
          useNativeDriver: true,
        }),
        Animated.timing(freeDeliveryBarGlow, {
          toValue: 0,
          duration: 900,
          easing,
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished && token.alive) runGlow();
      });
    };

    freeDeliveryShimmer.setValue(0);
    freeDeliveryBarGlow.setValue(0);
    runShimmer();
    runGlow();

    return stopLoops;
  }, [
    hasUnlockProgress,
    isCalculating,
    reducedMotion,
    freeDeliveryShimmer,
    freeDeliveryBarGlow,
  ]);

  // Pop the remaining amount when it changes (qty updates).
  useEffect(() => {
    if (!unlockProgress) {
      lastFreeDeliveryAmountRef.current = null;
      return;
    }
    const nextKey = `${unlockProgress.kind}:${unlockProgress.amountRemaining}:${unlockProgress.itemsRemaining}`;
    if (lastFreeDeliveryAmountRef.current == null) {
      lastFreeDeliveryAmountRef.current = nextKey;
      return;
    }
    if (lastFreeDeliveryAmountRef.current === nextKey) return;
    lastFreeDeliveryAmountRef.current = nextKey;
    if (reducedMotion) return;
    freeDeliveryAmountPop.setValue(0.86);
    Animated.spring(freeDeliveryAmountPop, {
      toValue: 1,
      friction: 5,
      tension: 140,
      useNativeDriver: true,
    }).start();
  }, [
    unlockProgress?.kind,
    unlockProgress?.amountRemaining,
    unlockProgress?.itemsRemaining,
    unlockProgress,
    freeDeliveryAmountPop,
    reducedMotion,
  ]);

  // Coupon card first-appearance animation: fade + slide up once, then a
  // subtle one-time chevron nudge. Runs only on mount, never on recalculation.
  useEffect(() => {
    if (reducedMotion) {
      couponEntranceAnim.setValue(1);
      return;
    }

    const entrance = Animated.timing(couponEntranceAnim, {
      toValue: 1,
      duration: motionConfig.screen.duration,
      easing,
      useNativeDriver: true,
    });
    const nudge = Animated.sequence([
      Animated.timing(couponChevronNudge, { toValue: 4, duration: 160, easing, useNativeDriver: true }),
      Animated.timing(couponChevronNudge, { toValue: 0, duration: 160, easing, useNativeDriver: true }),
    ]);

    Animated.sequence([entrance, Animated.delay(80), nudge]).start();

    return () => {
      entrance.stop();
      nudge.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Crossfade + micro-animation when the coupon card genuinely changes state
  // (available → applied → error → empty). Guarded so it never re-fires on
  // bill recalculations that leave the state unchanged.
  useEffect(() => {
    const isFirstRun = prevCouponStateRef.current === undefined;
    const changed = prevCouponStateRef.current !== couponState;
    prevCouponStateRef.current = couponState;

    couponStateAnimRef.current?.stop();

    if (reducedMotion) {
      couponContentOpacity.setValue(1);
      couponCheckScale.setValue(1);
      couponErrorShake.setValue(0);
      return;
    }

    if (isFirstRun || !changed) return;

    couponContentOpacity.setValue(0);
    const crossfade = Animated.timing(couponContentOpacity, {
      toValue: 1,
      duration: smallMs,
      easing,
      useNativeDriver: true,
    });

    let stateAnim = null;
    if (couponState === 'error') {
      couponErrorShake.setValue(0);
      stateAnim = Animated.sequence([
        Animated.timing(couponErrorShake, { toValue: 1, duration: 45, useNativeDriver: true }),
        Animated.timing(couponErrorShake, { toValue: -1, duration: 45, useNativeDriver: true }),
        Animated.timing(couponErrorShake, { toValue: 1, duration: 45, useNativeDriver: true }),
        Animated.timing(couponErrorShake, { toValue: 0, duration: 45, useNativeDriver: true }),
      ]);
    }

    const combined = stateAnim ? Animated.parallel([crossfade, stateAnim]) : crossfade;
    couponStateAnimRef.current = combined;
    combined.start();

    return () => {
      combined.stop();
    };
  }, [couponState, reducedMotion, couponContentOpacity, couponCheckScale, couponErrorShake]);

  // Bounce the "Applied" check icon whenever a new coupon becomes applied
  // (auto-apply often has null code — key by id).
  const prevAppliedKeyRef = useRef(undefined);
  useEffect(() => {
    const key = appliedCoupon
      ? `${appliedCoupon.id ?? ''}:${appliedCoupon.code ?? ''}`
      : null;
    const isFirstRun = prevAppliedKeyRef.current === undefined;
    const prevKey = prevAppliedKeyRef.current;
    prevAppliedKeyRef.current = key;

    if (isFirstRun || reducedMotion || !key || key === prevKey) return;

    couponCheckScale.setValue(0.75);
    Animated.sequence([
      Animated.timing(couponCheckScale, { toValue: 1.08, duration: 140, easing, useNativeDriver: true }),
      Animated.timing(couponCheckScale, { toValue: 1, duration: 120, easing, useNativeDriver: true }),
    ]).start();
  }, [appliedCoupon, reducedMotion, couponCheckScale]);

  const renderBillSkeleton = () => (
    <View style={styles.billCard}>
      <LoadingSkeleton style={styles.billSkeletonTitle} />
      <View style={styles.billSkeletonRows}>
        <LoadingSkeleton width="55%" height={14} />
        <LoadingSkeleton width="45%" height={14} />
        <LoadingSkeleton width="60%" height={14} />
      </View>
      <View style={styles.billSkeletonDivider} />
      <LoadingSkeleton width="70%" height={22} />
    </View>
  );

  const renderBillSummary = () => {
    if (!bill) return null;

    // Delivery reads as free either because the raw charge is ₹0 (e.g. a
    // free zone) or because a coupon (free_delivery type, or a flat/percent
    // coupon combined with "also give free delivery") waived it.
    // deliveryBlocked is excluded explicitly: the server also sends ₹0 when
    // it REFUSES the location, and rendering that as "FREE" advertised free
    // delivery to somewhere we won't deliver at all.
    const deliveryFree = !deliveryBlocked
      && (bill.deliveryCharge === 0 || bill.isFreeDeliveryApplied);
    const discountToShow = bill.isFreeDeliveryApplied ? bill.itemDiscount : bill.discount;

    return (
      <Animated.View style={[styles.billCard, { opacity: listOpacity }]}>
        <Text style={styles.billTitle}>Bill Summary</Text>

        {deliveryBlocked ? (
          <View style={styles.deliveryBlockedRow} accessibilityLiveRegion="polite">
            <AppIcon name="warning" size={14} color={colors.error} />
            <Text style={styles.deliveryBlockedText}>{deliveryBlockedMessage}</Text>
          </View>
        ) : null}

        <View style={styles.billRows}>
          <BillRow label="Item Total" value={`₹${bill.subtotal}`} />
          <BillRow
            label="Delivery Charge"
            value={deliveryBlocked ? '—' : deliveryFree ? 'FREE' : `₹${bill.deliveryCharge}`}
            valueStyle={deliveryFree ? styles.freeDeliveryValue : null}
            strikethroughValue={bill.isFreeDeliveryApplied ? `₹${bill.deliveryCharge}` : null}
          />
          {bill.nightCharge > 0 && (
            <BillRow
              label="Night Charge"
              value={`₹${bill.nightCharge}`}
              valueStyle={styles.nightChargeValue}
            />
          )}
          {bill.rainCharge > 0 && (
            <BillRow
              label="Rain Charge"
              value={`₹${bill.rainCharge}`}
              valueStyle={styles.nightChargeValue}
            />
          )}
          {discountToShow > 0 && (
            <BillRow
              label="Discount"
              value={`− ₹${discountToShow}`}
              valueStyle={styles.discountValue}
            />
          )}
        </View>

        <View style={styles.billDivider} />

        <View style={styles.grandTotalRow}>
          <Text style={styles.grandTotalLabel}>Grand Total</Text>
          <Text style={styles.grandTotalValue}>₹{bill.grandTotal}</Text>
        </View>

        {unlockProgress ? <View style={styles.fdDivider} /> : null}

        {unlockProgress ? renderUnlockProgress() : null}
      </Animated.View>
    );
  };

  const renderUnlockProgress = () => {
    if (!unlockProgress) return null;

    const amountLeft = Number(unlockProgress.amountRemaining || 0);
    const itemsLeft = Number(unlockProgress.itemsRemaining || 0);
    const unlockLabel = unlockProgress.title || 'offer';
    const a11y = buildProgressHintText(unlockProgress, {
      suffix: ` to unlock ${unlockLabel}`,
    });

    let remainingHighlight = null;
    if (amountLeft > 0) {
      remainingHighlight = (
        <Text style={styles.fdAmount}>₹{amountLeft.toFixed(0)}</Text>
      );
    } else if (itemsLeft > 0) {
      remainingHighlight = (
        <Text style={styles.fdAmount}>
          {itemsLeft} item{itemsLeft === 1 ? '' : 's'}
        </Text>
      );
    }

    const trackW = freeDeliveryTrackWidth > 0 ? freeDeliveryTrackWidth : 240;
    const showTip = unlockPercent > 4 && unlockPercent < 99;

    return (
      <Animated.View
        style={[
          styles.freeDeliveryBox,
          {
            opacity: freeDeliveryEntrance,
            transform: [{
              translateY: freeDeliveryEntrance.interpolate({
                inputRange: [0, 1],
                outputRange: [entryDistance, 0],
              }),
            }],
          },
        ]}
        accessibilityLabel={a11y}
      >
        <View style={styles.fdTitleRow}>
          <AppIcon name="ticket" size={16} color={colors.saffron} strokeWidth={2.4} />
          <Animated.View
            style={[
              styles.fdLine,
              { transform: [{ scale: freeDeliveryAmountPop }] },
            ]}
          >
            {remainingHighlight ? (
              <Text style={styles.fdLineBody} numberOfLines={1}>
                <Text style={styles.fdLineBody}>Add </Text>
                {remainingHighlight}
                <Text style={styles.fdLineBody}> to unlock {unlockLabel}</Text>
              </Text>
            ) : (
              <Text style={styles.fdLineBody} numberOfLines={1}>
                Unlock {unlockLabel}
              </Text>
            )}
          </Animated.View>
        </View>

        <View
          style={styles.fdProgressTrack}
          onLayout={(e) => {
            const w = e.nativeEvent.layout.width;
            if (w > 0 && Math.abs(w - freeDeliveryTrackWidth) > 1) {
              setFreeDeliveryTrackWidth(w);
            }
          }}
        >
          <Animated.View
            style={[
              styles.fdProgressFillWrap,
              {
                width: freeDeliveryAnim.interpolate({
                  inputRange: [0, 100],
                  outputRange: ['0%', '100%'],
                  extrapolate: 'clamp',
                }),
              },
            ]}
          >
            <Animated.View
              style={[
                styles.fdProgressFillInner,
                {
                  opacity: reducedMotion
                    ? 1
                    : freeDeliveryBarGlow.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0.86, 1],
                      }),
                },
              ]}
            >
              <LinearGradient
                colors={['#FFC29A', colors.btnHighlightStart, colors.saffron, colors.saffronDark]}
                locations={[0, 0.28, 0.68, 1]}
                start={{ x: 0, y: 0.5 }}
                end={{ x: 1, y: 0.5 }}
                style={styles.fdProgressFill}
              />
              {showTip && !reducedMotion ? (
                <Animated.View
                  pointerEvents="none"
                  style={[
                    styles.fdProgressTip,
                    {
                      transform: [{
                        scale: freeDeliveryBarGlow.interpolate({
                          inputRange: [0, 1],
                          outputRange: [1, 1.35],
                        }),
                      }],
                    },
                  ]}
                />
              ) : null}
            </Animated.View>
          </Animated.View>

          {!reducedMotion ? (
            <Animated.View
              pointerEvents="none"
              style={[
                styles.fdShimmer,
                {
                  opacity: freeDeliveryShimmer.interpolate({
                    inputRange: [0, 0.1, 0.5, 0.9, 1],
                    outputRange: [0, 1, 1, 1, 0],
                  }),
                  transform: [{
                    translateX: freeDeliveryShimmer.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-80, trackW + 20],
                    }),
                  }],
                },
              ]}
            >
              <LinearGradient
                colors={[
                  'transparent',
                  'rgba(255,255,255,0.25)',
                  'rgba(255,255,255,0.95)',
                  'rgba(255,255,255,0.25)',
                  'transparent',
                ]}
                locations={[0, 0.25, 0.5, 0.75, 1]}
                start={{ x: 0, y: 0.5 }}
                end={{ x: 1, y: 0.5 }}
                style={StyleSheet.absoluteFillObject}
              />
            </Animated.View>
          ) : null}
        </View>
      </Animated.View>
    );
  };

  // Auto-apply only: show the best applied coupon under the bill. No list,
  // no tap-to-apply, no coupon sheet — server pickBest upgrades as cart grows.
  const renderCouponCard = () => {
    const entranceStyle = {
      opacity: couponEntranceAnim,
      transform: [{
        translateY: couponEntranceAnim.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }),
      }],
    };

    if (couponState === 'empty') {
      return null;
    }

    if (couponState === 'error') {
      return (
        <Animated.View style={entranceStyle}>
          <View
            style={[styles.couponCard, styles.couponCardError]}
            accessible
            accessibilityLabel={bill?.couponError || "Offer couldn't apply"}
          >
            <Animated.View
              style={[
                styles.couponCardInner,
                {
                  opacity: couponContentOpacity,
                  transform: [{ translateX: Animated.multiply(couponErrorShake, 4) }],
                },
              ]}
            >
              <View style={[styles.couponIconWrap, styles.couponIconWrapError]}>
                <AppIcon name="close" size={18} color={colors.error} />
              </View>
              <View style={styles.couponTextWrap}>
                <Text style={styles.couponStatusLabelError} numberOfLines={1}>
                  {"Offer couldn't apply"}
                </Text>
                <Text style={styles.couponErrorText} numberOfLines={2}>
                  {bill?.couponError}
                </Text>
              </View>
            </Animated.View>
          </View>
        </Animated.View>
      );
    }

    // couponState === 'applied'
    const savings = bill?.discount > 0
      ? `Save ₹${bill.discount}`
      : formatOfferBadge(appliedCoupon);

    return (
      <Animated.View style={entranceStyle}>
        <View style={styles.couponOffersSection}>
          <View style={styles.couponOffersHeadingRow}>
            <View style={styles.couponOffersHeadingLeft}>
              <AppIcon name="ticket" size={16} color={colors.saffron} />
              <Text style={styles.couponOffersHeading}>Applied offer</Text>
            </View>
          </View>

          <View
            style={[styles.couponOfferCard, styles.couponOfferCardApplied]}
            accessible
            accessibilityRole="text"
            accessibilityLabel={`Best offer applied: ${appliedCoupon.title}${
              savings ? `, ${savings}` : ''
            }`}
          >
            <View style={[styles.couponOfferIconFrame, styles.couponOfferIconFrameApplied]}>
              <Animated.View style={{ transform: [{ scale: couponCheckScale }] }}>
                <AppIcon name="check" size={16} color={colors.textInverse} strokeWidth={3} />
              </Animated.View>
            </View>
            <View style={styles.couponOfferText}>
              <View style={styles.couponOfferTitleRow}>
                <Text style={styles.couponOfferTitle} numberOfLines={1}>
                  {appliedCoupon.title}
                </Text>
                <View style={styles.bestBadge}>
                  <Text style={styles.bestBadgeText}>BEST</Text>
                </View>
              </View>
              {appliedCoupon.description ? (
                <Text style={styles.couponOfferDesc} numberOfLines={1}>
                  {appliedCoupon.description}
                </Text>
              ) : savings ? (
                <Text style={styles.couponOfferDesc} numberOfLines={1}>
                  {savings}
                </Text>
              ) : null}
            </View>
            <View style={[styles.couponOfferSavingsPill, styles.couponOfferSavingsPillApplied]}>
              <Text
                style={[styles.couponOfferSavingsText, styles.couponOfferSavingsTextApplied]}
                numberOfLines={1}
              >
                Applied
              </Text>
            </View>
          </View>

          {futureOffers.length > 0 ? (
            <View style={styles.couponFutureList}>
              <Text style={styles.couponFutureHeading}>Better offers to unlock</Text>
              {futureOffers.map((coupon) => {
                const savings = formatOfferBadge(coupon);
                return (
                  <View
                    key={coupon.id || coupon.code || coupon.title}
                    style={styles.couponFutureRow}
                    accessible
                    accessibilityRole="text"
                    accessibilityLabel={`${coupon.title}. ${formatUnlockHint(coupon)}${
                      savings ? `. ${savings}` : ''
                    }`}
                  >
                    <AppIcon
                      name="ticket"
                      size={16}
                      color={colors.saffron}
                      strokeWidth={2.2}
                      style={styles.couponFutureIcon}
                    />
                    <View style={styles.couponOfferText}>
                      <Text style={styles.couponFutureTitle} numberOfLines={1}>
                        {coupon.title}
                      </Text>
                      <Text style={styles.couponFutureHint} numberOfLines={1}>
                        {formatUnlockHint(coupon)}
                      </Text>
                    </View>
                    {savings ? (
                      <Text style={styles.couponFutureSavings} numberOfLines={1}>
                        {savings}
                      </Text>
                    ) : (
                      <Text style={styles.couponFutureLocked} numberOfLines={1}>
                        Locked
                      </Text>
                    )}
                  </View>
                );
              })}
            </View>
          ) : null}
        </View>
      </Animated.View>
    );
  };

  return (
    <AppScreen style={styles.container} safeAreaBottom={false}>
      <AppHeader
        title="Your Cart"
        onBack={() => navigation.goBack()}
        rightActions={validItems.length > 0 ? [
          {
            icon: (
              <View style={styles.clearBtnContent}>
                <AppIcon name="delete" size={12} color={colors.error} />
                <Text style={styles.clearBtnText}>Clear</Text>
              </View>
            ),
            onPress: handleClear,
            label: 'Clear Cart',
            style: styles.clearHeaderBtn,
          }
        ] : []}
      />

      {validItems.length === 0 ? (
        renderEmptyState()
      ) : (
        <View style={styles.content}>
          <ScrollView
            contentContainerStyle={[
              styles.scrollContent,
              { paddingBottom: bottomBarHeight + spacing.lg },
            ]}
            showsVerticalScrollIndicator={false}
          >
            {/* Cart Items — white outer card, compact open rows inside */}
            <Animated.View
              style={[
                styles.itemsCard,
                {
                  opacity: fadeAnim,
                  transform: [{
                    translateY: fadeAnim.interpolate({ inputRange: [0, 1], outputRange: [entryDistance, 0] }),
                  }],
                },
              ]}
            >
              {validItems.map((item, index) => {
                const itemType = getItemType(item);
                const itemKey = getItemKey(item);
                const itemAnim = getItemAnim(itemKey);
                const qty = Number(item.quantity) || 0;
                const unitPrice = Number(item.variant?.price ?? item.product.price ?? 0);
                const lineTotal = unitPrice * qty;
                // Live unit price + line total (price × qty) so both update when
                // either admin price sync or stepper qty changes.
                const metaBits = [
                  item.variant?.label,
                  item.product.unit,
                  unitPrice > 0 ? `₹${unitPrice.toFixed(0)} each` : null,
                ].filter(Boolean);
                const isLast = index === validItems.length - 1;

                return (
                  <Animated.View
                    key={itemKey}
                    style={{
                      opacity: itemAnim,
                      transform: [{
                        translateY: itemAnim.interpolate({ inputRange: [0, 1], outputRange: [entryDistance, 0] }),
                      }],
                    }}
                  >
                    <View style={styles.itemRow}>
                      <ProductImage
                        uri={item.product.imageUri || item.product.imageUrl}
                        width={52}
                        height={52}
                        borderRadius={radius.sm}
                        style={styles.itemImage}
                      />

                      <View style={styles.itemBody}>
                        <Text style={styles.itemName} numberOfLines={2}>
                          {item.product.name}
                        </Text>
                        {metaBits.length > 0 ? (
                          <Text style={styles.itemMeta} numberOfLines={1}>
                            {metaBits.join(' · ')}
                          </Text>
                        ) : null}
                        {lineTotal > 0 ? (
                          <Text style={styles.itemLineTotal}>₹{lineTotal.toFixed(0)}</Text>
                        ) : null}
                        {!item.product.available ? (
                          <Text style={styles.itemUnavailable}>Currently unavailable</Text>
                        ) : null}
                      </View>

                      <View style={styles.itemStepperWrap}>
                        <QuantityStepper
                          dense
                          quantity={qty}
                          onIncrement={() => updateQuantity(item.product.id, qty + 1, itemType, item.variant?.id ?? null)}
                          onDecrement={() => {
                            if (qty <= 1) handleRemove(item.product.id, itemType, item.variant?.id ?? null);
                            else updateQuantity(item.product.id, qty - 1, itemType, item.variant?.id ?? null);
                          }}
                        />
                      </View>
                    </View>
                    {!isLast ? <View style={styles.itemDivider} /> : null}
                  </Animated.View>
                );
              })}
            </Animated.View>

            {/* Shop Closed Warning */}
            {shopStatus === 'closed' && (
              <View style={styles.shopClosedBox}>
                <AppIcon name="close" size={18} color={colors.error} />
                <Text style={styles.shopClosedText}>
                  The shop is currently closed. You can review your cart, but checkout is unavailable.
                </Text>
              </View>
            )}

            {/* Bill Summary */}
            {isCalculating ? renderBillSkeleton() : calcError ? (
              <View style={styles.billCard}>
                <ErrorState
                  message={calcError}
                  onRetry={calculateBill}
                  retryLabel="Retry"
                  style={styles.calcError}
                />
              </View>
            ) : renderBillSummary()}

            {/* Coupon / Offer Section */}
            {renderCouponCard()}
          </ScrollView>

          {/* Sticky Checkout Bar */}
          <Animated.View
            style={[
              styles.bottomBar,
              { paddingBottom: spacing.md + insets.bottom },
            ]}
          >
            <PressableScale
              onPress={handleCheckout}
              disabled={isCheckoutDisabled}
              style={[
                styles.checkoutBtn,
                isCheckoutDisabled && styles.checkoutBtnDisabled,
              ]}
              scaleTo={0.96}
              accessibilityRole="button"
              accessibilityLabel={bill ? `Proceed to Pay, ₹${bill.grandTotal}` : 'Checkout'}
            >
              <View style={styles.checkoutBtnContent}>
                <Text style={[
                  styles.checkoutBtnText,
                  isCheckoutDisabled && styles.checkoutBtnTextDisabled,
                ]}>
                  {checkoutBtnText}
                </Text>
                {!isCheckoutDisabled && (
                  <Animated.View style={[styles.checkoutArrow, { transform: [{ translateX: arrowAnim }] }]}>
                    <AppIcon name="chevronRight" size={18} color="#FFFFFF" />
                  </Animated.View>
                )}
              </View>
            </PressableScale>
          </Animated.View>
        </View>
      )}
    </AppScreen>
  );
}

function BillRow({ label, value, valueStyle, strikethroughValue }) {
  return (
    <View style={styles.billRow}>
      <Text style={styles.billRowLabel}>{label}</Text>
      <View style={styles.billRowValueGroup}>
        {strikethroughValue ? (
          <Text style={styles.billRowStrikethrough}>{strikethroughValue}</Text>
        ) : null}
        <Text style={[styles.billRowValue, valueStyle]}>{value}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgApp,
  },
  content: {
    flex: 1,
  },
  clearHeaderBtn: {
    width: 'auto',
    height: 30,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.errorLight,
    borderWidth: 1,
    borderColor: colors.errorBorder,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    gap: 4,
  },
  clearBtnContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  clearBtnText: {
    ...typography.labelSmall,
    color: colors.error,
    fontWeight: '700',
    fontSize: 11,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  scrollContent: {
    paddingTop: spacing.md,
    paddingHorizontal: spacing.screenPaddingH,
  },

  // ── Cart items (white outer card, compact rows inside) ────────
  itemsCard: {
    backgroundColor: colors.bgSurface,
    borderRadius: radius.lg,
    borderWidth: borderWidth.thin,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    marginBottom: spacing.md,
    ...shadows.sm,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  itemDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.divider,
    marginLeft: 52 + spacing.md, // under text (image width + gap)
  },
  itemImage: {
    width: 52,
    height: 52,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceMuted,
  },
  itemBody: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
  },
  itemName: {
    ...typography.label,
    color: colors.textPrimary,
    fontWeight: '700',
    fontSize: 14,
    lineHeight: 18,
  },
  itemMeta: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 3,
  },
  itemLineTotal: {
    ...typography.label,
    color: colors.textPrimary,
    fontWeight: '700',
    fontSize: 13,
    marginTop: 3,
  },
  itemUnavailable: {
    ...typography.captionMedium,
    color: colors.error,
    marginTop: 2,
  },
  itemStepperWrap: {
    flexShrink: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },

  shopClosedBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.errorLight,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: borderWidth.thin,
    borderColor: colors.errorBorder,
    gap: spacing.sm,
  },
  shopClosedText: {
    ...typography.body,
    color: colors.error,
    flex: 1,
  },

  // ── Bill Summary ──────────────────────────────────────────────
  billCard: {
    backgroundColor: colors.bgSurface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: borderWidth.thin,
    borderColor: colors.border,
    marginBottom: spacing.md,
    ...shadows.sm,
  },
  billTitle: {
    ...typography.h4,
    color: colors.textPrimary,
    fontWeight: '700',
    marginBottom: spacing.md,
  },
  billRows: {
    gap: spacing.sm,
  },
  billRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  billRowLabel: {
    ...typography.body,
    color: colors.textSecondary,
  },
  billRowValue: {
    ...typography.label,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  freeDeliveryValue: {
    color: colors.success,
    fontWeight: '700',
  },
  deliveryBlockedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.errorLight || 'rgba(220,53,69,0.08)',
    borderRadius: radius.sm,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    marginBottom: spacing.sm,
  },
  deliveryBlockedText: {
    ...typography.label,
    flex: 1,
    color: colors.error,
    fontWeight: '600',
  },
  billRowValueGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  billRowStrikethrough: {
    ...typography.label,
    color: colors.textSecondary,
    textDecorationLine: 'line-through',
  },
  nightChargeValue: {
    color: colors.textPrimary,
  },
  discountValue: {
    color: colors.success,
  },
  billDivider: {
    height: borderWidth.thin,
    backgroundColor: colors.divider,
    marginVertical: spacing.md,
  },
  grandTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  grandTotalLabel: {
    ...typography.h4,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  grandTotalValue: {
    ...typography.priceLarge,
    color: colors.textPrimary,
    fontWeight: '800',
  },

  fdDivider: {
    height: borderWidth.thin,
    backgroundColor: colors.divider,
    marginTop: spacing.md,
    marginBottom: spacing.md,
  },
  freeDeliveryBox: {
    marginTop: 0,
  },
  fdTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginBottom: spacing.sm + 2,
  },
  fdLine: {
    flex: 1,
    flexShrink: 1,
  },
  fdLineBody: {
    ...typography.label,
    color: colors.saffronDark,
    fontWeight: '700',
    fontSize: 14,
    letterSpacing: 0.1,
  },
  fdAmount: {
    color: colors.saffron,
    fontWeight: '800',
    fontSize: 16,
    letterSpacing: -0.2,
  },
  fdProgressTrack: {
    height: 14,
    backgroundColor: 'rgba(255, 122, 58, 0.12)',
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  fdProgressFillWrap: {
    height: '100%',
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  fdProgressFillInner: {
    flex: 1,
    borderRadius: radius.pill,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  fdProgressFill: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: radius.pill,
  },
  fdProgressTip: {
    position: 'absolute',
    right: 2,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.textInverse,
    borderWidth: 2,
    borderColor: colors.saffronDark,
  },
  fdShimmer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 78,
  },
  billSkeletonTitle: {
    height: 18,
    width: '38%',
    marginBottom: spacing.md,
  },
  billSkeletonRows: {
    gap: spacing.sm,
  },
  billSkeletonDivider: {
    height: borderWidth.thin,
    backgroundColor: colors.divider,
    marginVertical: spacing.md,
  },
  calcError: {
    paddingVertical: 0,
  },

  // ── Coupon card (rectangular, aligned with Bill Summary card) ───
  couponCard: {
    borderRadius: radius.lg,
    borderWidth: borderWidth.thin,
    marginBottom: spacing.md,
    overflow: 'hidden',
  },
  couponCardInner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    minWidth: 0,
  },
  couponCardError: {
    backgroundColor: colors.errorLight,
    borderColor: colors.errorBorder,
    ...shadows.sm,
  },
  couponCardEmpty: {
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
  },
  couponAction: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
    marginLeft: spacing.sm,
    flexShrink: 0,
  },
  couponIconWrap: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
    flexShrink: 0,
  },
  couponIconWrapError: {
    backgroundColor: colors.error + '1A',
  },
  couponIconWrapEmpty: {
    backgroundColor: colors.bgDisabled,
  },
  couponTextWrap: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
  },
  couponStatusLabelError: {
    ...typography.captionMedium,
    color: colors.error,
    fontWeight: '700',
  },
  couponStatusLabelEmpty: {
    ...typography.captionMedium,
    color: colors.textTertiary,
    fontWeight: '700',
  },
  couponSubtextEmpty: {
    ...typography.caption,
    color: colors.textTertiary,
    marginTop: 2,
  },
  couponErrorText: {
    ...typography.caption,
    color: colors.error,
    marginTop: 2,
  },
  couponActionCaptionError: {
    ...typography.label,
    color: colors.error,
    fontWeight: '800',
  },
  couponInlineError: {
    ...typography.caption,
    color: colors.error,
  },

  // ── Applied offer + future unlocks (auto-apply, display only) ──
  couponOffersSection: {
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  couponOffersHeadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.xs,
  },
  couponOffersHeadingLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  couponFutureList: {
    marginTop: spacing.xs,
    gap: spacing.sm,
  },
  couponFutureHeading: {
    ...typography.captionMedium,
    color: colors.saffronDark,
    fontWeight: '800',
    letterSpacing: 0.2,
    marginBottom: 2,
  },
  couponFutureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.bgSurface,
    borderRadius: radius.md,
  },
  couponFutureIcon: {
    marginRight: spacing.sm + 2,
    flexShrink: 0,
  },
  couponFutureTitle: {
    ...typography.label,
    color: colors.textPrimary,
    fontWeight: '700',
    flexShrink: 1,
  },
  couponFutureHint: {
    ...typography.caption,
    color: colors.saffronDark,
    fontWeight: '600',
    marginTop: 2,
  },
  couponFutureSavings: {
    ...typography.labelSmall,
    color: colors.saffron,
    fontWeight: '800',
    marginLeft: spacing.sm,
    flexShrink: 0,
  },
  couponFutureLocked: {
    ...typography.captionMedium,
    color: colors.textTertiary,
    fontWeight: '700',
    marginLeft: spacing.sm,
    flexShrink: 0,
  },
  couponOffersHeading: {
    ...typography.label,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  couponOffersCount: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  couponOfferCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgSurface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: borderWidth.thin,
    borderStyle: 'dashed',
    borderColor: colors.saffron + '59',
    ...shadows.sm,
  },
  couponOfferCardApplied: {
    backgroundColor: colors.successLight,
    borderColor: colors.success + '59',
  },
  couponOfferIconFrame: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.saffronLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
    flexShrink: 0,
  },
  couponOfferIconFrameApplied: {
    backgroundColor: colors.success,
  },
  couponOfferText: {
    flex: 1,
    minWidth: 0,
  },
  couponOfferTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  couponOfferTitle: {
    ...typography.label,
    color: colors.textPrimary,
    fontWeight: '700',
    flexShrink: 1,
  },
  bestBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.sm,
    backgroundColor: colors.saffron,
  },
  bestBadgeText: {
    ...typography.captionMedium,
    fontSize: 10,
    color: colors.textInverse,
    fontWeight: '800',
  },
  couponOfferDesc: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  couponOfferSavingsPill: {
    backgroundColor: colors.saffronLight,
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: spacing.md,
    marginLeft: spacing.sm,
    flexShrink: 0,
  },
  couponOfferSavingsPillApplied: {
    backgroundColor: colors.success,
  },
  couponOfferSavingsText: {
    ...typography.labelSmall,
    color: colors.saffronDark,
    fontWeight: '800',
  },
  couponOfferSavingsTextApplied: {
    color: colors.textInverse,
  },
  couponShowMoreBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: borderWidth.thin,
    borderColor: colors.saffron + '40',
    backgroundColor: colors.bgSurface,
  },
  couponShowMoreText: {
    ...typography.label,
    color: colors.saffronDark,
    fontWeight: '700',
  },

  // ── Sticky checkout bar ───────────────────────────────────────
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.bgSurface,
    borderTopWidth: borderWidth.thin,
    borderTopColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    ...shadows.lg,
  },
  checkoutBtn: {
    height: layout.buttonHeightLarge,
    backgroundColor: colors.success,
    borderRadius: radius.button,
    justifyContent: 'center',
    alignItems: 'center',
    ...shadows.lg,
    shadowColor: colors.success,
  },
  checkoutBtnDisabled: {
    backgroundColor: colors.bgDisabled,
    ...shadows.none,
  },
  checkoutBtnContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  checkoutBtnText: {
    ...typography.buttonLarge,
    color: colors.textInverse,
    fontWeight: '800',
  },
  checkoutBtnTextDisabled: {
    color: colors.textDisabled,
  },
  checkoutArrow: {
    justifyContent: 'center',
    alignItems: 'center',
  },
});
