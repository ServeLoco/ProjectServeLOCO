import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Animated,
  Dimensions,
  Modal,
  Linking,
  ActivityIndicator,
  RefreshControl,
  PanResponder,
  TouchableOpacity,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useNavigation, useRoute } from '@react-navigation/native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  AppScreen,
  AppHeader,
  AppIcon,
  Button,
  PressableScale,
  NotificationPermissionModal,
  ErrorState,
  RiderLiveMap,
} from '../../../components';
import { colors, typography, spacing, radius, shadows } from '../../../theme';
import { useSettingsStore, useCartStore, useDeliveryLocationStore } from '../../../stores';
import { ordersApi, subscribeOrderEvents, subscribeRealtime, subscribeRealtimeLifecycle } from '../../../api';
import { showToast } from '../../../components/Toast';
import { normalizeImageUrl, normalizeOrder } from '../../../utils';
import * as Notifications from 'expo-notifications';
import { requestNotificationPermission, checkNotificationPermission, readAskedState } from '../../../hooks/useLocalNotifications';
import {
  getRealtimeOrderId,
  getRealtimeOrderKey,
  isRecentRealtimeEvent,
  mergeOrderRealtimePatch,
} from '../../../utils/realtimeOrder';
import {
  formatCancelReasonForCustomer,
  pickCancelReason,
} from '../../../utils/cancelReason';
import { getReorderEligibility } from '../../../utils/reorderEligibility';

const WIN_H = Dimensions.get('window').height;
// Checkout-style sheet: collapsed = big map; expanded = order details.
const SHEET_COLLAPSED = Math.round(WIN_H * 0.47);
const SHEET_EXPANDED = Math.round(WIN_H * 0.78);
const SHEET_MID = (SHEET_COLLAPSED + SHEET_EXPANDED) / 2;

const STATUS_STEPS = [
  {
    id: 'Pending',
    label: 'Order Placed',
    shortLabel: 'Placed',
    accent: colors.saffron,
    gradientEnd: colors.saffronDark,
    icon: 'shoppingBag',
    hint: 'We received your order',
  },
  {
    id: 'Accepted',
    label: 'Order Accepted',
    shortLabel: 'Accepted',
    accent: colors.success,
    gradientEnd: colors.successDark,
    icon: 'check',
    hint: 'Store confirmed your order',
  },
  {
    id: 'Preparing',
    label: 'Preparing/Packing',
    shortLabel: 'Preparing',
    accent: colors.info,
    gradientEnd: '#1D4ED8',
    icon: 'box',
    hint: 'Your items are being packed',
  },
  {
    id: 'Out for Delivery',
    label: 'Out for Delivery',
    shortLabel: 'On Way',
    accent: colors.saffron,
    gradientEnd: colors.saffronDark,
    icon: 'navigation',
    hint: 'Rider is heading to you',
  },
  {
    id: 'Delivered',
    label: 'Delivered',
    shortLabel: 'Delivered',
    accent: colors.success,
    gradientEnd: colors.successDark,
    icon: 'check',
    hint: 'Order completed successfully',
  },
];

const normalizeTimelineStatus = (status) => {
  if (status === 'OutForDelivery' || status === 'Out_For_Delivery') return 'Out for Delivery';
  return status || 'Pending';
};

const getCancelledOrderPatch = (response) => {
  const responseOrder = response?.order || response?.data;
  if (!responseOrder || responseOrder.success) {
    return { status: 'Cancelled' };
  }

  return normalizeOrder(responseOrder);
};

const getCancelledPaymentStatus = (paymentMethod) => (
  paymentMethod === 'UPI' ? 'Refunded' : 'Failed'
);

const getPaymentStatusTheme = (status) => {
  switch (status) {
    case 'Paid':
    case 'Success':
    case 'Refunded':
      return {
        color: colors.successDark,
        background: colors.successLight,
      };
    case 'Failed':
      return {
        color: colors.error,
        background: colors.errorLight,
      };
    case 'Pending':
    default:
      return {
        color: colors.warning,
        background: colors.warningLight,
      };
  }
};

