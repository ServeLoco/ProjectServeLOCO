import React, { useEffect, useRef } from 'react';
import { StyleSheet, Text, View, Animated, Easing } from 'react-native';
import { Image } from 'expo-image';
import { colors, typography, spacing } from '../../theme';
import { useReducedMotion } from '../../utils';
import AppIcon from '../AppIcon';
import PressableScale from '../PressableScale';

// Per-mode circle color + icon. Falls back to a rotating palette for any
// admin-added mode slug not covered here (store_modes supports up to 5).
const MODE_STYLE = {
  packed: { icon: 'home', color: '#FF6B6B' },
  house: { icon: 'home', color: '#FF6B6B' },
  fast_food: { icon: 'burger', color: '#FFD93D', iconColor: '#7D2D00' },
  sweets: { icon: 'cake', color: '#FF85B3' },
};
const FALLBACK_PALETTE = ['#FF6B6B', '#FFD93D', '#FF85B3', '#7FD1AE', '#8AB4FF'];
const resolveModeStyle = (slug, idx) =>
  MODE_STYLE[slug] || { icon: 'box', color: FALLBACK_PALETTE[idx % FALLBACK_PALETTE.length] };

const BOUNCE_DISTANCE = -12;
const BOUNCE_DURATION = 2000;
// cubic-bezier(0.34, 1.56, 0.64, 1) — the "juicy" overshoot spec.
const BOUNCE_EASING = Easing.bezier(0.34, 1.56, 0.64, 1);

/**
 * SegmentedControl (Bouncing Mode Dock)
 * N-option (2-5) mode switcher styled as a row of bouncing icon circles —
 * built to be impossible to miss on a busy dashboard.
 *   - Every circle bounces in an infinite loop, staggered per index
 *   - Active option is larger, glowing, with a double pulsing ring
 *   - Tap gives a punch-scale pop in addition to the selection change
 *   - Bounce loop is skipped entirely under reduced-motion
 *
 * Props: same contract as before — options, value/selectedOption,
 * onChange/onSelect, renderLabel, style, disabled.
 * renderIconUrl(option) - optional, returns an admin-uploaded image URL for
 * the circle; falls back to the built-in lucide icon (MODE_STYLE) when unset.
 */
