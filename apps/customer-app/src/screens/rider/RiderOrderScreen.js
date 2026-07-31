import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { colors, spacing, typography, radius, shadows } from '../../theme';
import { riderApi, subscribeRealtime } from '../../api';
import AppIcon from '../../components/AppIcon';
import RiderDeliveryMap from '../../components/RiderDeliveryMap';
import {
  getRiderActionFlags,
  mergeRiderOrder,
} from '../../utils/riderOrderActions';
import { elapsedSecondsFromStart, formatElapsed } from '../../utils/riderOfferTime';

/**
 * Full-screen delivery map + status actions for one assigned order.
 * Button visibility matches RiderDashboardScreen (shared getRiderActionFlags).
 */
export default function RiderOrderScreen({ route, navigation }) {
  const orderId = route.params?.orderId;
  // Snapshot from dashboard so first paint matches the card before fetch returns.
  const [order, setOrder] = useState(() => route.params?.order || null);
  const [loading, setLoading] = useState(!route.params?.order);
  const [actionBusy, setActionBusy] = useState(null);
  const [error, setError] = useState(null);

  const fetchOrder = useCallback(async ({ silent = false } = {}) => {
    if (!orderId) return;
    try {
      if (!silent) setError(null);
      const res = await riderApi.getAssignment(orderId);
      const next = res?.order || null;
      if (next) {
        setOrder((prev) => mergeRiderOrder(prev, next));
      } else {
        setOrder(null);
      }
    } catch (err) {
      if (!silent) {
        setError(err?.message || 'Could not load order');
        setOrder(null);
      }
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useFocusEffect(
    useCallback(() => {
      // Always re-fetch on focus so map stays in sync with card actions.
      fetchOrder({ silent: true });
    }, [fetchOrder]),
  );

  // Live updates when this rider (or admin) changes assignment status.
  useEffect(() => {
    if (!orderId) return undefined;
    const unsub = subscribeRealtime('rider.assignment.updated', (payload) => {
      const eventOrderId = payload?.orderId ?? payload?.order_id;
      if (eventOrderId != null && String(eventOrderId) !== String(orderId)) return;
      if (payload?.order) {
        setOrder((prev) => mergeRiderOrder(prev, payload.order));
      } else {
        fetchOrder({ silent: true });
      }
    });
    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, [orderId, fetchOrder]);

  const runAction = useCallback(async (key, fn, { goBackOnSuccess = false } = {}) => {
    setActionBusy(key);
    try {
      const res = await fn();
      // Apply API order immediately so buttons hide without waiting for refetch.
      if (res?.order) {
        setOrder((prev) => mergeRiderOrder(prev, res.order));
      }
      if (goBackOnSuccess) {
        navigation.goBack();
        return;
      }
      await fetchOrder({ silent: true });
    } catch (err) {
      Alert.alert('Action failed', err?.message || 'Try again');
      await fetchOrder({ silent: true });
    } finally {
      setActionBusy(null);
    }
  }, [fetchOrder, navigation]);

  const handleOutForDelivery = () => {
    runAction('ofd', () => riderApi.updateStatus(orderId, 'Out for Delivery'));
  };

  const handleDelivered = () => {
    Alert.alert('Mark delivered?', 'Confirm this order was delivered.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delivered',
        onPress: () => runAction(
          'delivered',
          () => riderApi.updateStatus(orderId, 'Delivered'),
          { goBackOnSuccess: true },
        ),
      },
    ]);
  };

  const handleMarkPaid = () => {
    Alert.alert('Mark payment received?', 'Confirm you have collected payment for this order.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Mark paid',
        onPress: () => runAction('mark_paid', () => riderApi.markPaid(orderId)),
      },
    ]);
  };

  const terminal = order ? getRiderActionFlags(order).terminal : true;
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    if (!orderId || terminal) return undefined;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [orderId, terminal]);

  if (loading && !order) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator style={{ marginTop: 80 }} color={colors.saffron} />
      </SafeAreaView>
    );
  }

  if (!order) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.errorText}>{error || 'Order not found'}</Text>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={styles.backBtnText}>Go back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const flags = getRiderActionFlags(order);
  const phone = order?.phone;
  const pickedUp = flags.pickedUp;
  const isFast = order?.deliveryType === 'fast' || order?.delivery_type === 'fast';
  const assignedAt = order?.riderAssignedAt || order?.rider_assigned_at;
  const elapsedLabel = assignedAt
    ? formatElapsed(elapsedSecondsFromStart(assignedAt, nowTick))
    : null;

  return (
    <View style={styles.root}>
      <RiderDeliveryMap order={order} pickedUp={pickedUp} style={styles.map} />

      <SafeAreaView style={styles.sheet} edges={['bottom']}>
        <View style={styles.sheetHandle} />
        <ScrollView
          style={styles.sheetScroll}
          contentContainerStyle={styles.sheetContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.sheetHeader}>
            <TouchableOpacity onPress={() => navigation.goBack()} style={styles.iconBtn}>
              <AppIcon name="back" size={22} color={colors.textPrimary} />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={styles.orderNum}>#{order.orderNumber || order.order_number}</Text>
              <View style={styles.statusRow}>
                <Text style={styles.statusLine}>{flags.status || 'Assigned'}</Text>
                <View style={[styles.deliveryTypeBadge, isFast && styles.deliveryTypeBadgeFast]}>
                  <Text style={[styles.deliveryTypeBadgeText, isFast && styles.deliveryTypeBadgeTextFast]}>
                    {isFast ? 'Fast' : 'Standard'}
                  </Text>
                </View>
              </View>
              {elapsedLabel ? (
                <View style={styles.timerRow}>
                  <AppIcon name="clock" size={13} color={colors.textSecondary} />
                  <Text style={styles.timerText}>{elapsedLabel} since accepted</Text>
                </View>
              ) : null}
            </View>
            {phone ? (
              <TouchableOpacity
                style={styles.callBtn}
                onPress={() => Linking.openURL(`tel:${phone}`)}
                accessibilityLabel="Call customer"
              >
                <AppIcon name="phone" size={18} color={colors.textInverse} />
              </TouchableOpacity>
            ) : null}
          </View>

          {order.address ? (
            <Text style={styles.address} numberOfLines={2}>{order.address}</Text>
          ) : null}

          {Array.isArray(order.shops) && order.shops.length > 0 ? (
            <Text style={styles.shopsLine} numberOfLines={2}>
              Pickup: {order.shops.map((s) => s.name).filter(Boolean).join(' · ') || 'Shop'}
            </Text>
          ) : null}

          {Array.isArray(order.items) && order.items.length > 0 ? (
            <View style={styles.itemsBlock}>
              <Text style={styles.itemsLabel}>Order items</Text>
              {order.items.map((it, idx) => {
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
              {order.total != null ? (
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Order total</Text>
                  <Text style={styles.totalValue}>₹{Number(order.total).toFixed(0)}</Text>
                </View>
              ) : null}
            </View>
          ) : null}

          {!flags.terminal ? (
            <View style={styles.actions}>
              {flags.showOutForDelivery ? (
                <ActionBtn
                  label="Out for delivery"
                  icon="navigation"
                  variant="success"
                  busy={actionBusy === 'ofd'}
                  onPress={handleOutForDelivery}
                />
              ) : null}
              {flags.showDelivered ? (
                <ActionBtn
                  label="Mark delivered"
                  icon="check"
                  variant="success"
                  busy={actionBusy === 'delivered'}
                  onPress={handleDelivered}
                />
              ) : null}
              {flags.showMarkPaid ? (
                <ActionBtn
                  label="Mark paid"
                  icon="check"
                  variant="saffron"
                  busy={actionBusy === 'mark_paid'}
                  onPress={handleMarkPaid}
                />
              ) : null}
            </View>
          ) : (
            <View style={styles.doneBanner}>
              <Text style={styles.doneText}>
                {flags.status === 'Delivered' ? 'Delivery complete ✓' : 'Order cancelled'}
              </Text>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

function ActionBtn({ label, icon, onPress, busy, variant }) {
  const grad = variant === 'success'
    ? [colors.btnSuccessStart, colors.btnSuccessEnd]
    : [colors.btnHighlightStart, colors.btnHighlightEnd];
  return (
    <TouchableOpacity onPress={onPress} disabled={Boolean(busy)} activeOpacity={0.9}>
      <LinearGradient colors={grad} style={styles.primaryBtn}>
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
  root: { flex: 1, backgroundColor: colors.bgApp },
  container: { flex: 1, backgroundColor: colors.bgApp, alignItems: 'center' },
  map: { flex: 1 },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '48%',
    backgroundColor: colors.bgSurface,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    ...shadows.cardRaised,
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
  sheetScroll: { flexGrow: 0 },
  sheetContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.circle,
    backgroundColor: colors.bgApp,
    alignItems: 'center',
    justifyContent: 'center',
  },
  orderNum: { ...typography.h2, fontSize: 20 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  statusLine: { ...typography.caption, color: colors.textSecondary, fontWeight: '700' },
  timerRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  timerText: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  deliveryTypeBadge: {
    backgroundColor: colors.infoLight,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  deliveryTypeBadgeFast: { backgroundColor: colors.saffron },
  deliveryTypeBadgeText: { fontSize: 10, fontWeight: '800', color: colors.info },
  deliveryTypeBadgeTextFast: { color: colors.textInverse },
  callBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.circle,
    backgroundColor: colors.info,
    alignItems: 'center',
    justifyContent: 'center',
  },
  address: {
    ...typography.body,
    color: colors.textPrimary,
    marginBottom: spacing.xs,
    fontWeight: '600',
  },
  shopsLine: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '700',
    marginBottom: spacing.md,
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
  actions: { gap: spacing.sm },
  primaryBtn: {
    minHeight: 50,
    borderRadius: radius.button,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  primaryBtnText: { color: colors.textInverse, fontWeight: '800', fontSize: 15 },
  doneBanner: {
    backgroundColor: colors.successLight,
    padding: spacing.md,
    borderRadius: radius.lg,
    alignItems: 'center',
  },
  doneText: { color: colors.successDark, fontWeight: '800' },
  errorText: { color: colors.error, textAlign: 'center', margin: spacing.lg },
  backBtn: { marginTop: spacing.md, padding: spacing.md },
  backBtnText: { color: colors.saffron, fontWeight: '700' },
});