export default function OrderDetailScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const insets = useSafeAreaInsets();
  const orderId = route.params?.orderId;
  const supportPhone = useSettingsStore(state => state.supportPhone);

  const [order, setOrder] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState('');

  // Sheet scroll only — map is a sibling behind the sheet (checkout pattern).
  const scrollRef = useRef(null);
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const sheetExpandedRef = useRef(false);
  const sheetHeightAnim = useRef(new Animated.Value(SHEET_COLLAPSED)).current;
  const sheetHeightNum = useRef(SHEET_COLLAPSED);
  const sheetDragStart = useRef(SHEET_COLLAPSED);
  const scrollYRef = useRef(0);
  const [sheetReserve, setSheetReserve] = useState(SHEET_COLLAPSED);

  const snapSheet = useCallback((expanded) => {
    const h = expanded ? SHEET_EXPANDED : SHEET_COLLAPSED;
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
  }, [sheetHeightAnim]);

  const sheetPanResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_, g) => {
      if (Math.abs(g.dy) < 6) return false;
      if (Math.abs(g.dy) < Math.abs(g.dx) * 1.1) return false;
      if (!sheetExpandedRef.current) return true;
      if (sheetHeightNum.current < SHEET_EXPANDED - 4) return true;
      if (scrollYRef.current <= 2 && g.dy > 4) return true;
      return false;
    },
    onMoveShouldSetPanResponderCapture: (_, g) => {
      if (Math.abs(g.dy) < 6) return false;
      if (Math.abs(g.dy) < Math.abs(g.dx) * 1.1) return false;
      if (!sheetExpandedRef.current) return true;
      if (sheetHeightNum.current < SHEET_EXPANDED - 4) return true;
      if (scrollYRef.current <= 2 && g.dy > 4) return true;
      return false;
    },
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => {
      sheetDragStart.current = sheetHeightNum.current;
    },
    onPanResponderMove: (_, g) => {
      const next = Math.min(
        SHEET_EXPANDED,
        Math.max(SHEET_COLLAPSED, sheetDragStart.current - g.dy),
      );
      sheetHeightAnim.setValue(next);
      sheetHeightNum.current = next;
      sheetExpandedRef.current = next >= SHEET_MID;
    },
    onPanResponderRelease: (_, g) => {
      const current = sheetHeightNum.current;
      const flingUp = g.vy < -0.55;
      const flingDown = g.vy > 0.55;
      if (flingUp) snapSheet(true);
      else if (flingDown) snapSheet(false);
      else snapSheet(current >= SHEET_MID);
    },
    onPanResponderTerminate: () => {
      snapSheet(sheetHeightNum.current >= SHEET_MID);
    },
  }), [sheetHeightAnim, snapSheet]);

  // Modal State
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelError, setCancelError] = useState(null);

  // Notification Permission Modal State
  const [showNotificationModal, setShowNotificationModal] = useState(false);

  // Modal Animations
  const modalOpacity = useRef(new Animated.Value(0)).current;
  const modalScale = useRef(new Animated.Value(0.8)).current;
  const realtimeLoadTimer = useRef(null);
  const recentRealtimeEvents = useRef({});

  const loadOrder = React.useCallback((refresh = false) => {
    if (refresh) {
      setIsRefreshing(true);
    } else {
      setIsLoading(true);
    }
    setLoadError('');
    ordersApi.getOrder(orderId)
      .then(response => {
        setOrder(normalizeOrder(response?.order || response?.data || response));
      })
      .catch(error => setLoadError(error.message || 'Failed to load order'))
      .finally(() => {
        setIsLoading(false);
        setIsRefreshing(false);
      });
  }, [orderId]);

  useEffect(() => {
    loadOrder();
  }, [loadOrder]);

  // Show the in-app notification nudge only when:
  //   1. OS has NOT granted permission, AND
  //   2. The user has not yet been asked (login flow handles first-ask), OR
  //      the user explicitly denied it (so we can send them to Settings).
  // We deliberately skip the modal when the OS returns 'undetermined' after the
  // system dialog was already shown — on some Android builds getPermissionsAsync
  // returns 'undetermined' right after the user taps "Allow", which previously
  // caused the modal to flash even for users who already granted access.
  useEffect(() => {
    let timer;
    (async () => {
      try {
        const isGranted = await checkNotificationPermission();
        if (isGranted) return;

        const { status: osStatus } = await Notifications.getPermissionsAsync();
        const askedState = await readAskedState();

        // Only show the modal when we're confident the user denied access:
        //   - OS explicitly reports 'denied', OR
        //   - User was never asked at all (edge case: bypassed login flow).
        // Skip when os returns 'undetermined' even after asking — some Android
        // builds report this transiently after granting, and we don't want to
        // falsely tell the user to "enable in Settings".
        const explicitlyDenied = osStatus === 'denied';
        const neverAsked = !askedState.asked;

        if (explicitlyDenied || neverAsked) {
          timer = setTimeout(() => setShowNotificationModal(true), 2000);
        }
      } catch {
        // Non-critical; swallow silently.
      }
    })();
    return () => clearTimeout(timer);
  }, []);

  const queueRealtimeLoad = React.useCallback(() => {
    if (realtimeLoadTimer.current) {
      clearTimeout(realtimeLoadTimer.current);
    }

    realtimeLoadTimer.current = setTimeout(() => {
      loadOrder(true);
    }, 350);
  }, [loadOrder]);

  useEffect(() => {
    const unsubscribeOrders = subscribeOrderEvents(({ eventName, payload }) => {
      const eventOrderId = getRealtimeOrderId(payload);
      if (!eventOrderId || eventOrderId !== String(orderId)) return;

      const eventKey = getRealtimeOrderKey(eventName, payload);
      if (isRecentRealtimeEvent(recentRealtimeEvents, eventKey)) return;

      setOrder(prevOrder => mergeOrderRealtimePatch(prevOrder, payload));
      queueRealtimeLoad();
    });

    // Rider accepted → parent order reloads (rider info); map also listens itself.
    const unsubscribeAssign = subscribeRealtime('rider.assignment.updated', (payload) => {
      const eventOrderId = getRealtimeOrderId(payload);
      if (!eventOrderId || eventOrderId !== String(orderId)) return;
      queueRealtimeLoad();
    });

    const unsubscribeLifecycle = subscribeRealtimeLifecycle(({ eventName }) => {
      if (eventName === 'reconnected' || eventName === 'foreground') {
        queueRealtimeLoad();
      }
    });

    return () => {
      unsubscribeOrders();
      unsubscribeAssign();
      unsubscribeLifecycle();
      if (realtimeLoadTimer.current) {
        clearTimeout(realtimeLoadTimer.current);
      }
    };
  }, [orderId, queueRealtimeLoad]);

  const openModal = () => {
    setShowCancelModal(true);
    Animated.parallel([
      Animated.timing(modalOpacity, { toValue: 1, duration: 250, useNativeDriver: true }),
      Animated.spring(modalScale, { toValue: 1, friction: 6, useNativeDriver: true })
    ]).start();
  };

  const closeModal = () => {
    Animated.parallel([
      Animated.timing(modalOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
      Animated.timing(modalScale, { toValue: 0.8, duration: 200, useNativeDriver: true })
    ]).start(() => {
      setShowCancelModal(false);
      setCancelError(null);
    });
  };

  const confirmCancel = () => {
    setIsCancelling(true);
    setCancelError(null);
    ordersApi.cancelOrder(order.id)
      .then(response => {
        const cancelled = getCancelledOrderPatch(response);
        // Stop modal animations immediately before state changes to avoid
        // useNativeDriver conflict when TimelineStep re-renders.
        modalOpacity.stopAnimation();
        modalScale.stopAnimation();
        setShowCancelModal(false);
        setOrder(prev => ({
          ...prev,
          ...cancelled,
          id: prev.id,
          status: cancelled.status || 'Cancelled',
          paymentStatus: cancelled.paymentStatus || getCancelledPaymentStatus(prev.paymentMethod),
          canCancel: false,
        }));
      })
      .catch(err => {
        // Surface the failure inside the modal so the user can retry instead of
        // staring at a stuck spinner.
        setCancelError(err?.message || 'Unable to cancel order. Please try again.');
      })
      .finally(() => setIsCancelling(false));
  };

  const riderPhone = (() => {
    const raw = order?.rider?.phone || order?.riderPhone || order?.rider_phone || null;
    if (!raw) return null;
    const digits = String(raw).replace(/[^0-9+]/g, '');
    return digits || null;
  })();

  // Pretty display for the Contact Rider box (still dials the raw tel: value).
  const riderPhoneDisplay = (() => {
    if (!riderPhone) return null;
    const digits = String(riderPhone).replace(/[^0-9]/g, '');
    if (digits.length === 10) return `${digits.slice(0, 5)} ${digits.slice(5)}`;
    if (digits.length === 12 && digits.startsWith('91')) {
      return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
    }
    return riderPhone;
  })();

  // After delivery, fall back to Help & Support (same as pre-assignment).
  // While rider is assigned and order is still active → Contact Rider + number.
  const isDelivered = order?.status === 'Delivered';
  const showContactRider = Boolean(riderPhone) && !isDelivered;
  const showHelpSupport = Boolean(supportPhone) && !showContactRider;

  // TASK 29.6 — see getReorderEligibility's own comment for why this is an
  // area comparison rather than a per-product existence check.
  const currentAreaId = useDeliveryLocationStore(state => state.areaId);
  const addCartItem = useCartStore(state => state.addItem);
  const addCartCombo = useCartStore(state => state.addCombo);
  const { showReorder, canReorder, blockedReason: reorderBlockedReason } = getReorderEligibility(order, currentAreaId);

  const handleReorder = () => {
    if (!canReorder) return;
    let addedCount = 0;
    order.items.forEach((item) => {
      const product = {
        id: item.product_id ?? item.productId,
        name: item.product_name ?? item.productName ?? 'Item',
        price: Number(item.unit_price ?? item.unitPrice ?? 0),
        available: true,
      };
      if (!product.id) return;
      const quantity = Number(item.quantity) || 1;
      if (item.item_type === 'combo' || item.type === 'combo') {
        addCartCombo(product, quantity);
      } else {
        const variantId = item.variant_id ?? item.variantId;
        const variant = variantId ? { id: variantId, label: item.variant_label ?? item.variantLabel ?? null, price: product.price } : null;
        addCartItem(product, quantity, variant);
      }
      addedCount += 1;
    });
    if (addedCount === 0) {
      showToast('Could not add these items to cart', { type: 'error' });
      return;
    }
    // CartScreen's own price/availability reconciliation (same mechanism a
    // zone change already relies on) catches anything actually gone since —
    // reorder doesn't need its own per-product validation on top of that.
    showToast('Added to cart', { type: 'success' });
    navigation.navigate('Cart');
  };

  const handleContactRider = () => {
    if (!riderPhone) return;
    Linking.openURL(`tel:${riderPhone}`);
  };

  // Same as Profile → Help & Support: open WhatsApp to store support number.
  const handleHelpSupport = () => {
    if (!supportPhone) return;
    const digits = String(supportPhone).replace(/[^0-9]/g, '');
    const withCountryCode = digits.length === 10 ? `91${digits}` : digits;
    Linking.openURL(`https://wa.me/${withCountryCode}`).catch(() => {});
  };

  const handleAllowNotifications = async () => {
    try {
      // The hook handles the AsyncStorage dedup internally — we only need
      // to close the local modal. Calling the hook twice is a noop.
      await requestNotificationPermission();
      setShowNotificationModal(false);
    } catch (error) {
      setShowNotificationModal(false);
    }
  };

  const handleDismissNotificationModal = async () => {
    setShowNotificationModal(false);
  };

  const cardEntrance = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!order) return;
    cardEntrance.setValue(0.92);
    Animated.spring(cardEntrance, {
      toValue: 1,
      friction: 8,
      tension: 90,
      useNativeDriver: true,
    }).start();
  }, [cardEntrance, order?.status]);

  if (isLoading) {
    return (
      <AppScreen style={styles.container}>
        <AppHeader title="Order Details" onBack={() => navigation.goBack()} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      </AppScreen>
    );
  }

  if (loadError || !order) {
    return (
      <AppScreen style={styles.container}>
        <AppHeader title="Order Details" onBack={() => navigation.goBack()} />
        <ErrorState
          message="Unable to load order details. Tap to retry."
          onRetry={() => loadOrder(false)}
          retryLabel="Retry"
        />
      </AppScreen>
    );
  }

  const displayPaymentStatus = order.status === 'Cancelled'
    ? getCancelledPaymentStatus(order.paymentMethod)
    : order.paymentStatus;
  const displayPaymentLabel = order.paymentMethod === 'UPI' && displayPaymentStatus === 'Pending'
    ? 'Checking'
    : displayPaymentStatus;
  const displayPaymentTheme = getPaymentStatusTheme(displayPaymentStatus);
  const hasDeliveryDistance = order.deliveryDistanceKm !== null && order.deliveryDistanceKm !== undefined;
  const timelineStatus = normalizeTimelineStatus(order.status);
  const stepIndex = Math.max(0, STATUS_STEPS.findIndex((step) => step.id === timelineStatus));
  const currentStep = STATUS_STEPS[stepIndex] || STATUS_STEPS[0];
  const isLastStep = stepIndex === STATUS_STEPS.length - 1;
  const progressPercent = STATUS_STEPS.length > 1
    ? (stepIndex / (STATUS_STEPS.length - 1)) * 100
    : 0;
  const orderItemCount = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const orderItemsSubtotal = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  // Delivery Charge is always the standard fee — Fast is a separate
  // additive line shown below, never discounted.
  const deliveryChargeLabel = order.bill.belowThresholdDelivery
    ? 'Delivery (Below Minimum)'
    : 'Delivery Charge';
  const billDiscount = order.bill.freeDeliveryApplied ? order.bill.itemDiscount : order.bill.discount;
  // Hide map after delivery or cancel — full sheet only (no live tracking map).
  const mapMode = order.status !== 'Cancelled' && order.status !== 'Delivered';
  const orderNumberLabel = order.orderNumber || order.order_number || order.id || orderId;

  return (
    <View style={styles.immersiveRoot}>
      {mapMode ? (
        <View style={styles.mapLayer} pointerEvents="box-none">
          <RiderLiveMap
            orderId={order.id || orderId}
            initialOrder={order}
            style={StyleSheet.absoluteFill}
            showLegend={false}
            immersive
            sheetReserve={sheetReserve}
          />
        </View>
      ) : (
        <View style={styles.manualBackdrop} />
      )}

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
          edges={mapMode ? [] : ['top']}
        >
          <View style={styles.sheetDragZone}>
            {mapMode ? <View style={styles.sheetHandle} /> : null}
            <View style={[styles.sheetHeader, !mapMode && styles.sheetHeaderManual]}>
              <View style={styles.sheetHeaderText}>
                <Text style={styles.sheetTitle}>Track Order</Text>
                <Text style={styles.sheetStatusLine} numberOfLines={1}>
                  {mapMode
                    ? `#${orderNumberLabel} · ${currentStep.label}`
                    : order.status === 'Delivered'
                      ? `#${orderNumberLabel} · Delivered`
                      : `#${orderNumberLabel} · Cancelled`}
                </Text>
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

          <ScrollView
            ref={scrollRef}
            style={styles.sheetScroll}
            contentContainerStyle={styles.sheetScrollContent}
            showsVerticalScrollIndicator={false}
            nestedScrollEnabled
            scrollEnabled={sheetExpanded || !mapMode}
            bounces={sheetExpanded || !mapMode}
            onScroll={(e) => {
              scrollYRef.current = e.nativeEvent.contentOffset.y;
            }}
            scrollEventThrottle={16}
            refreshControl={
              <RefreshControl
                refreshing={isRefreshing}
                onRefresh={() => loadOrder(true)}
                tintColor={colors.primary}
                colors={[colors.primary, colors.success, colors.saffron]}
                title="Refreshing ServeLoco"
                titleColor={colors.textSecondary}
              />
            }
          >

        {/* Status Timeline */}
        {order.status === 'Cancelled' ? (
          <Animated.View
            style={[
              styles.trackingCard,
              {
                opacity: cardEntrance.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.92, 1],
                }),
                transform: [{
                  translateY: cardEntrance.interpolate({
                    inputRange: [0, 1],
                    outputRange: [6, 0],
                  }),
                }],
              },
            ]}
          >
            <LinearGradient
              colors={[colors.error, '#B91C1C']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.trackingCancelledBar}
            >
              <View style={styles.trackingCancelledIcon}>
                <AppIcon name="close" size={16} color={colors.white} />
              </View>
              <Text style={styles.trackingCancelledTitle}>Order Cancelled</Text>
            </LinearGradient>
            <View style={styles.trackingCancelledReasonBox}>
              <Text style={styles.trackingCancelledReasonLabel}>Reason</Text>
              <Text style={styles.trackingCancelledReasonText}>
                {formatCancelReasonForCustomer(pickCancelReason(order))}
              </Text>
            </View>
          </Animated.View>
        ) : (
          <Animated.View
            style={[
              styles.trackingCard,
              {
                opacity: cardEntrance.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.92, 1],
                }),
                transform: [{
                  translateY: cardEntrance.interpolate({
                    inputRange: [0, 1],
                    outputRange: [6, 0],
                  }),
                }],
              },
            ]}
          >
            <LinearGradient
              colors={[currentStep.accent, currentStep.gradientEnd]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.trackingHeroBand}
            >
              <View style={styles.trackingHeroRow}>
                <View style={styles.trackingHeroTextCol}>
                  <Text style={styles.trackingHeroTitle} numberOfLines={1}>
                    {currentStep.label}
                  </Text>
                  <Text style={styles.trackingHeroHint} numberOfLines={1}>
                    {currentStep.hint}
                  </Text>
                </View>
                <View style={styles.trackingLivePill}>
                  <LivePulseDot color={colors.white} />
                  <Text style={styles.trackingLiveText}>LIVE TRACKING</Text>
                </View>
              </View>
            </LinearGradient>

            <View style={styles.trackingTrack}>
              <View style={styles.trackingTrackLineWrap} pointerEvents="none">
                <View style={styles.trackingTrackLineBg} />
                <View style={[styles.trackingTrackLineFill, { width: `${progressPercent}%` }]}>
                  <LinearGradient
                    colors={[colors.success, currentStep.accent]}
                    start={{ x: 0, y: 0.5 }}
                    end={{ x: 1, y: 0.5 }}
                    style={StyleSheet.absoluteFill}
                  />
                </View>
              </View>

              <View style={styles.trackingNodes}>
                {STATUS_STEPS.map((step, index) => {
                  const isCompleted = index < stepIndex || (isLastStep && index === stepIndex);
                  const isActive = index === stepIndex && !isLastStep;
                  const isPending = index > stepIndex;

                  return (
                    <TrackingNode
                      key={step.id}
                      step={step}
                      isCompleted={isCompleted}
                      isActive={isActive}
                      isPending={isPending}
                    />
                  );
                })}
              </View>
            </View>
          </Animated.View>
        )}


        {/* Item List */}
        <View style={styles.itemsSection}>
          <View style={styles.itemsSectionHeader}>
            <View style={styles.itemsSectionIconWrap}>
              <AppIcon name="shoppingBag" size={18} color={colors.saffron} />
            </View>
            <View style={styles.itemsSectionHeaderText}>
              <Text style={styles.itemsSectionTitle}>Your Items</Text>
              <Text style={styles.itemsSectionSubtitle}>
                {orderItemCount} {orderItemCount === 1 ? 'product' : 'products'} in this order
              </Text>
            </View>
          </View>

          {order.items.map((item, index) => (
            <OrderItemRow
              key={item.id}
              item={item}
              showDivider={index < order.items.length - 1}
            />
          ))}

          <View style={styles.itemsTotalRow}>
            <Text style={styles.itemsTotalLabel}>Items subtotal</Text>
            <Text style={styles.itemsTotalValue}>₹{orderItemsSubtotal}</Text>
          </View>
        </View>

        {/* Delivery & Payment */}
        <View style={styles.deliveryPaymentSection}>
          <View style={styles.deliveryPaymentHeader}>
            <View style={styles.deliveryPaymentIconWrap}>
              <AppIcon name="location" size={18} color={colors.success} />
            </View>
            <View style={styles.deliveryPaymentHeaderText}>
              <Text style={styles.deliveryPaymentTitle}>Delivery & Payment</Text>
              <Text style={styles.deliveryPaymentSubtitle}>Address and payment details</Text>
            </View>
          </View>

          <View style={styles.deliveryPaymentRow}>
            <View style={[styles.deliveryPaymentRowIcon, styles.deliveryPaymentRowIconAddress]}>
              <AppIcon name="map" size={15} color={colors.success} />
            </View>
            <View style={styles.deliveryPaymentRowBody}>
              <Text style={styles.deliveryPaymentLabel}>Delivery address</Text>
              <Text style={styles.deliveryPaymentValue}>{order.address}</Text>
              {order.mapUrl ? (
                <PressableScale
                  onPress={() => Linking.openURL(order.mapUrl)}
                  style={styles.deliveryMapLink}
                  scaleTo={0.98}
                >
                  <AppIcon name="navigation" size={13} color={colors.success} />
                  <Text style={styles.deliveryMapLinkText}>Open in Maps</Text>
                </PressableScale>
              ) : null}
            </View>
          </View>

          {hasDeliveryDistance ? (
            <View style={[styles.deliveryPaymentRow, styles.deliveryPaymentRowDivider]}>
              <View style={[styles.deliveryPaymentRowIcon, styles.deliveryPaymentRowIconDistance]}>
                <AppIcon name="navigation" size={15} color={colors.info} />
              </View>
              <View style={styles.deliveryPaymentRowBody}>
                <Text style={styles.deliveryPaymentLabel}>Delivery distance</Text>
                <Text style={styles.deliveryPaymentValue}>
                  {Number(order.deliveryDistanceKm).toFixed(2)} km
                </Text>
              </View>
            </View>
          ) : null}

          <View style={[styles.deliveryPaymentRow, styles.deliveryPaymentRowDivider]}>
            <View style={[styles.deliveryPaymentRowIcon, styles.deliveryPaymentRowIconPayment]}>
              <AppIcon name="creditCard" size={15} color={colors.saffron} />
            </View>
            <View style={styles.deliveryPaymentRowBody}>
              <Text style={styles.deliveryPaymentLabel}>Payment method</Text>
              <View style={styles.deliveryPaymentMethodRow}>
                <Text style={styles.deliveryPaymentMethod}>{order.paymentMethod}</Text>
                <View
                  style={[
                    styles.deliveryPaymentStatus,
                    { backgroundColor: displayPaymentTheme.background },
                  ]}
                >
                  <Text style={[styles.deliveryPaymentStatusText, { color: displayPaymentTheme.color }]}>
                    {displayPaymentLabel}
                  </Text>
                </View>
              </View>
            </View>
          </View>
        </View>

        {/* Bill Summary */}
        <View style={styles.billSection}>
          <View style={styles.billSectionHeader}>
            <View style={styles.billSectionIconWrap}>
              <AppIcon name="rupee" size={18} color={colors.textPrimary} />
            </View>
            <View style={styles.billSectionHeaderText}>
              <Text style={styles.billSectionTitle}>Bill Summary</Text>
              <Text style={styles.billSectionSubtitle}>Final amount breakdown</Text>
            </View>
          </View>

          <BillLineRow label="Subtotal" value={`₹${order.bill.subtotal}`} showDivider={false} />

          <BillLineRow
            label={deliveryChargeLabel}
            value={order.bill.freeDeliveryApplied ? (
              <View style={styles.billFreeDeliveryValueRow}>
                <Text style={styles.billStrikethrough}>₹{order.bill.delivery}</Text>
                <Text style={styles.billFreeDeliveryText}>FREE</Text>
              </View>
            ) : `₹${order.bill.delivery}`}
          />

          {order.bill.fastDeliveryFee > 0 ? (
            <BillLineRow
              label="Fast Delivery Add-on"
              value={`₹${order.bill.fastDeliveryFee}`}
              tone="warning"
            />
          ) : null}

          {order.bill.nightCharge > 0 ? (
            <BillLineRow
              label="Night Charge"
              value={`₹${order.bill.nightCharge}`}
              tone="warning"
            />
          ) : null}

          {order.bill.rainCharge > 0 ? (
            <BillLineRow
              label="Rain Charge"
              value={`₹${order.bill.rainCharge}`}
              tone="warning"
            />
          ) : null}

          {billDiscount > 0 ? (
            <BillLineRow
              label="Discount"
              value={`- ₹${billDiscount}`}
              tone="success"
            />
          ) : null}

          <View style={styles.billGrandTotalRow}>
            <Text style={styles.billGrandTotalLabel}>Grand Total</Text>
            <Text style={styles.billGrandTotalValue}>₹{order.bill.grandTotal}</Text>
          </View>
        </View>

          </ScrollView>

          {/* Sticky sheet footer — cancel / contact rider (with number) / help / reorder */}
          {(order.canCancel || showContactRider || showHelpSupport || showReorder) ? (
            <View
              style={[
                styles.sheetFooter,
                { paddingBottom: Math.max(insets.bottom, spacing.sm) },
              ]}
            >
              {/* 29.6 — never silently substitute another area's product;
                  show the order, disable Reorder, explain why instead. */}
              {reorderBlockedReason ? (
                <Text style={styles.reorderBlockedText}>{reorderBlockedReason}</Text>
              ) : null}
              <View style={styles.actionButtonsRow}>
                {showReorder ? (
                  <View style={styles.btnWrapper}>
                    <PressableScale
                      onPress={handleReorder}
                      disabled={!canReorder}
                      style={[styles.bottomBtn, styles.outlineBtn, !canReorder && styles.bottomBtnDisabled]}
                      scaleTo={0.96}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: !canReorder }}
                      accessibilityLabel={canReorder ? 'Reorder' : `Reorder unavailable: ${reorderBlockedReason}`}
                    >
                      <View style={styles.btnContent}>
                        <AppIcon name="orders" size={16} color={canReorder ? colors.success : colors.textMuted} />
                        <Text style={[styles.outlineBtnText, !canReorder && { color: colors.textMuted }]}>Reorder</Text>
                      </View>
                    </PressableScale>
                  </View>
                ) : null}
                {order.canCancel ? (
                  <View style={styles.btnWrapper}>
                    <PressableScale
                      onPress={openModal}
                      style={[styles.bottomBtn, styles.cancelBtn]}
                      scaleTo={0.96}
                    >
                      <View style={styles.btnContent}>
                        <AppIcon name="close" size={16} color={colors.error} />
                        <Text style={styles.cancelBtnText}>Cancel Order</Text>
                      </View>
                    </PressableScale>
                  </View>
                ) : null}
                {showContactRider ? (
                  <View style={styles.btnWrapper}>
                    <PressableScale
                      onPress={handleContactRider}
                      style={[styles.bottomBtn, styles.outlineBtn]}
                      scaleTo={0.96}
                      accessibilityRole="button"
                      accessibilityLabel={`Contact rider ${riderPhoneDisplay || riderPhone}`}
                    >
                      <View style={styles.btnContentStacked}>
                        <View style={styles.btnContentRow}>
                          <AppIcon name="phone" size={16} color={colors.success} />
                          <Text style={styles.outlineBtnText}>Contact Rider</Text>
                        </View>
                        {riderPhoneDisplay ? (
                          <Text style={styles.outlineBtnPhone} numberOfLines={1}>
                            {riderPhoneDisplay}
                          </Text>
                        ) : null}
                      </View>
                    </PressableScale>
                  </View>
                ) : showHelpSupport ? (
                  <View style={styles.btnWrapper}>
                    <PressableScale
                      onPress={handleHelpSupport}
                      style={[styles.bottomBtn, styles.outlineBtn]}
                      scaleTo={0.96}
                      accessibilityRole="button"
                      accessibilityLabel="Help and Support"
                    >
                      <View style={styles.btnContent}>
                        <AppIcon name="whatsapp" size={16} color={colors.success} />
                        <Text style={styles.outlineBtnText}>Help & Support</Text>
                      </View>
                    </PressableScale>
                  </View>
                ) : null}
              </View>
            </View>
          ) : null}
        </SafeAreaView>
      </Animated.View>

      {/* Cancel Modal */}
      <Modal visible={showCancelModal} transparent animationType="none" onRequestClose={closeModal}>
        <View style={styles.modalOverlay}>
          <Animated.View style={[styles.modalBackdrop, { opacity: modalOpacity }]} />
          <Animated.View style={[styles.modalContent, { opacity: modalOpacity, transform: [{ scale: modalScale }] }]}>
            <AppIcon name="orders" size={34} color={colors.warning} style={styles.modalIcon} />
            <Text style={styles.modalTitle}>Cancel Order?</Text>
            <Text style={styles.modalDesc}>Are you sure you want to cancel this order? This action cannot be undone.</Text>
            {cancelError ? (
              <Text style={[styles.modalDesc, { color: colors.error, marginTop: 4 }]}>{cancelError}</Text>
            ) : null}

            <View style={styles.modalActions}>
              <Button
                label="Keep Order"
                onPress={closeModal}
                disabled={isCancelling}
                style={styles.modalBtn}
              />
              <Button
                label={isCancelling ? "Cancelling..." : "Cancel Order"}
                variant="outline"
                onPress={confirmCancel}
                disabled={isCancelling}
                style={[styles.modalBtn, { borderColor: colors.error }]}
                labelStyle={{ color: colors.error }}
              />
            </View>
          </Animated.View>
        </View>
      </Modal>

      <NotificationPermissionModal
        visible={showNotificationModal}
        onAllow={handleAllowNotifications}
        onDismiss={handleDismissNotificationModal}
      />
    </View>
  );
}

