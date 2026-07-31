import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import AppIcon from '../AppIcon';
import Button from '../Button';
import PressableScale from '../PressableScale';
import { AnimatedIllustration, STEPS } from '../LocationPermissionGate/LocationSettingsGuide';
import { colors, typography, spacing, radius } from '../../theme';

/**
 * Inline replacement for the old full-screen LocationPermissionGate — sits in
 * Home's top-center slot (same place as the "Change Location" bar / "We
 * don't deliver here yet" EmptyState) so the dashboard route itself is never
 * blocked by a separate screen.
 *
 * variant:
 *   'denied'  - permission not granted, OS dialog can still be shown
 *   'blocked' - OS won't show the dialog again, needs device Settings
 *
 * `onPickManually` — dropping a pin via ChangeLocationModal needs no OS
 * permission, offered only on the 'denied' variant (Open Settings is already
 * the primary action on 'blocked').
 */
function LocationPermissionCard({ variant, requesting, onAllow, onOpenSettings, onPickManually }) {
  const blocked = variant === 'blocked';

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      bounces={false}
    >
      {blocked ? (
        <>
          <View style={styles.darkCard}>
            <AnimatedIllustration compact />
          </View>
          <Text style={styles.title}>Enable Location in Settings</Text>
          <View style={styles.stepList}>
            {STEPS.map((step) => (
              <View key={step.number} style={styles.stepRow}>
                <View style={[styles.stepCircle, { backgroundColor: step.circleColor }]}>
                  <Text style={[styles.stepNumber, step.numberColor && { color: step.numberColor }]}>
                    {step.number}
                  </Text>
                </View>
                <Text style={styles.stepTitle}>{step.title}</Text>
              </View>
            ))}
          </View>
          <Button
            label="Open Settings"
            onPress={onOpenSettings}
            variant="highlight"
            size="md"
            fullWidth={false}
            style={styles.btn}
          />
        </>
      ) : (
        <>
          <View style={styles.iconWrap}>
            <AppIcon name="location" size={40} color={colors.saffron} strokeWidth={2.2} />
          </View>
          <Text style={styles.title}>Enable Location</Text>
          <Text style={styles.subtitle}>
            Allow location access to see shops near you in your area.
          </Text>
          <Button
            label="Allow Location"
            onPress={onAllow}
            loading={requesting}
            variant="highlight"
            size="md"
            fullWidth={false}
            style={styles.btn}
          />
        </>
      )}

      {!blocked && typeof onPickManually === 'function' ? (
        <PressableScale
          onPress={onPickManually}
          style={styles.pickManuallyBtn}
          accessibilityRole="button"
          accessibilityLabel="Pick location on map instead"
        >
          <AppIcon name="location" size={14} color={colors.textSecondary} />
          <Text style={styles.pickManuallyText}>Pick location on map instead</Text>
        </PressableScale>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    alignItems: 'center',
    // flex-start (not center): centering in the tall remaining space left a
    // big empty gap above the card before content even started.
    justifyContent: 'flex-start',
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
  },
  iconWrap: {
    width: 84,
    height: 84,
    borderRadius: radius.pill,
    backgroundColor: colors.saffronLight || colors.primaryLight || '#FFF2EB',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  darkCard: {
    width: '100%',
    maxWidth: 290,
    backgroundColor: colors.primaryDark,
    borderRadius: radius.lg,
    paddingVertical: spacing.xs,
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  title: {
    ...typography.h3,
    color: colors.textPrimary,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  subtitle: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  stepList: {
    width: '100%',
    maxWidth: 360,
    gap: 5,
    marginBottom: spacing.sm,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgSurface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 5,
    paddingHorizontal: spacing.md,
  },
  stepCircle: {
    width: 24,
    height: 24,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  stepNumber: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textInverse,
  },
  stepTitle: {
    flex: 1,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  btn: {
    paddingHorizontal: spacing.xl,
  },
  pickManuallyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  pickManuallyText: {
    ...(typography.label || {}),
    color: colors.textSecondary,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
});

export default LocationPermissionCard;
