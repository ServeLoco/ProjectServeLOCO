import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, spacing, typography, radius } from '../../theme';

/**
 * Play Store / App Store background-location policy requires a "prominent
 * in-app disclosure" shown BEFORE the OS permission dialog, explaining why
 * the app wants Allow-all-the-time / Always access — the permission string
 * alone does not satisfy either store's review requirement.
 *
 * Shown once (caller persists that) the first time a rider goes online,
 * before requestBackgroundPermissionsAsync() is ever called.
 */
function RiderBackgroundLocationDisclosure({ visible, onAllow, onDecline }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDecline}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Share location while online</Text>
          <Text style={styles.body}>
            VillKro uses your location — including while the app is in the
            background or your screen is locked — to match you with nearby
            orders and keep your position accurate for the delivery area
            system. This only runs while you are toggled online as a rider.
            You can turn it off anytime by going offline.
          </Text>
          <Pressable style={styles.primaryBtn} onPress={onAllow}>
            <Text style={styles.primaryBtnText}>Continue</Text>
          </Pressable>
          <Pressable style={styles.secondaryBtn} onPress={onDecline}>
            <Text style={styles.secondaryBtnText}>Not now</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: colors.bgCard,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  title: {
    ...typography.h3,
    color: colors.textPrimary,
    marginBottom: spacing.sm,
  },
  body: {
    ...typography.body,
    color: colors.textSecondary,
    marginBottom: spacing.lg,
  },
  primaryBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  primaryBtnText: {
    ...typography.button,
    color: colors.textInverse,
  },
  secondaryBtn: {
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  secondaryBtnText: {
    ...typography.body,
    color: colors.textTertiary,
  },
});

export default RiderBackgroundLocationDisclosure;
