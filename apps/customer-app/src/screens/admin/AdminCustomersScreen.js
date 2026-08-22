import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Linking, Modal, RefreshControl, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { colors, spacing, typography, radius, shadows } from '../../theme';
import { adminApi } from '../../api';
import AppIcon from '../../components/AppIcon';

const TRUST_FILTERS = [
  { value: '', label: 'All' },
  { value: '1', label: 'Trusted' },
  { value: '0', label: 'Not trusted' },
];
const BLOCK_FILTERS = [
  { value: '', label: 'All' },
  { value: '1', label: 'Blocked' },
  { value: '0', label: 'Active' },
];

function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
}

/**
 * AdminCustomersScreen (ADMIN TASK 12) — mirrors apps/admin Customers.jsx:
 * search + trusted/blocked filters, row → detail drawer, trust/block toggles
 * with the same confirm severity as web (both directions confirmed — web
 * confirms trust AND block changes either way, unlike the shop/dashboard
 * asymmetric toggles).
 */
export default function AdminCustomersScreen() {
  const [customers, setCustomers] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 20, totalPages: 1 });
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [trusted, setTrusted] = useState('');
  const [blocked, setBlocked] = useState('');
  const [selected, setSelected] = useState(null);
  const [updating, setUpdating] = useState(false);

  const fetchCustomers = useCallback(async (page = 1, { silent = false } = {}) => {
    try {
      if (!silent) setLoading(true);
      setError(null);
      const params = { page, limit: 20, search, trusted, blocked };
      Object.keys(params).forEach((k) => params[k] === '' && delete params[k]);
      const res = await adminApi.listCustomers(params);
      setCustomers(res?.data || []);
      if (res?.pagination) setPagination(res.pagination);
    } catch (err) {
      setError(err?.message || 'Could not load customers.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [search, trusted, blocked]);

  useFocusEffect(useCallback(() => { fetchCustomers(1, { silent: true }); }, [fetchCustomers]));

  useEffect(() => {
    const t = setTimeout(() => fetchCustomers(1), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, trusted, blocked]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    fetchCustomers(pagination.page || 1, { silent: true });
  }, [fetchCustomers, pagination.page]);

  const openDetail = async (id) => {
    try {
      setUpdating(true);
      const res = await adminApi.getCustomer(id);
      setSelected(res?.data || null);
    } catch (err) {
      setError(err?.message || 'Could not load customer.');
    } finally {
      setUpdating(false);
    }
  };

  const closeDetail = () => setSelected(null);

  const handleToggleTrust = () => {
    const nextValue = !selected.trusted;
    const action = nextValue ? 'mark this customer as trusted' : 'revoke trusted status for this customer';
    Alert.alert('Confirm', `Are you sure you want to ${action}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Confirm', onPress: async () => {
          try {
            setUpdating(true);
            await adminApi.updateCustomerTrust(selected.id, nextValue);
            setSelected((prev) => ({ ...prev, trusted: nextValue }));
            fetchCustomers(pagination.page || 1, { silent: true });
          } catch (err) {
            setError(err?.message || 'Could not update trust status.');
          } finally {
            setUpdating(false);
          }
        },
      },
    ]);
  };

  const handleToggleBlock = () => {
    const nextValue = !selected.blocked;
    const action = nextValue
      ? 'block this customer? They will not be able to place orders.'
      : 'unblock this customer? They will be able to place orders again.';
    Alert.alert('Confirm', `Are you sure you want to ${action}`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Confirm', style: nextValue ? 'destructive' : 'default', onPress: async () => {
          try {
            setUpdating(true);
            await adminApi.updateCustomerBlock(selected.id, nextValue);
            setSelected((prev) => ({ ...prev, blocked: nextValue }));
            fetchCustomers(pagination.page || 1, { silent: true });
          } catch (err) {
            setError(err?.message || 'Could not update block status.');
          } finally {
            setUpdating(false);
          }
        },
      },
    ]);
  };

  const renderCustomer = ({ item }) => (
    <TouchableOpacity style={styles.row} activeOpacity={0.8} onPress={() => openDetail(item.id)}>
      <View style={{ flex: 1 }}>
        <View style={styles.nameRow}>
          <Text style={styles.name}>{item.name}</Text>
          {item.trusted ? <View style={[styles.badge, styles.badgeTrusted]}><Text style={styles.badgeTrustedText}>Trusted</Text></View> : null}
          {item.blocked ? <View style={[styles.badge, styles.badgeBlocked]}><Text style={styles.badgeBlockedText}>Blocked</Text></View> : null}
        </View>
        <Text style={styles.meta}>{item.phone} · {item.order_count || item.total_orders || 0} orders · {formatDate(item.created_at)}</Text>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <View style={styles.searchRow}>
        <AppIcon name="search" size={16} color={colors.textSecondary} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search name, phone, WhatsApp"
          placeholderTextColor={colors.textTertiary}
          value={search}
          onChangeText={setSearch}
        />
      </View>

      <View style={styles.filterRow}>
        {TRUST_FILTERS.map((f) => (
          <TouchableOpacity
            key={`trust-${f.value}`}
            style={[styles.chip, trusted === f.value && styles.chipActive]}
            onPress={() => setTrusted(f.value)}
          >
            <Text style={[styles.chipText, trusted === f.value && styles.chipTextActive]}>{f.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.filterRow}>
        {BLOCK_FILTERS.map((f) => (
          <TouchableOpacity
            key={`block-${f.value}`}
            style={[styles.chip, blocked === f.value && styles.chipActive]}
            onPress={() => setBlocked(f.value)}
          >
            <Text style={[styles.chipText, blocked === f.value && styles.chipTextActive]}>{f.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <FlatList
        data={customers}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderCustomer}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.saffron} />}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={{ marginTop: spacing.xl }} color={colors.saffron} />
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>No customers found.</Text>
            </View>
          )
        }
        ListFooterComponent={
          customers.length > 0 ? (
            <View style={styles.pagination}>
              <TouchableOpacity
                style={[styles.pageBtn, pagination.page <= 1 && styles.pageBtnDisabled]}
                disabled={pagination.page <= 1 || loading}
                onPress={() => fetchCustomers(pagination.page - 1)}
              >
                <Text style={styles.pageBtnText}>Previous</Text>
              </TouchableOpacity>
              <Text style={styles.pageLabel}>Page {pagination.page} of {pagination.totalPages}</Text>
              <TouchableOpacity
                style={[styles.pageBtn, pagination.page >= pagination.totalPages && styles.pageBtnDisabled]}
                disabled={pagination.page >= pagination.totalPages || loading}
                onPress={() => fetchCustomers(pagination.page + 1)}
              >
                <Text style={styles.pageBtnText}>Next</Text>
              </TouchableOpacity>
            </View>
          ) : null
        }
      />

      <Modal visible={!!selected} transparent animationType="slide" onRequestClose={closeDetail}>
        <View style={styles.sheetOverlay}>
          <TouchableOpacity style={styles.sheetBackdrop} activeOpacity={1} onPress={closeDetail} />
          {selected ? (
            <View style={styles.sheet}>
              <View style={styles.detailHeader}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{(selected.name || '?').charAt(0).toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.detailName}>{selected.name}</Text>
                  <View style={styles.nameRow}>
                    {selected.trusted ? <View style={[styles.badge, styles.badgeTrusted]}><Text style={styles.badgeTrustedText}>Trusted</Text></View> : null}
                    {selected.blocked ? <View style={[styles.badge, styles.badgeBlocked]}><Text style={styles.badgeBlockedText}>Blocked</Text></View> : null}
                  </View>
                </View>
              </View>

              <View style={styles.statsRow}>
                <View style={styles.statCard}>
                  <Text style={styles.statLabel}>Total orders</Text>
                  <Text style={styles.statValue}>{selected.order_count || selected.total_orders || 0}</Text>
                </View>
                <View style={styles.statCard}>
                  <Text style={styles.statLabel}>Joined</Text>
                  <Text style={styles.statValue}>{formatDate(selected.created_at)}</Text>
                </View>
              </View>

              <Text style={styles.sectionTitle}>Contact</Text>
              <Text style={styles.contactRow}>Phone: {selected.phone}</Text>
              {selected.whatsapp_number ? <Text style={styles.contactRow}>WhatsApp: {selected.whatsapp_number}</Text> : null}
              {(selected.short_address || selected.address) ? (
                <Text style={styles.addressText}>{selected.short_address || selected.address}</Text>
              ) : null}
              <View style={styles.contactActions}>
                <TouchableOpacity style={styles.contactBtn} onPress={() => Linking.openURL(`tel:${selected.phone}`)}>
                  <Text style={styles.contactBtnText}>Call</Text>
                </TouchableOpacity>
                {selected.whatsapp_number ? (
                  <TouchableOpacity
                    style={styles.contactBtn}
                    onPress={() => Linking.openURL(`https://wa.me/${String(selected.whatsapp_number).replace(/[^0-9]/g, '')}`)}
                  >
                    <Text style={styles.contactBtnText}>WhatsApp</Text>
                  </TouchableOpacity>
                ) : null}
              </View>

              <TouchableOpacity style={styles.actionBtn} onPress={handleToggleTrust} disabled={updating}>
                {updating ? <ActivityIndicator color={colors.textPrimary} /> : (
                  <Text style={styles.actionBtnText}>{selected.trusted ? 'Revoke trust' : 'Mark as trusted'}</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity style={[styles.actionBtn, styles.dangerBtn]} onPress={handleToggleBlock} disabled={updating}>
                {updating ? <ActivityIndicator color={colors.error} /> : (
                  <Text style={[styles.actionBtnText, styles.dangerBtnText]}>{selected.blocked ? 'Unblock customer' : 'Block customer'}</Text>
                )}
              </TouchableOpacity>
            </View>
          ) : null}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgApp },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginHorizontal: spacing.lg,
    backgroundColor: colors.bgSurface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: spacing.md, marginTop: spacing.sm, marginBottom: spacing.sm,
  },
  searchInput: { flex: 1, paddingVertical: 10, color: colors.textPrimary, fontSize: 14 },
  filterRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm,
    paddingHorizontal: spacing.lg, marginBottom: spacing.sm,
  },
  chip: {
    borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 8, minHeight: 34,
    justifyContent: 'center', backgroundColor: colors.bgSurface, borderWidth: 1, borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.saffron, borderColor: colors.saffron },
  chipText: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
  chipTextActive: { color: colors.textInverse },
  errorBanner: { marginHorizontal: spacing.lg, backgroundColor: colors.errorLight, borderRadius: radius.lg, padding: spacing.sm, marginBottom: spacing.sm },
  errorText: { color: colors.error, fontWeight: '600', fontSize: 13 },
  listContent: { paddingBottom: spacing.xl },
  row: {
    backgroundColor: colors.bgSurface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    padding: spacing.md, marginHorizontal: spacing.lg, marginBottom: spacing.sm, ...shadows.sm,
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexWrap: 'wrap' },
  name: { ...typography.body, fontWeight: '700', color: colors.textPrimary },
  meta: { fontSize: 12, color: colors.textSecondary, marginTop: 4 },
  badge: { borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
  badgeTrusted: { backgroundColor: colors.successLight },
  badgeTrustedText: { fontSize: 10, fontWeight: '800', color: colors.successDark },
  badgeBlocked: { backgroundColor: colors.errorLight },
  badgeBlockedText: { fontSize: 10, fontWeight: '800', color: colors.error },
  emptyState: { alignItems: 'center', paddingTop: spacing.xl },
  emptyText: { ...typography.body, color: colors.textSecondary },
  pagination: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, marginTop: spacing.md },
  pageBtn: { backgroundColor: colors.bgSurface, borderRadius: radius.button, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderWidth: 1, borderColor: colors.border },
  pageBtnDisabled: { opacity: 0.4 },
  pageBtnText: { fontWeight: '700', color: colors.textPrimary, fontSize: 13 },
  pageLabel: { fontSize: 12, color: colors.textSecondary },
  sheetOverlay: { flex: 1, justifyContent: 'flex-end' },
  sheetBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.overlayDark },
  sheet: { backgroundColor: colors.bgSurface, borderTopLeftRadius: radius.xxl, borderTopRightRadius: radius.xxl, padding: spacing.lg, paddingBottom: spacing.xl },
  detailHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.md },
  avatar: { width: 48, height: 48, borderRadius: radius.circle, backgroundColor: colors.saffronLight, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 20, fontWeight: '800', color: colors.saffronDark },
  detailName: { ...typography.h3, color: colors.textPrimary, marginBottom: 4 },
  statsRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  statCard: { flex: 1, backgroundColor: colors.bgApp, borderRadius: radius.lg, padding: spacing.sm, alignItems: 'center' },
  statLabel: { fontSize: 11, color: colors.textSecondary, fontWeight: '700' },
  statValue: { fontSize: 16, fontWeight: '800', color: colors.textPrimary, marginTop: 2 },
  sectionTitle: { fontSize: 12, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', marginBottom: spacing.xs },
  contactRow: { fontSize: 13, color: colors.textPrimary, marginBottom: 4 },
  addressText: { fontSize: 13, color: colors.textPrimary, backgroundColor: colors.bgApp, borderRadius: radius.lg, padding: spacing.sm, marginTop: spacing.xs },
  contactActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md, marginBottom: spacing.md },
  contactBtn: { flex: 1, borderRadius: radius.button, paddingVertical: 10, alignItems: 'center', backgroundColor: colors.saffron },
  contactBtnText: { color: colors.textInverse, fontWeight: '800', fontSize: 13 },
  actionBtn: {
    borderRadius: radius.button, paddingVertical: spacing.sm, alignItems: 'center',
    borderWidth: 1.5, borderColor: colors.border, marginTop: spacing.sm,
  },
  actionBtnText: { fontWeight: '800', color: colors.textPrimary },
  dangerBtn: { borderColor: colors.error },
  dangerBtnText: { color: colors.error },
});
