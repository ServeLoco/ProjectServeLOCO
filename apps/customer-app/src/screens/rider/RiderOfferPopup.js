import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  Animated,
  ScrollView,
  Linking,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, spacing, typography, radius, shadows, motion, motionConfig } from '../../theme';
import AppIcon from '../../components/AppIcon';
import {
  remainingSecondsFromExpiresAt,
  formatCountdown,
} from '../../utils/riderOfferTime';

/**
 * Premium non-dismissible Accept/Reject offer modal.
 * Countdown is always derived from server expiresAt.
 */
// Fallback only — the real total now rides on offer.offerTimeoutSec so the
// progress bar can't silently drift if RIDER_OFFER_TIMEOUT_SEC is overridden
// via env without a matching client release.
const DEFAULT_OFFER_TIMEOUT_SEC = 150;

/**
 * @param {object} props
 * @param {object} props.offer - current front-of-queue offer
 * @param {number} [props.queueIndex=0] - 0-based index in offer queue
 * @param {number} [props.queueTotal=1] - total pending offers
 * @param {number} [props.activeJobCount=0] - already-accepted jobs
 */
export default function RiderOfferPopup({
  offer,
  onAccept,
  onReject,
  hasActiveJobs = false,
  queueIndex = 0,
  queueTotal = 1,
  activeJobCount = 0,
}) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  const enter = useRef(new Animated.Value(0)).current;
  const ringPulse = useRef(new Animated.Value(1)).current;
  const offerKey = offer?.id || offer?.offerId;

  useEffect(() => {
    if (!offer) return;
    enter.setValue(0);
    Animated.spring(enter, {
      toValue: 1,
      friction: 8,
      tension: 80,
      useNativeDriver: true,
    }).start();
  }, [offerKey, enter, offer]);

  useEffect(() => {
    setBusy(null);
    setError(null);
  }, [offerKey]);

  useEffect(() => {
    if (!offer) return undefined;
    const expiresAt = offer.expiresAt || offer.expires_at;
    const tick = () => setSecondsLeft(remainingSecondsFromExpiresAt(expiresAt));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [offerKey, offer]);

  // Urgent pulse when < 30s
  useEffect(() => {
    if (secondsLeft > 30 || secondsLeft <= 0) {
      ringPulse.setValue(1);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(ringPulse, {
          toValue: 1.06,
          duration: 450,
          useNativeDriver: true,
        }),
        Animated.timing(ringPulse, {
          toValue: 1,
          duration: 450,
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [secondsLeft <= 30, ringPulse, secondsLeft]);

  const handleAccept = useCallback(async () => {
    setError(null);
    setBusy('accept');
    try {
      await onAccept(offer);
    } catch (err) {
      setError(err?.message || 'Could not accept. Try again.');
      setBusy(null);
    }
  }, [offer, onAccept]);

  const handleReject = useCallback(async () => {
    setError(null);
    setBusy('reject');
    try {
      await onReject(offer);
    } catch (err) {
      setError(err?.message || 'Could not reject. Try again.');
      setBusy(null);
    }
  }, [offer, onReject]);

  if (!offer) return null;

  const scale = enter.interpolate({
    inputRange: [0, 1],
    outputRange: [motion.modalScaleStart || 0.92, 1],
  });
  const countdownLabel = formatCountdown(secondsLeft);
  const countdownUrgent = secondsLeft <= 30;
  const shops = offer.shops || [];
  const items = offer.items || [];
  const phone = offer.phone;
  const isFast = offer.deliveryType === 'fast' || offer.delivery_type === 'fast';
  const offerTimeoutSec = offer.offerTimeoutSec || offer.offer_timeout_sec || DEFAULT_OFFER_TIMEOUT_SEC;
  const progress = Math.min(1, Math.max(0, secondsLeft / offerTimeoutSec));

  return (
    <Modal visible transparent animationType="none" onRequestClose={() => {}}>
      <View style={styles.overlay}>
        <SafeAreaView style={styles.wrap}>
          <Animated.View style={[styles.sheet, { opacity: enter, transform: [{ scale }] }]}>
            <LinearGradient
              colors={[colors.brandGradientStart, colors.brandGradientEnd]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.topBar}
            />

            <View style={styles.badgeRow}>
              <View style={styles.newBadge}>
                <AppIcon name="navigation" size={14} color={colors.textInverse} />
                <Text style={styles.newBadgeText}>Delivery offer</Text>
              </View>
              <View style={[styles.timerChip, countdownUrgent && styles.timerChipUrgent]}>
                <AppIcon
                  name="clock"
                  size={13}
                  color={countdownUrgent ? colors.error : colors.saffronDark}
                />
                <Text style={[styles.timerChipText, countdownUrgent && styles.timerChipTextUrgent]}>
                  {secondsLeft > 0 ? countdownLabel : '0:00'}
                </Text>
              </View>
            </View>

            {queueTotal > 1 ? (
              <View style={styles.queueBanner}>
                <AppIcon name="orders" size={14} color={colors.saffronDark} />
                <Text style={styles.queueBannerText}>
                  Offer {Math.min(queueIndex + 1, queueTotal)} of {queueTotal}
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
              #{offer.orderNumber || offer.order_number}
            </Text>
            <View style={[styles.deliveryTypeBadge, isFast && styles.deliveryTypeBadgeFast]}>
              <AppIcon
                name="navigation"
                size={13}
                color={isFast ? colors.textInverse : colors.info}
              />
              <Text style={[styles.deliveryTypeBadgeText, isFast && styles.deliveryTypeBadgeTextFast]}>
                {isFast ? 'Fast delivery' : 'Standard delivery'}
              </Text>
            </View>
            <Text style={styles.countdownHint}>
              {secondsLeft > 0
                ? countdownUrgent
                  ? 'Hurry — respond before this offer expires'
                  : 'Respond within the timer to claim this delivery'
                : 'Time expired — wait for the next offer'}
            </Text>
            {(hasActiveJobs || activeJobCount > 0) ? (
              <Text style={styles.multiJobHint}>
                {activeJobCount > 0
                  ? `You already have ${activeJobCount} active ${
                    activeJobCount === 1 ? 'delivery' : 'deliveries'
                  } — accept to add this to your job queue.`
                  : 'You already have active deliveries — accept to add this to your job queue.'}
              </Text>
            ) : null}

            {/* Progress bar */}
            <View style={styles.progressTrack}>
              <Animated.View
                style={[
                  styles.progressFill,
                  countdownUrgent && styles.progressFillUrgent,
                  { width: `${progress * 100}%`, transform: [{ scaleY: ringPulse }] },
                ]}
              />
            </View>

            {offer.address ? (
              <View style={styles.addressCard}>
                <View style={styles.addressIconWrap}>
                  <AppIcon name="map" size={18} color={colors.saffronDark} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fieldLabel}>Drop-off address</Text>
                  <Text style={styles.addressText}>{offer.address}</Text>
                </View>
              </View>
            ) : null}

            {(offer.customerName || offer.customer_name || phone) ? (
              <View style={styles.customerCard}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>
                    {(offer.customerName || offer.customer_name || 'C').charAt(0).toUpperCase()}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.customerName}>
                    {offer.customerName || offer.customer_name || 'Customer'}
                  </Text>
                  {phone ? <Text style={styles.customerPhone}>{phone}</Text> : null}
                </View>
                {phone ? (
                  <TouchableOpacity
                    style={styles.callBtn}
                    onPress={() => Linking.openURL(`tel:${phone}`)}
                    activeOpacity={0.85}
                  >
                    <AppIcon name="phone" size={16} color={colors.info} />
                    <Text style={styles.callBtnText}>Call</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : null}

            {shops.length > 0 ? (
              <>
                <Text style={styles.sectionLabel}>Pickup shops</Text>
                <ScrollView style={styles.shopsCard} showsVerticalScrollIndicator={false}>
                  {shops.map((s, idx) => (
                    <View
                      key={s.id}
                      style={[styles.shopRow, idx === shops.length - 1 && styles.shopRowLast]}
                    >
                      <View style={styles.shopIndex}>
                        <Text style={styles.shopIndexText}>{idx + 1}</Text>
                      </View>
                      <Text style={styles.shopName}>{s.name}</Text>
                    </View>
                  ))}
                </ScrollView>
              </>
            ) : null}

            {items.length > 0 ? (
              <>
                <Text style={styles.sectionLabel}>Order items</Text>
                <ScrollView style={styles.itemsCard} showsVerticalScrollIndicator={false}>
                  {items.map((it, idx) => {
                    const variant = it.variantLabel || it.variant_label;
                    const shopName = it.shopName || it.shop_name;
                    return (
                      <View
                        key={it.id ?? idx}
                        style={[styles.itemRow, idx === items.length - 1 && styles.itemRowLast]}
                      >
                        <Text style={styles.itemQty}>{it.quantity}x</Text>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.itemName} numberOfLines={1}>
                            {it.productName || it.product_name}
                            {variant ? ` (${variant})` : ''}
                          </Text>
                          {shopName ? (
                            <Text style={styles.itemShopName} numberOfLines={1}>{shopName}</Text>
                          ) : null}
                        </View>
                      </View>
                    );
                  })}
                </ScrollView>
                {offer.total != null ? (
                  <View style={styles.totalRow}>
                    <Text style={styles.totalLabel}>Order total</Text>
                    <Text style={styles.totalValue}>₹{Number(offer.total).toFixed(0)}</Text>
                  </View>
                ) : null}
              </>
            ) : null}

            {error ? (
              <View style={styles.errorPill}>
                <AppIcon name="close" size={14} color={colors.error} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            <View style={styles.actionRow}>
              <PressButton
                label="Reject"
                variant="reject"
                busy={busy === 'reject'}
                disabled={busy !== null}
                onPress={handleReject}
              />
              <PressButton
                label="Accept ride"
                variant="accept"
                busy={busy === 'accept'}
                disabled={busy !== null || secondsLeft <= 0}
                onPress={handleAccept}
              />
            </View>
          </Animated.View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

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
      style={[styles.actionBtn, { transform: [{ scale }], opacity: disabled ? 0.72 : 1 }]}
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
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 6,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  newBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.saffron,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  newBadgeText: {
    color: colors.textInverse,
    fontWeight: '800',
    fontSize: 13,
    letterSpacing: 0.3,
  },
  timerChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.saffronLight,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  timerChipUrgent: { backgroundColor: colors.errorLight },
  timerChipText: {
    fontWeight: '800',
    fontSize: 14,
    color: colors.saffronDark,
    fontVariant: ['tabular-nums'],
  },
  timerChipTextUrgent: { color: colors.error },
  orderNumber: {
    ...typography.display,
    fontSize: 28,
    color: colors.textPrimary,
    marginBottom: 4,
  },
  deliveryTypeBadge: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    alignItems: 'center',
    gap: 5,
    backgroundColor: colors.infoLight,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginBottom: spacing.xs,
  },
  deliveryTypeBadgeFast: { backgroundColor: colors.saffron },
  deliveryTypeBadgeText: {
    fontWeight: '700',
    fontSize: 12,
    color: colors.info,
  },
  deliveryTypeBadgeTextFast: { color: colors.textInverse },
  countdownHint: {
    ...typography.caption,
    color: colors.textSecondary,
    marginBottom: spacing.md,
    fontWeight: '500',
  },
  multiJobHint: {
    ...typography.caption,
    color: colors.info || colors.saffronDark,
    backgroundColor: colors.infoLight || colors.saffronLight,
    borderRadius: radius.lg,
    padding: spacing.sm,
    marginBottom: spacing.md,
    fontWeight: '600',
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
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.grey100,
    overflow: 'hidden',
    marginBottom: spacing.lg,
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
    backgroundColor: colors.saffron,
  },
  progressFillUrgent: { backgroundColor: colors.error },

  addressCard: {
    flexDirection: 'row',
    gap: spacing.md,
    backgroundColor: colors.saffronLight,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  addressIconWrap: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.bgSurface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fieldLabel: {
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

  customerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.md,
    paddingVertical: spacing.xs,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: radius.circle,
    backgroundColor: colors.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontWeight: '800', fontSize: 17, color: colors.textPrimary },
  customerName: { ...typography.bodyBold, color: colors.textPrimary },
  customerPhone: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  callBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.infoLight,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  callBtnText: { color: colors.info, fontWeight: '800', fontSize: 13 },

  sectionLabel: {
    ...typography.labelSmall,
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: spacing.sm,
  },
  shopsCard: {
    backgroundColor: colors.bgApp,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.lg,
    maxHeight: 120,
  },
  shopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  shopRowLast: { borderBottomWidth: 0 },
  shopIndex: {
    width: 24,
    height: 24,
    borderRadius: radius.circle,
    backgroundColor: colors.saffronLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shopIndexText: { color: colors.saffronDark, fontWeight: '800', fontSize: 12 },
  shopName: { flex: 1, ...typography.body, color: colors.textPrimary, fontWeight: '600' },

  itemsCard: {
    backgroundColor: colors.bgApp,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.lg,
    maxHeight: 140,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  itemRowLast: { borderBottomWidth: 0 },
  itemQty: {
    fontWeight: '800',
    fontSize: 13,
    color: colors.saffronDark,
    minWidth: 28,
  },
  itemName: { flex: 1, ...typography.body, color: colors.textPrimary, fontWeight: '600' },
  itemShopName: { fontSize: 11, fontWeight: '700', color: colors.saffronDark, marginTop: 1 },
  itemPrice: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },

  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xs,
    marginTop: -spacing.sm,
    marginBottom: spacing.lg,
  },
  totalLabel: { ...typography.body, color: colors.textSecondary, fontWeight: '600' },
  totalValue: { ...typography.body, color: colors.textPrimary, fontWeight: '800', fontSize: 16 },

  errorPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.errorLight,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginBottom: spacing.md,
  },
  errorText: { color: colors.error, fontWeight: '600', fontSize: 13, flexShrink: 1 },

  actionRow: { flexDirection: 'row', gap: spacing.md },
  actionBtn: { flex: 1, borderRadius: radius.button, overflow: 'hidden' },
  gradientFill: {
    minHeight: 54,
    borderRadius: radius.button,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rejectFill: {
    borderWidth: 1.5,
    borderColor: colors.error,
    backgroundColor: colors.errorLight,
  },
  btnInner: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  actionBtnText: { fontWeight: '800', fontSize: 16 },
});
