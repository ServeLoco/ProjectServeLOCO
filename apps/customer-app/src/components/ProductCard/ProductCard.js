import React, { useRef } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, Animated } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, radius, layout } from '../../theme';
import ProductImage from '../ProductImage';
import AppIcon from '../AppIcon';

/**
 * ProductCard — "Redesign v2" (Claude Design: Product Card Redesign.dc.html)
 * Full-bleed image card:
 *   - Duotone vignette + bottom scrim for legibility
 *   - Corner-fold ribbon (not a diagonal strip) for discounts
 *   - Glass name plate with a saffron accent edge
 *   - Fixed 72x28 "pebble" buy/stepper control, dark-ink text on saffron
 *
 * Buy control never grows/shrinks the price row — same footprint in every
 * state (Buy, stepper, variant "Buy ⌄", "{n} in cart", Out).
 *
 * Props:
 *   product      - { id, name, price, unit, imageUrl, available, discountLabel }
 *   quantity     - current cart quantity
 *   onAdd        - called when Add is tapped
 *   onIncrement  - called to increase qty
 *   onDecrement  - called to decrease qty
 *   onPress      - called when card body is tapped (open detail)
 *   style        - container style
 */
// Fixed-footprint pebble control's gradient background — hoisted to module
// scope (not defined inside ProductCard's render body) so it keeps a stable
// component identity across re-renders. A component redefined inline on
// every render forces React to unmount/remount the clipped LinearGradient
// natively every time, which on Android can leave it permanently blank.
const PebbleGradient = () => (
  <LinearGradient
    colors={['#FF9A5C', '#FF7A3A', '#E05A1A']}
    locations={[0, 0.45, 1]}
    start={{ x: 0, y: 0 }}
    end={{ x: 1, y: 1 }}
    style={StyleSheet.absoluteFillObject}
  />
);

