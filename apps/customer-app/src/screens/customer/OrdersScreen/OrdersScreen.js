/* eslint-disable react-hooks/exhaustive-deps */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Animated,
  TouchableOpacity,
  LayoutAnimation,
  RefreshControl,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useNavigation, useIsFocused } from '@react-navigation/native';
import {
  AppScreen,
  AppHeader,
  Button,
  AppIcon,
  SkeletonRow,
  EmptyState,
  ErrorState,
  DayHistoryPicker,
} from '../../../components';
import { colors, typography, spacing, radius, shadows, layout } from '../../../theme';
import { ordersApi, subscribeOrderEvents, subscribeRealtimeLifecycle } from '../../../api';
import { asArray, normalizeOrder } from '../../../utils';
import { todayDateStr } from '../../../utils/dateStr';
import {
  getRealtimeOrderId,
  getRealtimeOrderKey,
  isRecentRealtimeEvent,
  mergeOrderRealtimePatch,
} from '../../../utils/realtimeOrder';

const FILTER_CHIPS = [
  { label: 'All', value: 'All' },
  { label: 'Order Placed', value: 'Pending' },
  { label: 'Accepted', value: 'Accepted' },
  { label: 'Preparing/Packing', value: 'Preparing' },
  { label: 'Out for Delivery', value: 'Out for Delivery' },
  { label: 'Delivered', value: 'Delivered' },
  { label: 'Cancelled', value: 'Cancelled' },
];
const STATUS_CODE_LABELS = {
  0: 'Pending',
  1: 'Accepted',
  2: 'Preparing',
  3: 'Out for Delivery',
  4: 'Delivered',
  5: 'Cancelled',
};
const STATUS_DISPLAY_LABELS = {
  Pending: 'Order Placed',
  Accepted: 'Accepted',
  Preparing: 'Preparing/Packing',
};

const formatStatus = (status) => {
  if (status === null || status === undefined || status === '') return 'Pending';
  const raw = String(status).trim();
  if (/^\d+$/.test(raw)) return STATUS_CODE_LABELS[raw] || 'Pending';
  return raw.replace(/_/g, ' ');
};

const formatDate = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
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

// Per-status visual tokens. Kept in one map so the chip / accent bar /
// status icon all stay in sync.
const STATUS_VISUALS = {
  Pending: {
    color: '#0E1116',
    colorAlt: '#374151',
    bg: '#F3F4F6',
    iconBg: '#E5E7EB',
    icon: 'orders',
    gradientStart: '#2A303D',
    gradientEnd: '#0E1116',
    glowColor: 'rgba(14,17,22,0.28)',
    step: 0,
  },
  Accepted: {
    color: '#1D4ED8',
    colorAlt: '#3B82F6',
    bg: '#EFF6FF',
    iconBg: '#DBEAFE',
    icon: 'check',
    gradientStart: '#3B82F6',
    gradientEnd: '#1D4ED8',
    glowColor: 'rgba(59,130,246,0.30)',
    step: 1,
  },
  Preparing: {
    color: '#C2410C',
    colorAlt: '#FF7A3A',
    bg: '#FFF2EB',
    iconBg: '#FFE0CC',
    icon: 'box',
    gradientStart: '#FF9A66',
    gradientEnd: '#E05A1A',
    glowColor: 'rgba(224,90,26,0.30)',
    step: 2,
  },
  'Out for Delivery': {
    color: '#B45309',
    colorAlt: '#F59E0B',
    bg: '#FFFBEB',
    iconBg: '#FEF3C7',
    icon: 'navigation',
    gradientStart: '#FBBF24',
    gradientEnd: '#D97706',
    glowColor: 'rgba(245,158,11,0.30)',
    step: 3,
  },
  Delivered: {
    color: '#065F46',
    colorAlt: '#1FB574',
    bg: '#EAFDF5',
    iconBg: '#C6F4DF',
    icon: 'check',
    gradientStart: '#3FE09D',
    gradientEnd: '#179E62',
    glowColor: 'rgba(31,181,116,0.28)',
    step: 4,
  },
  Cancelled: {
    color: '#9B1C1C',
    colorAlt: '#E5484D',
    bg: '#FFF0F0',
    iconBg: '#FCA5A5',
    icon: 'close',
    gradientStart: '#F87171',
    gradientEnd: '#C93B40',
    glowColor: 'rgba(229,72,77,0.28)',
    step: -1,
  },
};

