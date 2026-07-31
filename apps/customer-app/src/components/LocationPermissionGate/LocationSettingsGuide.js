import React, { useEffect, useRef } from 'react';
import { Animated, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AppIcon from '../AppIcon';
import PressableScale from '../PressableScale';
import { colors, spacing, radius } from '../../theme';

const STEPS = [
  {
    circleColor: colors.saffron,
    number: '1',
    title: "Tap 'Open Settings' below",
  },
  {
    circleColor: colors.saffronDark,
    number: '2',
    title: "Go to 'Permissions'",
  },
  {
    circleColor: colors.primary,
    number: '3',
    title: "Select 'Location'",
  },
  {
    circleColor: colors.border,
    numberColor: colors.textPrimary,
    number: '4',
    title: "Choose 'Allow While Using App'",
  },
];

// Animation timing for the looping illustration below.
const STAGE_HOLD_MS = 1500;
const FADE_MS = 300;
const STAGE_COUNT = 4;

/**
 * Looping illustration cycling App info -> Permissions -> Location dialog ->
 * Success, echoing the reference mock's animated walkthrough but built with
 * Animated (no static image) and the app's own saffron accent — the
 * reference was for layout/flow only, not its color palette.
 *
 * `compact`: real (not transform-scaled) smaller sizing for the inline Home
 * card — a CSS transform+overflow:hidden clip was tried first but RN doesn't
 * clip a transformed child to the parent's pre-transform layout box reliably,
 * so this renders genuinely smaller elements instead.
 */
function AnimatedIllustration({ compact = false }) {
  const s = compact ? compactStyles : styles;
  const iconSize = compact
    ? { app: 21, location: 15, pin: 19, check: 26 }
    : { app: 22, location: 16, pin: 20, check: 28 };
  const stageOpacities = useRef(STEPS.map((_, i) => new Animated.Value(i === 0 ? 1 : 0))).current;
  const pulse = useRef(new Animated.Value(1)).current;
  const checkScale = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    let cancelled = false;
    let holdTimeout;
    let pulseLoop;

    const runStage = (index) => {
      if (cancelled) return;
      Animated.parallel(
        stageOpacities.map((v, i) =>
          Animated.timing(v, {
            toValue: i === index ? 1 : 0,
            duration: FADE_MS,
            useNativeDriver: true,
          }),
        ),
      ).start();

      if (index < STAGE_COUNT - 1) {
        pulse.setValue(1);
        pulseLoop = Animated.loop(
          Animated.sequence([
            Animated.timing(pulse, { toValue: 1.08, duration: 380, useNativeDriver: true }),
            Animated.timing(pulse, { toValue: 1, duration: 380, useNativeDriver: true }),
          ]),
          { iterations: 2 },
        );
        pulseLoop.start();
      } else {
        checkScale.setValue(0.6);
        Animated.spring(checkScale, {
          toValue: 1,
          friction: 5,
          tension: 120,
          useNativeDriver: true,
        }).start();
      }

      holdTimeout = setTimeout(() => runStage((index + 1) % STAGE_COUNT), STAGE_HOLD_MS);
    };

    runStage(0);

    return () => {
      cancelled = true;
      clearTimeout(holdTimeout);
      pulseLoop?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={s.illustrationBox}>
      {/* Stage 0: App info */}
      <Animated.View style={[s.stageLayer, { opacity: stageOpacities[0] }]}>
        <View style={s.appIconBox}>
          <AppIcon name="shoppingBag" size={iconSize.app} color={colors.saffron} strokeWidth={2} />
        </View>
        <Text style={s.appName}>VillKro</Text>
        <Animated.View style={[s.mockRow, { transform: [{ scale: pulse }] }]}>
          <Text style={s.mockRowText}>Permissions</Text>
          <AppIcon name="chevronRight" size={iconSize.location} color={colors.textTertiary} />
        </Animated.View>
      </Animated.View>

      {/* Stage 1: Permissions list */}
      <Animated.View style={[s.stageLayer, { opacity: stageOpacities[1] }]}>
        <Text style={s.mockSectionLabel}>NOT ALLOWED</Text>
        <Animated.View style={[s.mockRow, s.mockRowHighlight, { transform: [{ scale: pulse }] }]}>
          <AppIcon name="location" size={iconSize.location} color={colors.saffronDark} />
          <Text style={s.mockRowText}>Location</Text>
        </Animated.View>
      </Animated.View>

      {/* Stage 2: system permission dialog */}
      <Animated.View style={[s.stageLayer, { opacity: stageOpacities[2] }]}>
        <View style={s.pinWrap}>
          <AppIcon name="location" size={iconSize.pin} color={colors.saffron} strokeWidth={2.2} />
        </View>
        <Text style={s.dialogText}>
          Allow VillKro to access{'\n'}this device's location?
        </Text>
        <Animated.View style={[s.dialogBtnPrimary, { transform: [{ scale: pulse }] }]}>
          <Text style={s.dialogBtnPrimaryText}>While using the app</Text>
        </Animated.View>
        <Text style={s.dialogBtnGhostText}>Only this time</Text>
      </Animated.View>

      {/* Stage 3: success */}
      <Animated.View style={[s.stageLayer, { opacity: stageOpacities[3] }]}>
        <Animated.View style={[s.successCircle, { transform: [{ scale: checkScale }] }]}>
          <AppIcon name="check" size={iconSize.check} color={colors.textInverse} strokeWidth={3} />
        </Animated.View>
        <Text style={s.successText}>Location enabled!</Text>
      </Animated.View>
    </View>
  );
}

/**
 * Step-by-step "how to enable location in Settings" screen — shown after the
 * OS permission dialog has been permanently denied (canAskAgain === false),
 * so the system dialog itself won't come back and the only path forward is
 * the device Settings app. Layout follows the reference mock; colors are the
 * app's own theme.
 *
 * Props:
 *   onBack        - back arrow in the header (returns to the plain Allow view)
 *   onOpenSettings - primary CTA, opens the OS app-settings page
 */
export { AnimatedIllustration, STEPS };

function LocationSettingsGuide({ onBack, onOpenSettings }) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <PressableScale
          onPress={onBack}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <AppIcon name="back" size={20} color={colors.textPrimary} />
        </PressableScale>
        <Text style={styles.headerTitle}>Enable Location</Text>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: 88 + insets.bottom }]}
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        <View style={styles.darkCard}>
          <AnimatedIllustration />
          <Text style={styles.darkCaption}>How to enable location permissions</Text>
        </View>

        <Text style={styles.sectionTitle}>Step-by-step Guide</Text>
        <View style={styles.stepList}>
          {STEPS.map((step) => (
            <View key={step.number} style={styles.stepRow}>
              <View style={[styles.stepCircle, { backgroundColor: step.circleColor }]}>
                <Text style={[styles.stepNumber, step.numberColor && { color: step.numberColor }]}>
                  {step.number}
                </Text>
              </View>
              <View style={styles.stepTextCol}>
                <Text style={styles.stepTitle}>{step.title}</Text>
              </View>
            </View>
          ))}
        </View>

        <View style={styles.privacyCard}>
          <AppIcon name="lock" size={20} color={colors.saffronDark} strokeWidth={2.2} />
          <View style={styles.privacyTextCol}>
            <Text style={styles.privacyTitle}>Privacy Guaranteed</Text>
            <Text style={styles.privacySubtitle}>
              We only use your location to find nearby services and optimize your route.
            </Text>
          </View>
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
        <PressableScale
          style={styles.footerBtn}
          onPress={onOpenSettings}
          scaleTo={0.98}
          accessibilityRole="button"
          accessibilityLabel="Open Settings"
        >
          <Text style={styles.footerBtnText}>Open Settings</Text>
        </PressableScale>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bgApp,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 52,
    paddingHorizontal: spacing.md,
  },
  backBtn: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  headerTitle: {
    fontSize: 19,
    lineHeight: 24,
    fontWeight: '700',
    letterSpacing: -0.2,
    color: colors.textPrimary,
  },
  content: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },
  darkCard: {
    backgroundColor: colors.primaryDark,
    borderRadius: radius.lg,
    padding: spacing.md,
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  illustrationBox: {
    width: '100%',
    maxWidth: 240,
    minHeight: 180,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stageLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  appIconBox: {
    width: 48,
    height: 48,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  appName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#E6E1E5',
    marginBottom: spacing.md,
  },
  mockSectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.4,
    color: colors.saffron,
    marginBottom: spacing.sm,
  },
  mockRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: radius.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    minWidth: 175,
  },
  mockRowHighlight: {
    backgroundColor: 'rgba(255,122,58,0.18)',
  },
  mockRowText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#E6E1E5',
  },
  pinWrap: {
    width: 38,
    height: 38,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,122,58,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  dialogText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '500',
    color: '#E6E1E5',
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  dialogBtnPrimary: {
    minWidth: 195,
    height: 42,
    borderRadius: radius.pill,
    backgroundColor: colors.saffron,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  dialogBtnPrimaryText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textInverse,
  },
  dialogBtnGhostText: {
    fontSize: 13,
    color: '#E6E1E5',
  },
  successCircle: {
    width: 58,
    height: 58,
    borderRadius: radius.pill,
    backgroundColor: colors.success,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  successText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#E6E1E5',
  },
  darkCaption: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '500',
    color: colors.textTertiary,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
  sectionTitle: {
    fontSize: 19,
    lineHeight: 24,
    fontWeight: '700',
    letterSpacing: -0.2,
    color: colors.textPrimary,
    marginBottom: spacing.sm,
  },
  stepList: {
    gap: spacing.sm,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgSurface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  stepCircle: {
    width: 30,
    height: 30,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  stepNumber: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textInverse,
  },
  stepTextCol: {
    flex: 1,
    minWidth: 0,
  },
  stepTitle: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  privacyCard: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.saffronLight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  privacyTextCol: {
    flex: 1,
    minWidth: 0,
  },
  privacyTitle: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '700',
    letterSpacing: 0.3,
    color: colors.saffronDark,
  },
  privacySubtitle: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '500',
    color: colors.textSecondary,
    marginTop: 1,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    backgroundColor: colors.bgApp,
  },
  footerBtn: {
    width: '100%',
    height: 52,
    borderRadius: radius.pill,
    backgroundColor: colors.saffron,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footerBtnText: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '700',
    color: colors.textInverse,
  },
});

