import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  Easing,
  Linking,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, spacing, typography, radius, shadows } from '../../theme';
import { useAuthStore } from '../../stores';
import { riderApi, subscribeRealtime } from '../../api';
import ShopToggle from '../../components/shop/ShopToggle';
import AppIcon from '../../components/AppIcon';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { useRiderOfferAlert } from '../../hooks/useRiderOfferAlert';
import { useRiderLocationTracking } from '../../hooks/useRiderLocationTracking';
import { useRiderIdleLocationPing } from '../../hooks/useRiderIdleLocationPing';
import {
  getRiderActionFlags,
  isOutForDelivery,
  mergeRiderOrder,
} from '../../utils/riderOrderActions';
import { elapsedSecondsFromStart, formatElapsed } from '../../utils/riderOfferTime';
import RiderOfferPopup from './RiderOfferPopup';

const STEPS = [
  { key: 'assigned', label: 'Assigned' },
  { key: 'ofd', label: 'On the way' },
  { key: 'done', label: 'Delivered' },
];

function stepIndex(status) {
  if (status === 'Delivered') return 2;
  if (isOutForDelivery(status)) return 1;
  return 0;
}

function offerIdOf(o) {
  return o?.id ?? o?.offerId ?? null;
}

/** Oldest-first unique queue; keep richer payload when merging. */
function normalizeOfferQueue(list) {
  if (!Array.isArray(list)) return [];
  const byId = new Map();
  list.forEach((o) => {
    const id = offerIdOf(o);
    if (id == null) return;
    const key = String(id);
    const prev = byId.get(key);
    byId.set(key, prev ? { ...prev, ...o } : o);
  });
  return Array.from(byId.values()).sort(
    (a, b) => Number(offerIdOf(a)) - Number(offerIdOf(b)),
  );
}

function upsertOfferInQueue(prev, incoming) {
  if (!incoming || offerIdOf(incoming) == null) return prev || [];
  return normalizeOfferQueue([...(prev || []), incoming]);
}

/**
 * Premium rider dashboard — online hero, metrics, active job with step rail.
 */
