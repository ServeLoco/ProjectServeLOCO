import React, { useMemo } from 'react';
import {
  FlatList,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, typography, spacing, radius, shadows } from '../../theme';
import AppIcon from '../AppIcon';
import { todayDateStr } from '../../utils/dateStr';

const pad = (n) => String(n).padStart(2, '0');
// `date` here is a pure calendar-date container (not a real instant) —
// anchored at UTC midnight so subtracting days can't cross a local DST/offset
// boundary. Format it with timeZone: 'UTC' wherever it's displayed.
const toDateStr = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

function buildDays(daysBack) {
  const days = [];
  // Anchor on the IST calendar day (todayDateStr), not the device's local
  // day — a device not set to IST would otherwise generate a day list that
  // doesn't line up with the IST "Today"/"Yesterday" labels below.
  const [ty, tm, td] = todayDateStr().split('-').map(Number);
  const todayUtc = Date.UTC(ty, tm - 1, td);
  for (let i = 0; i < daysBack; i += 1) {
    const d = new Date(todayUtc - i * 24 * 60 * 60 * 1000);
    days.push({ dateStr: toDateStr(d), date: d });
  }
  return days;
}

function labelFor(dateStr, date, todayStr, yesterdayStr) {
  if (dateStr === todayStr) return 'Today';
  if (dateStr === yesterdayStr) return 'Yesterday';
  return date.toLocaleDateString('en-IN', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * DayHistoryPicker
 * Bottom-sheet list of the last `daysBack` days for "browse orders by day"
 * history flows (shop/rider/customer order lists). Selecting a day calls
 * onSelectDate(dateStr) with a local YYYY-MM-DD string.
 */
export default function DayHistoryPicker({
  visible = false,
  onClose,
  onSelectDate,
  selectedDate,
  daysBack = 60,
}) {
  const days = useMemo(() => buildDays(daysBack), [daysBack]);
  const todayStr = todayDateStr();
  const yesterdayStr = days[1]?.dateStr;

  return (
    <Modal visible={visible} transparent animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop}>
          <TouchableWithoutFeedback>
            <View style={styles.sheet}>
              <SafeAreaView edges={['bottom']}>
                <View style={styles.handle} />
                <View style={styles.header}>
                  <Text style={styles.title}>Order History</Text>
                  <TouchableOpacity onPress={onClose} accessibilityLabel="Close" style={styles.closeBtn}>
                    <AppIcon name="close" size={18} color={colors.textSecondary} />
                  </TouchableOpacity>
                </View>
                <FlatList
                  data={days}
                  keyExtractor={(item) => item.dateStr}
                  contentContainerStyle={styles.list}
                  showsVerticalScrollIndicator={false}
                  renderItem={({ item }) => {
                    const active = item.dateStr === selectedDate;
                    return (
                      <TouchableOpacity
                        style={[styles.row, active && styles.rowActive]}
                        onPress={() => onSelectDate?.(item.dateStr)}
                        activeOpacity={0.75}
                      >
                        <Text style={[styles.rowText, active && styles.rowTextActive]}>
                          {labelFor(item.dateStr, item.date, todayStr, yesterdayStr)}
                        </Text>
                        {active ? <AppIcon name="check" size={16} color={colors.saffronDark} /> : null}
                      </TouchableOpacity>
                    );
                  }}
                />
              </SafeAreaView>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    maxHeight: '70%',
    backgroundColor: colors.bgSurface,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    ...shadows.cardRaised,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  title: { ...typography.h3, color: colors.textPrimary },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.circle,
    backgroundColor: colors.bgApp,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowActive: {},
  rowText: { ...typography.body, color: colors.textPrimary, fontWeight: '600' },
  rowTextActive: { color: colors.saffronDark, fontWeight: '800' },
});
