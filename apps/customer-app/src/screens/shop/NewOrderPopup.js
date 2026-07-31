import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  Modal, StyleSheet, Text, View, TouchableOpacity, ActivityIndicator, Animated, ScrollView,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, spacing, typography, radius, shadows, motion, motionConfig } from '../../theme';
import AppIcon from '../../components/AppIcon';

/**
 * NewOrderPopup
 * Full-screen, non-dismissible modal for one new order at a time. When multiple
 * orders arrive they queue; only the head is shown until Accept/Reject, then
 * the next advances. Shows product names/quantities + delivery-time badge —
 * no prices/customer info. Outside-tap / back dismiss is a no-op.
 *
 * @param {object|null} order - front-of-queue order
 * @param {number} [queueIndex=0]
 * @param {number} [queueTotal=1]
 */
const RESPONSE_WINDOW_SEC = 600; // 10 minutes

export default function NewOrderPopup({
  order,
  onAccept,
  onReject,
  queueIndex = 0,
  queueTotal = 1,
}) {
  const [busy, setBusy] = useState(null); // 'accept' | 'reject' | null
  const [error, setError] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(RESPONSE_WINDOW_SEC);

  // Entrance animation (scale + fade) — runs whenever an order arrives.
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!order) return;
    enter.setValue(0);
    Animated.timing(enter, {
      toValue: 1,
      duration: motion.screenMs,
      easing: motion.easingModal,
      useNativeDriver: true,
    }).start();
  }, [order, enter]);

  // Reset busy/error state for each new order — otherwise a spinner or stale
  // error from the previous order carries over and permanently disables the
  // buttons for the next one in the queue.
  useEffect(() => {
    setBusy(null);
    setError(null);
  }, [order?.id]);

  // 2-minute response countdown, restarts for each new order in the queue.
  useEffect(() => {
    if (!order) return undefined;
    setSecondsLeft(RESPONSE_WINDOW_SEC);
    const id = setInterval(() => {
      setSecondsLeft(s => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [order?.id]);

  const handleAccept = useCallback(async () => {
    setError(null);
    setBusy('accept');
    try {
      await onAccept(order.id);
    } catch (err) {
      setError(err?.message || 'Could not accept order. Try again.');
      setBusy(null);
    }
  }, [order, onAccept]);

  const handleReject = useCallback(async () => {
    setError(null);
    setBusy('reject');
    try {
      await onReject(order.id);
    } catch (err) {
      setError(err?.message || 'Could not reject order. Try again.');
      setBusy(null);
    }
  }, [order, onReject]);

  if (!order) return null;

  const isFast = order.deliveryType === 'fast' || order.delivery_type === 'fast';
  const minutes = order.expectedMinutes ?? order.expected_minutes;

  const scale = enter.interpolate({ inputRange: [0, 1], outputRange: [motion.modalScaleStart, 1] });

  const countdownMin = Math.floor(secondsLeft / 60);
  const countdownSec = secondsLeft % 60;
  const countdownLabel = `${countdownMin}:${String(countdownSec).padStart(2, '0')}`;
  const countdownUrgent = secondsLeft <= 30;

  return (
    <Modal visible transparent animationType="none" onRequestClose={() => {}}>
      <View style={styles.overlay}>
        <SafeAreaView style={styles.wrap}>
          <Animated.View style={[styles.sheet, { opacity: enter, transform: [{ scale }] }]}>
            <View style={styles.topAccent} />

            <View style={styles.badgeRow}>
              <View style={styles.newBadge}>
                <AppIcon name="notification" size={14} color={colors.textInverse} />
                <Text style={styles.newBadgeText}>New order</Text>
              </View>
            </View>

            {queueTotal > 1 ? (
              <View style={styles.queueBanner}>
                <AppIcon name="orders" size={14} color={colors.saffronDark} />
                <Text style={styles.queueBannerText}>
                  Order {Math.min(queueIndex + 1, queueTotal)} of {queueTotal}
                  {queueTotal - queueIndex - 1 > 0
                    ? ` · ${queueTotal - queueIndex - 1} more waiting`
                    : ''}
                </Text>
              </View>
            ) : null}

            <Text
              style={styles.orderNumber}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.6}
            >
              #{order.orderNumber || order.order_number}
            </Text>

            <View style={[styles.countdownPill, countdownUrgent && styles.countdownPillUrgent]}>
              <AppIcon name="clock" size={14} color={countdownUrgent ? colors.error : colors.textSecondary} />
              <Text style={[styles.countdownText, countdownUrgent && styles.countdownTextUrgent]}>
                Respond within {countdownLabel}
              </Text>
            </View>

            {minutes != null && (
              <LinearGradient
                colors={isFast ? [colors.btnHighlightStart, colors.btnHighlightEnd] : [colors.infoLight, colors.infoLight]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={[styles.timeBadge, isFast && styles.timeBadgeFast]}
              >
                <AppIcon
                  name="navigation"
                  size={18}
                  color={isFast ? colors.textInverse : colors.info}
                />
                <Text style={[styles.timeBadgeText, isFast && styles.timeBadgeTextFast]}>
                  {isFast ? 'Fast delivery' : 'Standard delivery'} · {minutes} min
                </Text>
              </LinearGradient>
            )}

            <Text style={styles.itemsLabel}>Items</Text>
            <ScrollView style={styles.itemsCard} showsVerticalScrollIndicator={false}>
              {(order.items || []).map((it, idx) => {
                const lineTotal = it.shopLineTotal ?? it.shop_line_total;
                return (
                  <View key={idx} style={styles.itemRow}>
                    <View style={styles.qtyChip}>
                      <Text style={styles.qtyChipText}>{it.quantity}x</Text>
                    </View>
                    <Text style={styles.itemName} numberOfLines={1}>
                      {it.productName || it.product_name}
                    </Text>
                    <Text style={styles.itemPrice}>
                      {lineTotal != null ? `₹${lineTotal}` : ''}
                    </Text>
                  </View>
                );
              })}
            </ScrollView>

            {(order.shopTotal ?? order.shop_total) > 0 && (
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>You'll receive</Text>
                <Text style={styles.totalValue}>₹{order.shopTotal ?? order.shop_total}</Text>
              </View>
            )}

            {error && (
              <View style={styles.errorPill}>
                <AppIcon name="close" size={14} color={colors.error} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}

            <View style={styles.actionRow}>
              <PressButton
                label="Reject"
                variant="reject"
                busy={busy === 'reject'}
                disabled={busy !== null}
                onPress={handleReject}
              />
              <PressButton
                label="Accept"
                variant="accept"
                busy={busy === 'accept'}
                disabled={busy !== null}
                onPress={handleAccept}
              />
            </View>
          </Animated.View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

/** Large Accept/Reject button with gradient or outline fill + press scale. */
function PressButton({ label, variant, busy, disabled, onPress }) {
  const scale = useRef(new Animated.Value(1)).current;
  const isAccept = variant === 'accept';
  const handleIn = () => Animated.timing(scale, { toValue: 0.96, ...motionConfig.tap }).start();
  const handleOut = () => Animated.timing(scale, { toValue: 1, ...motionConfig.tap }).start();
  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPressIn={handleIn}
      onPressOut={handleOut}
      onPress={onPress}
      disabled={disabled}
      style={[styles.actionBtn, { transform: [{ scale }], opacity: disabled ? 0.75 : 1 }]}
    >
      {isAccept ? (
        <LinearGradient
          colors={[colors.btnSuccessStart, colors.btnSuccessEnd]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.gradientFill}
        >
          <ButtonInner label={label} busy={busy} color={colors.textInverse} icon="check" />
        </LinearGradient>
      ) : (
        <View style={[styles.gradientFill, styles.rejectFill]}>
          <ButtonInner label={label} busy={busy} color={colors.error} icon="close" />
        </View>
      )}
    </TouchableOpacity>
  );
}

function ButtonInner({ label, busy, color, icon }) {
  if (busy) return <ActivityIndicator color={color} />;
  return (
    <View style={styles.btnInner}>
      <AppIcon name={icon} size={18} color={color} />
      <Text style={[styles.actionBtnText, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: colors.overlayDark,
    justifyContent: 'center',
  },
  wrap: { flex: 1, justifyContent: 'center', padding: spacing.lg },
  sheet: {
    backgroundColor: colors.bgSurface,
    borderRadius: radius.xxl,
    padding: spacing.xl,
    overflow: 'hidden',
    ...shadows.modal,
  },
  topAccent: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 6,
    backgroundColor: colors.saffron,
  },
  badgeRow: {
    flexDirection: 'row', alignItems: 'center',
    marginTop: spacing.sm, marginBottom: spacing.xs,
  },
  countdownPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
    marginBottom: spacing.md,
  },
  countdownPillUrgent: {},
  countdownText: {
    color: colors.textSecondary, fontWeight: '700', fontSize: 13,
  },
  countdownTextUrgent: {
    color: colors.error,
  },
  newBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.saffron, borderRadius: radius.pill,
    paddingHorizontal: spacing.md, paddingVertical: spacing.xs,
  },
  newBadgeText: {
    color: colors.textInverse, fontWeight: '800', fontSize: 13, letterSpacing: 0.3,
  },
  queueBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    backgroundColor: colors.warningLight || colors.saffronLight,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    marginBottom: spacing.sm,
  },
  queueBannerText: {
    fontSize: 12,
    fontWeight: '800',
    color: colors.saffronDark || colors.warning,
  },
  orderNumber: {
    ...typography.h2, color: colors.textPrimary, marginBottom: spacing.sm,
  },
  timeBadge: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    alignSelf: 'stretch', borderRadius: radius.button,
    paddingHorizontal: spacing.md, paddingVertical: spacing.md, marginBottom: spacing.lg,
    borderWidth: 1, borderColor: colors.info,
  },
  timeBadgeFast: { borderWidth: 0 },
  timeBadgeText: { color: colors.info, fontWeight: '700', fontSize: 15 },
  timeBadgeTextFast: { color: colors.textInverse },
  itemsLabel: {
    ...typography.labelSmall, color: colors.textSecondary, textTransform: 'uppercase',
    letterSpacing: 0.6, marginBottom: spacing.sm,
  },
  itemsCard: {
    backgroundColor: colors.bgApp, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: spacing.sm,
    maxHeight: 220,
  },
  itemRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xs,
  },
  qtyChip: {
    backgroundColor: colors.saffronLight, borderRadius: radius.sm, paddingHorizontal: 8,
    paddingVertical: 2, minWidth: 36, alignItems: 'center',
  },
  qtyChipText: { color: colors.saffronDark, fontWeight: '800', fontSize: 13 },
  itemName: { flex: 1, ...typography.bodyLarge, color: colors.textPrimary, fontWeight: '500' },
  itemPrice: {
    ...typography.bodyLarge, color: colors.textSecondary, fontWeight: '700',
    minWidth: 64, textAlign: 'right',
  },
  totalRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.xs, marginBottom: spacing.lg,
  },
  totalLabel: { ...typography.bodySmall, color: colors.textSecondary, fontWeight: '700' },
  totalValue: { ...typography.h4, color: colors.successDark, fontWeight: '800' },
  errorPill: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs,
    backgroundColor: colors.errorLight, borderRadius: radius.pill,
    paddingHorizontal: spacing.md, paddingVertical: spacing.xs, marginBottom: spacing.md,
  },
  errorText: {
    color: colors.error, fontSize: 13, fontWeight: '600', textAlign: 'center',
  },
  actionRow: { flexDirection: 'row', gap: spacing.md },
  actionBtn: { flex: 1, borderRadius: radius.button, minHeight: 58, ...shadows.md },
  gradientFill: { flex: 1, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center' },
  rejectFill: {
    backgroundColor: colors.errorLight, borderWidth: 2, borderColor: colors.error,
  },
  btnInner: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  actionBtnText: { ...typography.buttonLarge, fontWeight: '800' },
});