function ProductCard({
  product = {},
  name,
  price,
  originalPrice,
  unit,
  imageUrl,
  imageUri,
  available,
  disabled,
  discountLabel,
  quantity = 0,
  onAdd,
  onIncrement,
  onDecrement,
  onPress,
  style,
  compact = false,
}) {
  const resolvedName = product.name ?? name;
  const resolvedPrice = product.price ?? price;
  const resolvedOriginalPrice = product.originalPrice ?? product.original_price ?? originalPrice;
  const resolvedUnit = product.unit ?? unit;
  // Prefer server thumbnail on cards; fall back to full-size when no thumb.
  const resolvedImageUrl =
    product.thumbUrl ?? product.thumb_url ?? product.imageUrl ?? product.imageUri ?? imageUrl ?? imageUri;
  // Full-size URL for detail pre-warm (may equal card URL when no thumb).
  const fullImageUrl =
    product.imageUrl ?? product.imageUri ?? imageUrl ?? imageUri ?? null;
  const resolvedDisabled = product.disabled ?? disabled ?? false;
  const resolvedAvailable = product.available ?? available ?? product.isAvailable ?? !resolvedDisabled;
  const isShopClosed = product.shopIsOpen === false || product.shop_is_open === false || product.shopIsOpen === 0 || product.shop_is_open === 0;
  // Shop-closed and out-of-stock are collapsed into one "unavailable" state —
  // no separate label/behavior per cause, so the customer sees one
  // unambiguous signal regardless of why the item can't be bought.
  const isUnavailable = !resolvedAvailable || isShopClosed;

  // Multi-variant products (e.g. pizza sizes, burger types) show the plain
  // lowest variant price and open the VariantSheet on tap instead of a bare
  // +/- stepper — a "+" can't know which variant to increment.
  const resolvedVariants = product.variants ?? [];
  const isMultiVariant = resolvedVariants.length > 1;
  const displayPrice = Math.floor(Number(
    isMultiVariant ? (product.minPrice ?? product.min_price ?? resolvedPrice) : resolvedPrice
  ));

  const pressAnim = useRef(new Animated.Value(0)).current;

  const discountPct = resolvedOriginalPrice && Number(resolvedOriginalPrice) > Number(resolvedPrice)
    ? Math.round(((Number(resolvedOriginalPrice) - Number(resolvedPrice)) / Number(resolvedOriginalPrice)) * 100)
    : 0;

  const resolvedDiscountLabel = product.discountLabel ?? discountLabel ?? (discountPct > 0 ? `${discountPct}% OFF` : null);

  const handlePressIn = () => {
    // Warm full-size image into expo-image cache before navigation/detail paint.
    if (fullImageUrl && typeof fullImageUrl === 'string') {
      ExpoImage.prefetch(fullImageUrl).catch(() => {});
    }
    Animated.spring(pressAnim, {
      toValue: 1,
      friction: 6,
      tension: 120,
      useNativeDriver: true,
    }).start();
  };
  const handlePressOut = () => {
    Animated.spring(pressAnim, {
      toValue: 0,
      friction: 6,
      tension: 120,
      useNativeDriver: true,
    }).start();
  };

  const cardScale = pressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0.97],
  });

  const pebbleStyle = [styles.pebble, compact && styles.pebbleCompact];
  const stepBtnStyle = [styles.stepBtn, compact && styles.stepBtnCompact];
  const pebbleLabelStyle = [styles.pebbleLabel, compact && styles.pebbleLabelCompact];
  const stepGlyphStyle = [styles.stepGlyph, compact && styles.stepGlyphCompact];
  const stepQtyStyle = [styles.stepQty, compact && styles.stepQtyCompact];
  const iconSize = compact ? 10 : 12;

  const renderControl = () => {
    if (isUnavailable) {
      return (
        <View key="unavailable" style={[styles.outPill, compact && styles.outPillCompact]}>
          <Text style={[styles.outText, compact && styles.outTextCompact]}>Unavailable</Text>
        </View>
      );
    }

    if (isMultiVariant) {
      if (quantity > 0) {
        return (
          <TouchableOpacity
            key="in-cart"
            onPress={onAdd}
            activeOpacity={0.8}
            style={[styles.inCartPill, compact && styles.inCartPillCompact]}
            accessibilityRole="button"
            accessibilityLabel={`${quantity} in cart. Tap to change ${resolvedName} options`}
          >
            <Text style={[styles.inCartText, compact && styles.inCartTextCompact]} numberOfLines={1}>{quantity} in cart</Text>
          </TouchableOpacity>
        );
      }
      return (
        <TouchableOpacity
          key="buy-variant"
          onPress={onAdd}
          activeOpacity={0.8}
          style={pebbleStyle}
          collapsable={false}
          accessibilityRole="button"
          accessibilityLabel={`Choose options for ${resolvedName}`}
        >
          <PebbleGradient />
          <Text style={pebbleLabelStyle}>Select</Text>
          <AppIcon name="down" size={compact ? 9 : 11} color="#1A0D05" strokeWidth={3} />
        </TouchableOpacity>
      );
    }

    if (quantity > 0) {
      return (
        <View key="stepper" style={pebbleStyle} collapsable={false}>
          <PebbleGradient />
          <TouchableOpacity
            onPress={onDecrement}
            activeOpacity={0.7}
            style={stepBtnStyle}
            accessibilityRole="button"
            accessibilityLabel="Decrease quantity"
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
          >
            <Text style={stepGlyphStyle}>−</Text>
          </TouchableOpacity>
          <Text style={stepQtyStyle}>{quantity}</Text>
          <TouchableOpacity
            onPress={onIncrement}
            activeOpacity={0.7}
            style={stepBtnStyle}
            accessibilityRole="button"
            accessibilityLabel="Increase quantity"
            hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
          >
            <Text style={stepGlyphStyle}>+</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <TouchableOpacity
        key="buy"
        onPress={onAdd}
        activeOpacity={0.8}
        style={pebbleStyle}
        collapsable={false}
        accessibilityRole="button"
        accessibilityLabel={`Add ${resolvedName} to cart`}
      >
        <PebbleGradient />
        <AppIcon name="add" size={iconSize} color="#1A0D05" strokeWidth={3} />
        <Text style={pebbleLabelStyle}>Buy</Text>
      </TouchableOpacity>
    );
  };

  return (
    <Animated.View style={[styles.card, compact && styles.cardCompact, style, { transform: [{ scale: cardScale }] }]}>
      <TouchableOpacity
        activeOpacity={1}
        onPress={isUnavailable ? null : onPress}
        onPressIn={isUnavailable ? null : handlePressIn}
        onPressOut={isUnavailable ? null : handlePressOut}
        disabled={isUnavailable}
        style={styles.touchable}
        accessibilityRole="button"
        accessibilityLabel={resolvedName}
        accessibilityState={{ disabled: isUnavailable }}
      >
        <View style={[styles.cardInner, compact && styles.cardInnerCompact]}>
          {/* Full-bleed image — grayscale when the product's shop is closed */}
          <ProductImage
            uri={resolvedImageUrl}
            width="100%"
            height="100%"
            resizeMode="cover"
            priority="high"
            filter={isUnavailable ? [{ grayscale: 1 }] : undefined}
            recyclingKey={product?.id != null ? String(product.id) : undefined}
          />

          {/* Closed-shop / product-off white wash (reinforces muted look, esp. on iOS) */}
          {isUnavailable ? (
            <View style={styles.closedWash} pointerEvents="none">
              <View style={styles.closedWashInner} />
            </View>
          ) : null}

          {/* Single unavailable label — centered horizontally, just above vertical center */}
          {isUnavailable ? (
            <View style={styles.shopClosedLabel} pointerEvents="none">
              <Text style={styles.shopClosedText}>Item Unavailable</Text>
            </View>
          ) : null}

          {/* Duotone vignette — darkens the top corners slightly */}
          <LinearGradient
            colors={['rgba(10,8,6,0.22)', 'rgba(10,8,6,0)']}
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 0.35 }}
            pointerEvents="none"
            style={StyleSheet.absoluteFillObject}
          />

          {/* Bottom scrim for white text legibility */}
          <LinearGradient
            colors={['rgba(10,8,6,0)', 'rgba(10,8,6,0.86)']}
            pointerEvents="none"
            style={styles.bottomScrim}
          />

          {/* Unit badge (top-left) */}
          {resolvedUnit ? (
            <View style={[styles.unitBadge, compact && styles.unitBadgeCompact]}>
              <Text style={[styles.unitBadgeText, compact && styles.unitBadgeTextCompact]} numberOfLines={1}>
                {resolvedUnit}
              </Text>
            </View>
          ) : null}

          {/* Corner-fold discount ribbon (top-right) */}
          {resolvedDiscountLabel && !isUnavailable ? (
            <View style={[styles.ribbonMask, compact && styles.ribbonMaskCompact]} pointerEvents="none">
              <LinearGradient
                colors={['#34D399', '#0F9D63']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={[styles.ribbonStrip, compact && styles.ribbonStripCompact]}
              >
                <Text style={[styles.ribbonText, compact && styles.ribbonTextCompact]} numberOfLines={1}>
                  {resolvedDiscountLabel}
                </Text>
              </LinearGradient>
            </View>
          ) : null}

          {/* Bottom stack: glass name plate, then price + control row */}
          <View style={[styles.bottomStrip, compact && styles.bottomStripCompact]}>
            <View style={[styles.namePlate, compact && styles.namePlateCompact]}>
              <View style={styles.namePlateEdge} />
              <Text style={[styles.name, compact && styles.nameCompact]} numberOfLines={2}>
                {resolvedName}
              </Text>
            </View>

            <View style={styles.priceActionRow}>
              <View style={styles.priceBlock}>
                {isMultiVariant ? (
                  <Text style={[styles.fromPrefix, compact && styles.fromPrefixCompact]}>from</Text>
                ) : null}
                <Text style={[styles.price, compact && styles.priceCompact]} numberOfLines={1}>
                  ₹{displayPrice}
                </Text>
                {!isMultiVariant && resolvedOriginalPrice ? (
                  <Text style={[styles.originalPrice, compact && styles.originalPriceCompact]} numberOfLines={1}>
                    ₹{Math.floor(Number(resolvedOriginalPrice))}
                  </Text>
                ) : null}
              </View>

              <View style={styles.bottomRight}>
                {renderControl()}
              </View>
            </View>
          </View>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // ----- Card container -----
  card: {
    width: layout.productCardWidth,
    backgroundColor: colors.bgSurface,
    borderRadius: radius.xl,
    shadowColor: '#B8860B',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.32,
    shadowRadius: 14,
    elevation: 6,
    borderWidth: 1,
    borderColor: '#E6B800',
  },
  cardCompact: {
    width: '100%',
  },

  // Touchable wraps the inner card to handle press feedback
  touchable: {
    width: '100%',
  },

  // Inner aspect-ratio wrapper
  cardInner: {
    width: '100%',
    aspectRatio: 0.78,
    backgroundColor: colors.bgSkeletonBase,
    borderRadius: radius.xl,
    overflow: 'hidden',
    position: 'relative',
  },
  cardInnerCompact: {
    aspectRatio: 0.82,
  },

  // Closed-shop / product-off muted overlay + centered label
  closedWash: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closedWashInner: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255,255,255,0.45)',
  },
  shopClosedLabel: {
    position: 'absolute',
    top: '38%',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  shopClosedText: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    color: '#1A0D05',
    fontSize: 13,
    fontWeight: '700',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radius.md,
    overflow: 'hidden',
    textAlign: 'center',
  },

  // Bottom dark gradient strip — white text overlay
  bottomScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '46%',
  },

  // Unit badge (top-left)
  unitBadge: {
    position: 'absolute',
    top: 9,
    left: 9,
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(8,8,10,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    zIndex: 10,
  },
  unitBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: 0.2,
  },
  unitBadgeCompact: {
    top: 6,
    left: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  unitBadgeTextCompact: {
    fontSize: 9,
  },

  // Corner-fold ribbon — a 54x54 clipped corner with a rotated strip inside,
  // instead of a diagonal strip bleeding off the card edge.
  ribbonMask: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 54,
    height: 54,
    overflow: 'hidden',
    zIndex: 10,
  },
  ribbonStrip: {
    position: 'absolute',
    top: 10,
    right: -16,
    width: 78,
    paddingVertical: 3,
    transform: [{ rotate: '45deg' }],
    alignItems: 'center',
  },
  ribbonText: {
    color: '#05130C',
    fontSize: 8.5,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  ribbonMaskCompact: {
    width: 42,
    height: 42,
  },
  ribbonStripCompact: {
    top: 7,
    right: -14,
    width: 62,
    paddingVertical: 2,
  },
  ribbonTextCompact: {
    fontSize: 7,
  },

  // Bottom strip content
  bottomStrip: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 9,
    paddingBottom: 9,
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: 7,
    zIndex: 5,
  },
  bottomStripCompact: {
    paddingHorizontal: 6,
    paddingBottom: 6,
    gap: 5,
  },

  // Glass name plate — frosted-look panel (approximated, no real blur) with
  // a saffron accent edge, distinct from the unit badge's plain pill.
  namePlate: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    backgroundColor: 'rgba(30,26,22,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    borderRadius: radius.md,
    paddingVertical: 5,
    paddingRight: 9,
    paddingLeft: 12,
    position: 'relative',
    overflow: 'hidden',
  },
  namePlateEdge: {
    position: 'absolute',
    left: 0,
    top: 4,
    bottom: 4,
    width: 2.5,
    borderRadius: 2,
    backgroundColor: colors.saffron,
  },
  name: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 12,
    lineHeight: 15,
    letterSpacing: -0.1,
  },
  namePlateCompact: {
    paddingVertical: 4,
    paddingRight: 7,
    paddingLeft: 10,
  },
  nameCompact: {
    fontSize: 11,
    lineHeight: 14,
  },

  priceActionRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 6,
  },
  priceBlock: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: 4,
  },
  fromPrefix: {
    fontSize: 9,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.92)',
  },
  fromPrefixCompact: {
    fontSize: 8,
  },
  price: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 16,
    letterSpacing: -0.3,
  },
  priceCompact: {
    fontSize: 13,
  },
  originalPrice: {
    color: 'rgba(255,255,255,0.42)',
    textDecorationLine: 'line-through',
    fontSize: 11,
    fontWeight: '600',
  },
  originalPriceCompact: {
    fontSize: 9.5,
  },
  bottomRight: {
    flexShrink: 0,
    alignItems: 'flex-end',
  },

  // Pebble control — fixed 72x28 footprint shared by Buy/stepper/variant,
  // dark-ink text on the saffron gradient (never full-width, never flex:1).
  pebble: {
    width: 72,
    height: 28,
    borderRadius: radius.pill,
    overflow: 'hidden',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    shadowColor: '#E05A1A',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 3,
  },
  pebbleCompact: {
    width: 58,
    height: 24,
  },
  pebbleLabel: {
    color: '#1A0D05',
    fontSize: 11,
    fontWeight: '700',
  },
  pebbleLabelCompact: {
    fontSize: 10,
  },
  stepBtn: {
    width: 22,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBtnCompact: {
    width: 18,
    height: 24,
  },
  stepGlyph: {
    color: '#1A0D05',
    fontSize: 14,
    fontWeight: '800',
  },
  stepGlyphCompact: {
    fontSize: 12,
  },
  stepQty: {
    flex: 1,
    textAlign: 'center',
    color: '#1A0D05',
    fontSize: 12,
    fontWeight: '700',
  },
  stepQtyCompact: {
    fontSize: 10.5,
  },

  // "{n} in cart" — inverted glass pill for multi-variant products
  inCartPill: {
    width: 72,
    height: 28,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1.5,
    borderColor: colors.saffron,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  inCartPillCompact: {
    width: 58,
    height: 24,
  },
  inCartText: {
    color: '#FFAB7A',
    fontSize: 9.5,
    fontWeight: '700',
    textAlign: 'center',
  },
  inCartTextCompact: {
    fontSize: 8.5,
  },

  // Out-of-stock pill — fixed footprint, no handlers
  outPill: {
    width: 72,
    height: 28,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  outPillCompact: {
    width: 58,
    height: 24,
  },
  outText: {
    color: 'rgba(243,241,236,0.55)',
    fontSize: 11,
    fontWeight: '700',
  },
  outTextCompact: {
    fontSize: 10,
  },
});

export default React.memo(ProductCard);