export default function RiderDashboardScreen({ navigation }) {
  const rider = useAuthStore((s) => s.rider);
  const setRider = useAuthStore((s) => s.setRider);
  const logout = useAuthStore((s) => s.logout);
  const isFocused = useIsFocused();

  const [isOnline, setIsOnline] = useState(Boolean(rider?.isOnline || rider?.is_online));
  const [toggleBusy, setToggleBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Offer queue (oldest first). Popup shows index 0; accept/reject advances.
  const [offerQueue, setOfferQueue] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [error, setError] = useState(null);
  const [actionBusy, setActionBusy] = useState(null);
  const activeOffer = offerQueue[0] || null;
  // Latest/primary for map tracking + step rail helpers
  const assignment = assignments[0] || null;
  const mountedRef = useRef(true);
  const isOnlineRef = useRef(isOnline);
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    isOnlineRef.current = isOnline;
  }, [isOnline]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Live pulse when online
  useEffect(() => {
    if (!isOnline) {
      pulse.setValue(0.45);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.3,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [isOnline, pulse]);

  const fetchAll = useCallback(async () => {
    try {
      setError(null);
      const me = await riderApi.getMe();
      if (!mountedRef.current) return;
      if (me?.rider) {
        setRider(me.rider);
        setIsOnline(Boolean(me.rider.isOnline || me.rider.is_online));
      }
      let offers = me?.activeOffers || me?.active_offers || null;
      // /me already carries the offer queue; the extra offers/active call only
      // adds shop names for the popup. Skip it when /me says there are zero
      // offers — fetchAll runs on every socket event/focus, so this halves the
      // idle dashboard's request volume. Still called when /me lacks the queue
      // field entirely (older API) or offers exist (need shop enrichment).
      if (!Array.isArray(offers) || offers.length > 0) {
        try {
          const offerRes = await riderApi.getActiveOffer();
          if (Array.isArray(offerRes?.offers)) {
            offers = offerRes.offers;
          } else if (offerRes?.offer) {
            offers = [offerRes.offer];
          } else if (offerRes && offerRes.offer === null) {
            offers = [];
          }
        } catch (_) { /* keep from me */ }
      }
      if (!mountedRef.current) return;
      if (!Array.isArray(offers)) {
        const one = me?.activeOffer || me?.active_offer || null;
        offers = one ? [one] : [];
      }
      setOfferQueue(normalizeOfferQueue(offers));
      const list = me?.currentAssignments || me?.current_assignments;
      if (Array.isArray(list) && list.length > 0) {
        setAssignments(list);
      } else {
        const one = me?.currentAssignment || me?.current_assignment || null;
        setAssignments(one ? [one] : []);
      }
    } catch (err) {
      if (mountedRef.current) setError(err?.message || 'Could not load rider status');
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [setRider]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Re-sync when returning from the map screen so card buttons match map actions.
  useFocusEffect(
    useCallback(() => {
      fetchAll();
    }, [fetchAll]),
  );

  useEffect(() => {
    const unsubs = [
      subscribeRealtime('rider.offer.created', (payload) => {
        const incoming = {
          id: payload.offerId || payload.offer_id,
          offerId: payload.offerId || payload.offer_id,
          orderId: payload.orderId || payload.order_id,
          orderNumber: payload.orderNumber || payload.order_number,
          expiresAt: payload.expiresAt || payload.expires_at,
          expires_at: payload.expiresAt || payload.expires_at,
        };
        // Enqueue without dropping the offer currently on screen.
        setOfferQueue((prev) => upsertOfferInQueue(prev, incoming));
        riderApi.getActiveOffer()
          .then((res) => {
            if (!mountedRef.current) return;
            if (Array.isArray(res?.offers)) {
              setOfferQueue(normalizeOfferQueue(res.offers));
            } else if (res?.offer) {
              setOfferQueue((prev) => upsertOfferInQueue(prev, res.offer));
            }
          })
          .catch(() => {});
        // Warm background: ring until accept/reject (main JS — works with Metro).
        if (AppState.currentState !== 'active') {
          const { displayAlarmNotification, ALERT_TYPE_RIDER_OFFER } = require('../../utils/orderAlarmNotifications');
          displayAlarmNotification({
            alertType: ALERT_TYPE_RIDER_OFFER,
            type: 'rider_offer',
            offerId: String(incoming.offerId || ''),
            orderId: String(incoming.orderId || ''),
            orderNumber: String(incoming.orderNumber || ''),
            expiresAt: String(incoming.expiresAt || ''),
          }).catch(() => {});
        }
      }),
      // Server reminder while offer still pending — rehydrate popup if needed.
      subscribeRealtime('rider.offer.reminder', (payload) => {
        const incoming = {
          id: payload.offerId || payload.offer_id,
          offerId: payload.offerId || payload.offer_id,
          orderId: payload.orderId || payload.order_id,
          orderNumber: payload.orderNumber || payload.order_number,
          expiresAt: payload.expiresAt || payload.expires_at,
          expires_at: payload.expiresAt || payload.expires_at,
        };
        if (!incoming.id) return;
        setOfferQueue((prev) => upsertOfferInQueue(prev, incoming));
      }),
      subscribeRealtime('rider.offer.expired', (payload) => {
        const expiredId = payload.offerId || payload.offer_id;
        setOfferQueue((prev) => prev.filter((o) => {
          const id = o.id || o.offerId;
          return !(id && Number(id) === Number(expiredId));
        }));
        fetchAll();
      }),
      subscribeRealtime('rider.offer.revoked', () => {
        setOfferQueue([]);
        fetchAll();
      }),
      subscribeRealtime('rider.assignment.updated', (payload) => {
        // Patch local list immediately when payload includes order, then hard refresh.
        if (payload?.order?.id) {
          setAssignments((prev) => {
            const id = payload.order.id;
            const status = payload.order.status;
            if (status === 'Delivered' || status === 'Cancelled') {
              return prev.filter((a) => String(a.id) !== String(id));
            }
            let found = false;
            const next = prev.map((a) => {
              if (String(a.id) !== String(id)) return a;
              found = true;
              return mergeRiderOrder(a, payload.order);
            });
            return found ? next : prev;
          });
        }
        fetchAll();
      }),
      // Admin toggled online/offline from web Riders page — sync toggle.
      subscribeRealtime('rider.status.updated', (payload) => {
        const online = payload?.isOnline ?? payload?.is_online;
        if (typeof online === 'boolean') {
          setIsOnline(online);
          isOnlineRef.current = online;
        }
        fetchAll();
      }),
      subscribeRealtime('lifecycle.foreground', () => fetchAll()),
      subscribeRealtime('lifecycle.reconnected', () => fetchAll()),
    ];
    return () => unsubs.forEach((u) => u && u());
  }, [fetchAll]);

  // Multi-order: still alert for new offers even if rider already has jobs.
  // Continuous local chime while popup is open; server re-pushes every ~15s
  // until accept/reject so closed-app riders keep getting FCM banners.
  useRiderOfferAlert(activeOffer);
  // Pause the dashboard's own GPS watch while RiderOrder is on top — that
  // screen's RiderDeliveryMap runs its own watcher, and a single ping fans
  // out server-side to every active assignment regardless of which job
  // screen is open, so running both here was a duplicate watcher (2x
  // battery/GPS calls) rather than extra coverage.
  useRiderLocationTracking(isFocused ? assignment : null);
  // While free, keep a coarse position on the server — offers are ranked by
  // distance from the pickup shop, and a rider who never pings is invisible to
  // the near rings. Stops the moment a job starts (the watcher above takes over).
  useRiderIdleLocationPing(isOnline, Boolean(assignment));

  const handleToggle = useCallback(async (next) => {
    const prev = isOnline;
    setIsOnline(next);
    setToggleBusy(true);
    try {
      const res = await riderApi.setOnline(next);
      if (res?.rider) setRider(res.rider);
      await fetchAll();
    } catch (err) {
      setIsOnline(prev);
      Alert.alert('Could not update status', err?.message || 'Try again');
    } finally {
      setToggleBusy(false);
    }
  }, [fetchAll, isOnline, setRider]);

  const handleLogout = useCallback(() => {
    const activeCount = assignments.length;
    if (activeCount > 0) {
      Alert.alert(
        'Finish deliveries first',
        activeCount === 1
          ? 'You still have 1 active order. Deliver it before signing out.'
          : `You still have ${activeCount} active orders. Deliver them all before signing out.`,
        [{ text: 'OK' }],
      );
      return;
    }
    Alert.alert('Sign out', 'Go offline and sign out of rider mode?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: async () => {
          try {
            // Re-check server in case a job arrived after the local list loaded.
            if (isOnlineRef.current) {
              await riderApi.setOnline(false);
            }
          } catch (err) {
            Alert.alert(
              'Cannot sign out',
              err?.message || 'Deliver all active orders before signing out.',
            );
            fetchAll();
            return;
          }
          logout();
        },
      },
    ]);
  }, [assignments.length, fetchAll, logout]);

  const refreshOfferQueue = useCallback(async () => {
    try {
      const res = await riderApi.getActiveOffer();
      if (!mountedRef.current) return;
      if (Array.isArray(res?.offers)) {
        setOfferQueue(normalizeOfferQueue(res.offers));
      } else if (res?.offer) {
        setOfferQueue(normalizeOfferQueue([res.offer]));
      } else {
        setOfferQueue([]);
      }
    } catch (_) {
      setOfferQueue([]);
    }
  }, []);

  const silenceRiderAlarm = useCallback(() => {
    // Media alarm loop must stop on accept/reject (not only on notifee action).
    try {
      // Lazy requires avoid circular imports at module load.
      // eslint-disable-next-line global-require
      require('../../utils/alarmSound').stopAlarmSound();
      // eslint-disable-next-line global-require
      require('../../utils/orderAlarmNotifications').cancelRiderOfferAlarm().catch(() => {});
    } catch { /* ignore */ }
  }, []);

  const handleAcceptOffer = useCallback(async (offer) => {
    silenceRiderAlarm();
    const id = offer.id || offer.offerId;
    const res = await riderApi.acceptOffer(id);
    // Drop accepted offer from queue, then load any next pending offer.
    setOfferQueue((prev) => prev.filter((o) => {
      const oid = o.id || o.offerId;
      return !(oid && Number(oid) === Number(id));
    }));
    await fetchAll();
    await refreshOfferQueue();
    // Open delivery map immediately after accept when we have the order id.
    const orderId = res?.order?.id ?? offer.orderId ?? offer.order_id;
    if (orderId) {
      navigation.navigate('RiderOrder', {
        orderId,
        order: res?.order || undefined,
      });
    }
  }, [fetchAll, navigation, refreshOfferQueue, silenceRiderAlarm]);

  const handleRejectOffer = useCallback(async (offer) => {
    silenceRiderAlarm();
    const id = offer.id || offer.offerId;
    await riderApi.rejectOffer(id);
    setOfferQueue((prev) => prev.filter((o) => {
      const oid = o.id || o.offerId;
      return !(oid && Number(oid) === Number(id));
    }));
    await fetchAll();
    // Next offer in queue (if any) becomes the new popup front.
    await refreshOfferQueue();
  }, [fetchAll, refreshOfferQueue, silenceRiderAlarm]);

  const runAction = useCallback(async (key, fn) => {
    setActionBusy(key);
    try {
      const res = await fn();
      // Optimistic patch from API so buttons update before full list reload.
      if (res?.order?.id) {
        setAssignments((prev) => {
          const id = res.order.id;
          if (res.order.status === 'Delivered' || res.order.status === 'Cancelled') {
            return prev.filter((a) => String(a.id) !== String(id));
          }
          return prev.map((a) => (
            String(a.id) === String(id) ? mergeRiderOrder(a, res.order) : a
          ));
        });
      }
      await fetchAll();
    } catch (err) {
      Alert.alert('Action failed', err?.message || 'Try again');
      await fetchAll();
    } finally {
      setActionBusy(null);
    }
  }, [fetchAll]);

  const handleOutForDelivery = useCallback(() => {
    if (!assignment?.id) return;
    runAction('ofd', () => riderApi.updateStatus(assignment.id, 'Out for Delivery'));
  }, [assignment, runAction]);

  const handleDelivered = useCallback(() => {
    if (!assignment?.id) return;
    Alert.alert('Mark delivered?', 'Confirm this order was delivered to the customer.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delivered',
        onPress: () => runAction('delivered', () => riderApi.updateStatus(assignment.id, 'Delivered')),
      },
    ]);
  }, [assignment, runAction]);

  const handleMarkPaid = useCallback(() => {
    if (!assignment?.id) return;
    Alert.alert('Mark payment received?', 'Confirm you have collected payment for this order.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Mark paid',
        onPress: () => runAction('mark_paid', () => riderApi.markPaid(assignment.id)),
      },
    ]);
  }, [assignment, runAction]);

  const openDeliveryMap = useCallback((job) => {
    if (!job?.id) return;
    // Pass snapshot so map sheet buttons match the card on first paint.
    navigation.navigate('RiderOrder', { orderId: job.id, order: job });
  }, [navigation]);

  const phone = assignment?.phone;
  const actionFlags = assignment ? getRiderActionFlags(assignment) : null;
  const pickedUp = actionFlags?.pickedUp || false;
  const status = actionFlags?.status || assignment?.status;
  const currentStep = stepIndex(status);
  const isFastDelivery = assignment?.deliveryType === 'fast' || assignment?.delivery_type === 'fast';
  const displayName = rider?.displayName || rider?.display_name || 'Rider';

  // Timer starts the moment the rider accepts (rider_assigned_at) and keeps
  // ticking until the job reaches a terminal state.
  const [nowTick, setNowTick] = useState(Date.now());
  const assignmentId = assignment?.id;
  const terminal = actionFlags?.terminal;
  useEffect(() => {
    if (!assignmentId || terminal) return undefined;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [assignmentId, terminal]);
  const assignedAt = assignment?.riderAssignedAt || assignment?.rider_assigned_at;
  const elapsedLabel = assignedAt
    ? formatElapsed(elapsedSecondsFromStart(assignedAt, nowTick))
    : null;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{displayName}</Text>
          <Text style={styles.subtitle}>Rider delivery dashboard</Text>
        </View>
        <TouchableOpacity onPress={handleLogout} style={styles.logoutBtn} activeOpacity={0.8}>
          <AppIcon name="logout" size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={(
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); fetchAll(); }}
            tintColor={colors.saffron}
          />
        )}
      >
        {/* Hero online card */}
        <LinearGradient
          colors={isOnline
            ? [colors.btnSuccessStart, colors.btnSuccessEnd]
            : [colors.btnDarkStart, colors.btnDarkEnd]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.heroCard}
        >
          <View style={styles.heroTopRow}>
            <View style={styles.heroIconBubble}>
              <AppIcon name="navigation" size={22} color={isOnline ? colors.successDark : colors.textInverse} />
            </View>
            <View style={styles.heroLive}>
              <Animated.View
                style={[
                  styles.liveDot,
                  {
                    opacity: isOnline ? pulse : 0.5,
                    backgroundColor: isOnline ? colors.success100 : 'rgba(255,255,255,0.7)',
                  },
                ]}
              />
              <Text style={styles.heroLiveText}>{isOnline ? 'LIVE' : 'OFF'}</Text>
            </View>
          </View>

          <View style={styles.heroRow}>
            <View style={{ flex: 1, paddingRight: spacing.md }}>
              <Text style={styles.heroStatus}>{isOnline ? 'Online' : 'Offline'}</Text>
              <Text style={styles.heroSub}>
                {assignment
                  ? 'On a delivery — finish this job first'
                  : isOnline
                    ? 'Ready for new delivery offers'
                    : 'Go online to receive offers'}
              </Text>
            </View>
            <ShopToggle
              value={isOnline}
              onValueChange={handleToggle}
              activeColor={colors.success}
              disabled={toggleBusy || loading || Boolean(assignment)}
              size="lg"
            />
          </View>
        </LinearGradient>

        {/* Metrics */}
        <View style={styles.metricsRow}>
          <View style={styles.metricCard}>
            <View style={[styles.metricIcon, { backgroundColor: colors.saffronLight }]}>
              <AppIcon name="orders" size={18} color={colors.saffronDark} />
            </View>
            <Text style={styles.metricValue}>{assignments.length}</Text>
            <Text style={styles.metricLabel}>
              {assignments.length === 1 ? 'Active job' : 'Active jobs'}
            </Text>
          </View>
          <View style={styles.metricCard}>
            <View style={[styles.metricIcon, { backgroundColor: isOnline ? colors.successLight : colors.surfaceMuted }]}>
              <AppIcon name="navigation" size={18} color={isOnline ? colors.success : colors.textTertiary} />
            </View>
            <Text style={[styles.metricValue, { color: isOnline ? colors.successDark : colors.textTertiary }]}>
              {isOnline ? 'On' : 'Off'}
            </Text>
            <Text style={styles.metricLabel}>Availability</Text>
          </View>
          <View style={styles.metricCard}>
            <View style={[styles.metricIcon, { backgroundColor: activeOffer ? colors.warningLight : colors.surfaceMuted }]}>
              <AppIcon name="notification" size={18} color={activeOffer ? colors.warning : colors.textTertiary} />
            </View>
            <Text style={styles.metricValue}>{offerQueue.length}</Text>
            <Text style={styles.metricLabel}>
              {offerQueue.length === 1 ? 'Offer' : 'Offers'}
            </Text>
          </View>
        </View>

        {error ? (
          <View style={styles.errorBanner}>
            <AppIcon name="close" size={14} color={colors.error} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>
            {assignments.length > 1
              ? 'Delivery queue'
              : assignment
                ? 'Current delivery'
                : 'Job queue'}
          </Text>
          {assignments.length > 0 ? (
            <View style={styles.countPill}>
              <Text style={styles.countPillText}>
                {assignments.length}
              </Text>
            </View>
          ) : null}
        </View>

        {assignments.length > 1 ? (
          <View style={styles.queueHint}>
            <AppIcon name="orders" size={14} color={colors.saffronDark} />
            <Text style={styles.queueHintText}>
              {assignments.length} active jobs · finish or advance each from its map
            </Text>
          </View>
        ) : null}

        {loading && !assignment ? (
          <ActivityIndicator style={{ marginTop: spacing.xl }} color={colors.saffron} />
        ) : assignment ? (
          <View style={styles.jobCard}>
            <View style={styles.jobAccent} />
            <View style={styles.jobBody}>
              <View style={styles.jobHeader}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  {assignments.length > 1 ? (
                    <Text style={styles.jobQueuePos}>Job 1 of {assignments.length}</Text>
                  ) : null}
                  <Text style={styles.jobOrderNum}>
                    #{assignment.orderNumber || assignment.order_number}
                  </Text>
                  <View style={[styles.deliveryTypeBadge, isFastDelivery && styles.deliveryTypeBadgeFast]}>
                    <Text style={[styles.deliveryTypeBadgeText, isFastDelivery && styles.deliveryTypeBadgeTextFast]}>
                      {isFastDelivery ? 'Fast' : 'Standard'}
                    </Text>
                  </View>
                </View>
                <View style={[
                  styles.statusChip,
                  isOutForDelivery(status) && styles.statusChipHot,
                  pickedUp && !isOutForDelivery(status) && styles.statusChipOk,
                ]}
                >
                  <Text style={[
                    styles.statusChipText,
                    isOutForDelivery(status) && styles.statusChipTextHot,
                    pickedUp && !isOutForDelivery(status) && styles.statusChipTextOk,
                  ]}
                  >
                    {status || 'Assigned'}
                  </Text>
                </View>
              </View>

              {elapsedLabel ? (
                <View style={styles.timerRow}>
                  <AppIcon name="clock" size={14} color={colors.textSecondary} />
                  <Text style={styles.timerText}>{elapsedLabel} since accepted</Text>
                </View>
              ) : null}

              {/* Step rail */}
              <View style={styles.stepRail}>
                {STEPS.map((step, i) => {
                  const done = i <= currentStep;
                  const active = i === currentStep;
                  return (
                    <View key={step.key} style={styles.stepItem}>
                      <View style={styles.stepTrackRow}>
                        <View style={[
                          styles.stepDot,
                          done && styles.stepDotDone,
                          active && styles.stepDotActive,
                        ]}
                        >
                          {done ? (
                            <AppIcon name="check" size={10} color={colors.textInverse} />
                          ) : null}
                        </View>
                        {i < STEPS.length - 1 ? (
                          <View style={[styles.stepLine, i < currentStep && styles.stepLineDone]} />
                        ) : null}
                      </View>
                      <Text style={[styles.stepLabel, done && styles.stepLabelDone]} numberOfLines={1}>
                        {step.label}
                      </Text>
                    </View>
                  );
                })}
              </View>

              {assignment.address ? (
                <View style={styles.addressBlock}>
                  <View style={styles.addressIcon}>
                    <AppIcon name="map" size={16} color={colors.saffronDark} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.addressLabel}>Drop-off</Text>
                    <Text style={styles.addressText}>{assignment.address}</Text>
                  </View>
                </View>
              ) : null}

              {Array.isArray(assignment.items) && assignment.items.length > 0 ? (
                <View style={styles.itemsBlock}>
                  <Text style={styles.itemsLabel}>Order items</Text>
                  {assignment.items.map((it, idx) => {
                    const variant = it.variantLabel || it.variant_label;
                    const shopName = it.shopName || it.shop_name;
                    return (
                      <View key={it.id ?? idx} style={styles.itemRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.itemLine} numberOfLines={1}>
                            {it.quantity}x {it.productName || it.product_name}
                            {variant ? ` (${variant})` : ''}
                          </Text>
                          {shopName ? (
                            <Text style={styles.itemShopName} numberOfLines={1}>{shopName}</Text>
                          ) : null}
                        </View>
                      </View>
                    );
                  })}
                  {assignment.total != null ? (
                    <View style={styles.totalRow}>
                      <Text style={styles.totalLabel}>Order total</Text>
                      <Text style={styles.totalValue}>₹{Number(assignment.total).toFixed(0)}</Text>
                    </View>
                  ) : null}
                </View>
              ) : null}

              {assignment.total != null ? (
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Order total</Text>
                  <Text style={styles.totalValue}>₹{Number(assignment.total).toFixed(0)}</Text>
                </View>
              ) : null}

              {(assignment.customerName || assignment.customer_name || phone) ? (
                <View style={styles.customerRow}>
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>
                      {(assignment.customerName || assignment.customer_name || 'C').charAt(0).toUpperCase()}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.customerName}>
                      {assignment.customerName || assignment.customer_name || 'Customer'}
                    </Text>
                    {phone ? <Text style={styles.customerPhone}>{phone}</Text> : null}
                  </View>
                  {phone ? (
                    <TouchableOpacity
                      style={styles.callFab}
                      onPress={() => Linking.openURL(`tel:${phone}`)}
                      activeOpacity={0.85}
                    >
                      <AppIcon name="phone" size={18} color={colors.textInverse} />
                    </TouchableOpacity>
                  ) : null}
                </View>
              ) : null}

              <TouchableOpacity
                style={styles.mapOpenBtn}
                onPress={() => openDeliveryMap(assignment)}
                activeOpacity={0.9}
              >
                <AppIcon name="map" size={20} color={colors.saffronDark} />
                <Text style={styles.mapOpenBtnText}>Open delivery map & route</Text>
                <AppIcon name="chevronRight" size={16} color={colors.saffronDark} />
              </TouchableOpacity>

              {/* Primary action stack — same rules as map sheet (getRiderActionFlags) */}
              <View style={styles.actionsCol}>
                {actionFlags?.showOutForDelivery ? (
                  <PrimaryBtn
                    label="Out for delivery"
                    icon="navigation"
                    busy={actionBusy === 'ofd'}
                    onPress={handleOutForDelivery}
                    variant="success"
                  />
                ) : null}
                {actionFlags?.showDelivered ? (
                  <PrimaryBtn
                    label="Mark delivered"
                    icon="check"
                    busy={actionBusy === 'delivered'}
                    onPress={handleDelivered}
                    variant="success"
                  />
                ) : null}
                {actionFlags?.showMarkPaid ? (
                  <PrimaryBtn
                    label="Mark paid"
                    icon="check"
                    busy={actionBusy === 'mark_paid'}
                    onPress={handleMarkPaid}
                    variant="saffron"
                  />
                ) : null}
              </View>

            </View>
          </View>
        ) : activeOffer ? (
          <View style={styles.offerWaitingCard}>
            <LinearGradient
              colors={[colors.brandGradientStart, colors.brandGradientEnd]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.offerWaitingInner}
            >
              <AppIcon name="notification" size={28} color={colors.textInverse} />
              <Text style={styles.offerWaitingTitle}>
                {offerQueue.length > 1
                  ? `${offerQueue.length} offers in queue`
                  : 'New offer waiting'}
              </Text>
              <Text style={styles.offerWaitingSub}>
                {offerQueue.length > 1
                  ? 'Respond one by one in the popup — next opens after accept/reject'
                  : 'Accept or reject in the popup — timer is running'}
              </Text>
            </LinearGradient>
          </View>
        ) : (
          <View style={styles.emptyState}>
            <View style={styles.emptyIconWrap}>
              <AppIcon name="navigation" size={32} color={colors.saffronDark} />
            </View>
            <Text style={styles.emptyTitle}>
              {isOnline ? 'Waiting for offers' : 'You are offline'}
            </Text>
            <Text style={styles.emptyText}>
              {isOnline
                ? 'When a shop accepts an order, you may get a delivery offer here.'
                : 'Turn on availability above to start receiving deliveries.'}
            </Text>
          </View>
        )}

        {/* Jobs 2+ in the delivery queue */}
        {assignments.length > 1
          ? assignments.slice(1).map((job, idx) => {
              const jobFlags = getRiderActionFlags(job);
              return (
                <TouchableOpacity
                  key={job.id}
                  style={styles.queueJobCard}
                  onPress={() => openDeliveryMap(job)}
                  activeOpacity={0.9}
                >
                  <View style={styles.queueJobAccent} />
                  <View style={styles.queueJobBody}>
                    <View style={styles.queueJobTop}>
                      <Text style={styles.jobQueuePos}>
                        Job {idx + 2} of {assignments.length}
                      </Text>
                      <View style={[
                        styles.statusChip,
                        isOutForDelivery(jobFlags.status) && styles.statusChipHot,
                        jobFlags.pickedUp && !isOutForDelivery(jobFlags.status) && styles.statusChipOk,
                      ]}
                      >
                        <Text style={[
                          styles.statusChipText,
                          isOutForDelivery(jobFlags.status) && styles.statusChipTextHot,
                          jobFlags.pickedUp && !isOutForDelivery(jobFlags.status) && styles.statusChipTextOk,
                        ]}
                        >
                          {jobFlags.status || 'Assigned'}
                        </Text>
                      </View>
                    </View>
                    <Text style={styles.queueJobNum}>
                      #{job.orderNumber || job.order_number}
                    </Text>
                    {job.address ? (
                      <Text style={styles.queueJobAddress} numberOfLines={2}>
                        {job.address}
                      </Text>
                    ) : null}
                    {(job.deliveryType || job.delivery_type || job.total != null) ? (
                      <Text style={styles.queueJobMeta}>
                        {(job.deliveryType || job.delivery_type) === 'fast' ? '⚡ Express' : 'Standard'}
                        {job.total != null ? ` · ₹${Number(job.total).toFixed(0)}` : ''}
                      </Text>
                    ) : null}
                    <View style={styles.queueJobFooter}>
                      <Text style={styles.queueJobCta}>Open map & actions</Text>
                      <AppIcon name="chevronRight" size={16} color={colors.saffronDark} />
                    </View>
                  </View>
                </TouchableOpacity>
              );
            })
          : null}
      </ScrollView>

      {activeOffer ? (
        <RiderOfferPopup
          offer={activeOffer}
          onAccept={handleAcceptOffer}
          onReject={handleRejectOffer}
          hasActiveJobs={assignments.length > 0}
          activeJobCount={assignments.length}
          queueIndex={0}
          queueTotal={offerQueue.length}
        />
      ) : null}
    </SafeAreaView>
  );
}