const getStatusVisual = (statusLabel) => STATUS_VISUALS[statusLabel] || {
  color: colors.textSecondary,
  colorAlt: colors.textTertiary,
  bg: colors.bgApp,
  iconBg: colors.bgApp,
  icon: 'orders',
  gradientStart: '#6B7280',
  gradientEnd: '#374151',
  glowColor: 'rgba(107,114,128,0.20)',
  step: 0,
};

// Order lifecycle steps for the progress stepper
const ORDER_STEPS = [
  { label: 'Placed', icon: 'orders' },
  { label: 'Accepted', icon: 'check' },
  { label: 'Packing', icon: 'box' },
  { label: 'On way', icon: 'navigation' },
  { label: 'Done', icon: 'check' },
];

// Defined at module scope so its hook identities and component reference are
// stable across OrdersScreen renders. Previously this lived inside the parent
// function and forced every card to unmount/remount on each parent render.
//
// Mixing useNativeDriver:true (opacity/transform) with useNativeDriver:false
// (backgroundColor) on the SAME Animated.View crashes React Native, so the
// JS-driven backgroundColor lives on the outer Animated.View and the native
// opacity/transform on an inner Animated.View.
const FadeInItem = ({ children, index, status }) => {
  const anim = useRef(new Animated.Value(0)).current;
  const highlightAnim = useRef(new Animated.Value(0)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;

  const normalizedStatus = String(status || '').trim().toLowerCase();
  const isInProcess = normalizedStatus !== 'delivered' && normalizedStatus !== 'cancelled';

  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1,
      duration: 400,
      delay: index * 100,
      useNativeDriver: true,
    }).start();
  // index and anim are stable refs — run once on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (status === 'Cancelled') {
      highlightAnim.stopAnimation();
      Animated.sequence([
        Animated.timing(highlightAnim, { toValue: 1, duration: 300, useNativeDriver: false }),
        Animated.timing(highlightAnim, { toValue: 0, duration: 600, useNativeDriver: false }),
      ]).start();
    }
  }, [status, highlightAnim]);

  useEffect(() => {
    let loop;
    if (isInProcess) {
      glowAnim.stopAnimation();
      glowAnim.setValue(0);
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(glowAnim, { toValue: 1, duration: 1500, useNativeDriver: true }),
          Animated.timing(glowAnim, { toValue: 0, duration: 1500, useNativeDriver: true }),
        ])
      );
      loop.start();
    } else {
      glowAnim.stopAnimation();
      glowAnim.setValue(0);
    }
    return () => {
      if (loop) loop.stop();
    };
  }, [isInProcess, glowAnim]);

  const highlightColor = highlightAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [colors.bgSurface, colors.error + '1A'],
  });

  return (
    <Animated.View
      style={{
        backgroundColor: highlightColor,
        borderRadius: radius.xl,
      }}
    >
      <Animated.View
        style={{
          opacity: anim,
          transform: [{
            translateY: anim.interpolate({
              inputRange: [0, 1],
              outputRange: [20, 0],
            }),
          }],
        }}
      >
        <View style={{ position: 'relative' }}>
          {children}
          {isInProcess && (
            <Animated.View
              pointerEvents="none"
              style={[
                styles.glowBorder,
                {
                  opacity: glowAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.15, 0.65],
                  }),
                },
              ]}
            />
          )}
        </View>
      </Animated.View>
    </Animated.View>
  );
};