// Same stage markup as `styles`, real (not transform-scaled) smaller
// sizing — used when AnimatedIllustration is rendered `compact` inside
// Home's inline LocationPermissionCard instead of the full-screen guide.
const compactStyles = StyleSheet.create({
  illustrationBox: {
    width: '100%',
    maxWidth: 260,
    minHeight: 150,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stageLayer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  appIconBox: {
    width: 46,
    height: 46,
    borderRadius: radius.lg,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  appName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#E6E1E5',
    marginBottom: spacing.sm,
  },
  mockSectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.4,
    color: colors.saffron,
    marginBottom: spacing.xs,
  },
  mockRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: radius.pill,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    minWidth: 190,
  },
  mockRowHighlight: {
    backgroundColor: 'rgba(255,122,58,0.18)',
  },
  mockRowText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#E6E1E5',
  },
  pinWrap: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,122,58,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  dialogText: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '500',
    color: '#E6E1E5',
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  dialogBtnPrimary: {
    minWidth: 200,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.saffron,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  dialogBtnPrimaryText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textInverse,
  },
  dialogBtnGhostText: {
    fontSize: 13,
    color: '#E6E1E5',
  },
  successCircle: {
    width: 54,
    height: 54,
    borderRadius: radius.pill,
    backgroundColor: colors.success,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  successText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#E6E1E5',
  },
});

export default LocationSettingsGuide;
