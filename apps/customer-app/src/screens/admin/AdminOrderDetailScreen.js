import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Dimensions, Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation, useRoute } from '@react-navigation/native';
import { colors, spacing, typography, radius, shadows } from '../../theme';
import { adminApi, subscribeAdminOrderEvents } from '../../api';
import AppIcon from '../../components/AppIcon';
import RiderLiveMap from '../../components/RiderLiveMap';
import { getRealtimeOrderId, mergeAdminOrderPatch } from '../../utils/realtimeOrder';
import {
  ORDER_STATUS_OPTIONS,
  PAYMENT_STATUS_OPTIONS,
  getOrderStatusLabel,
  getOrderStatusColors,
  isTerminalOrderStatus,
} from '../../utils/adminOrderStatus';

function formatMoney(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

function formatDateTime(value) {
  if (!value) return 'Not captured';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatKm(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)} km` : 'Not captured';
}

const isFreeDeliverySnapshot = (v) => v === true || v === 1 || v === '1' || v === 'true';

/**
 * AdminOrderDetailScreen (ADMIN TASK 9) — full parity with apps/admin
 * Orders.jsx drawer: customer/WhatsApp/map, delivery pricing snapshot,
 * rider/assignment state, status + payment mutation (refetch-before-patch
 * race guard, 409 handling matching web exactly), items + per-shop
 * confirmation badges, customer note.
 */
export default function AdminOrderDetailScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const orderId = route.params?.orderId;

  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [updating, setUpdating] = useState(false);

  // Disables the page ScrollView while a finger is on the inline map so
  // pan/pinch reaches the native MapView instead of being stolen by the
  // outer scroll gesture. Same pattern as the customer OrderDetailScreen.
  const scrollRef = useRef(null);
  const scrollLockTimeoutRef = useRef(null);
  const lockMapScroll = useCallback(() => {
    scrollRef.current?.setNativeProps?.({ scrollEnabled: false });
    if (scrollLockTimeoutRef.current) clearTimeout(scrollLockTimeoutRef.current);
    scrollLockTimeoutRef.current = setTimeout(() => {
      scrollRef.current?.setNativeProps?.({ scrollEnabled: true });
      scrollLockTimeoutRef.current = null;
    }, 4000);
  }, []);
  const unlockMapScroll = useCallback(() => {
    if (scrollLockTimeoutRef.current) {
      clearTimeout(scrollLockTimeoutRef.current);
      scrollLockTimeoutRef.current = null;
    }
    scrollRef.current?.setNativeProps?.({ scrollEnabled: true });
  }, []);
  useEffect(() => () => {
    if (scrollLockTimeoutRef.current) clearTimeout(scrollLockTimeoutRef.current);
  }, []);

  // RiderLiveMap defaults to the customer-scoped order endpoint (filtered by
  // customer_id) — admins need the admin-scoped one instead.
  const fetchAdminOrderForMap = useCallback((id) => adminApi.getOrder(id), []);

  const fetchOrder = useCallback(async ({ silent = false } = {}) => {
    if (!orderId) return;
    try {
      if (!silent) setLoading(true);
      const res = await adminApi.getOrder(orderId);
      setOrder(res?.data || null);
      // Only a non-silent (deliberate/fresh) load clears a stale error —
      // the silent refetch after a 409 conflict must NOT wipe the message
      // that refetch was triggered to accompany (matches web's
      // fetchSelectedOrder, which never touches error state at all).
      if (!silent) setError(null);
    } catch (err) {
      setError(err?.message || 'Could not load order.');
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useFocusEffect(useCallback(() => { fetchOrder(); }, [fetchOrder]));

  useEffect(() => {
    const unsub = subscribeAdminOrderEvents(({ payload }) => {
      const eventOrderId = getRealtimeOrderId(payload);
      if (!eventOrderId || String(orderId) !== eventOrderId) return;
      setOrder((prev) => mergeAdminOrderPatch(prev, payload));
      // Merge is a fast local patch; refetch shortly after for full fidelity
      // (rider assignment / shop confirmation fields the socket patch omits).
      fetchOrder({ silent: true });
    });
    return unsub;
  }, [orderId, fetchOrder]);

  const applyStatusChange = useCallback(async (newStatus, cancelReason) => {
    setUpdating(true);
    let latest;
    try {
      const res = await adminApi.getOrder(orderId);
      latest = res?.data || res;
    } catch (err) {
      setError(err?.message || 'Could not verify current order state.');
      setUpdating(false);
      return;
    }
    if (!latest || latest.status !== order.status) {
      setError(`Order was updated by someone else (current status: ${getOrderStatusLabel(latest?.status)}). Please review.`);
      setOrder(latest || order);
      setUpdating(false);
      return;
    }
    try {
      const patchRes = await adminApi.updateOrderStatus(orderId, newStatus, cancelReason);
      if (patchRes?.order) setOrder(patchRes.order);
    } catch (err) {
      if (err?.status === 409) {
        setError(err?.message || 'This order was updated by someone else.');
        await fetchOrder({ silent: true });
      } else {
        setError(err?.message || 'Could not update order status.');
      }
    } finally {
      setUpdating(false);
    }
  }, [orderId, order, fetchOrder]);

  const handleStatusPress = useCallback((newStatus) => {
    if (!order || newStatus === order.status) return;

    const proceed = (cancelReason) => {
      Alert.alert(
        `Change status to ${getOrderStatusLabel(newStatus)}?`,
        undefined,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Confirm', onPress: () => applyStatusChange(newStatus, cancelReason) },
        ]
      );
    };

    if (newStatus === 'Cancelled') {
      // iOS: free-text reason (shown on customer Track Order). Android: default message.
      if (typeof Alert.prompt === 'function') {
        Alert.prompt(
          'Cancel this order?',
          'Reason shown to the customer on Track Order (optional):',
          [
            { text: 'Back', style: 'cancel' },
            {
              text: 'Cancel order',
              style: 'destructive',
              onPress: (text) => applyStatusChange('Cancelled', text?.trim() || null),
            },
          ],
          'plain-text'
        );
        return;
      }
      Alert.alert(
        'Cancel this order?',
        'The customer will see: "This order was cancelled by the store."',
        [
          { text: 'Keep order', style: 'cancel' },
          {
            text: 'Cancel order',
            style: 'destructive',
            onPress: () => applyStatusChange('Cancelled', null),
          },
        ]
      );
      return;
    }
    proceed(null);
  }, [order, applyStatusChange]);

  const applyPaymentChange = useCallback(async (newPayment) => {
    setUpdating(true);
    let latest;
    try {
      const res = await adminApi.getOrder(orderId);
      latest = res?.data || res;
    } catch (err) {
      setError(err?.message || 'Could not verify current order state.');
      setUpdating(false);
      return;
    }
    if (!latest || latest.payment_status !== order.payment_status) {
      setError(`Payment status was updated by someone else (current: ${latest?.payment_status}). Please review.`);
      setOrder(latest || order);
      setUpdating(false);
      return;
    }
    try {
      const patchRes = await adminApi.updateOrderPayment(orderId, newPayment);
      if (patchRes?.order) setOrder(patchRes.order);
    } catch (err) {
      if (err?.status === 409) {
        setError(err?.message || 'This order was updated by someone else.');
        await fetchOrder({ silent: true });
      } else {
        setError(err?.message || 'Could not update payment status.');
      }
    } finally {
      setUpdating(false);
    }
  }, [orderId, order, fetchOrder]);

  const handlePaymentPress = useCallback((newPayment) => {
    if (!order || newPayment === order.payment_status) return;
    Alert.alert(`Change payment status to ${newPayment}?`, undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Confirm', onPress: () => applyPaymentChange(newPayment) },
    ]);
  }, [order, applyPaymentChange]);

  if (loading && !order) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <ActivityIndicator style={{ marginTop: spacing.xl }} color={colors.saffron} />
      </SafeAreaView>
    );
  }

  if (!order) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.headerBar}>
          <TouchableOpacity onPress={() => navigation.goBack()}>
            <AppIcon name="back" size={22} color={colors.textPrimary} />
          </TouchableOpacity>
        </View>
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>{error || 'Order not found.'}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const terminal = isTerminalOrderStatus(order.status);
  const statusOrder = ORDER_STATUS_OPTIONS.filter((o) => o.value !== 'Cancelled').map((o) => o.value);
  const currentIdx = statusOrder.indexOf(order.status);
  const hasRiderInfo = order.riderId || order.rider_id
    || ['searching', 'offered', 'failed'].includes(order.riderAssignmentStatus);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.headerBar}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={10}>
          <AppIcon name="back" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: spacing.md }}>
          <Text style={styles.headerTitle}>Order #{order.order_number}</Text>
          <Text style={styles.headerSubtitle}>{formatDateTime(order.created_at)} · ₹{formatMoney(order.total)}</Text>
        </View>
        <View style={[styles.pill, { backgroundColor: getOrderStatusColors(order.status).bg }]}>
          <Text style={[styles.pillText, { color: getOrderStatusColors(order.status).text }]}>{getOrderStatusLabel(order.status)}</Text>
        </View>
      </View>

      <ScrollView ref={scrollRef} contentContainerStyle={styles.scrollContent}>
        {error && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {order.status !== 'Cancelled' ? (
          <View
            style={styles.mapHeroBleed}
            onTouchStart={lockMapScroll}
            onTouchMove={lockMapScroll}
            onTouchEnd={unlockMapScroll}
            onTouchCancel={unlockMapScroll}
          >
            <RiderLiveMap
              orderId={order.id || orderId}
              initialOrder={order}
              fetchOrder={fetchAdminOrderForMap}
              style={styles.mapHeroInner}
              showLegend={false}
            />
          </View>
        ) : null}

        <Section title="Customer">
          <Row label="Name" value={order.customer_name} />
          <Row label="Phone" value={order.phone} />
          <Row label="Address" value={order.address} />
          <View style={styles.actionRow}>
            {order.phone ? (
              <TouchableOpacity
                style={styles.actionBtn}
                onPress={() => Linking.openURL(`https://wa.me/${String(order.phone).replace(/[^0-9]/g, '')}`)}
              >
                <Text style={styles.actionBtnText}>WhatsApp</Text>
              </TouchableOpacity>
            ) : null}
            {order.map_url ? (
              <TouchableOpacity style={styles.actionBtn} onPress={() => Linking.openURL(order.map_url)}>
                <Text style={styles.actionBtnText}>View Map</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </Section>

        <Section title="Delivery pricing">
          <Row label="Distance" value={formatKm(order.delivery_distance_km)} />
          <Row label="Zone extent" value={formatKm(order.delivery_radius_km_snapshot)} />
          <Row
            label="Cost per km"
            value={order.delivery_cost_per_km_snapshot != null ? `₹${order.delivery_cost_per_km_snapshot}` : 'Not captured'}
          />
          <Row label="Free delivery offer" value={isFreeDeliverySnapshot(order.free_delivery_offer_snapshot) ? 'Applied' : 'Not applied'} />
        </Section>

        {hasRiderInfo ? (
          <Section title="Delivery / Rider">
            {order.riderId || order.rider_id ? (
              <>
                <Row label="Rider" value={order.riderName || `#${order.riderId || order.rider_id}`} />
                <Row label="Assigned" value={formatDateTime(order.rider_assigned_at)} />
                {order.rider_picked_up_at ? <Row label="Picked up" value={formatDateTime(order.rider_picked_up_at)} /> : null}
              </>
            ) : (
              <Row
                label="Assignment"
                value={
                  order.riderAssignmentStatus === 'searching' ? 'Searching for a rider…'
                    : order.riderAssignmentStatus === 'offered' ? 'Offer sent — awaiting rider response'
                    : order.riderAssignmentStatus === 'failed' ? 'No rider — needs admin action (not auto-cancelled)'
                    : 'Not started'
                }
                valueColor={order.riderAssignmentStatus === 'failed' ? colors.error : undefined}
              />
            )}
            {order.status === 'Cancelled' && order.cancel_reason ? (
              <Row label="Cancel reason" value={order.cancel_reason} />
            ) : null}
          </Section>
        ) : null}

        <Section title="Order status">
          <View style={styles.optionsWrap}>
            {ORDER_STATUS_OPTIONS.map((opt) => {
              const active = opt.value === order.status;
              // Forward-only progression, same rule as web: Cancelled always
              // allowed (from non-terminal), others must move forward.
              const optIdx = statusOrder.indexOf(opt.value);
              const disabled = terminal || updating || active
                || (opt.value !== 'Cancelled' && optIdx !== -1 && optIdx <= currentIdx);
              return (
                <TouchableOpacity
                  key={opt.value}
                  style={[styles.optionChip, active && styles.optionChipActive, disabled && !active && styles.optionChipDisabled]}
                  disabled={disabled}
                  onPress={() => handleStatusPress(opt.value)}
                >
                  <Text style={[styles.optionChipText, active && styles.optionChipTextActive]}>{opt.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Section>

        <Section title="Payment status">
          <View style={styles.optionsWrap}>
            {PAYMENT_STATUS_OPTIONS.map((v) => {
              const active = v === order.payment_status;
              return (
                <TouchableOpacity
                  key={v}
                  style={[styles.optionChip, active && styles.optionChipActive, (terminal || updating) && !active && styles.optionChipDisabled]}
                  disabled={terminal || updating || active}
                  onPress={() => handlePaymentPress(v)}
                >
                  <Text style={[styles.optionChipText, active && styles.optionChipTextActive]}>{v}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Section>

        <Section title="Items">
          {order.shopConfirmations && order.shopConfirmations.length > 0 ? (
            <View style={styles.shopBadgesRow}>
              {order.shopConfirmations.map((sc) => {
                const label = sc.rejected ? '✕ Cancelled' : sc.ready ? '✓ Ready' : sc.confirmed ? '✓ Confirmed' : '⏳ Waiting';
                const bg = sc.rejected ? colors.errorLight : sc.ready ? colors.infoLight : sc.confirmed ? colors.successLight : colors.warningLight;
                const text = sc.rejected ? colors.error : sc.ready ? colors.info : sc.confirmed ? colors.successDark : colors.warning;
                const shopTotal = sc.shopTotal ?? sc.shop_total;
                return (
                  <View key={sc.shopId} style={[styles.shopBadge, { backgroundColor: bg }]}>
                    <Text style={[styles.shopBadgeText, { color: text }]}>
                      {sc.shopName} {label}{shopTotal > 0 ? ` · ₹${shopTotal} owed` : ''}
                    </Text>
                  </View>
                );
              })}
            </View>
          ) : null}
          {(order.items || []).map((item, idx) => (
            <View key={idx} style={styles.itemRow}>
              <Text style={styles.itemText}>{item.quantity}x {item.product_name}</Text>
              <Text style={styles.itemTotal}>₹{formatMoney(item.line_total)}</Text>
            </View>
          ))}
          <View style={styles.totalsBlock}>
            <Row label="Subtotal" value={`₹${formatMoney(order.subtotal)}`} />
            <Row label="Delivery" value={`₹${formatMoney(order.delivery_charge)}`} />
            {order.fast_delivery_charge > 0 ? <Row label="Fast delivery add-on" value={`₹${formatMoney(order.fast_delivery_charge)}`} /> : null}
            {order.night_charge > 0 ? <Row label="Night charge" value={`₹${formatMoney(order.night_charge)}`} /> : null}
            {order.rain_charge > 0 ? <Row label="Rain charge" value={`₹${formatMoney(order.rain_charge)}`} /> : null}
            <Row label="Total" value={`₹${formatMoney(order.total)}`} big />
          </View>
        </Section>

        {order.note ? (
          <Section title="Customer note" tone="warning">
            <Text style={styles.noteText}>{order.note}</Text>
          </Section>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, children, tone }) {
  return (
    <View style={[styles.section, tone === 'warning' && styles.sectionWarning]}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ label, value, valueColor, big }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, big && styles.rowValueBig, valueColor && { color: valueColor }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgApp },
  headerBar: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md, backgroundColor: colors.bgSurface, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  headerTitle: { ...typography.h3, color: colors.textPrimary },
  headerSubtitle: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  scrollContent: { padding: spacing.lg, paddingBottom: spacing.xl },
  mapHeroBleed: {
    height: 220,
    marginHorizontal: -spacing.lg,
    marginTop: -spacing.lg,
    marginBottom: spacing.md,
    width: Dimensions.get('window').width,
    alignSelf: 'center',
    overflow: 'hidden',
    position: 'relative',
  },
  mapHeroInner: { flex: 1, minHeight: 0 },
  errorBanner: { backgroundColor: colors.errorLight, borderRadius: radius.lg, padding: spacing.sm, marginBottom: spacing.md },
  errorText: { color: colors.error, fontWeight: '600', fontSize: 13 },
  section: {
    backgroundColor: colors.bgSurface, borderRadius: radius.xl, padding: spacing.md,
    borderWidth: 1, borderColor: colors.border, marginBottom: spacing.md, ...shadows.sm,
  },
  sectionWarning: { borderColor: colors.warning, backgroundColor: colors.warningLight },
  sectionTitle: {
    ...typography.labelSmall, color: colors.textSecondary, textTransform: 'uppercase',
    letterSpacing: 0.5, marginBottom: spacing.sm,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  rowLabel: { fontSize: 13, color: colors.textSecondary },
  rowValue: { fontSize: 13, color: colors.textPrimary, fontWeight: '700', flexShrink: 1, textAlign: 'right' },
  rowValueBig: { fontSize: 18, color: colors.saffronDark },
  actionRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, flexWrap: 'wrap' },
  actionBtn: {
    borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 8,
    backgroundColor: colors.bgApp, borderWidth: 1, borderColor: colors.border,
  },
  actionBtnText: { fontSize: 12, fontWeight: '700', color: colors.textPrimary },
  optionsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  optionChip: {
    borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 9, minHeight: 36,
    justifyContent: 'center', backgroundColor: colors.bgApp, borderWidth: 1, borderColor: colors.border,
  },
  optionChipActive: { backgroundColor: colors.saffron, borderColor: colors.saffron },
  optionChipDisabled: { opacity: 0.4 },
  optionChipText: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  optionChipTextActive: { color: colors.textInverse },
  shopBadgesRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.sm },
  shopBadge: { borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  shopBadgeText: { fontSize: 11, fontWeight: '700' },
  itemRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  itemText: { fontSize: 13, color: colors.textPrimary, flex: 1 },
  itemTotal: { fontSize: 13, fontWeight: '700', color: colors.textPrimary },
  totalsBlock: { marginTop: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm },
  noteText: { fontSize: 14, color: colors.textPrimary },
  pill: { borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  pillText: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  emptyState: { alignItems: 'center', marginTop: spacing.xl },
  emptyText: { ...typography.body, color: colors.textSecondary },
});