function BillLineRow({ label, value, tone, showDivider = true }) {
  const labelStyle = tone === 'success'
    ? styles.billLineLabelSuccess
    : tone === 'warning'
      ? styles.billLineLabelWarning
      : null;
  const valueStyle = tone === 'success'
    ? styles.billLineValueSuccess
    : tone === 'warning'
      ? styles.billLineValueWarning
      : null;

  return (
    <View style={[styles.billLineRow, showDivider && styles.billLineRowDivider]}>
      <Text style={[styles.billLineLabel, labelStyle]}>{label}</Text>
      {typeof value === 'string' ? (
        <Text style={[styles.billLineValue, valueStyle]}>{value}</Text>
      ) : (
        value
      )}
    </View>
  );
}

function OrderItemRow({ item, showDivider }) {
  const imageUri = normalizeImageUrl(item.imageUrl || item.image_url || item.imageUri || '');
  const lineTotal = item.price * item.quantity;

  return (
    <View style={[styles.itemRow, showDivider && styles.itemRowDivider]}>
      {imageUri ? (
        <ExpoImage
          source={{ uri: imageUri }}
          style={styles.itemThumb}
          contentFit="cover"
          transition={120}
        />
      ) : (
        <View style={styles.itemThumbFallback}>
          <AppIcon name="box" size={18} color={colors.saffron} />
        </View>
      )}

      <View style={styles.itemCardBody}>
        <Text style={styles.itemCardName} numberOfLines={2}>{item.name}</Text>
        {item.unit ? (
          <Text style={styles.itemCardUnit} numberOfLines={1}>{item.unit}</Text>
        ) : null}
        <View style={styles.itemQtyBadge}>
          <Text style={styles.itemQtyBadgeText}>Qty {item.quantity}</Text>
        </View>
      </View>

      <View style={styles.itemCardPriceCol}>
        <Text style={styles.itemCardPrice}>₹{lineTotal}</Text>
        {item.quantity > 1 ? (
          <Text style={styles.itemCardUnitPrice}>₹{item.price} each</Text>
        ) : null}
      </View>
    </View>
  );
}

