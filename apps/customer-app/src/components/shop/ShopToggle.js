import React, { useEffect, useRef } from 'react';
import { Animated, TouchableOpacity, StyleSheet } from 'react-native';
import { colors, radius, shadows, motion, motionConfig } from '../../theme';

/**
 * ShopToggle
 * Custom animated pill toggle used across the shop-owner screens
 * (shop status, group active, product available). Replaces the native
 * Switch so the motion + color feel is consistent and on-brand.
 *
 * Props:
 *   value        boolean   on/off state
 *   onValueChange fn(value) toggled callback
 *   activeColor  string    track color when ON (defaults to success green)
 *   disabled     boolean
 *   size         'sm'|'md'|'lg' visual size
 */
const SIZES = {
  sm: { w: 38, h: 22, thumb: 16, pad: 3 },
  md: { w: 46, h: 28, thumb: 22, pad: 3 },
  lg: { w: 56, h: 32, thumb: 26, pad: 3 },
};

export default function ShopToggle({
  value,
  onValueChange,
  activeColor = colors.success,
  disabled = false,
  size = 'lg',
  accessibilityLabel,
}) {
  const dims = SIZES[size] || SIZES.lg;
  const anim = useRef(new Animated.Value(value ? 1 : 0)).current;
  const press = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: value ? 1 : 0,
      duration: motion.smallMs,
      easing: motion.easingModal,
      useNativeDriver: false,
    }).start();
  }, [value, anim]);

  const travel = dims.w - dims.thumb - dims.pad * 2;
  const translateX = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [dims.pad, dims.pad + travel],
  });
  const trackColor = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [colors.grey100, activeColor],
  });

  const handlePressIn = () => {
    if (disabled) return;
    Animated.timing(press, { toValue: 0.92, ...motionConfig.tap }).start();
  };
  const handlePressOut = () => {
    Animated.timing(press, { toValue: 1, ...motionConfig.tap }).start();
  };

  return (
    <TouchableOpacity
      activeOpacity={1}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={() => !disabled && onValueChange && onValueChange(!value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={accessibilityLabel}
      style={{ opacity: disabled ? 0.5 : 1 }}
    >
      <Animated.View style={{ transform: [{ scale: press }] }}>
        <Animated.View
          style={[
            styles.track,
            {
              width: dims.w,
              height: dims.h,
              borderRadius: radius.pill,
              backgroundColor: trackColor,
            },
          ]}
        >
          <Animated.View
            style={[
              styles.thumb,
              {
                width: dims.thumb,
                height: dims.thumb,
                borderRadius: radius.circle,
                transform: [{ translateX }],
              },
            ]}
          />
        </Animated.View>
      </Animated.View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  track: {
    justifyContent: 'center',
    ...shadows.xs,
  },
  thumb: {
    backgroundColor: colors.white,
    ...shadows.sm,
  },
});
