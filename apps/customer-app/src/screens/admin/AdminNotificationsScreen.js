import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, ScrollView, StyleSheet, Switch,
  Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { colors, spacing, typography, radius, shadows } from '../../theme';
import { adminApi } from '../../api';

const TYPES = [
  { value: 'info', label: 'Info' },
  { value: 'offer', label: 'Offer' },
  { value: 'success', label: 'Success' },
  { value: 'warning', label: 'Warning' },
  { value: 'admin', label: 'Admin' },
];

const EVENT_LABELS = {
  order_placed: 'Order Placed',
  status_accepted: 'Order Accepted',
  status_preparing: 'Preparing',
  status_out_for_delivery: 'Out for Delivery',
  status_delivered: 'Delivered',
  status_cancelled: 'Order Cancelled',
  payment_paid: 'Payment Received',
  payment_failed: 'Payment Failed',
  payment_refunded: 'Payment Refunded',
};

function parsePhones(input) {
  const seen = new Set();
  const out = [];
  for (const raw of String(input || '').split(/[\s,;]+/)) {
    const cleaned = String(raw || '').replace(/[^\d+]/g, '');
    const normalized = cleaned.startsWith('+') ? `+${cleaned.slice(1).replace(/\D/g, '')}` : cleaned.replace(/\D/g, '');
    if (!normalized || normalized.length < 7 || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function formatDateTime(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

/**
 * AdminNotificationsScreen (ADMIN TASK 13) — mirrors apps/admin
 * Notifications.jsx: broadcast composer (title/body/type/target) + history,
 * and auto-send event template settings. Uses the system keyboard for emoji
 * (13.4) — no custom emoji picker grid needed on a phone.
 */
export default function AdminNotificationsScreen() {
  const [segment, setSegment] = useState('broadcast');

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.segmentRow}>
        {[{ key: 'broadcast', label: 'Broadcast' }, { key: 'templates', label: 'Templates' }].map((s) => {
          const active = segment === s.key;
          return (
            <TouchableOpacity
              key={s.key}
              style={[styles.segment, active && styles.segmentActive]}
              onPress={() => setSegment(s.key)}
              activeOpacity={0.85}
            >
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{s.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {segment === 'broadcast' ? <BroadcastPanel /> : <TemplatesPanel />}
    </SafeAreaView>
  );
}

function BroadcastPanel() {
  const [broadcasts, setBroadcasts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [type, setType] = useState('info');
  const [target, setTarget] = useState('everyone');
  const [phonesInput, setPhonesInput] = useState('');
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [deletingId, setDeletingId] = useState(null);

  const parsedPhones = target === 'phones' ? parsePhones(phonesInput) : [];

  const fetchBroadcasts = useCallback(async () => {
    try {
      setLoading(true);
      const res = await adminApi.listNotifications();
      setBroadcasts(res?.data || []);
    } catch (_) {
      // history load failure is non-fatal to composing
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { fetchBroadcasts(); }, [fetchBroadcasts]));

  const send = async () => {
    setErrorMsg('');
    setSuccessMsg('');
    if (!title.trim() || !body.trim()) {
      setErrorMsg('Title and body are required');
      return;
    }
    if (title.length > 80) {
      setErrorMsg('Title must be 80 characters or less');
      return;
    }
    if (body.length > 240) {
      setErrorMsg('Body must be 240 characters or less');
      return;
    }
    if (target === 'phones' && parsedPhones.length === 0) {
      setErrorMsg('Enter at least one phone number to send to specific customers');
      return;
    }

    const targetDescription = target === 'everyone'
      ? 'all active customers'
      : `${parsedPhones.length} customer${parsedPhones.length === 1 ? '' : 's'} by phone`;

    Alert.alert('Send broadcast?', `This will send to ${targetDescription}.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Send', onPress: doSend },
    ]);

    async function doSend() {
      setSending(true);
      try {
        const payload = { title, body, type, target };
        if (target === 'phones') payload.phones = parsedPhones;
        const res = await adminApi.createNotification(payload);
        const recipientCount = res?.data?.recipientCount ?? 'all';
        setSuccessMsg(`Sent to ${recipientCount} customer${recipientCount === 1 ? '' : 's'}.`);
        setTitle('');
        setBody('');
        setPhonesInput('');
        fetchBroadcasts();
      } catch (err) {
        setErrorMsg(err?.message || 'Could not send broadcast.');
      } finally {
        setSending(false);
      }
    }
  };

  const handleDelete = (id) => {
    Alert.alert('Delete broadcast?', 'It will be removed from customer inboxes.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          setDeletingId(id);
          try {
            await adminApi.deleteNotification(id);
            setBroadcasts((prev) => prev.filter((b) => b.id !== id));
          } catch (err) {
            setErrorMsg(err?.message || 'Could not delete broadcast.');
          } finally {
            setDeletingId(null);
          }
        },
      },
    ]);
  };

  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <Text style={styles.sectionTitle}>Send new broadcast</Text>

      {errorMsg ? <View style={styles.errorBanner}><Text style={styles.errorText}>{errorMsg}</Text></View> : null}
      {successMsg ? <View style={styles.successBanner}><Text style={styles.successText}>{successMsg}</Text></View> : null}

      <Text style={styles.fieldLabel}>Target audience</Text>
      <View style={styles.chipsRow}>
        <TouchableOpacity style={[styles.chip, target === 'everyone' && styles.chipActive]} onPress={() => setTarget('everyone')}>
          <Text style={[styles.chipText, target === 'everyone' && styles.chipTextActive]}>All customers</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.chip, target === 'phones' && styles.chipActive]} onPress={() => setTarget('phones')}>
          <Text style={[styles.chipText, target === 'phones' && styles.chipTextActive]}>Specific phones</Text>
        </TouchableOpacity>
      </View>

      {target === 'phones' ? (
        <>
          <TextInput
            style={styles.textArea}
            multiline
            numberOfLines={3}
            placeholder="9999999001, 9999999002"
            placeholderTextColor={colors.textTertiary}
            value={phonesInput}
            onChangeText={setPhonesInput}
          />
          <Text style={styles.hint}>
            {parsedPhones.length === 0 ? 'Enter at least one phone, separated by commas.' : `${parsedPhones.length} valid phone(s) parsed`}
          </Text>
        </>
      ) : null}

      <Text style={styles.fieldLabel}>Notification type</Text>
      <View style={styles.chipsRow}>
        {TYPES.map((t) => (
          <TouchableOpacity key={t.value} style={[styles.chip, type === t.value && styles.chipActive]} onPress={() => setType(t.value)}>
            <Text style={[styles.chipText, type === t.value && styles.chipTextActive]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.fieldLabel}>Title ({title.length}/80)</Text>
      <TextInput style={styles.input} value={title} onChangeText={setTitle} maxLength={80} placeholder="e.g. Flash Sale Today!" placeholderTextColor={colors.textTertiary} />

      <Text style={styles.fieldLabel}>Body ({body.length}/240)</Text>
      <TextInput
        style={styles.textArea}
        multiline
        numberOfLines={4}
        value={body}
        onChangeText={setBody}
        maxLength={240}
        placeholder="Type your message here…"
        placeholderTextColor={colors.textTertiary}
      />

      <TouchableOpacity style={styles.sendBtn} onPress={send} disabled={sending}>
        {sending ? <ActivityIndicator color={colors.textInverse} /> : <Text style={styles.sendBtnText}>Send broadcast</Text>}
      </TouchableOpacity>

      <Text style={[styles.sectionTitle, { marginTop: spacing.lg }]}>Recent broadcasts</Text>
      {loading ? (
        <ActivityIndicator color={colors.saffron} style={{ marginTop: spacing.md }} />
      ) : broadcasts.length === 0 ? (
        <Text style={styles.emptyText}>No recent broadcasts found.</Text>
      ) : (
        broadcasts.map((b) => (
          <View key={b.id} style={styles.broadcastRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.broadcastTitle}>{b.title}</Text>
              <Text style={styles.broadcastBody} numberOfLines={2}>{b.body}</Text>
              <Text style={styles.broadcastMeta}>{formatDateTime(b.created_at)} · {b.recipient_count} recipients</Text>
            </View>
            <TouchableOpacity onPress={() => handleDelete(b.id)} disabled={deletingId === b.id}>
              <Text style={styles.deleteLink}>{deletingId === b.id ? 'Deleting…' : 'Delete'}</Text>
            </TouchableOpacity>
          </View>
        ))
      )}
    </ScrollView>
  );
}

function TemplatesPanel() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ title: '', body: '' });
  const [savingId, setSavingId] = useState(null);
  const [resettingId, setResettingId] = useState(null);
  const [togglingId, setTogglingId] = useState(null);

  const fetchTemplates = useCallback(async () => {
    try {
      setLoading(true);
      const res = await adminApi.listNotificationTemplates();
      setTemplates(res?.data || []);
    } catch (_) {
      // best-effort
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { fetchTemplates(); }, [fetchTemplates]));

  const startEdit = (tmpl) => {
    setEditingId(tmpl.id);
    setEditForm({ title: tmpl.title, body: tmpl.body });
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditForm({ title: '', body: '' });
  };

  const saveEdit = async (tmpl) => {
    if (!editForm.title.trim() || !editForm.body.trim()) return;
    setSavingId(tmpl.id);
    try {
      const res = await adminApi.updateNotificationTemplate(tmpl.id, {
        title: editForm.title.trim(), body: editForm.body.trim(), enabled: tmpl.enabled,
      });
      setTemplates((prev) => prev.map((t) => (t.id === tmpl.id ? res.data : t)));
      setEditingId(null);
    } catch (_) {
      // best-effort, keep editing open on failure
    } finally {
      setSavingId(null);
    }
  };

  const resetTemplate = (tmpl) => {
    Alert.alert('Reset to default?', `"${EVENT_LABELS[tmpl.event_key] || tmpl.event_key}" will go back to its default text.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset', onPress: async () => {
          setResettingId(tmpl.id);
          try {
            const res = await adminApi.resetNotificationTemplate(tmpl.id);
            setTemplates((prev) => prev.map((t) => (t.id === tmpl.id ? res.data : t)));
            if (editingId === tmpl.id) setEditingId(null);
          } catch (_) {
            // best-effort
          } finally {
            setResettingId(null);
          }
        },
      },
    ]);
  };

  const toggleEnabled = async (tmpl) => {
    setTogglingId(tmpl.id);
    try {
      const res = await adminApi.updateNotificationTemplate(tmpl.id, {
        title: tmpl.title, body: tmpl.body, enabled: tmpl.enabled ? 0 : 1,
      });
      setTemplates((prev) => prev.map((t) => (t.id === tmpl.id ? res.data : t)));
    } catch (_) {
      // best-effort
    } finally {
      setTogglingId(null);
    }
  };

  return (
    <FlatList
      data={templates}
      keyExtractor={(item) => String(item.id)}
      contentContainerStyle={styles.scrollContent}
      ListEmptyComponent={loading ? <ActivityIndicator color={colors.saffron} style={{ marginTop: spacing.md }} /> : <Text style={styles.emptyText}>No templates found.</Text>}
      renderItem={({ item: tmpl }) => {
        const isEditing = editingId === tmpl.id;
        return (
          <View style={[styles.templateCard, !tmpl.enabled && styles.templateCardDisabled]}>
            <View style={styles.templateHeader}>
              <View style={{ flex: 1 }}>
                <Text style={styles.templateName}>{EVENT_LABELS[tmpl.event_key] || tmpl.event_key}</Text>
                {!isEditing ? <Text style={styles.templatePreview} numberOfLines={2}>{tmpl.title} — {tmpl.body}</Text> : null}
              </View>
              <Switch value={Boolean(tmpl.enabled)} onValueChange={() => toggleEnabled(tmpl)} disabled={togglingId === tmpl.id} />
            </View>

            {isEditing ? (
              <View style={{ marginTop: spacing.sm }}>
                <TextInput style={styles.input} value={editForm.title} onChangeText={(v) => setEditForm((p) => ({ ...p, title: v }))} maxLength={80} />
                <TextInput
                  style={styles.textArea}
                  multiline
                  numberOfLines={3}
                  value={editForm.body}
                  onChangeText={(v) => setEditForm((p) => ({ ...p, body: v }))}
                  maxLength={240}
                />
                <View style={styles.templateActionsRow}>
                  <TouchableOpacity style={styles.smallBtn} onPress={() => saveEdit(tmpl)} disabled={savingId === tmpl.id}>
                    <Text style={styles.smallBtnText}>{savingId === tmpl.id ? 'Saving…' : 'Save'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.smallBtnSecondary} onPress={cancelEdit}>
                    <Text style={styles.smallBtnSecondaryText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <View style={styles.templateActionsRow}>
                <TouchableOpacity style={styles.smallBtnSecondary} onPress={() => startEdit(tmpl)}>
                  <Text style={styles.smallBtnSecondaryText}>Edit</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.smallBtnSecondary} onPress={() => resetTemplate(tmpl)} disabled={resettingId === tmpl.id}>
                  <Text style={styles.smallBtnSecondaryText}>{resettingId === tmpl.id ? 'Resetting…' : 'Reset'}</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgApp },
  segmentRow: {
    flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg,
    paddingTop: spacing.md, paddingBottom: spacing.sm,
  },
  segment: {
    flex: 1, minWidth: 0, borderRadius: radius.pill, paddingVertical: 11, minHeight: 40,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.bgSurface, borderWidth: 1, borderColor: colors.border,
  },
  segmentActive: { backgroundColor: colors.saffron, borderColor: colors.saffron },
  segmentText: { fontWeight: '700', fontSize: 13, color: colors.textSecondary },
  segmentTextActive: { color: colors.textInverse },
  scrollContent: { padding: spacing.lg, paddingBottom: spacing.xl },
  sectionTitle: { ...typography.h3, color: colors.textPrimary, marginBottom: spacing.sm },
  errorBanner: { backgroundColor: colors.errorLight, borderRadius: radius.lg, padding: spacing.sm, marginBottom: spacing.sm },
  errorText: { color: colors.error, fontWeight: '600', fontSize: 13 },
  successBanner: { backgroundColor: colors.successLight, borderRadius: radius.lg, padding: spacing.sm, marginBottom: spacing.sm },
  successText: { color: colors.successDark, fontWeight: '600', fontSize: 13 },
  fieldLabel: {
    fontSize: 12, fontWeight: '700', color: colors.textSecondary, marginBottom: spacing.xs,
    marginTop: spacing.sm, textTransform: 'uppercase',
  },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 8, minHeight: 34,
    justifyContent: 'center', backgroundColor: colors.bgSurface, borderWidth: 1, borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.saffron, borderColor: colors.saffron },
  chipText: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  chipTextActive: { color: colors.textInverse },
  input: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, paddingHorizontal: spacing.md,
    paddingVertical: 12, color: colors.textPrimary, marginBottom: spacing.xs, fontSize: 14,
  },
  textArea: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, paddingHorizontal: spacing.md,
    paddingVertical: 12, color: colors.textPrimary, textAlignVertical: 'top', marginBottom: spacing.xs,
    minHeight: 88, fontSize: 14,
  },
  hint: { fontSize: 11, color: colors.textTertiary, marginBottom: spacing.sm },
  sendBtn: {
    backgroundColor: colors.saffron, borderRadius: radius.button, paddingVertical: 12,
    alignItems: 'center', marginTop: spacing.md, minHeight: 44, justifyContent: 'center',
  },
  sendBtnText: { color: colors.textInverse, fontWeight: '800' },
  emptyText: { ...typography.body, color: colors.textSecondary, marginTop: spacing.sm },
  broadcastRow: {
    flexDirection: 'row', gap: spacing.sm, backgroundColor: colors.bgSurface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginTop: spacing.sm, ...shadows.sm,
  },
  broadcastTitle: { ...typography.body, fontWeight: '700', color: colors.textPrimary },
  broadcastBody: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  broadcastMeta: { fontSize: 11, color: colors.textTertiary, marginTop: 4 },
  deleteLink: { fontSize: 12, fontWeight: '700', color: colors.error, alignSelf: 'flex-start', paddingVertical: 4 },
  templateCard: {
    backgroundColor: colors.bgSurface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, marginBottom: spacing.sm, ...shadows.sm,
  },
  templateCardDisabled: { opacity: 0.6 },
  templateHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  templateName: { ...typography.body, fontWeight: '700', color: colors.textPrimary },
  templatePreview: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  templateActionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  smallBtn: {
    backgroundColor: colors.saffron, borderRadius: radius.button, paddingHorizontal: spacing.md,
    paddingVertical: 10, minHeight: 36, justifyContent: 'center',
  },
  smallBtnText: { color: colors.textInverse, fontWeight: '800', fontSize: 12 },
  smallBtnSecondary: {
    borderRadius: radius.button, paddingHorizontal: spacing.md, paddingVertical: 10,
    borderWidth: 1, borderColor: colors.border, minHeight: 36, justifyContent: 'center',
  },
  smallBtnSecondaryText: { color: colors.textPrimary, fontWeight: '700', fontSize: 12 },
});