function LivePulseDot({ color }) {
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.8, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <View style={styles.liveDotWrap}>
      <Animated.View
        style={[
          styles.liveDotPulse,
          {
            backgroundColor: color,
            transform: [{ scale: pulse }],
            opacity: pulse.interpolate({ inputRange: [1, 1.8], outputRange: [0.45, 0] }),
          },
        ]}
      />
      <View style={[styles.liveDotCore, { backgroundColor: color }]} />
    </View>
  );
}

function TrackingNode({ step, isCompleted, isActive, isPending }) {
  const activePulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    let pulseLoop;
    if (isActive) {
      activePulse.stopAnimation();
      activePulse.setValue(1);
      pulseLoop = Animated.loop(
        Animated.sequence([
          Animated.timing(activePulse, {
            toValue: 1.45,
            duration: 900,
            useNativeDriver: true,
          }),
          Animated.timing(activePulse, {
            toValue: 1,
            duration: 900,
            useNativeDriver: true,
          }),
        ])
      );
      pulseLoop.start();
    } else {
      activePulse.stopAnimation();
      activePulse.setValue(1);
    }

    return () => {
      if (pulseLoop) {
        pulseLoop.stop();
      }
    };
  }, [isActive, activePulse]);

  const iconName = isCompleted ? 'check' : step.icon;
  const iconColor = isCompleted
    ? colors.white
    : isActive
      ? step.accent
      : colors.textHint;

  return (
    <View style={styles.trackingNode}>
      <View style={styles.trackingDotWrap}>
        {isActive ? (
          <Animated.View
            style={[
              styles.trackingDotPulse,
              {
                backgroundColor: step.accent + '30',
                transform: [{ scale: activePulse }],
                opacity: activePulse.interpolate({
                  inputRange: [1, 1.45],
                  outputRange: [0.55, 0],
                }),
              },
            ]}
          />
        ) : null}
        <View
          style={[
            styles.trackingDot,
            isCompleted && styles.trackingDotDone,
            isActive && [styles.trackingDotActive, { borderColor: step.accent }],
            isPending && styles.trackingDotPending,
          ]}
        >
          <AppIcon name={iconName} size={isActive ? 15 : 13} color={iconColor} />
        </View>
      </View>
      <Text
        style={[
          styles.trackingNodeLabel,
          isCompleted && styles.trackingNodeLabelDone,
          isActive && [styles.trackingNodeLabelActive, { color: step.accent }],
          isPending && styles.trackingNodeLabelPending,
        ]}
        numberOfLines={1}
      >
        {step.shortLabel}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgApp,
  },
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
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  sheetHeaderManual: {
    paddingTop: spacing.sm,
  },
  sheetHeaderText: {
    flex: 1,
    paddingLeft: spacing.lg + spacing.sm,
  },
  sheetIconBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.circle,
    backgroundColor: colors.bgApp,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  sheetTitle: {
    ...typography.h2,
    fontSize: 20,
    color: colors.textPrimary,
    textAlign: 'left',
  },
  sheetStatusLine: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '700',
    textAlign: 'left',
  },
  sheetScroll: {
    flexGrow: 1,
    flexShrink: 1,
  },
  sheetScrollContent: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    flexGrow: 0,
  },
  sheetFooter: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bgSurface,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trackingCard: {
    backgroundColor: colors.bgSurface,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    overflow: 'hidden',
    marginBottom: spacing.md,
    ...shadows.cardRaised,
  },
  trackingHeroBand: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.22)',
  },
  trackingHeroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  trackingHeroTextCol: {
    flex: 1,
    minWidth: 0,
  },
  trackingLivePill: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: 5,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  trackingLiveText: {
    ...typography.caption,
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.8,
    color: colors.white,
  },
  liveDotWrap: {
    width: 8,
    height: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveDotPulse: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  liveDotCore: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  trackingHeroTitle: {
    ...typography.h2,
    fontSize: 17,
    lineHeight: 22,
    color: colors.white,
    fontWeight: '900',
    marginBottom: 1,
  },
  trackingHeroHint: {
    ...typography.caption,
    color: 'rgba(255,255,255,0.88)',
    lineHeight: 16,
  },
  trackingTrack: {
    position: 'relative',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    backgroundColor: colors.bgSurface,
  },
  trackingTrackLineWrap: {
    position: 'absolute',
    left: '11%',
    right: '11%',
    top: spacing.lg + 18,
    height: 5,
    zIndex: 0,
    borderRadius: 3,
    overflow: 'hidden',
  },
  trackingTrackLineBg: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.border,
  },
  trackingTrackLineFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 2,
    overflow: 'hidden',
  },
  trackingNodes: {
    flexDirection: 'row',
    zIndex: 1,
  },
  trackingNode: {
    flex: 1,
    alignItems: 'center',
    minWidth: 0,
  },
  trackingDotWrap: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  trackingDotPulse: {
    position: 'absolute',
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  trackingDot: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    backgroundColor: colors.bgSurface,
  },
  trackingDotDone: {
    backgroundColor: colors.success,
    borderColor: colors.success,
  },
  trackingDotActive: {
    borderWidth: 2.5,
    backgroundColor: colors.white,
    transform: [{ scale: 1.06 }],
    ...shadows.sm,
  },
  trackingDotPending: {
    backgroundColor: colors.bgInput,
    borderColor: colors.borderStrong,
  },
  trackingNodeLabel: {
    ...typography.caption,
    fontSize: 10,
    fontWeight: '700',
    color: colors.textTertiary,
    textAlign: 'center',
    letterSpacing: 0.1,
    paddingHorizontal: 2,
  },
  trackingNodeLabelDone: {
    color: colors.successDark,
  },
  trackingNodeLabelActive: {
    fontWeight: '800',
  },
  trackingNodeLabelPending: {
    color: colors.textHint,
  },
  trackingCancelledBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  trackingCancelledIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  trackingCancelledTitle: {
    ...typography.labelLarge,
    color: colors.white,
    fontWeight: '800',
  },
  trackingCancelledReasonBox: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    backgroundColor: colors.errorLight || 'rgba(185, 28, 28, 0.08)',
  },
  trackingCancelledReasonLabel: {
    ...typography.labelSmall,
    color: colors.error,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 4,
  },
  trackingCancelledReasonText: {
    ...typography.body,
    color: colors.textPrimary,
    lineHeight: 22,
  },
  itemsSection: {
    backgroundColor: colors.bgSurface,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderLeftWidth: 4,
    borderLeftColor: colors.saffron,
    ...shadows.card,
  },
  itemsSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  itemsSectionIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.saffronLight,
    borderWidth: 1.5,
    borderColor: colors.saffron + '35',
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.xs,
  },
  itemsSectionHeaderText: {
    flex: 1,
  },
  itemsSectionTitle: {
    ...typography.h3,
    color: colors.textPrimary,
    marginBottom: 2,
  },
  itemsSectionSubtitle: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  itemRowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  itemThumb: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.bgInput,
  },
  itemThumbFallback: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.saffronLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemCardBody: {
    flex: 1,
    minWidth: 0,
  },
  itemCardName: {
    ...typography.label,
    color: colors.textPrimary,
    fontWeight: '800',
    lineHeight: 18,
  },
  itemCardUnit: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  itemQtyBadge: {
    alignSelf: 'flex-start',
    marginTop: 4,
  },
  itemQtyBadgeText: {
    ...typography.caption,
    fontSize: 10,
    fontWeight: '800',
    color: colors.saffronDark,
    letterSpacing: 0.2,
  },
  itemCardPriceCol: {
    alignItems: 'flex-end',
    minWidth: 72,
  },
  itemCardPrice: {
    ...typography.labelLarge,
    color: colors.textPrimary,
    fontWeight: '900',
  },
  itemCardUnitPrice: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
    fontWeight: '600',
  },
  itemsTotalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: spacing.sm,
    marginTop: spacing.xs,
    borderTopWidth: 1.5,
    borderTopColor: colors.borderStrong,
  },
  itemsTotalLabel: {
    ...typography.label,
    color: colors.textSecondary,
    fontWeight: '700',
    fontSize: 12,
  },
  itemsTotalValue: {
    ...typography.h3,
    color: colors.successDark,
    fontWeight: '900',
  },
  deliveryPaymentSection: {
    backgroundColor: colors.bgSurface,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderLeftWidth: 4,
    borderLeftColor: colors.success,
    ...shadows.card,
  },
  deliveryPaymentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.palette.success100,
  },
  deliveryPaymentIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.successLight,
    borderWidth: 1.5,
    borderColor: colors.palette.success200,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.xs,
  },
  deliveryPaymentHeaderText: {
    flex: 1,
  },
  deliveryPaymentTitle: {
    ...typography.h3,
    color: colors.textPrimary,
    marginBottom: 2,
  },
  deliveryPaymentSubtitle: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  deliveryPaymentRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  deliveryPaymentRowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  deliveryPaymentRowIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  deliveryPaymentRowIconAddress: {
    backgroundColor: colors.successLight,
  },
  deliveryPaymentRowIconDistance: {
    backgroundColor: colors.infoLight,
  },
  deliveryPaymentRowIconPayment: {
    backgroundColor: colors.saffronLight,
  },
  deliveryPaymentRowBody: {
    flex: 1,
    minWidth: 0,
  },
  deliveryPaymentLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    fontSize: 10,
    marginBottom: 4,
  },
  deliveryPaymentValue: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '600',
    lineHeight: 22,
  },
  deliveryMapLink: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    marginTop: spacing.xs,
  },
  deliveryMapLinkText: {
    ...typography.labelSmall,
    color: colors.success,
    fontWeight: '800',
  },
  deliveryPaymentMethodRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  deliveryPaymentMethod: {
    ...typography.labelLarge,
    color: colors.textPrimary,
    fontWeight: '800',
  },
  deliveryPaymentStatus: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  deliveryPaymentStatusText: {
    ...typography.caption,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  billSection: {
    backgroundColor: colors.bgSurface,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    borderLeftWidth: 4,
    borderLeftColor: colors.textPrimary,
    ...shadows.card,
  },
  billSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  billSectionIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.bgInput,
    borderWidth: 1.5,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.xs,
  },
  billSectionHeaderText: {
    flex: 1,
  },
  billSectionTitle: {
    ...typography.h3,
    color: colors.textPrimary,
    marginBottom: 2,
  },
  billSectionSubtitle: {
    ...typography.caption,
    color: colors.textSecondary,
  },
  billLineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  billLineRowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  billLineLabel: {
    ...typography.body,
    color: colors.textSecondary,
    fontWeight: '600',
    flex: 1,
  },
  billLineLabelSuccess: {
    color: colors.successDark,
  },
  billLineLabelWarning: {
    color: colors.warning,
  },
  billLineValue: {
    ...typography.label,
    color: colors.textPrimary,
    fontWeight: '700',
  },
  billLineValueSuccess: {
    color: colors.successDark,
    fontWeight: '800',
  },
  billLineValueWarning: {
    color: colors.warning,
    fontWeight: '800',
  },
  billFreeDeliveryValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  billStrikethrough: {
    ...typography.label,
    color: colors.textSecondary,
    textDecorationLine: 'line-through',
    fontWeight: '600',
  },
  billFreeDeliveryText: {
    ...typography.label,
    color: colors.successDark,
    fontWeight: '900',
  },
  billGrandTotalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: spacing.sm,
    marginTop: spacing.xs,
    borderTopWidth: 1.5,
    borderTopColor: colors.borderStrong,
  },
  billGrandTotalLabel: {
    ...typography.labelLarge,
    color: colors.textPrimary,
    fontWeight: '900',
  },
  billGrandTotalValue: {
    ...typography.h2,
    color: colors.successDark,
    fontWeight: '900',
  },
  bottomBar: {
    backgroundColor: colors.bgSurface,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    borderTopWidth: 1.5,
    borderTopColor: colors.border,
  },
  mapHeroBleed: {
    height: 380,
    marginHorizontal: -spacing.md,
    marginTop: -spacing.md,
    marginBottom: spacing.md,
    width: Dimensions.get('window').width,
    alignSelf: 'center',
    overflow: 'hidden',
    position: 'relative',
  },
  livePill: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.55)',
    zIndex: 6,
  },
  livePillText: {
    ...typography.caption,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
    color: colors.white || '#fff',
  },
  expandMapBtn: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    zIndex: 6,
  },
  mapHeroInner: {
    flex: 1,
    minHeight: 0,
  },
  actionButtonsRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  btnWrapper: {
    flex: 1,
  },
  bottomBtn: {
    width: '100%',
    height: 52,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    overflow: 'hidden',
  },
  bottomBtnDisabled: {
    borderColor: colors.border,
    backgroundColor: colors.surfaceMuted || '#F3F4F6',
    opacity: 0.7,
  },
  reorderBlockedText: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  btnContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  btnContentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  btnContentStacked: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    gap: 2,
  },
  cancelBtn: {
    borderColor: '#FCA5A5',
    backgroundColor: '#FFF0F0',
  },
  cancelBtnText: {
    ...typography.button,
    color: colors.error,
    fontWeight: '700',
    fontSize: 13,
  },
  outlineBtn: {
    borderColor: colors.success + '40',
    backgroundColor: colors.successLight,
  },
  outlineBtnText: {
    ...typography.button,
    color: colors.success,
    fontWeight: '700',
    fontSize: 13,
  },
  outlineBtnPhone: {
    ...typography.caption,
    color: colors.success,
    fontWeight: '600',
    fontSize: 12,
    letterSpacing: 0.3,
    opacity: 0.9,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  modalContent: {
    width: '85%',
    backgroundColor: colors.bgSurface,
    borderRadius: radius.lg,
    padding: spacing.xl,
    alignItems: 'center',
    ...shadows.xl,
  },
  modalIcon: {
    marginBottom: spacing.md,
  },
  modalTitle: {
    ...typography.h2,
    color: colors.textPrimary,
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  modalDesc: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: spacing.xl,
  },
  modalActions: {
    width: '100%',
    gap: spacing.md,
  },
  modalBtn: {
    width: '100%',
  },
});
