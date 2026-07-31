import React, { useMemo, useRef, useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, FlatList, StyleSheet, Pressable,
} from 'react-native';
import { colors, spacing, radius, shadows, typography } from '../../theme';

const ITEM_HEIGHT = 44;
const VISIBLE_ROWS = 5;
const WHEEL_HEIGHT = ITEM_HEIGHT * VISIBLE_ROWS;
const SPACER_HEIGHT = ITEM_HEIGHT * Math.floor(VISIBLE_ROWS / 2);

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1); // 1..12
const MINUTES = Array.from({ length: 60 }, (_, i) => i); // 0..59

function parseHHMM(hhmm) {
  if (!hhmm) return { hour12: 9, minute: 0, meridiem: 'AM' };
  const [h, m] = String(hhmm).split(':').map(Number);
  const meridiem = h >= 12 ? 'PM' : 'AM';
  let hour12 = h % 12;
  if (hour12 === 0) hour12 = 12;
  return { hour12, minute: m || 0, meridiem };
}

function toHHMM(hour12, minute, meridiem) {
  let h = hour12 % 12;
  if (meridiem === 'PM') h += 12;
  return `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Wheel-style time picker built from plain FlatLists (no native date/time
 * picker dependency is installed in this app — adding one means an Expo
 * prebuild + native rebuild, so this stays pure JS/OTA-shippable).
 */
function Wheel({ data, selected, onSelect, formatItem, width }) {
  const listRef = useRef(null);
  const initialIndex = Math.max(0, data.indexOf(selected));

  const onMomentumEnd = (e) => {
    const y = e.nativeEvent.contentOffset.y;
    const index = Math.round(y / ITEM_HEIGHT);
    const clamped = Math.max(0, Math.min(data.length - 1, index));
    listRef.current?.scrollToOffset({ offset: clamped * ITEM_HEIGHT, animated: true });
    onSelect(data[clamped]);
  };

  // Tapping any visible-but-off-center row jumps straight to it — the wheel
  // doesn't require nailing a scroll/fling gesture to pick a nearby value.
  const selectIndex = (index) => {
    listRef.current?.scrollToOffset({ offset: index * ITEM_HEIGHT, animated: true });
    onSelect(data[index]);
  };

  return (
    <FlatList
      ref={listRef}
      data={data}
      keyExtractor={(item) => String(item)}
      style={{ height: WHEEL_HEIGHT, width }}
      contentContainerStyle={{ paddingVertical: SPACER_HEIGHT }}
      showsVerticalScrollIndicator={false}
      snapToInterval={ITEM_HEIGHT}
      decelerationRate="fast"
      initialScrollIndex={initialIndex}
      getItemLayout={(_, index) => ({ length: ITEM_HEIGHT, offset: ITEM_HEIGHT * index, index })}
      onMomentumScrollEnd={onMomentumEnd}
      renderItem={({ item, index }) => {
        const isSelected = item === selected;
        return (
          <TouchableOpacity
            style={styles.wheelRow}
            activeOpacity={0.6}
            onPress={() => selectIndex(index)}
          >
            <Text style={[styles.wheelText, isSelected && styles.wheelTextSelected]}>
              {formatItem(item)}
            </Text>
          </TouchableOpacity>
        );
      }}
    />
  );
}

export default function TimePickerModal({ visible, title, initialValue, onConfirm, onClose }) {
  const parsed = useMemo(() => parseHHMM(initialValue), [initialValue, visible]);
  const [hour12, setHour12] = useState(parsed.hour12);
  const [minute, setMinute] = useState(parsed.minute);
  const [meridiem, setMeridiem] = useState(parsed.meridiem);

  // Re-seed from the opened value each time the modal opens, so re-opening
  // after Cancel doesn't keep whatever was mid-scroll last time.
  React.useEffect(() => {
    if (!visible) return;
    setHour12(parsed.hour12);
    setMinute(parsed.minute);
    setMeridiem(parsed.meridiem);
  }, [visible, parsed]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>{title}</Text>

          <View style={styles.wheelsRow}>
            <View style={styles.selectionWindow} pointerEvents="none" />
            <Wheel data={HOURS} selected={hour12} onSelect={setHour12} formatItem={(h) => String(h)} width={64} />
            <Text style={styles.colon}>:</Text>
            <Wheel
              data={MINUTES}
              selected={minute}
              onSelect={setMinute}
              formatItem={(m) => String(m).padStart(2, '0')}
              width={64}
            />
            <View style={styles.meridiemCol}>
              {['AM', 'PM'].map((m) => (
                <TouchableOpacity
                  key={m}
                  style={[styles.meridiemBtn, meridiem === m && styles.meridiemBtnActive]}
                  onPress={() => setMeridiem(m)}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.meridiemText, meridiem === m && styles.meridiemTextActive]}>{m}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View style={styles.actionsRow}>
            <TouchableOpacity style={styles.cancelBtn} onPress={onClose} activeOpacity={0.85}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.confirmBtn}
              onPress={() => onConfirm(toHHMM(hour12, minute, meridiem))}
              activeOpacity={0.85}
            >
              <Text style={styles.confirmBtnText}>Set time</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1, backgroundColor: 'rgba(15, 15, 20, 0.5)', alignItems: 'center', justifyContent: 'center',
  },
  sheet: {
    width: '86%', backgroundColor: colors.bgSurface, borderRadius: radius.xxl,
    padding: spacing.lg, ...shadows.cardRaised,
  },
  title: { ...typography.h3, color: colors.textPrimary, textAlign: 'center', marginBottom: spacing.md },
  wheelsRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', position: 'relative',
  },
  selectionWindow: {
    position: 'absolute', left: 0, right: 0, top: SPACER_HEIGHT, height: ITEM_HEIGHT,
    borderTopWidth: 1.5, borderBottomWidth: 1.5, borderColor: colors.saffron,
    backgroundColor: colors.saffronLight, borderRadius: radius.md,
  },
  wheelRow: { height: ITEM_HEIGHT, alignItems: 'center', justifyContent: 'center' },
  wheelText: { fontSize: 20, color: colors.textTertiary, fontWeight: '600' },
  wheelTextSelected: { color: colors.textPrimary, fontWeight: '800', fontSize: 22 },
  colon: { fontSize: 22, fontWeight: '800', color: colors.textPrimary, marginHorizontal: 2 },
  meridiemCol: { marginLeft: spacing.md, gap: spacing.xs },
  meridiemBtn: {
    paddingHorizontal: spacing.md, paddingVertical: 8, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgApp,
  },
  meridiemBtnActive: { backgroundColor: colors.saffron, borderColor: colors.saffron },
  meridiemText: { fontWeight: '700', color: colors.textSecondary, fontSize: 13 },
  meridiemTextActive: { color: colors.textInverse },
  actionsRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  cancelBtn: {
    flex: 1, borderRadius: radius.button, paddingVertical: 12, alignItems: 'center',
    borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.bgApp,
  },
  cancelBtnText: { color: colors.textSecondary, fontWeight: '800', fontSize: 14 },
  confirmBtn: {
    flex: 1, borderRadius: radius.button, paddingVertical: 12, alignItems: 'center',
    backgroundColor: colors.saffron,
  },
  confirmBtnText: { color: colors.textInverse, fontWeight: '800', fontSize: 14 },
});
