import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  ActivityIndicator, Alert, Animated, AppState, Easing, FlatList, Platform,
  RefreshControl, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { colors, spacing, typography, radius, shadows } from '../../theme';
import { useAuthStore } from '../../stores';
import {
  shopApi,
  subscribeRealtime,
  subscribeRealtimeLifecycle,
  getRealtimeConnectionState,
} from '../../api';
import { useNewOrderAlert } from '../../hooks/useNewOrderAlert';
import { stopAlarmSound } from '../../utils/alarmSound';
import {
  cancelOrderAlarm,
  displayAlarmNotification,
} from '../../utils/orderAlarmNotifications';
import AppIcon from '../../components/AppIcon';
import ShopToggle from '../../components/shop/ShopToggle';
import TimePickerModal from '../../components/shop/TimePickerModal';
import NewOrderPopup from './NewOrderPopup';

function formatDisplayTime(hhmm) {
  if (!hhmm) return '--:--';
  const [h, m] = String(hhmm).split(':').map(Number);
  const meridiem = h >= 12 ? 'PM' : 'AM';
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${String(m).padStart(2, '0')} ${meridiem}`;
}

function formatElapsed(startTime, nowMs) {
  const start = new Date(startTime).getTime();
  if (!startTime || Number.isNaN(start)) return '0:00:00';
  const diffSec = Math.max(0, Math.floor((nowMs - start) / 1000));
  const h = Math.floor(diffSec / 3600);
  const m = Math.floor((diffSec % 3600) / 60);
  const s = diffSec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Cap for ackedOrderIdsRef below — this screen can stay mounted for a shop's
// entire shift on an always-on tablet.
const ACKED_ORDER_IDS_CAP = 200;

/**
 * ShopDashboardScreen
 * Premium shop-owner dashboard: live open/closed toggle, active-order queue,
 * and a non-dismissible Accept/Reject popup for incoming orders.
 */
export default function ShopDashboardScreen() {
  const shop = useAuthStore((s) => s.shop);
  const logout = useAuthStore((s) => s.logout);

  // ── Shop open/closed toggle ──────────────────────────────────────────
  const [isOpen, setIsOpen] = useState(Boolean(shop?.isOpen));
  const [toggleBusy, setToggleBusy] = useState(false);
  // fetchAll() (focus effect, socket events, foreground/reconnect) can race
  // an in-flight PATCH /shop/me/toggle and overwrite the optimistic isOpen
  // with the pre-toggle DB value — this ref stops it from clobbering the
  // toggle while one is in flight (fixes "toggle needs a second press").
  const toggleInFlightRef = useRef(false);

  // ── Auto open/close schedule ─────────────────────────────────────────
  const [openTime, setOpenTime] = useState(shop?.openTime || null);
  const [closeTime, setCloseTime] = useState(shop?.closeTime || null);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [pickerField, setPickerField] = useState(null); // 'open' | 'close' | null
  const scheduleEnabled = Boolean(openTime && closeTime);

  // ── Orders ────────────────────────────────────────────────────────────
  const [activeOrders, setActiveOrders] = useState([]); // confirmed:true
  const [pendingQueue, setPendingQueue] = useState([]); // confirmed:false && rejected:false
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const mountedRef = useRef(true);

  // ── Order-cancelled notice ───────────────────────────────────────────
  // Shown for 3s when admin/backend cancels an order the shop already
  // accepted (or was still queued to accept), so the owner isn't left
  // guessing why a card silently vanished mid-prep.
  const [cancelledNotice, setCancelledNotice] = useState(null); // { orderNumber, items }
  const cancelledNoticeTimerRef = useRef(null);

  const showCancelledNotice = useCallback((order) => {
    if (!order) return;
    if (cancelledNoticeTimerRef.current) clearTimeout(cancelledNoticeTimerRef.current);
    setCancelledNotice({
      orderNumber: order.orderNumber || order.order_number,
      items: order.items || [],
    });
    cancelledNoticeTimerRef.current = setTimeout(() => {
      setCancelledNotice(null);
      cancelledNoticeTimerRef.current = null;
    }, 3000);
  }, []);

  useEffect(() => () => {
    if (cancelledNoticeTimerRef.current) clearTimeout(cancelledNoticeTimerRef.current);
  }, []);

  // Ticking clock for the elapsed-time readout on each active order card.
  // Only ticks while there is something to show — avoids re-rendering the
  // whole screen every second when the queue is empty.
  const [now, setNow] = useState(() => Date.now());
  const hasActiveOrders = activeOrders.length > 0;
  useEffect(() => {
    if (!hasActiveOrders) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasActiveOrders]);

  // Pulsing live dot
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!isOpen) return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [isOpen, pulse]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const fetchAll = useCallback(async () => {
    try {
      const [shopRes, ordersRes] = await Promise.all([
        shopApi.getMyShop().catch(() => null),
        shopApi.getMyOrders(),
      ]);
      if (!mountedRef.current) return;
      if (shopRes?.shop && !toggleInFlightRef.current) {
        setIsOpen(Boolean(shopRes.shop.isOpen));
        setOpenTime(shopRes.shop.openTime || null);
        setCloseTime(shopRes.shop.closeTime || null);
      }

      const orders = ordersRes.orders || [];
      setActiveOrders(orders.filter(o => o.confirmed && !o.rejected));
      // One-at-a-time popup queue: keep existing order, append new ones
      // oldest-first so the first arrived stays on screen until Accept/Reject.
      setPendingQueue(prev => {
        const incoming = orders
          .filter(o => !o.confirmed && !o.rejected)
          .slice()
          .sort((a, b) => Number(a.id) - Number(b.id));
        const stillPendingIds = new Set(incoming.map(o => o.id));
        const kept = prev.filter(o => stillPendingIds.has(o.id));
        const keptIds = new Set(kept.map(o => o.id));
        const fresh = incoming.filter(o => !keptIds.has(o.id));
        return [...kept, ...fresh];
      });
      setLoadError(false);
    } catch (_) {
      if (mountedRef.current) setLoadError(true);
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    fetchAll();
  }, [fetchAll]);

  useFocusEffect(
    useCallback(() => {
      fetchAll();
    }, [fetchAll])
  );

  // Latest pending head for background alarm (socket may fire while Home).
  const pendingHeadRef = useRef(null);
  pendingHeadRef.current = pendingQueue[0] || null;

  /**
   * When the shop app is backgrounded, FCM data-only often never reaches Metro
   * (headless JS logs only in logcat) and ColorOS may drop audio. Socket is
   * still connected — ring the full notifee + media alarm from the main JS
   * context so the owner hears it.
   */
  const ringBackgroundShopAlarm = useCallback((payload = {}) => {
    if (Platform.OS !== 'android') return;
    if (AppState.currentState === 'active') return;
    const head = pendingHeadRef.current;
    const orderId = payload?.orderId ?? payload?.order_id ?? head?.id;
    const orderNumber =
      payload?.orderNumber
      ?? payload?.order_number
      ?? head?.orderNumber
      ?? head?.order_number
      ?? '';
    console.warn(
      '[orderAlarm] socket/bg ring shop order',
      orderId,
      orderNumber,
      'appState=',
      AppState.currentState,
    );
    displayAlarmNotification({
      alertType: 'new_order_alarm',
      type: 'shop_order',
      orderId: orderId != null ? String(orderId) : '',
      orderNumber: orderNumber != null ? String(orderNumber) : '',
    }).catch((err) => {
      console.warn('[orderAlarm] socket/bg ring failed:', err?.message || err);
    });
  }, []);

  useEffect(() => {
    // shop.order.updated: admin confirm/ready/reject, rider Out for Delivery /
    // Delivered, or cancel — refetch so Active list + Accept popup stay live.
    // shop.order.cancelled: admin cancelled whole order.
    const dropOrder = (payload, { cancelled = false } = {}) => {
      const orderId = payload?.orderId ?? payload?.order_id;
      if (orderId == null) return;
      const matchId = (o) => Number(o.id) === Number(orderId);
      if (cancelled) {
        setActiveOrders((prev) => {
          const match = prev.find(matchId);
          if (match) showCancelledNotice(match);
          return prev.filter((o) => !matchId(o));
        });
        setPendingQueue((prev) => {
          const match = prev.find(matchId);
          if (match) showCancelledNotice(match);
          return prev.filter((o) => !matchId(o));
        });
      } else {
        setPendingQueue((prev) => prev.filter((o) => !matchId(o)));
        setActiveOrders((prev) => prev.filter((o) => !matchId(o)));
      }
    };
    const terminalStatuses = new Set(['Delivered', 'Cancelled', 'Out for Delivery']);
    const unsubAssigned = subscribeRealtime('shop.order.assigned', (payload) => {
      fetchAll();
      // Warm background: don't wait for FCM — socket owns the loud path.
      ringBackgroundShopAlarm(payload || {});
    });
    const unsubCancelled = subscribeRealtime('shop.order.cancelled', (payload) => {
      dropOrder(payload, { cancelled: true });
      fetchAll();
    });
    const unsubUpdated = subscribeRealtime('shop.order.updated', (payload) => {
      const status = payload?.status;
      const isCancelled = payload?.action === 'cancelled' || status === 'Cancelled';
      if (isCancelled || (status && terminalStatuses.has(status))) {
        // Optimistic remove so Active cards clear before the GET returns.
        dropOrder(payload, { cancelled: isCancelled });
      }
      fetchAll();
    });
    const unsubRiderAssigned = subscribeRealtime('shop.order.rider_assigned', () => fetchAll());
    const unsubRiderFailed = subscribeRealtime('shop.order.rider_failed', (payload) => {
      dropOrder(payload);
      fetchAll();
    });
    const unsubForeground = subscribeRealtime('lifecycle.foreground', () => fetchAll());
    const unsubReconnected = subscribeRealtime('lifecycle.reconnected', () => fetchAll());

    // If owner backgrounds while a popup is already waiting, start notifee now
    // (local 8s loop is paused for shop in background).
    const appSub = AppState.addEventListener('change', (next) => {
      if (next !== 'active' && pendingHeadRef.current) {
        ringBackgroundShopAlarm({
          orderId: pendingHeadRef.current.id,
          orderNumber:
            pendingHeadRef.current.orderNumber
            || pendingHeadRef.current.order_number,
        });
      }
    });

    return () => {
      unsubAssigned();
      unsubCancelled();
      unsubUpdated();
      unsubRiderAssigned();
      unsubRiderFailed();
      unsubForeground();
      unsubReconnected();
      appSub.remove();
    };
  }, [fetchAll, ringBackgroundShopAlarm, showCancelledNotice]);

  // ── Weak-network resilience: offline banner + HTTP polling fallback ────
  // A socket can sit "connected" for up to ~30s after the underlying network
  // actually died (see the server's pingInterval/pingTimeout) — during that
  // window a new-order alarm emitted into it is silently dropped. Poll
  // GET /shop/orders on a plain interval whenever we know the socket is down
  // so a new order still surfaces without waiting on the realtime path at all.
  const [socketConnected, setSocketConnected] = useState(
    () => getRealtimeConnectionState().connected
  );
  useEffect(() => {
    const unsubLifecycle = subscribeRealtimeLifecycle(({ eventName }) => {
      setSocketConnected(eventName !== 'disconnected');
    });
    return unsubLifecycle;
  }, []);

  useEffect(() => {
    if (socketConnected) return undefined;
    const id = setInterval(() => fetchAll(), 15000);
    return () => clearInterval(id);
  }, [socketConnected, fetchAll]);

  // ── Repeating alert while anything is waiting in the popup queue ────
  // role: 'shop' — alarm tray clear + foreground 8s loop; background uses
  // socket ringBackgroundShopAlarm + FCM (admin uses default quiet loop).
  useNewOrderAlert(pendingQueue.length > 0, { role: 'shop' });

  const currentPopupOrder = pendingQueue[0] || null;

  // Proof-of-delivery for the in-app popup path (foreground, or backgrounded
  // then foregrounded without ever hitting the killed-app FCM handler) — the
  // killed-app notifee path already acks from displayAlarmNotification.
  // Capped FIFO, not an unbounded Set: this screen can stay mounted for a
  // shop's entire shift on an always-on tablet, and an order id is only
  // ever useful here to dedupe a re-render of the SAME still-pending popup —
  // once confirmed/rejected/expired it never reappears, so nothing is lost
  // by forgetting old ids once the cap is hit.
  const ackedOrderIdsRef = useRef(new Set());
  useEffect(() => {
    if (!currentPopupOrder) return;
    const id = currentPopupOrder.id;
    const acked = ackedOrderIdsRef.current;
    if (acked.has(id)) return;
    acked.add(id);
    if (acked.size > ACKED_ORDER_IDS_CAP) {
      acked.delete(acked.values().next().value); // oldest (Set preserves insertion order)
    }
    shopApi.ackOrderAlert(id).catch(() => {});
  }, [currentPopupOrder]);

  const dequeue = useCallback((orderId) => {
    setPendingQueue(prev => prev.filter(o => o.id !== orderId));
  }, []);

  const silenceShopAlarm = useCallback(() => {
    // Media loop keeps playing until stopAlarmSound — must run on accept/reject.
    stopAlarmSound();
    cancelOrderAlarm().catch(() => {});
  }, []);

  const handleAccept = useCallback(async (orderId) => {
    silenceShopAlarm();
    const order = pendingQueue.find(o => o.id === orderId);
    await shopApi.confirmOrder(orderId);
    dequeue(orderId);
    if (order) setActiveOrders(prev => [...prev, { ...order, confirmed: true }]);
  }, [pendingQueue, dequeue, silenceShopAlarm]);

  const handleReject = useCallback(async (orderId) => {
    silenceShopAlarm();
    await shopApi.rejectOrder(orderId);
    dequeue(orderId);
  }, [dequeue, silenceShopAlarm]);

  // ── Active-order actions: Cancel / Ready ─────────────────────────────
  const [actionBusy, setActionBusy] = useState({}); // { [orderId]: 'cancel' | 'ready' }

  const handleCancelOrder = useCallback((orderId) => {
    Alert.alert(
      'Cancel order',
      'Cancel this order? The admin will be notified to reassign or contact the customer.',
      [
        { text: 'Keep order', style: 'cancel' },
        {
          text: 'Cancel order', style: 'destructive', onPress: async () => {
            setActionBusy(prev => ({ ...prev, [orderId]: 'cancel' }));
            try {
              await shopApi.rejectOrder(orderId);
              setActiveOrders(prev => prev.filter(o => o.id !== orderId));
            } catch (err) {
              Alert.alert('Could not cancel order', err?.message || 'Please try again.');
            } finally {
              setActionBusy(prev => {
                const next = { ...prev };
                delete next[orderId];
                return next;
              });
            }
          },
        },
      ]
    );
  }, []);

  const handleReadyOrder = useCallback(async (orderId) => {
    setActionBusy(prev => ({ ...prev, [orderId]: 'ready' }));
    try {
      await shopApi.readyOrder(orderId);
      setActiveOrders(prev => prev.map(o => (o.id === orderId ? { ...o, ready: true } : o)));
    } catch (err) {
      Alert.alert('Could not mark ready', err?.message || 'Please try again.');
    } finally {
      setActionBusy(prev => {
        const next = { ...prev };
        delete next[orderId];
        return next;
      });
    }
  }, []);

  // ── Shop toggle ───────────────────────────────────────────────────────
  const handleToggle = useCallback(async (value) => {
    const prev = isOpen;
    toggleInFlightRef.current = true;
    setIsOpen(value); // optimistic
    setToggleBusy(true);
    try {
      await shopApi.toggleShop(value);
    } catch (err) {
      setIsOpen(prev); // rollback
      Alert.alert('Could not update shop', err?.message || 'Please try again.');
    } finally {
      toggleInFlightRef.current = false;
      setToggleBusy(false);
    }
  }, [isOpen]);

  // ── Schedule: master switch + per-boundary time pickers ─────────────
  // Enabling seeds sensible defaults (9 AM–9 PM) so the owner has something
  // to tweak instead of an empty state; disabling clears both columns, which
  // is exactly what tells shopScheduleSweeper (server-side) to leave is_open
  // alone from then on.
  const handleScheduleToggle = useCallback(async (value) => {
    const prevOpen = openTime;
    const prevClose = closeTime;
    const nextOpen = value ? (openTime || '09:00') : null;
    const nextClose = value ? (closeTime || '21:00') : null;
    setOpenTime(nextOpen);
    setCloseTime(nextClose);
    setScheduleBusy(true);
    try {
      await shopApi.updateSchedule(nextOpen, nextClose);
    } catch (err) {
      setOpenTime(prevOpen);
      setCloseTime(prevClose);
      Alert.alert('Could not update schedule', err?.message || 'Please try again.');
    } finally {
      setScheduleBusy(false);
    }
  }, [openTime, closeTime]);

  const handleTimeConfirm = useCallback(async (hhmm) => {
    const prevOpen = openTime;
    const prevClose = closeTime;
    const nextOpen = pickerField === 'open' ? hhmm : openTime;
    const nextClose = pickerField === 'close' ? hhmm : closeTime;
    setPickerField(null);
    if (nextOpen === nextClose) {
      Alert.alert('Pick different times', 'Opening and closing time cannot be the same.');
      return;
    }
    setOpenTime(nextOpen);
    setCloseTime(nextClose);
    setScheduleBusy(true);
    try {
      await shopApi.updateSchedule(nextOpen, nextClose);
    } catch (err) {
      setOpenTime(prevOpen);
      setCloseTime(prevClose);
      Alert.alert('Could not update schedule', err?.message || 'Please try again.');
    } finally {
      setScheduleBusy(false);
    }
  }, [pickerField, openTime, closeTime]);

  const handleLogout = useCallback(() => {
    Alert.alert('Sign out', 'Sign out of the shop dashboard?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => logout() },
    ]);
  }, [logout]);

  const renderActiveOrder = ({ item }) => (
    <View style={styles.activeCard}>
      <View style={styles.activeAccent} />
      <View style={styles.activeCardBody}>
        <View style={styles.activeCardHeader}>
          <Text style={styles.activeOrderNumber}>#{item.orderNumber || item.order_number}</Text>
          <View style={styles.activeBadge}>
            <AppIcon name="check" size={12} color={colors.successDark} />
            <Text style={styles.activeBadgeText}>Preparing</Text>
          </View>
        </View>
        <View style={styles.activeElapsedRow}>
          <AppIcon name="clock" size={13} color={colors.textSecondary} />
          <Text style={styles.activeElapsedText}>
            {formatElapsed(item.createdAt || item.created_at, now)}
          </Text>
          {(item.shopTotal ?? item.shop_total) > 0 ? (
            <Text style={styles.activeShopTotal}>You'll receive ₹{item.shopTotal ?? item.shop_total}</Text>
          ) : null}
        </View>
        {(item.items || []).map((it, idx) => {
          const lineTotal = it.shopLineTotal ?? it.shop_line_total;
          return (
            <View key={idx} style={styles.activeItemRow}>
              <View style={styles.qtyChip}>
                <Text style={styles.qtyChipText}>{it.quantity}x</Text>
              </View>
              <Text style={styles.activeItemText} numberOfLines={1}>
                {it.productName || it.product_name}
              </Text>
              <Text style={styles.activeItemPrice}>
                {lineTotal != null ? `₹${lineTotal}` : ''}
              </Text>
            </View>
          );
        })}

        {item.ready ? (
          <View style={styles.readyPill}>
            <AppIcon name="check" size={13} color={colors.info} />
            <Text style={styles.readyPillText}>Ready for pickup</Text>
          </View>
        ) : null}

        <View style={styles.activeActionsRow}>
          <TouchableOpacity
            style={styles.cancelBtn}
            onPress={() => handleCancelOrder(item.id)}
            disabled={!!actionBusy[item.id]}
            activeOpacity={0.85}
          >
            {actionBusy[item.id] === 'cancel' ? (
              <ActivityIndicator size="small" color={colors.error} />
            ) : (
              <Text style={styles.cancelBtnText}>Cancel</Text>
            )}
          </TouchableOpacity>
          {!item.ready && (
            <TouchableOpacity
              style={styles.readyBtn}
              onPress={() => handleReadyOrder(item.id)}
              disabled={!!actionBusy[item.id]}
              activeOpacity={0.85}
            >
              {actionBusy[item.id] === 'ready' ? (
                <ActivityIndicator size="small" color={colors.textInverse} />
              ) : (
                <Text style={styles.readyBtnText}>Ready</Text>
              )}
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );

  const renderListHeader = useCallback(() => (
    <>
      {/* Auto open/close schedule */}
      <View style={styles.scheduleCard}>
        <View style={styles.scheduleHeader}>
          <View style={styles.scheduleHeaderLeft}>
            <View style={styles.scheduleIconWrap}>
              <AppIcon name="clock" size={18} color={colors.saffronDark} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.scheduleTitle}>Auto schedule</Text>
              <Text style={styles.scheduleSub}>
                {scheduleEnabled ? 'Opens and closes on its own every day' : 'Off — the toggle above stays fully manual'}
              </Text>
            </View>
          </View>
          <ShopToggle
            value={scheduleEnabled}
            onValueChange={handleScheduleToggle}
            disabled={scheduleBusy}
            size="md"
            accessibilityLabel="Toggle auto schedule"
          />
        </View>

        {scheduleEnabled && (
          <View style={styles.scheduleTimesRow}>
            <TouchableOpacity
              style={styles.timeChip}
              onPress={() => setPickerField('open')}
              activeOpacity={0.8}
              disabled={scheduleBusy}
            >
              <Text style={styles.timeChipLabel}>Opens</Text>
              <Text style={styles.timeChipValue}>{formatDisplayTime(openTime)}</Text>
            </TouchableOpacity>
            <View style={styles.scheduleArrow}>
              <AppIcon name="chevronRight" size={16} color={colors.textTertiary} />
            </View>
            <TouchableOpacity
              style={styles.timeChip}
              onPress={() => setPickerField('close')}
              activeOpacity={0.8}
              disabled={scheduleBusy}
            >
              <Text style={styles.timeChipLabel}>Closes</Text>
              <Text style={styles.timeChipValue}>{formatDisplayTime(closeTime)}</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Metric strip */}
      <View style={styles.metricsRow}>
        <View style={[styles.metricCard, { flex: 1 }]}>
          <AppIcon name="orders" size={22} color={colors.saffron} />
          <Text style={styles.metricValue}>{activeOrders.length}</Text>
          <Text style={styles.metricLabel}>Active orders</Text>
        </View>
        <View style={[styles.metricCard, { flex: 1 }]}>
          <AppIcon name="home" size={22} color={isOpen ? colors.success : colors.textTertiary} />
          <Text style={[styles.metricValue, { color: isOpen ? colors.successDark : colors.textTertiary }]}>
            {isOpen ? 'On' : 'Off'}
          </Text>
          <Text style={styles.metricLabel}>Shop status</Text>
        </View>
      </View>

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Active orders</Text>
        {activeOrders.length > 0 && (
          <View style={styles.countPill}>
            <Text style={styles.countPillText}>{activeOrders.length}</Text>
          </View>
        )}
      </View>
    </>
  ), [scheduleEnabled, handleScheduleToggle, scheduleBusy, openTime, closeTime, activeOrders.length, isOpen]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{shop?.name || 'My Shop'}</Text>
          <Text style={styles.subtitle}>Shop owner dashboard</Text>
        </View>
        <TouchableOpacity onPress={handleLogout} style={styles.logoutBtn} activeOpacity={0.8}>
          <AppIcon name="logout" size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {!socketConnected && (
        <View style={styles.offlineBanner}>
          <AppIcon name="warning" size={16} color={'#8A5A00'} />
          <Text style={styles.offlineBannerText}>
            Weak connection — checking for new orders every 15s
          </Text>
        </View>
      )}

      {/* Hero open/closed card */}
      <LinearGradient
        colors={[colors.brandGradientStart, colors.brandGradientEnd]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.heroCard}
      >
        <View style={styles.heroRow}>
          <View style={{ flex: 1 }}>
            <View style={styles.heroStatusRow}>
              <Animated.View
                style={[
                  styles.liveDot,
                  { opacity: isOpen ? pulse : 0.45, backgroundColor: isOpen ? colors.success100 : 'rgba(255,255,255,0.8)' },
                ]}
              />
              <Text style={styles.heroStatus}>{isOpen ? 'Open' : 'Closed'}</Text>
            </View>
            <Text style={styles.heroSub}>
              {isOpen ? 'Taking new orders now' : 'Not accepting orders right now'}
            </Text>
          </View>
          <ShopToggle
            value={isOpen}
            onValueChange={handleToggle}
            activeColor={colors.success}
            disabled={toggleBusy}
            size="lg"
          />
        </View>
      </LinearGradient>

      <TimePickerModal
        visible={!!pickerField}
        title={pickerField === 'open' ? 'Opening time' : 'Closing time'}
        initialValue={pickerField === 'open' ? openTime : closeTime}
        onConfirm={handleTimeConfirm}
        onClose={() => setPickerField(null)}
      />

      {loading && activeOrders.length === 0 ? (
        <>
          {renderListHeader()}
          <ActivityIndicator style={{ marginTop: spacing.xl }} color={colors.saffron} />
        </>
      ) : activeOrders.length === 0 ? (
        <FlatList
          data={[]}
          keyExtractor={() => 'empty'}
          renderItem={null}
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={renderListHeader}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.saffron} />}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <View style={styles.emptyIconWrap}>
                <AppIcon name="orders" size={32} color={colors.saffronDark} />
              </View>
              <Text style={styles.emptyTitle}>{loadError ? 'Could not load orders' : 'No active orders'}</Text>
              <Text style={styles.emptyText}>
                {loadError ? 'Pull down to try again.' : 'New orders appear here the moment a customer checks out.'}
              </Text>
            </View>
          }
        />
      ) : (
        <FlatList
          data={activeOrders}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderActiveOrder}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={renderListHeader}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.saffron} />}
        />
      )}

      <NewOrderPopup
        order={currentPopupOrder}
        onAccept={handleAccept}
        onReject={handleReject}
        queueIndex={0}
        queueTotal={pendingQueue.length}
      />

      {cancelledNotice && (
        <View style={styles.cancelledNotice} pointerEvents="none">
          <View style={styles.cancelledNoticeIconWrap}>
            <AppIcon name="close" size={16} color={colors.white} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.cancelledNoticeTitle}>
              Order cancelled{cancelledNotice.orderNumber ? ` — #${cancelledNotice.orderNumber}` : ''}
            </Text>
            {cancelledNotice.items.length > 0 && (
              <Text style={styles.cancelledNoticeItems} numberOfLines={2}>
                {cancelledNotice.items
                  .map((it) => `${it.quantity}× ${it.productName || it.product_name}`)
                  .join(', ')}
              </Text>
            )}
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgApp },
  cancelledNotice: {
    position: 'absolute', top: spacing.md, left: spacing.lg, right: spacing.lg,
    flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm,
    backgroundColor: colors.error, borderRadius: radius.lg,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2,
    ...shadows.lg,
  },
  cancelledNoticeIconWrap: {
    width: 24, height: 24, borderRadius: radius.circle, backgroundColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center', justifyContent: 'center', marginTop: 1,
  },
  cancelledNoticeTitle: { color: colors.white, fontWeight: '800', fontSize: 14 },
  cancelledNoticeItems: { color: 'rgba(255,255,255,0.9)', fontSize: 12, fontWeight: '500', marginTop: 2 },
  offlineBanner: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.xs,
    backgroundColor: colors.warningLight, marginHorizontal: spacing.lg,
    borderRadius: radius.md, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs + 2,
    marginBottom: spacing.xs,
  },
  offlineBannerText: { color: '#8A5A00', fontSize: 12, fontWeight: '600', flexShrink: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm,
  },
  title: { ...typography.display, fontSize: 26, color: colors.textPrimary },
  subtitle: { ...typography.bodySmall, color: colors.textSecondary, marginTop: 2, fontWeight: '500' },
  logoutBtn: {
    width: 42, height: 42, borderRadius: radius.circle, backgroundColor: colors.bgSurface,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border,
    ...shadows.xs,
  },
  heroCard: {
    marginHorizontal: spacing.lg, marginTop: spacing.xs, marginBottom: spacing.md,
    borderRadius: radius.xxl, padding: spacing.xl, ...shadows.cardRaised,
  },
  heroRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heroStatusRow: { flexDirection: 'row', alignItems: 'center' },
  liveDot: {
    width: 12, height: 12, borderRadius: radius.circle, marginRight: spacing.sm,
    backgroundColor: colors.success100,
  },
  heroStatus: { color: colors.textInverse, fontSize: 28, fontWeight: '800', letterSpacing: -0.4 },
  heroSub: { color: 'rgba(255,255,255,0.92)', fontSize: 15, marginTop: 4, fontWeight: '500' },
  scheduleCard: {
    marginBottom: spacing.md, backgroundColor: colors.bgSurface,
    borderRadius: radius.xl, borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, ...shadows.sm,
  },
  scheduleHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  scheduleHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 },
  scheduleIconWrap: {
    width: 36, height: 36, borderRadius: radius.circle, backgroundColor: colors.saffronLight,
    alignItems: 'center', justifyContent: 'center',
  },
  scheduleTitle: { ...typography.label, color: colors.textPrimary, fontWeight: '800' },
  scheduleSub: { fontSize: 12, color: colors.textSecondary, marginTop: 1, fontWeight: '500' },
  scheduleTimesRow: {
    flexDirection: 'row', alignItems: 'center', marginTop: spacing.md,
    paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border,
  },
  timeChip: {
    flex: 1, backgroundColor: colors.bgApp, borderRadius: radius.lg, borderWidth: 1,
    borderColor: colors.border, paddingVertical: spacing.sm, paddingHorizontal: spacing.md,
    alignItems: 'center',
  },
  timeChipLabel: { fontSize: 11, color: colors.textSecondary, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  timeChipValue: { fontSize: 16, color: colors.textPrimary, fontWeight: '800', marginTop: 2 },
  scheduleArrow: { paddingHorizontal: spacing.xs },
  metricsRow: {
    flexDirection: 'row', gap: spacing.md, marginBottom: spacing.lg,
  },
  metricCard: {
    backgroundColor: colors.bgSurface, borderRadius: radius.xl, paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm, borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center', ...shadows.sm,
  },
  metricValue: { fontSize: 28, fontWeight: '800', color: colors.textPrimary, lineHeight: 34, marginTop: spacing.xs },
  metricLabel: { fontSize: 12, color: colors.textSecondary, marginTop: 2, fontWeight: '600', letterSpacing: 0.2 },
  sectionHeader: {
    flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm,
  },
  sectionTitle: {
    ...typography.labelSmall, fontSize: 13, color: colors.textSecondary, textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  countPill: {
    marginLeft: spacing.sm, backgroundColor: colors.saffronLight, borderRadius: radius.pill,
    paddingHorizontal: 9, paddingVertical: 2, minWidth: 24, alignItems: 'center',
  },
  countPillText: { color: colors.saffronDark, fontWeight: '800', fontSize: 12 },
  listContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  activeCard: {
    flexDirection: 'row', backgroundColor: colors.bgSurface, borderRadius: radius.xl,
    marginBottom: spacing.md, borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
    ...shadows.sm,
  },
  activeAccent: {
    width: 6, backgroundColor: colors.saffron,
  },
  activeCardBody: { flex: 1, padding: spacing.md },
  activeCardHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm,
  },
  activeOrderNumber: { ...typography.h3, color: colors.textPrimary },
  activeBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.successLight, borderRadius: radius.pill,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  activeBadgeText: { color: colors.successDark, fontWeight: '700', fontSize: 12 },
  activeElapsedRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: spacing.xs },
  activeElapsedText: { color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  activeShopTotal: { color: colors.successDark, fontSize: 12, fontWeight: '800', marginLeft: 'auto' },
  activeItemRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.xs },
  qtyChip: {
    backgroundColor: colors.saffronLight, borderRadius: radius.sm, paddingHorizontal: 8,
    paddingVertical: 2, marginRight: spacing.sm, minWidth: 36, alignItems: 'center',
  },
  qtyChipText: { color: colors.saffronDark, fontWeight: '800', fontSize: 13 },
  activeItemText: { flex: 1, ...typography.body, color: colors.textSecondary, fontWeight: '500' },
  activeItemPrice: {
    ...typography.body, color: colors.textSecondary, fontWeight: '700',
    minWidth: 56, textAlign: 'right',
  },
  readyPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start',
    backgroundColor: colors.infoLight, borderRadius: radius.pill,
    paddingHorizontal: 10, paddingVertical: 4, marginTop: spacing.sm,
  },
  readyPillText: { color: colors.info, fontWeight: '800', fontSize: 12 },
  activeActionsRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  cancelBtn: {
    flex: 1, borderRadius: radius.button, borderWidth: 1.5, borderColor: colors.error,
    paddingVertical: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.errorLight,
  },
  cancelBtnText: { color: colors.error, fontWeight: '800', fontSize: 14 },
  readyBtn: {
    flex: 1, borderRadius: radius.button, paddingVertical: 10,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.success,
  },
  readyBtnText: { color: colors.textInverse, fontWeight: '800', fontSize: 14 },
  emptyState: { alignItems: 'center', paddingHorizontal: spacing.xl, marginTop: spacing.xl },
  emptyIconWrap: {
    width: 72, height: 72, borderRadius: radius.circle, backgroundColor: colors.saffronLight,
    alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md,
  },
  emptyTitle: { ...typography.h3, color: colors.textPrimary },
  emptyText: {
    ...typography.body, color: colors.textSecondary, textAlign: 'center', marginTop: spacing.xs,
    lineHeight: 20, maxWidth: 260,
  },
});