function SegmentedControl({
  options = [],
  value,
  selectedOption,
  onChange,
  onSelect,
  renderLabel,
  renderIconUrl,
  style,
  disabled,
}) {
  const reducedMotion = useReducedMotion();
  if (!options || options.length < 2 || options.length > 5) return null;
  const activeValue = value ?? selectedOption;
  const handleChange = onChange || onSelect;
  const activeIndex = Math.max(0, options.indexOf(activeValue));

  // Options can grow after mount (store modes load async), so top up the refs
  // instead of capturing a fixed-length array on first render.
  const bounceRef = useRef([]);
  const punchRef = useRef([]);
  const ringARef = useRef([]);
  const ringBRef = useRef([]);
  while (bounceRef.current.length < options.length) {
    bounceRef.current.push(new Animated.Value(0));
    punchRef.current.push(new Animated.Value(1));
    ringARef.current.push(new Animated.Value(0));
    ringBRef.current.push(new Animated.Value(0));
  }

  // Only the active circle bounces — keeps the row calm and draws the eye to
  // the current selection instead of jittering the whole row.
  useEffect(() => {
    bounceRef.current.forEach((v, idx) => {
      if (idx !== activeIndex) v.setValue(0);
    });
    if (reducedMotion) return undefined;
    const anim = bounceRef.current[activeIndex];
    if (!anim) return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, {
          toValue: 1,
          duration: BOUNCE_DURATION / 2,
          easing: BOUNCE_EASING,
          useNativeDriver: true,
        }),
        Animated.timing(anim, {
          toValue: 0,
          duration: BOUNCE_DURATION / 2,
          easing: BOUNCE_EASING,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [activeIndex, reducedMotion]);

  // Pulsing double ring around the active circle.
  useEffect(() => {
    if (reducedMotion) return undefined;
    const ringA = ringARef.current[activeIndex];
    const ringB = ringBRef.current[activeIndex];
    if (!ringA || !ringB) return undefined;
    ringA.setValue(0);
    ringB.setValue(0.5);
    const loopA = Animated.loop(
      Animated.sequence([
        Animated.timing(ringA, { toValue: 1, duration: 1400, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(ringA, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    const loopB = Animated.loop(
      Animated.sequence([
        Animated.timing(ringB, { toValue: 1, duration: 1400, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(ringB, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    loopA.start();
    loopB.start();
    return () => {
      loopA.stop();
      loopB.stop();
    };
  }, [activeIndex, reducedMotion]);

  const handlePress = (opt, idx) => {
    if (disabled) return;
    const punch = punchRef.current[idx];
    if (!reducedMotion) {
      punch.setValue(1);
      Animated.sequence([
        Animated.spring(punch, { toValue: 1.08, friction: 5, tension: 260, useNativeDriver: true }),
        Animated.spring(punch, { toValue: 1, friction: 5, tension: 220, useNativeDriver: true }),
      ]).start();
    }
    handleChange && handleChange(opt);
  };

  return (
    <View style={[styles.card, style, disabled && styles.disabledCard]}>
      {options.map((opt, idx) => {
        const isActive = idx === activeIndex;
        const modeStyle = resolveModeStyle(opt, idx);
        const iconUrl = renderIconUrl ? renderIconUrl(opt) : null;
        const size = isActive ? 76 : 58;
        const bounceY = bounceRef.current[idx].interpolate({
          inputRange: [0, 1],
          outputRange: [0, BOUNCE_DISTANCE],
        });
        return (
          <View key={opt} style={styles.item}>
            <View style={styles.circleWrap}>
              {isActive && !reducedMotion ? (
                <>
                  <Animated.View
                    pointerEvents="none"
                    style={[
                      styles.ring,
                      styles.ringOuter,
                      {
                        opacity: ringARef.current[idx].interpolate({ inputRange: [0, 1], outputRange: [0.3, 0] }),
                        transform: [{ scale: ringARef.current[idx].interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] }) }],
                      },
                    ]}
                  />
                  <Animated.View
                    pointerEvents="none"
                    style={[
                      styles.ring,
                      styles.ringInner,
                      {
                        opacity: ringBRef.current[idx].interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
                        transform: [{ scale: ringBRef.current[idx].interpolate({ inputRange: [0, 1], outputRange: [1, 1.2] }) }],
                      },
                    ]}
                  />
                </>
              ) : null}
              <PressableScale
                onPress={() => handlePress(opt, idx)}
                disabled={disabled}
                scaleTo={0.94}
                accessibilityRole="button"
                accessibilityState={{ selected: isActive, disabled: Boolean(disabled) }}
                accessibilityLabel={renderLabel ? renderLabel(opt) : opt}
              >
                <Animated.View
                  style={[
                    styles.circle,
                    {
                      width: size,
                      height: size,
                      borderRadius: size / 2,
                      backgroundColor: iconUrl ? '#FFFFFF' : modeStyle.color,
                      transform: [
                        { translateY: bounceY },
                        { scale: punchRef.current[idx] },
                      ],
                    },
                    isActive && styles.circleActive,
                  ]}
                >
                  {iconUrl ? (
                    <Image
                      source={{ uri: iconUrl }}
                      style={{ width: size, height: size, borderRadius: size / 2 }}
                      contentFit="cover"
                    />
                  ) : (
                    <AppIcon
                      name={modeStyle.icon}
                      size={isActive ? 32 : 24}
                      color={modeStyle.iconColor || '#FFFFFF'}
                      strokeWidth={2.2}
                    />
                  )}
                </Animated.View>
              </PressableScale>
            </View>
            <Text
              style={[
                styles.label,
                isActive && styles.activeLabel,
                disabled && styles.disabledLabel,
              ]}
              numberOfLines={1}
            >
              {renderLabel ? renderLabel(opt) : opt}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: spacing.lg,
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderRadius: 28,
    borderWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.9)',
    borderLeftColor: 'rgba(255,255,255,0.9)',
    borderRightColor: 'rgba(0,0,0,0.05)',
    borderBottomColor: 'rgba(0,0,0,0.08)',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    shadowColor: '#7A2400',
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.22,
    shadowRadius: 28,
    elevation: 14,
  },
  disabledCard: {
    opacity: 0.6,
  },
  item: {
    alignItems: 'center',
    gap: spacing.xs + 2,
  },
  circleWrap: {
    width: 80,
    height: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: '#FFD93D',
    borderRadius: 999,
  },
  ringOuter: {
    width: 96,
    height: 96,
  },
  ringInner: {
    width: 88,
    height: 88,
  },
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 4,
  },
  circleActive: {
    shadowOpacity: 0.28,
    shadowRadius: 14,
    elevation: 8,
  },
  label: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '700',
    fontSize: 12,
    letterSpacing: 0.3,
  },
  activeLabel: {
    color: colors.saffronDark || colors.primary,
    fontWeight: '800',
    fontSize: 14,
    letterSpacing: 0.4,
    textShadowColor: 'rgba(255, 122, 58, 0.35)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 6,
  },
  disabledLabel: {
    color: colors.textDisabled,
  },
});

export default SegmentedControl;