function PrimaryBtn({ label, icon, onPress, busy, variant = 'saffron' }) {
  const grad = variant === 'success'
    ? [colors.btnSuccessStart, colors.btnSuccessEnd]
    : [colors.btnHighlightStart, colors.btnHighlightEnd];
  return (
    <TouchableOpacity onPress={onPress} disabled={Boolean(busy)} activeOpacity={0.9}>
      <LinearGradient colors={grad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.primaryBtn}>
        {busy ? (
          <ActivityIndicator color={colors.textInverse} />
        ) : (
          <>
            <AppIcon name={icon} size={18} color={colors.textInverse} />
            <Text style={styles.primaryBtnText}>{label}</Text>
          </>
        )}
      </LinearGradient>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgApp },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  title: { ...typography.display, fontSize: 26, color: colors.textPrimary },
  subtitle: { ...typography.bodySmall, color: colors.textSecondary, marginTop: 2, fontWeight: '500' },
  logoutBtn: {
    width: 42,
    height: 42,
    borderRadius: radius.circle,
    backgroundColor: colors.bgSurface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.xs,
  },
  body: { flex: 1 },
  scrollContent: { paddingBottom: spacing.xxl },

  heroCard: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.xs,
    marginBottom: spacing.md,
    borderRadius: radius.xxl,
    padding: spacing.xl,
    ...shadows.cardRaised,
  },
  heroTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  heroIconBubble: {
    width: 44,
    height: 44,
    borderRadius: radius.circle,
    backgroundColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroLive: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  liveDot: {
    width: 10,
    height: 10,
    borderRadius: radius.circle,
  },
  heroLiveText: {
    color: 'rgba(255,255,255,0.95)',
    fontWeight: '800',
    fontSize: 11,
    letterSpacing: 1.2,
  },
  heroRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heroStatus: {
    color: colors.textInverse,
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: -0.4,
  },
  heroSub: {
    color: 'rgba(255,255,255,0.92)',
    fontSize: 14,
    marginTop: 4,
    fontWeight: '500',
    lineHeight: 20,
  },

  metricsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.lg,
  },
  metricCard: {
    flex: 1,
    backgroundColor: colors.bgSurface,
    borderRadius: radius.xl,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    ...shadows.sm,
  },
  metricIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.circle,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  metricValue: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.textPrimary,
    lineHeight: 28,
  },
  metricLabel: {
    fontSize: 11,
    color: colors.textSecondary,
    marginTop: 2,
    fontWeight: '600',
    letterSpacing: 0.2,
  },

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  sectionTitle: {
    ...typography.labelSmall,
    fontSize: 13,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  countPill: {
    marginLeft: spacing.sm,
    backgroundColor: colors.saffronLight,
    borderRadius: radius.pill,
    paddingHorizontal: 9,
    paddingVertical: 2,
    minWidth: 24,
    alignItems: 'center',
  },
  countPillText: { color: colors.saffronDark, fontWeight: '800', fontSize: 12 },
  queueHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.saffronLight,
    borderRadius: radius.lg,
  },
  queueHintText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    color: colors.saffronDark,
  },
  jobQueuePos: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.saffronDark,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 2,
  },
  queueJobCard: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    backgroundColor: colors.bgSurface,
    borderRadius: radius.xxl,
    overflow: 'hidden',
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.sm,
  },
  queueJobAccent: {
    width: 5,
    backgroundColor: colors.info || colors.saffron,
  },
  queueJobBody: {
    flex: 1,
    padding: spacing.md,
  },
  queueJobTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  queueJobNum: {
    fontSize: 18,
    fontWeight: '900',
    color: colors.textPrimary,
    marginBottom: 4,
  },
  queueJobAddress: {
    fontSize: 13,
    color: colors.textSecondary,
    fontWeight: '500',
    marginBottom: spacing.sm,
  },
  queueJobMeta: {
    fontSize: 12,
    color: colors.textSecondary,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  queueJobFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  queueJobCta: {
    fontSize: 13,
    fontWeight: '800',
    color: colors.saffronDark,
  },

  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    backgroundColor: colors.errorLight,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  errorText: { flex: 1, color: colors.error, fontWeight: '600', fontSize: 13 },

  jobCard: {
    flexDirection: 'row',
    marginHorizontal: spacing.lg,
    backgroundColor: colors.bgSurface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    ...shadows.cardRaised,
  },
  jobAccent: { width: 6, backgroundColor: colors.saffron },
  jobBody: { flex: 1, padding: spacing.lg },
  jobHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  jobOrderNum: { ...typography.h2, fontSize: 22, color: colors.textPrimary },
  deliveryTypeBadge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.infoLight,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginTop: 4,
  },
  deliveryTypeBadgeFast: { backgroundColor: colors.saffron },
  deliveryTypeBadgeText: { fontSize: 10, fontWeight: '800', color: colors.info },
  deliveryTypeBadgeTextFast: { color: colors.textInverse },
  statusChip: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  statusChipHot: { backgroundColor: colors.badgeHotBg },
  statusChipOk: { backgroundColor: colors.successLight },
  statusChipText: { fontWeight: '800', fontSize: 12, color: colors.textSecondary },
  statusChipTextHot: { color: colors.badgeHotText },
  statusChipTextOk: { color: colors.successDark },
  timerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: spacing.sm,
  },
  timerText: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  stepRail: {
    flexDirection: 'row',
    marginBottom: spacing.lg,
    paddingTop: spacing.xs,
  },
  stepItem: { flex: 1 },
  stepTrackRow: { flexDirection: 'row', alignItems: 'center' },
  stepDot: {
    width: 22,
    height: 22,
    borderRadius: radius.circle,
    backgroundColor: colors.grey100,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepDotDone: {
    backgroundColor: colors.success,
    borderColor: colors.success,
  },
  stepDotActive: {
    backgroundColor: colors.saffron,
    borderColor: colors.saffron,
    ...shadows.sm,
  },
  stepLine: {
    flex: 1,
    height: 3,
    backgroundColor: colors.grey100,
    marginHorizontal: 2,
    borderRadius: 2,
  },
  stepLineDone: { backgroundColor: colors.success },
  stepLabel: {
    fontSize: 10,
    color: colors.textTertiary,
    fontWeight: '600',
    marginTop: 6,
  },
  stepLabelDone: { color: colors.textSecondary, fontWeight: '700' },

  addressBlock: {
    flexDirection: 'row',
    gap: spacing.md,
    backgroundColor: colors.saffronLight,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  addressIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.bgSurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addressLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.saffronDark,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  addressText: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '600',
    lineHeight: 20,
  },

  itemsBlock: {
    backgroundColor: colors.bgApp,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  itemsLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: 2,
  },
  itemLine: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '600',
    flex: 1,
  },
  itemShopName: { fontSize: 11, fontWeight: '700', color: colors.saffronDark, marginTop: 1 },
  itemPrice: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
    paddingTop: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  totalLabel: { ...typography.body, color: colors.textSecondary, fontWeight: '600' },
  totalValue: { ...typography.body, color: colors.textPrimary, fontWeight: '800' },

  customerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.lg,
    paddingVertical: spacing.sm,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: radius.circle,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontWeight: '800', fontSize: 18, color: colors.textPrimary },
  customerName: { ...typography.bodyBold, color: colors.textPrimary },
  customerPhone: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  callFab: {
    width: 44,
    height: 44,
    borderRadius: radius.circle,
    backgroundColor: colors.info,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.sm,
  },

  mapOpenBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.saffronLight,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.saffron,
  },
  mapOpenBtnText: {
    flex: 1,
    fontWeight: '800',
    fontSize: 14,
    color: colors.saffronDark,
  },
  actionsCol: { gap: spacing.sm },
  primaryBtn: {
    minHeight: 52,
    borderRadius: radius.button,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    ...shadows.sm,
  },
  primaryBtnText: {
    color: colors.textInverse,
    fontWeight: '800',
    fontSize: 16,
  },
  ghostDanger: {
    minHeight: 48,
    borderRadius: radius.button,
    borderWidth: 1.5,
    borderColor: colors.error,
    backgroundColor: colors.errorLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghostDangerText: { color: colors.error, fontWeight: '800', fontSize: 14 },

  offerWaitingCard: {
    marginHorizontal: spacing.lg,
    borderRadius: radius.xl,
    overflow: 'hidden',
    ...shadows.cardRaised,
  },
  offerWaitingInner: {
    padding: spacing.xl,
    alignItems: 'center',
  },
  offerWaitingTitle: {
    color: colors.textInverse,
    fontWeight: '800',
    fontSize: 20,
    marginTop: spacing.md,
  },
  offerWaitingSub: {
    color: 'rgba(255,255,255,0.9)',
    textAlign: 'center',
    marginTop: spacing.xs,
    fontWeight: '500',
    lineHeight: 20,
  },

  emptyState: {
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    marginTop: spacing.lg,
  },
  emptyIconWrap: {
    width: 80,
    height: 80,
    borderRadius: radius.circle,
    backgroundColor: colors.saffronLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  emptyTitle: { ...typography.h3, color: colors.textPrimary },
  emptyText: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.xs,
    lineHeight: 21,
    maxWidth: 280,
  },
});