export default function OrdersScreen() {
  const navigation = useNavigation();
  const isFocused = useIsFocused();

  const [activeFilter, setActiveFilter] = useState('All');
  const [orders, setOrders] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isError, setIsError] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [cancellingId, setCancellingId] = useState(null);
  const [pagination, setPagination] = useState({ limit: 20, offset: 0, hasMore: true, total: 0 });
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  // Default view is today only; picking a day from history browses that day.
  const [selectedDate, setSelectedDate] = useState(() => todayDateStr());
  const [pickerVisible, setPickerVisible] = useState(false);
  const isToday = selectedDate === todayDateStr();

  // Animations
  const listOpacity = useRef(new Animated.Value(1)).current;
  const realtimeFetchTimer = useRef(null);
  const recentRealtimeEvents = useRef({});

  const fetchOrders = useCallback((refresh = false) => {
    const isLoadMore = !refresh && pagination.offset > 0;
    if (refresh) {
      setIsRefreshing(true);
    } else if (isLoadMore) {
      setIsLoadingMore(true);
    } else {
      setIsLoading(true);
    }
    setIsError(false);

    const offset = refresh ? 0 : pagination.offset;

    ordersApi.getOrders({ limit: pagination.limit, offset, date: selectedDate })
      .then(response => {
        const meta = response?.meta || { total: 0, limit: 20, offset: 0, hasMore: false };
        // Store the RAW page — the status-chip filter is applied at render
        // time (displayOrders below). Filtering here would bake the filter
        // that was active at fetch time into the paginated list, so pages
        // fetched under different chips would mix and chip taps would do
        // nothing until the next fetch.
        const fetched = asArray(response, ['orders']).map(normalizeOrder);

        Animated.sequence([
          Animated.timing(listOpacity, { toValue: 0.5, duration: 100, useNativeDriver: true }),
          Animated.timing(listOpacity, { toValue: 1, duration: 200, useNativeDriver: true })
        ]).start();

        setPagination({
          limit: meta.limit,
          offset: meta.offset + fetched.length,
          hasMore: meta.hasMore,
          total: meta.total,
        });

        setOrders(prev => (refresh ? fetched : [...prev, ...fetched]));
      })
      .catch((err) => {
        setIsError(true);
        setErrorMessage(err?.response?.data?.message || err?.message || 'There was a problem fetching your order history.');
      })
      .finally(() => {
        setIsLoading(false);
        setIsRefreshing(false);
        setIsLoadingMore(false);
      });
  }, [listOpacity, pagination.limit, pagination.offset, selectedDate]);

  // Keep a ref to the latest fetchOrders so the realtime subscription can call
  // the most recent version without depending on pagination state. Without
  // this, every pagination update would tear down and recreate the realtime
  // subscription, which can drop realtime events during the resubscribe.
  const fetchOrdersRef = useRef(fetchOrders);
  useEffect(() => {
    fetchOrdersRef.current = fetchOrders;
  }, [fetchOrders]);

  const queueRealtimeRefresh = useCallback(() => {
    if (realtimeFetchTimer.current) {
      clearTimeout(realtimeFetchTimer.current);
    }

    realtimeFetchTimer.current = setTimeout(() => {
      if (isFocused) {
        fetchOrdersRef.current(true);
      }
    }, 350);
  }, [isFocused]);

  const handleLoadMore = useCallback(() => {
    if (!isLoadingMore && pagination.hasMore && !isRefreshing && !isLoading) {
      fetchOrders(false);
    }
  }, [isLoadingMore, pagination.hasMore, isRefreshing, isLoading, fetchOrders]);

  const handleRefresh = () => {
    fetchOrders(true);
  };

  const handleSelectDate = useCallback((dateStr) => {
    setSelectedDate(dateStr);
    setPickerVisible(false);
  }, []);

  const backToToday = useCallback(() => {
    setSelectedDate(todayDateStr());
  }, []);

  useEffect(() => {
    if (isFocused) {
      // Always a full refresh: fetchOrders(false) at offset > 0 is a
      // load-more and would silently APPEND the next page every time the
      // user tabs back to this screen. isLoading starts true, so the very
      // first focus still shows the skeleton rather than the pull spinner.
      fetchOrders(true);
    }
  }, [isFocused, selectedDate]); // Re-fetch on focus, or when browsing a different day

  useEffect(() => {
    const unsubscribeOrders = subscribeOrderEvents(({ eventName, payload }) => {
      const eventKey = getRealtimeOrderKey(eventName, payload);
      if (isRecentRealtimeEvent(recentRealtimeEvents, eventKey)) return;

      if (eventName === 'order.created') {
        queueRealtimeRefresh();
        return;
      }

      const eventOrderId = getRealtimeOrderId(payload);
      if (!eventOrderId) return;

      // The chip filter is applied at render time, so patching an order in
      // place moves it between chips automatically. A refetch is only needed
      // when the order isn't in the loaded pages at all.
      let shouldRefresh = false;

      setOrders(prevOrders => {
        let found = false;
        const nextOrders = prevOrders.map(order => {
          if (String(order.id) !== eventOrderId) return order;
          found = true;
          return mergeOrderRealtimePatch(order, payload);
        });

        if (!found) {
          shouldRefresh = true;
        }

        return nextOrders;
      });

      if (shouldRefresh) {
        queueRealtimeRefresh();
      }
    });

    const unsubscribeLifecycle = subscribeRealtimeLifecycle(({ eventName }) => {
      if (eventName === 'reconnected' || eventName === 'foreground') {
        queueRealtimeRefresh();
      }
    });

    return () => {
      unsubscribeOrders();
      unsubscribeLifecycle();
      if (realtimeFetchTimer.current) {
        clearTimeout(realtimeFetchTimer.current);
      }
    };
  }, [queueRealtimeRefresh]);

  const handleCancelOrder = (orderId) => {
    setCancellingId(orderId);
    ordersApi.cancelOrder(orderId)
      .then(response => {
        const cancelled = getCancelledOrderPatch(response);
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setOrders(prev => prev.map(o => o.id === orderId ? {
          ...o,
          ...cancelled,
          id: o.id,
          status: cancelled.status || 'Cancelled',
          paymentStatus: cancelled.paymentStatus || getCancelledPaymentStatus(o.paymentMethod),
          canCancel: false,
        } : o));
      })
      // Don't flip the full-screen error state for a single failed cancel —
      // that would wipe the entire orders list. Show an inline alert and keep
      // the list intact so the user can retry.
      .catch(err => {
        Alert.alert('Cancel failed', err?.message || 'Unable to cancel this order. Please try again.');
      })
      .finally(() => setCancellingId(null));
  };

  const getPaymentStatusColor = (status) => {
    switch (status) {
      case 'Paid':
      case 'Success':
      case 'Refunded':
        return colors.success;
      case 'Failed':
        return colors.error;
      case 'Pending':
      default:
        return '#F59E0B';
    }
  };

  // Chip filtering happens here — over the raw paginated list — so tapping a
  // chip refilters the already-loaded pages instantly and load-more keeps
  // appending to one consistent list regardless of the active chip.
  const displayOrders = useMemo(() => (
    activeFilter === 'All'
      ? orders
      : orders.filter(o => formatStatus(o.status) === activeFilter)
  ), [orders, activeFilter]);

  const summary = useMemo(() => {
    const total = orders.length;
    let active = 0;
    let delivered = 0;
    let cancelled = 0;
    orders.forEach((o) => {
      const s = formatStatus(o.status);
      if (s === 'Delivered') delivered += 1;
      else if (s === 'Cancelled') cancelled += 1;
      else active += 1;
    });
    return { total, active, delivered, cancelled };
  }, [orders]);

  const renderItem = ({ item, index }) => {
    const statusLabel = formatStatus(item.status);
    const displayStatus = STATUS_DISPLAY_LABELS[statusLabel] || statusLabel;
    const orderLabel = item.orderNumber || item.order_number || item.id;
    const paymentStatus = statusLabel === 'Cancelled'
      ? getCancelledPaymentStatus(item.paymentMethod)
      : item.paymentStatus;
    const visual = getStatusVisual(statusLabel);
    const payColor = getPaymentStatusColor(paymentStatus);
    const isCancelled = statusLabel === 'Cancelled';
    const activeStep = visual.step;

    return (
    <FadeInItem index={index} status={statusLabel}>
      <View style={[
        styles.card,
        { shadowColor: visual.glowColor, borderColor: visual.colorAlt + '33' },
      ]}>

        {/* ── Gradient Header ── */}
        <LinearGradient
          colors={[visual.gradientStart, visual.gradientEnd]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.cardHeader}
        >
          {/* Decorative blob */}
          <View style={styles.cardHeaderBlob} pointerEvents="none" />
          <View style={styles.cardHeaderBlob2} pointerEvents="none" />

          {/* Order ID + Date */}
          <View style={styles.cardHeaderLeft}>
            <View style={[styles.cardIconBubble, styles.cardIconBubbleGlass]}>
              <AppIcon name={visual.icon} size={16} color={'#FFFFFF'} strokeWidth={2.6} />
            </View>
            <View style={styles.cardMeta}>
              <Text style={styles.orderId} numberOfLines={1}>#{orderLabel}</Text>
              <Text style={styles.orderDate} numberOfLines={1}>{formatDate(item.date)}</Text>
            </View>
          </View>

          {/* Status pill */}
          <View style={styles.statusPillGlass}>
            <View style={styles.statusPillGlassDot} />
            <Text style={styles.statusPillGlassText} numberOfLines={1}>
              {displayStatus}
            </Text>
          </View>
        </LinearGradient>

        {/* ── Card Body ── */}
        <View style={styles.cardBody}>

          {/* Progress stepper (hidden for Cancelled) */}
          {!isCancelled && (
            <View style={styles.stepperRow}>
              {ORDER_STEPS.map((step, si) => {
                const isCompleted = si <= activeStep;
                const isActive = si === activeStep;
                return (
                  <React.Fragment key={step.label}>
                    <View style={styles.stepItem}>
                      <View style={[
                        styles.stepDot,
                        isCompleted ? { backgroundColor: visual.colorAlt } : styles.stepDotInactive,
                        isActive && styles.stepDotActive,
                      ]}>
                        {isCompleted && (
                          <AppIcon
                            name={isActive ? visual.icon : 'check'}
                            size={isActive ? 9 : 8}
                            color="#FFF"
                            strokeWidth={3}
                          />
                        )}
                      </View>
                      <Text style={[
                        styles.stepLabel,
                        isCompleted ? { color: visual.colorAlt, fontWeight: '700' } : {},
                        isActive ? { fontWeight: '800' } : {},
                      ]} numberOfLines={1}>
                        {step.label}
                      </Text>
                    </View>
                    {si < ORDER_STEPS.length - 1 && (
                      <View style={[
                        styles.stepLine,
                        si < activeStep ? { backgroundColor: visual.colorAlt } : {},
                      ]} />
                    )}
                  </React.Fragment>
                );
              })}
            </View>
          )}

          {/* Cancelled banner */}
          {isCancelled && (
            <View style={styles.cancelledBanner}>
              <AppIcon name="close" size={13} color={colors.error} strokeWidth={2.8} />
              <Text style={styles.cancelledBannerText}>This order was cancelled</Text>
            </View>
          )}

          {/* Info tags row */}
          <View style={styles.tagsRow}>
            <View style={styles.tag}>
              <Text style={styles.tagText}>
                {item.itemCount} Item{item.itemCount > 1 ? 's' : ''}
              </Text>
            </View>
            <View style={styles.tag}>
              <Text style={styles.tagText}>{item.paymentMethod}</Text>
            </View>
            <View style={[styles.tag, { backgroundColor: payColor + '18', borderColor: payColor + '40' }]}>
              <View style={[styles.payDot, { backgroundColor: payColor }]} />
              <Text style={[styles.tagText, { color: payColor, fontWeight: '800' }]}>{paymentStatus}</Text>
            </View>
          </View>

          {/* Bottom row: price + actions */}
          <View style={styles.cardRowBottom}>
            <View>
              <Text style={styles.totalLabel}>Order Total</Text>
              <Text style={styles.totalAmount}>Rs. {item.total}</Text>
            </View>
            <View style={styles.actionsRow}>
              {item.canCancel && (
                <Button
                  label={cancellingId === item.id ? 'Cancelling…' : 'Cancel'}
                  variant="outline"
                  size="small"
                  onPress={() => handleCancelOrder(item.id)}
                  disabled={cancellingId === item.id}
                  style={styles.cancelBtn}
                />
              )}
              <LinearGradient
                colors={[visual.gradientStart, visual.gradientEnd]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.detailsBtnGradient}
              >
                <TouchableOpacity
                  onPress={() => navigation.navigate('OrderDetail', { orderId: item.id })}
                  style={styles.detailsBtn}
                  activeOpacity={0.80}
                  accessibilityRole="button"
                  accessibilityLabel="View order details"
                >
                  <Text style={styles.detailsBtnText}>Details</Text>
                  <AppIcon name="chevronRight" size={13} color={'#FFF'} strokeWidth={2.8} />
                </TouchableOpacity>
              </LinearGradient>
            </View>
          </View>

        </View>
      </View>
    </FadeInItem>
  );
  };

  const renderSkeleton = () => (
    <View style={styles.skeletonContainer}>
      {[1, 2, 3].map((k) => (
        <View key={k} style={styles.card}>
          <View style={styles.cardBody}>
            <View style={styles.cardRow}>
              <SkeletonRow style={{ width: '70%' }} />
            </View>
            <View style={{ height: 8 }} />
            <SkeletonRow style={{ width: '90%' }} />
            <View style={{ height: 8 }} />
            <SkeletonRow style={{ width: '40%' }} />
          </View>
        </View>
      ))}
    </View>
  );

  const renderEmptyState = () => (
    <EmptyState
      icon={<AppIcon name="orders" size={56} color={colors.textTertiary} />}
      title="No orders found"
      subtitle={activeFilter === 'All'
        ? "You haven't placed any orders yet. Start exploring our delicious menu!"
        : `You don't have any ${(STATUS_DISPLAY_LABELS[activeFilter] || activeFilter).toLowerCase()} orders.`}
      actionLabel="Start Shopping"
      onAction={() => navigation.navigate('MainTabs', { screen: 'Home' })}
      style={styles.emptyState}
    />
  );

  const renderErrorState = () => (
    <ErrorState
      icon={<AppIcon name="close" size={48} color={colors.error} />}
      title="Could not load orders"
      message={errorMessage}
      onRetry={() => fetchOrders()}
      style={styles.emptyState}
    />
  );

  const renderFooter = () => {
    if (!isLoadingMore) return null;
    return (
      <View style={{ paddingVertical: 16, alignItems: 'center' }}>
        <ActivityIndicator size="small" color={colors.primary} />
      </View>
    );
  };

  return (
    <AppScreen style={styles.container} safeAreaBottom={false}>
      <AppHeader title="My Orders" />

      <View style={styles.dateRow}>
        <Text style={styles.dateRowText}>
          {isToday ? "Today's orders" : `Orders on ${selectedDate}`}
        </Text>
        {isToday ? (
          <TouchableOpacity style={styles.historyBtn} onPress={() => setPickerVisible(true)}>
            <AppIcon name="orders" size={14} color={colors.saffronDark} />
            <Text style={styles.historyBtnText}>History</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.historyBtn} onPress={backToToday}>
            <Text style={styles.historyBtnText}>← Today</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Summary hero (only shown when we actually have orders) */}
      {!isLoading && !isError && orders.length > 0 && (
        <View style={styles.summaryWrap}>
          <LinearGradient
            colors={[colors.brandGradientStart, colors.brandGradientEnd]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.summaryGradient}
          >
            <View style={styles.summaryBlob} pointerEvents="none" />
            <View style={styles.summaryContent}>
              <View>
                <Text style={styles.summaryLabel}>Total orders</Text>
                <Text style={styles.summaryValue}>{summary.total}</Text>
              </View>
              <View style={styles.summaryStatsRow}>
                <SummaryStat label="Active" value={summary.active} color="#FFFFFF" bg="rgba(255,255,255,0.25)" />
                <SummaryStat label="Delivered" value={summary.delivered} color="#FFFFFF" bg="rgba(255,255,255,0.25)" />
                <SummaryStat label="Cancelled" value={summary.cancelled} color="#FFFFFF" bg="rgba(255,255,255,0.25)" />
              </View>
            </View>
          </LinearGradient>
        </View>
      )}

      {/* Filter Chips */}
      <View style={styles.filterArea}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterScroll}
        >
          {FILTER_CHIPS.map(chip => {
            const isActive = activeFilter === chip.value;
            return (
              <TouchableOpacity
                key={chip.value}
                style={[styles.chip, isActive && styles.chipActive]}
                onPress={() => {
                  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                  setActiveFilter(chip.value);
                }}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={chip.label}
                accessibilityState={{ selected: isActive }}
              >
                <Text style={[styles.chipText, isActive && styles.chipTextActive]}>
                  {chip.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      <View style={styles.listContainer}>
        {isLoading ? (
          renderSkeleton()
        ) : isError ? (
          renderErrorState()
        ) : displayOrders.length === 0 ? (
          renderEmptyState()
        ) : (
          <Animated.FlatList
            data={displayOrders}
            keyExtractor={item => item.id}
            renderItem={renderItem}
            contentContainerStyle={styles.flatListContent}
            showsVerticalScrollIndicator={false}
            ItemSeparatorComponent={() => <View style={{ height: spacing.sm }} />}
            style={{ opacity: listOpacity }}
            // removeClippedSubviews + windowSize tuning — see ProductListScreen.
            removeClippedSubviews
            initialNumToRender={6}
            maxToRenderPerBatch={6}
            windowSize={7}
            onEndReached={handleLoadMore}
            onEndReachedThreshold={0.5}
            ListFooterComponent={renderFooter}
            refreshControl={
              <RefreshControl
                refreshing={isRefreshing}
                onRefresh={handleRefresh}
                tintColor={colors.primary}
                colors={[colors.primary, colors.success, colors.saffron]}
                title="Refreshing ServeLoco"
                titleColor={colors.textSecondary}
              />
            }
          />
        )}
      </View>

      <DayHistoryPicker
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        onSelectDate={handleSelectDate}
        selectedDate={selectedDate}
      />
    </AppScreen>
  );
}

function SummaryStat({ label, value, color, bg }) {
  return (
    <View style={styles.summaryStat}>
      <View style={[styles.summaryStatBubble, { backgroundColor: bg }]}>
        <Text style={[styles.summaryStatValue, { color }]}>{value}</Text>
      </View>
      <Text style={[styles.summaryStatLabel, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgApp,
  },

  /* ----- Date row (today / history) ----- */
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  dateRowText: {
    ...typography.bodySmall,
    color: colors.textSecondary,
    fontWeight: '600',
  },
  historyBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.saffronLight, borderRadius: radius.pill,
    paddingHorizontal: 12, paddingVertical: 8,
  },
  historyBtnText: { color: colors.saffronDark, fontWeight: '800', fontSize: 13 },

  /* ----- Summary hero ----- */
  summaryWrap: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },
  summaryGradient: {
    borderRadius: radius.xxl,
    padding: spacing.md,
    overflow: 'hidden',
    position: 'relative',
    ...shadows.cardRaised,
  },
  summaryBlob: {
    position: 'absolute',
    top: -30,
    right: -30,
    width: 130,
    height: 130,
    borderRadius: 65,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  summaryContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  summaryLabel: {
    ...typography.captionMedium,
    color: 'rgba(26,31,43,0.7)',
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 2,
  },
  summaryValue: {
    ...typography.hero,
    color: colors.brandInk,
    fontWeight: '900',
    letterSpacing: -0.5,
    lineHeight: 32,
  },
  summaryStatsRow: {
    flexDirection: 'row',
    gap: 6,
  },
  summaryStat: {
    alignItems: 'center',
  },
  summaryStatBubble: {
    minWidth: 34,
    height: 28,
    paddingHorizontal: 8,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 3,
  },
  summaryStatValue: {
    ...typography.labelLarge,
    fontWeight: '900',
  },
  summaryStatLabel: {
    ...typography.caption,
    fontSize: 9,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    opacity: 0.85,
  },

  /* ----- Filter chips ----- */
  filterArea: {
    backgroundColor: colors.bgSurface,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginTop: spacing.md,
  },
  filterScroll: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.bgApp,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
    ...shadows.sm,
  },
  chipText: {
    ...typography.labelSmall,
    color: colors.textSecondary,
    fontWeight: '700',
  },
  chipTextActive: {
    color: colors.textInverse,
    fontWeight: '800',
  },

  /* ----- List ----- */
  listContainer: {
    flex: 1,
  },
  flatListContent: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: layout.bottomNavHeight + spacing.lg,
  },

  /* ----- Skeleton ----- */
  skeletonContainer: {
    padding: spacing.md,
    gap: spacing.md,
  },

  /* ----- Card (redesigned) ----- */
  card: {
    backgroundColor: colors.bgSurface,
    borderRadius: radius.xl,
    borderWidth: 1,
    overflow: 'hidden',
    ...shadows.cardRaised,
  },

  /* Gradient header */
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    overflow: 'hidden',
    position: 'relative',
  },
  cardHeaderBlob: {
    position: 'absolute',
    top: -20,
    right: -20,
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(255,255,255,0.14)',
    pointerEvents: 'none',
  },
  cardHeaderBlob2: {
    position: 'absolute',
    bottom: -15,
    right: 70,
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: 'rgba(255,255,255,0.09)',
    pointerEvents: 'none',
  },
  cardHeaderLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minWidth: 0,
  },
  cardIconBubble: {
    width: 34,
    height: 34,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  cardIconBubbleGlass: {
    backgroundColor: 'rgba(255,255,255,0.22)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  cardMeta: {
    flex: 1,
    minWidth: 0,
  },
  orderId: {
    color: '#FFFFFF',
    fontWeight: '900',
    fontSize: 15,
    lineHeight: 19,
    letterSpacing: -0.2,
  },
  orderDate: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 11,
    fontWeight: '600',
    lineHeight: 14,
    marginTop: 1,
  },
  statusPillGlass: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.22)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    flexShrink: 0,
  },
  statusPillGlassDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#FFFFFF',
  },
  statusPillGlassText: {
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    color: '#FFFFFF',
    lineHeight: 13,
  },

  /* Card body */
  cardBody: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm + 4,
    paddingBottom: spacing.md,
    gap: 12,
  },

  /* Progress stepper */
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 2,
  },
  stepItem: {
    alignItems: 'center',
    gap: 4,
  },
  stepDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepDotInactive: {
    backgroundColor: colors.bgSkeletonBase,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  stepDotActive: {
    width: 26,
    height: 26,
    borderRadius: 13,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 4,
  },
  stepLabel: {
    fontSize: 9,
    fontWeight: '600',
    color: colors.textTertiary,
    textAlign: 'center',
    letterSpacing: 0.1,
  },
  stepLine: {
    flex: 1,
    height: 2.5,
    backgroundColor: colors.border,
    borderRadius: 2,
    marginBottom: 14,
    marginHorizontal: 2,
  },

  /* Cancelled banner */
  cancelledBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.errorLight,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: colors.error + '30',
  },
  cancelledBannerText: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.error,
    letterSpacing: 0.1,
  },

  /* Info tag chips */
  tagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tagText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.textSecondary,
    letterSpacing: 0.1,
  },
  payDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },

  /* Bottom row */
  cardRowBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingTop: 2,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  totalLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: colors.textTertiary,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginBottom: 2,
  },
  totalAmount: {
    color: colors.textPrimary,
    fontWeight: '900',
    fontSize: 19,
    lineHeight: 22,
    letterSpacing: -0.5,
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cancelBtn: {
    height: 36,
    paddingHorizontal: spacing.md,
  },
  detailsBtnGradient: {
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  detailsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 36,
    paddingHorizontal: 14,
  },
  detailsBtnText: {
    fontWeight: '800',
    color: '#FFFFFF',
    fontSize: 13,
    letterSpacing: 0.1,
  },
  glowBorder: {
    position: 'absolute',
    top: -2,
    left: -2,
    right: -2,
    bottom: -2,
    borderRadius: radius.xl + 2,
    borderWidth: 2,
    borderColor: '#FFEA00',
    ...shadows.md,
    shadowColor: '#FFEA00',
    shadowOpacity: 0.8,
    shadowRadius: 8,
  },

  /* ----- Empty / error ----- */
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    marginTop: spacing.xxl,
  },
});