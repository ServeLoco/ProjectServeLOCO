import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { colors, spacing, typography, radius, shadows } from '../../theme';
import { adminApi, subscribeAdminOrderEvents, subscribeAdminRealtime } from '../../api';
import { useNewOrderAlert } from '../../hooks/useNewOrderAlert';
import AppIcon from '../../components/AppIcon';

const AUTO_ACCEPT_SECONDS = 120;

function formatPlacedAt(iso) {
  if (!iso) return 'Just now';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'Just now';
  const diffSec = Math.max(0, Math.round((Date.now() - then.getTime()) / 1000));
  if (diffSec < 5) return 'Just now';
  if (diffSec < 60) return `${diffSec} sec ago`;
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min} min ago`;
  return then.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

function formatCurrency(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `₹${n}` : '₹0';
}

function omitKey(obj, key) {
  const rest = { ...obj };
  delete rest[key];
  return rest;
}

/**
 * AdminNewOrderPopup (ADMIN TASK 9.5-9.8) — full-screen queue popup for
 * `admin.order.created`, mirroring apps/admin GlobalOrderAlert.jsx: one full
 * card for the head of the queue, compact chips for the rest, a repeating
 * sound + vibration alert while the queue is non-empty, and an auto-accept
 * countdown display (server does the actual auto-accept; this is a readout).
 * Mounted once at the top of AdminNavigator so it floats above every tab.
 */
export default function AdminNewOrderPopup() {
  const [modals, setModals] = useState([]);
  const [busy, setBusy] = useState({});
  const [errors, setErrors] = useState({});
  const [autoAcknowledged, setAutoAcknowledged] = useState({});
  const [secondsLeft, setSecondsLeft] = useState(AUTO_ACCEPT_SECONDS);

  const current = modals.length > 0 ? modals[0] : null;
  const currentBusy = current ? Boolean(busy[current.id]) : false;
  const currentAutoAccepted = current ? Boolean(autoAcknowledged[current.payload?.orderId]) : false;

  // Repeating sound + vibration while anything is queued (shared shop/admin alert).
  useNewOrderAlert(modals.length > 0);

  // Countdown readout for the head of the queue only; resets per order.
  useEffect(() => {
    if (!current || currentBusy || currentAutoAccepted) return undefined;
    setSecondsLeft(AUTO_ACCEPT_SECONDS);
    const start = Date.now();
    const id = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      setSecondsLeft(Math.max(0, Math.round(AUTO_ACCEPT_SECONDS - elapsed)));
    }, 1000);
    return () => clearInterval(id);
  }, [current?.id, currentBusy, currentAutoAccepted]);

  useEffect(() => {
    const unsubscribe = subscribeAdminOrderEvents(({ eventName, payload }) => {
      if (eventName !== 'admin.order.created') return;
      const orderId = payload?.orderId;
      if (!orderId) return;

      const id = `${orderId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setModals((prev) => {
        if (prev.some((m) => m.payload?.orderId === orderId)) return prev;
        return [...prev, { id, payload, addedAt: Date.now() }];
      });
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const off = subscribeAdminRealtime('admin.order.auto_accepted', (payload) => {
      if (!payload?.orderId) return;
      setAutoAcknowledged((prev) => ({ ...prev, [payload.orderId]: true }));
    });
    return off;
  }, []);

  const removeModal = useCallback((id) => {
    setModals((prev) => prev.filter((m) => m.id !== id));
    setBusy((prev) => omitKey(prev, id));
    setErrors((prev) => omitKey(prev, id));
  }, []);

  const submitStatus = useCallback(async (id, orderId, status, reason) => {
    setBusy((prev) => ({ ...prev, [id]: true }));
    setErrors((prev) => ({ ...prev, [id]: null }));
    try {
      await adminApi.updateOrderStatus(orderId, status, reason);
      removeModal(id);
    } catch (err) {
      setErrors((prev) => ({ ...prev, [id]: err?.message || `Failed to ${status === 'Accepted' ? 'accept' : 'cancel'} order` }));
      setBusy((prev) => ({ ...prev, [id]: false }));
    }
  }, [removeModal]);

  const handleAccept = useCallback((id, orderId) => submitStatus(id, orderId, 'Accepted'), [submitStatus]);
  const handleCancel = useCallback((id, orderId) => submitStatus(id, orderId, 'Cancelled', 'Cancelled by admin'), [submitStatus]);

  const handleSkip = useCallback(() => {
    const head = modals[0];
    if (head && !busy[head.id]) removeModal(head.id);
  }, [modals, busy, removeModal]);

  const bringToFront = useCallback((id) => {
    setModals((prev) => {
      const idx = prev.findIndex((m) => m.id === id);
      if (idx <= 0) return prev;
      const next = [...prev];
      const [picked] = next.splice(idx, 1);
      next.unshift(picked);
      return next;
    });
  }, []);

  if (!current) return null;

  const total = modals.length;
  const waiting = modals.slice(1);
  const { id, payload } = current;
  const orderId = payload?.orderId;
  const orderNumber = payload?.orderNumber || '—';
  const customerName = payload?.customerName || 'Customer';
  const address = payload?.address || '';
  const customerPhone = payload?.customerPhone || '';
  const paymentMethod = payload?.paymentMethod || 'Cash';
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const isBusy = Boolean(busy[id]);
  const error = errors[id];
  const wasAutoAccepted = Boolean(autoAcknowledged[orderId]);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => {}}>
      <View style={styles.overlay}>
        {total > 1 ? (
          <View style={styles.queueBar}>
            <Text style={styles.queueLabel}>{total} new orders · showing 1 of {total}</Text>
            <View style={styles.queueChips}>
              {modals.map((m, i) => {
                const num = m.payload?.orderNumber || m.payload?.orderId || i + 1;
                const isHead = i === 0;
                return (
                  <TouchableOpacity
                    key={m.id}
                    style={[styles.queueChip, isHead && styles.queueChipActive]}
                    onPress={() => { if (!isHead) bringToFront(m.id); }}
                    disabled={isBusy}
                  >
                    <Text style={[styles.queueChipText, isHead && styles.queueChipTextActive]}>#{num}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        ) : null}

        <View style={styles.card}>
          <View style={styles.topAccent} />
          <View style={styles.headerRow}>
            <Text style={styles.bell}>{wasAutoAccepted ? '⚡' : '🔔'}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.headerTitle}>{wasAutoAccepted ? `Order #${orderNumber} auto-accepted` : 'New Order Received!'}</Text>
              <Text style={styles.headerSub}>#{orderNumber}{total > 1 ? ` · Order 1 of ${total}` : ''}</Text>
            </View>
            {!wasAutoAccepted ? (
              <View style={styles.countdownPill}>
                <Text style={styles.countdownText}>{secondsLeft}s</Text>
              </View>
            ) : null}
          </View>

          <View style={styles.body}>
            <DetailRow label="Customer" value={customerName} />
            {customerPhone ? <DetailRow label="Phone" value={customerPhone} /> : null}
            {address ? <DetailRow label="Address" value={address} /> : null}
            <DetailRow label="Payment" value={paymentMethod} />
            {items.length > 0 ? (
              <DetailRow label="Items" value={items.map((it) => `${it.quantity}x ${it.name}`).join(', ')} />
            ) : null}
            <DetailRow label="Total" value={formatCurrency(payload?.total)} big />
            <Text style={styles.meta}>Placed {formatPlacedAt(payload?.createdAt)}</Text>

            {wasAutoAccepted ? (
              <Text style={styles.info}>Auto-accepted after {AUTO_ACCEPT_SECONDS}s with no admin action. You can still cancel below.</Text>
            ) : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>

          <View style={styles.actionRow}>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => handleCancel(id, orderId)} disabled={isBusy}>
              {isBusy ? <ActivityIndicator color={colors.error} /> : <Text style={styles.cancelBtnText}>Cancel</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.acceptBtn} onPress={() => handleAccept(id, orderId)} disabled={isBusy}>
              {isBusy ? <ActivityIndicator color={colors.textInverse} /> : <Text style={styles.acceptBtnText}>Accept</Text>}
            </TouchableOpacity>
          </View>

          {waiting.length > 0 ? (
            <TouchableOpacity style={styles.skipBtn} onPress={handleSkip} disabled={isBusy}>
              <AppIcon name="chevronRight" size={14} color={colors.textSecondary} />
              <Text style={styles.skipBtnText}>Skip · next in queue ({waiting.length} waiting)</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

function DetailRow({ label, value, big }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, big && styles.detailValueBig]} numberOfLines={2}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: colors.overlayDark, justifyContent: 'center', padding: spacing.lg },
  queueBar: {
    backgroundColor: colors.bgSurface, borderRadius: radius.lg, padding: spacing.sm, marginBottom: spacing.sm,
  },
  queueLabel: { fontSize: 12, fontWeight: '700', color: colors.textSecondary, marginBottom: spacing.xs },
  queueChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  queueChip: {
    borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 4,
    backgroundColor: colors.bgApp, borderWidth: 1, borderColor: colors.border,
  },
  queueChipActive: { backgroundColor: colors.saffron, borderColor: colors.saffron },
  queueChipText: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  queueChipTextActive: { color: colors.textInverse },
  card: {
    backgroundColor: colors.bgSurface, borderRadius: radius.xxl, padding: spacing.lg,
    overflow: 'hidden', ...shadows.modal,
  },
  topAccent: { position: 'absolute', top: 0, left: 0, right: 0, height: 6, backgroundColor: colors.saffron },
  headerRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.sm, marginBottom: spacing.md, gap: spacing.sm },
  bell: { fontSize: 28 },
  headerTitle: { ...typography.h3, color: colors.textPrimary },
  headerSub: { fontSize: 12, color: colors.textSecondary, marginTop: 2, fontWeight: '600' },
  countdownPill: {
    backgroundColor: colors.saffronLight, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: 6,
  },
  countdownText: { color: colors.saffronDark, fontWeight: '800', fontSize: 13 },
  body: { marginBottom: spacing.md },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, gap: spacing.sm },
  detailLabel: { fontSize: 12, color: colors.textSecondary, fontWeight: '600' },
  detailValue: { fontSize: 13, color: colors.textPrimary, fontWeight: '700', flexShrink: 1, textAlign: 'right' },
  detailValueBig: { fontSize: 18, color: colors.saffronDark },
  meta: { fontSize: 11, color: colors.textTertiary, marginTop: spacing.xs },
  info: {
    fontSize: 12, color: colors.info, backgroundColor: colors.infoLight, borderRadius: radius.lg,
    padding: spacing.sm, marginTop: spacing.sm,
  },
  error: {
    fontSize: 12, color: colors.error, backgroundColor: colors.errorLight, borderRadius: radius.lg,
    padding: spacing.sm, marginTop: spacing.sm, fontWeight: '600',
  },
  actionRow: { flexDirection: 'row', gap: spacing.md },
  cancelBtn: {
    flex: 1, borderRadius: radius.button, borderWidth: 1.5, borderColor: colors.error,
    paddingVertical: 14, alignItems: 'center', backgroundColor: colors.errorLight,
  },
  cancelBtnText: { color: colors.error, fontWeight: '800', fontSize: 15 },
  acceptBtn: { flex: 1, borderRadius: radius.button, paddingVertical: 14, alignItems: 'center', backgroundColor: colors.success },
  acceptBtnText: { color: colors.textInverse, fontWeight: '800', fontSize: 15 },
  skipBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: spacing.md },
  skipBtnText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
});
