import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { colors, spacing, typography, radius, shadows } from '../../theme';
import { riderApi } from '../../api';
import AppIcon from '../../components/AppIcon';
import DayHistoryPicker from '../../components/DayHistoryPicker';
import { todayDateStr } from '../../utils/dateStr';

function formatWhen(value) {
  if (!value) return '';
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export default function RiderHistoryScreen() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Default view is today only; picking a day from history browses that day.
  const [selectedDate, setSelectedDate] = useState(() => todayDateStr());
  const [pickerVisible, setPickerVisible] = useState(false);
  const isToday = selectedDate === todayDateStr();

  const load = useCallback(async (date) => {
    try {
      const res = await riderApi.getHistory({ page: 1, limit: 40, date: date || selectedDate });
      setOrders(res?.orders || []);
    } catch (_) {
      setOrders([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selectedDate]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const handleSelectDate = useCallback((dateStr) => {
    setSelectedDate(dateStr);
    setPickerVisible(false);
    setLoading(true);
    load(dateStr);
  }, [load]);

  const backToToday = useCallback(() => {
    const t = todayDateStr();
    setSelectedDate(t);
    setLoading(true);
    load(t);
  }, [load]);

  const deliveredCount = orders.filter((o) => o.status === 'Delivered').length;

  const renderItem = ({ item }) => {
    const delivered = item.status === 'Delivered';
    const when = formatWhen(item.updated_at || item.updatedAt || item.created_at || item.createdAt);
    return (
      <View style={styles.card}>
        <View style={[styles.accent, delivered ? styles.accentOk : styles.accentMuted]} />
        <View style={styles.cardBody}>
          <View style={styles.cardTop}>
            <Text style={styles.orderNum}>#{item.orderNumber || item.order_number}</Text>
            <View style={[styles.chip, delivered ? styles.chipOk : styles.chipCancel]}>
              <AppIcon
                name={delivered ? 'check' : 'close'}
                size={11}
                color={delivered ? colors.successDark : colors.error}
              />
              <Text style={[styles.chipText, delivered ? styles.chipTextOk : styles.chipTextCancel]}>
                {item.status}
              </Text>
            </View>
          </View>
          {item.address ? (
            <View style={styles.addrRow}>
              <AppIcon name="map" size={13} color={colors.textTertiary} />
              <Text style={styles.addr} numberOfLines={2}>{item.address}</Text>
            </View>
          ) : null}
          <View style={styles.metaRow}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {when ? <Text style={styles.meta}>{when}</Text> : null}
              {(item.deliveryType || item.delivery_type) ? (
                <Text style={styles.meta}>
                  · {(item.deliveryType || item.delivery_type) === 'fast' ? '⚡ Express' : 'Standard'}
                </Text>
              ) : null}
            </View>
            {item.total != null ? (
              <Text style={styles.total}>₹{Number(item.total).toFixed(0)}</Text>
            ) : null}
          </View>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <View>
            <Text style={styles.title}>History</Text>
            <Text style={styles.subtitle}>
              {loading ? 'Loading…' : `${deliveredCount} delivered · ${orders.length} total`}
            </Text>
            <Text style={styles.subtitle}>{isToday ? 'Today' : selectedDate}</Text>
          </View>
          {isToday ? (
            <TouchableOpacity style={styles.historyBtn} onPress={() => setPickerVisible(true)}>
              <AppIcon name="orders" size={14} color={colors.saffronDark} />
              <Text style={styles.historyBtnText}>Browse days</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.historyBtn} onPress={backToToday}>
              <Text style={styles.historyBtnText}>← Today</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {loading ? (
        <ActivityIndicator style={{ marginTop: spacing.xl }} color={colors.saffron} />
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          refreshControl={(
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
              tintColor={colors.saffron}
            />
          )}
          contentContainerStyle={orders.length === 0 ? styles.emptyWrap : styles.list}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={(
            <View style={styles.emptyState}>
              <View style={styles.emptyIcon}>
                <AppIcon name="orders" size={30} color={colors.saffronDark} />
              </View>
              <Text style={styles.emptyTitle}>No deliveries yet</Text>
              <Text style={styles.emptyText}>
                Completed and cancelled jobs you rode for will show up here.
              </Text>
            </View>
          )}
        />
      )}

      <DayHistoryPicker
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        onSelectDate={handleSelectDate}
        selectedDate={selectedDate}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bgApp },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
  },
  title: { ...typography.display, fontSize: 26, color: colors.textPrimary },
  subtitle: {
    ...typography.bodySmall,
    color: colors.textSecondary,
    marginTop: 4,
    fontWeight: '500',
  },
  historyBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.saffronLight, borderRadius: radius.pill,
    paddingHorizontal: 12, paddingVertical: 8,
  },
  historyBtnText: { color: colors.saffronDark, fontWeight: '800', fontSize: 13 },
  list: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  emptyWrap: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: spacing.xl },
  card: {
    flexDirection: 'row',
    backgroundColor: colors.bgSurface,
    borderRadius: radius.xl,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    ...shadows.sm,
  },
  accent: { width: 5 },
  accentOk: { backgroundColor: colors.success },
  accentMuted: { backgroundColor: colors.grey200 },
  cardBody: { flex: 1, padding: spacing.md },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  orderNum: { ...typography.h3, color: colors.textPrimary },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chipOk: { backgroundColor: colors.successLight },
  chipCancel: { backgroundColor: colors.errorLight },
  chipText: { fontWeight: '800', fontSize: 11 },
  chipTextOk: { color: colors.successDark },
  chipTextCancel: { color: colors.error },
  addrRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginBottom: spacing.sm,
  },
  addr: {
    flex: 1,
    ...typography.caption,
    color: colors.textSecondary,
    lineHeight: 18,
    fontWeight: '500',
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  meta: { fontSize: 12, color: colors.textTertiary, fontWeight: '600' },
  total: { fontSize: 14, fontWeight: '800', color: colors.textPrimary },
  emptyState: { alignItems: 'center' },
  emptyIcon: {
    width: 72,
    height: 72,
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
    lineHeight: 20,
    maxWidth: 260,
  },
});
