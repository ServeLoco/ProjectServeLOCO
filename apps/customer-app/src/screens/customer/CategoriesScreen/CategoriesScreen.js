import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Animated,
  TouchableOpacity,
  LayoutAnimation,
  RefreshControl,
  useWindowDimensions,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import {
  AppScreen,
  AppHeader,
  AppIcon,
  SegmentedControl,
  StickyMiniCart,
  Button,
  LoadingSkeleton,
  PressableScale,
  ProductImage,
  ErrorState,
  EmptyState,
  LocationPermissionCard,
} from '../../../components';
import { colors, typography, spacing, radius, shadows, layout } from '../../../theme';
import { useCartStore, useDeliveryLocationStore } from '../../../stores';
import { useStoreModes, useCachedFetch, useHomeLocationPermission } from '../../../hooks';
import { productsApi } from '../../../api';
import { trackEvent } from '../../../api/analyticsClient';
import { asArray, normalizeCategory } from '../../../utils';


const CATEGORY_IMAGE_ASPECT_RATIO = 0.9;

export default function CategoriesScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const { width: windowWidth } = useWindowDimensions();
  const categoryImageWidth = Math.floor((windowWidth - spacing.md * 2) * 0.28);
  const items = useCartStore(state => state.items);
  const cartItemCount = useMemo(
    () => items.reduce((total, item) => total + (Number(item.quantity) || 0), 0),
    [items]
  );
  const cartDisplayTotal = useMemo(
    () => items.reduce(
      (total, item) => total + ((Number(item.variant?.price ?? item.product?.price) || 0) * (Number(item.quantity) || 0)),
      0,
    ),
    [items]
  );
  
  const [storeType, setStoreType] = useState(route.params?.storeType || 'packed');
  const [activeChip, setActiveChip] = useState('All');

  const normalizedStoreType = storeType;

  // Delivery zone gating — same rule as HomeScreen: everything in this admin
  // panel is zone-based, so category browsing must never show items before
  // we actually know the pin's zone.
  const deliveryCoords = useDeliveryLocationStore(state => state.coords);
  const deliveryCoordsRef = useRef(deliveryCoords);
  deliveryCoordsRef.current = deliveryCoords;
  const { modes } = useStoreModes(deliveryCoords);
  const insideDeliveryZone = useDeliveryLocationStore(state => state.insideZone);
  const deliveryZoneId = useDeliveryLocationStore(state => state.zoneId);
  const isInitialLocationSyncComplete = useDeliveryLocationStore(state => state.isInitialSyncComplete);
  // Keyed on zoneId too: the category catalog isn't zone-scoped server-side
  // yet, but this way the cache is already correct the day it becomes so,
  // instead of painting zone A's cached categories the instant the pin moves
  // into zone B. useCachedFetch refetches automatically on a key change.
  const categoriesCacheKey = `categories:${storeType}:${deliveryZoneId ?? 'none'}`;
  const { status: locationPermStatus, requestAllow: requestLocationAllow, openSettings: openLocationSettings } = useHomeLocationPermission();
  const [requestingLocationAllow, setRequestingLocationAllow] = useState(false);
  const needsLocationPermission = !deliveryCoords
    && (locationPermStatus === 'denied' || locationPermStatus === 'blocked');
  const outOfDeliveryZone = !needsLocationPermission
    && isInitialLocationSyncComplete
    && insideDeliveryZone === false;
  const isLocationGated = needsLocationPermission || outOfDeliveryZone;
  const handleAllowLocation = useCallback(async () => {
    setRequestingLocationAllow(true);
    try {
      await requestLocationAllow();
    } finally {
      setRequestingLocationAllow(false);
    }
  }, [requestLocationAllow]);

  const fetchCategories = useCallback(async () => {
    // Without a pin, resolveCustomerArea (server) falls back to the default
    // area for this route (no requireCustomer here to source last_area_id
    // from) — every customer would browse the SAME area's categories
    // regardless of where they actually are (multi-area audit finding #4).
    const response = await productsApi.getCategories({
      type: storeType,
      latitude: deliveryCoordsRef.current?.lat,
      longitude: deliveryCoordsRef.current?.lng,
    });
    return asArray(response, ['categories']).map(normalizeCategory);
  }, [storeType]);

  const {
    data: categoriesData,
    isLoading,
    isRefreshing,
    error,
    refresh,
  } = useCachedFetch(categoriesCacheKey, fetchCategories, { enabled: !isLocationGated });

  const categories = categoriesData || [];
  const isError = Boolean(error) && categories.length === 0;

  const chips = useMemo(() => [
    'All',
    ...new Set(categories.flatMap(category => (
      category.subcategories || []
    )).map(item => item.name || item).filter(Boolean)),
  ], [categories]);

  // If the selected chip doesn't exist for the current mode (e.g. user picked
  // "Burgers" on fast food then switched to sweets), fall back to All so the
  // list is never wiped by a stale filter.
  const effectiveChip = chips.includes(activeChip) ? activeChip : 'All';

  // API already filters by store type (`getCategories({ type })`). Do NOT
  // re-filter by category.type here — mismatches empty the list after mode
  // switches even when the fetch returned categories.
  const displayCategories = useMemo(() => categories.filter(category => {
    if (effectiveChip === 'All') return true;
    return category.subcategories?.some(
      item => String(item.name || item).toLowerCase() === effectiveChip.toLowerCase(),
    );
  }), [categories, effectiveChip]);

  // Reset chip when the shop mode changes so a previous mode's chip can't
  // hide every category on the next mode.
  useEffect(() => {
    setActiveChip('All');
  }, [storeType]);

  // Animations
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(20)).current;
  const staggerAnims = useRef(Array.from({ length: 12 }, () => new Animated.Value(0))).current;
  const lastAnimatedKeyRef = useRef(null);

  useEffect(() => {
    if (isLoading || !categoriesData) return;

    // Same mode key again (cache revalidate / remount): keep list visible.
    // Without this, a revalidate can skip the entry animation while opacity
    // is still 0 from a prior interrupted switch → "all categories gone".
    if (lastAnimatedKeyRef.current === categoriesCacheKey) {
      fadeAnim.setValue(1);
      slideAnim.setValue(0);
      staggerAnims.forEach(anim => anim.setValue(1));
      return;
    }

    lastAnimatedKeyRef.current = categoriesCacheKey;
    fadeAnim.setValue(0);
    slideAnim.setValue(20);
    staggerAnims.forEach(anim => anim.setValue(0));
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 300, useNativeDriver: true }),
      Animated.stagger(
        50,
        staggerAnims.map(anim => Animated.spring(anim, { toValue: 1, friction: 7, useNativeDriver: true }))
      ),
    ]).start();
  }, [isLoading, categoriesData, categoriesCacheKey, fadeAnim, slideAnim, staggerAnims]);

  const handleRefresh = () => {
    refresh();
  };

  const handleSearchPress = () => {
    navigation.navigate('ProductList', { mode: 'search', storeType: normalizedStoreType });
  };

  const handleCategoryPress = (category) => {
    trackEvent('category_view', { categoryId: Number(category.id) });
    navigation.navigate('ProductList', { categoryId: category.id, categoryName: category.name, storeType: normalizedStoreType });
  };

  const handleCartPress = () => {
    navigation.navigate('Cart');
  };

  const handleChipPress = (chip) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setActiveChip(chip);
  };

  const renderSkeletonList = () => (
    <View style={styles.list}>
      {[1, 2, 3, 4, 5, 6].map((k) => (
        <View key={k} style={styles.skeletonCard}>
          <View style={styles.skeletonAccent} />
          <LoadingSkeleton style={[styles.skeletonCardImage, { width: categoryImageWidth }]} />
          <View style={styles.skeletonCardBody}>
            <LoadingSkeleton style={styles.skeletonCardTitle} />
            <LoadingSkeleton style={styles.skeletonCardPill} />
          </View>
          <LoadingSkeleton style={styles.skeletonCardArrow} />
        </View>
      ))}
    </View>
  );

  return (
    <AppScreen style={styles.container} safeAreaBottom={false}>
      {/* Header */}
      <AppHeader
        title="Categories"
      />

      <View style={styles.content}>
        {/* Segmented Control */}
        <View style={styles.toggleContainer}>
          <SegmentedControl
            options={modes.map(m => m.slug)}
            renderLabel={(slug) => modes.find(m => m.slug === slug)?.label || slug}
            selectedOption={storeType}
            onSelect={(opt) => {
              if (opt === storeType) return;
              LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
              setActiveChip('All');
              setStoreType(opt);
            }}
          />
        </View>

        {/* Search Bar (Fake Input) */}
        <TouchableOpacity
          activeOpacity={0.85}
          style={styles.searchBar}
          onPress={handleSearchPress}
          accessibilityRole="search"
          accessibilityLabel="Search products"
        >
          <AppIcon name="search" size={20} color={colors.textSecondary} style={styles.searchIcon} />
          <Text style={styles.searchText}>
            Search items, food, snacks...
          </Text>
        </TouchableOpacity>

        {/* Subcategory Chips */}
        <View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipsScroll}
          >
            {chips.map((chip) => {
              const isActive = effectiveChip === chip;
              return (
                <TouchableOpacity
                  key={chip}
                  activeOpacity={0.7}
                  onPress={() => handleChipPress(chip)}
                  style={[styles.chip, isActive && styles.chipActive]}
                >
                  <Text style={[styles.chipText, isActive && styles.chipTextActive]}>
                    {chip}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>

        {/* List / Empty State */}
        <View style={styles.listContainer}>
          {needsLocationPermission ? (
            <LocationPermissionCard
              variant={locationPermStatus}
              requesting={requestingLocationAllow}
              onAllow={handleAllowLocation}
              onOpenSettings={openLocationSettings}
            />
          ) : outOfDeliveryZone ? (
            <EmptyState
              icon={<AppIcon name="location" size={56} color={colors.textTertiary} />}
              title="We don't deliver here yet"
              subtitle="We're expanding rapidly and hope to serve your location soon. Thank you for your patience."
              actionLabel="Go to Home"
              onAction={() => navigation.navigate('Home')}
              style={styles.emptyState}
            />
          ) : isLoading ? (
            renderSkeletonList()
          ) : isError ? (
            <ErrorState
              message="Unable to load categories. Tap to retry."
              onRetry={() => refresh()}
              retryLabel="Retry"
              style={styles.emptyState}
            />
          ) : (
            <Animated.ScrollView
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}
              refreshControl={
                <RefreshControl
                  refreshing={isRefreshing}
                  onRefresh={handleRefresh}
                  tintColor={colors.primary}
                  colors={[colors.primary, colors.success, colors.saffron]}
                  title="Refreshing ServeLoco"
                  titleColor={colors.textSecondary}
                />
              }
            >
              {displayCategories.length > 0 ? (
                <View style={styles.list}>
                  {displayCategories.map((cat, idx) => (
                    <Animated.View
                      key={cat.id}
                      style={[
                        styles.listItem,
                        {
                          opacity: staggerAnims[idx] || 1,
                          transform: [{
                            translateY: (staggerAnims[idx] || new Animated.Value(1)).interpolate({
                              inputRange: [0, 1],
                              outputRange: [20, 0],
                            })
                          }]
                        }
                      ]}
                    >
                      <PressableScale
                        onPress={() => handleCategoryPress(cat)}
                        style={styles.categoryCard}
                        scaleTo={0.98}
                        accessibilityRole="button"
                        accessibilityLabel={cat.name}
                      >
                        <View style={styles.categoryAccent} />
                        <View style={[styles.categoryImageFrame, { width: categoryImageWidth }]}>
                          <ProductImage
                            uri={cat.thumbUrl || cat.imageUri}
                            width="100%"
                            height="100%"
                            borderRadius={radius.lg}
                            resizeMode="cover"
                            priority="high"
                          />
                        </View>
                        <View style={styles.categoryBody}>
                          <Text style={styles.categoryName} numberOfLines={2}>
                            {cat.name}
                          </Text>
                          {cat.count !== undefined && (
                            <View style={styles.categoryCountPill}>
                              <Text style={styles.categoryCountText}>
                                {cat.count} {cat.count === 1 ? 'item' : 'items'}
                              </Text>
                            </View>
                          )}
                        </View>
                        <View style={styles.categoryArrow}>
                          <AppIcon name="chevronRight" size={18} color={colors.textPrimary} />
                        </View>
                      </PressableScale>
                    </Animated.View>
                  ))}
                </View>
              ) : (
                <View style={styles.emptyState}>
                  <AppIcon name="box" size={48} color={colors.textTertiary} style={styles.emptyEmoji} />
                  <Text style={styles.emptyTitle}>No items found</Text>
                  <Text style={styles.emptyDesc}>We couldn't find any categories for this store type.</Text>
                  <Button 
                    label="View All Products" 
                    onPress={() => navigation.navigate('ProductList')}
                    style={styles.emptyBtn}
                  />
                </View>
              )}
            </Animated.ScrollView>
          )}
        </View>
      </View>

      {/* Sticky Mini Cart */}
      <StickyMiniCart
        itemCount={cartItemCount}
        totalAmount={cartDisplayTotal}
        onPress={handleCartPress}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgApp,
  },
  content: {
    flex: 1,
  },
  toggleContainer: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  searchBar: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
    backgroundColor: colors.bgSurface,
    height: 50,
    borderRadius: radius.xxl,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.card,
  },
  searchIcon: {
    marginRight: spacing.sm,
  },
  searchText: {
    ...typography.body,
    color: colors.textSecondary,
    fontSize: 14,
  },
  chipsScroll: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.bgSurface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipText: {
    ...typography.label,
    color: colors.textSecondary,
  },
  chipTextActive: {
    color: colors.textInverse,
    fontWeight: '600',
  },
  listContainer: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: layout.stickyCartScrollPadding,
  },
  list: {
    paddingTop: spacing.sm,
    gap: spacing.sm,
  },
  listItem: {
    marginBottom: 0,
  },
  categoryCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgSurface,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    paddingRight: spacing.md,
    paddingLeft: spacing.sm,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.saffron + '28',
    shadowColor: colors.saffron,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 10,
    elevation: 3,
  },
  categoryAccent: {
    width: 4,
    alignSelf: 'stretch',
    borderRadius: radius.pill,
    backgroundColor: colors.saffron,
    marginRight: spacing.sm,
  },
  categoryImageFrame: {
    aspectRatio: CATEGORY_IMAGE_ASPECT_RATIO,
    backgroundColor: colors.bgSkeletonBase,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#E6B800',
    shadowColor: '#B8860B',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.32,
    shadowRadius: 14,
    elevation: 6,
  },
  categoryBody: {
    flex: 1,
    marginLeft: spacing.md,
    justifyContent: 'center',
    gap: spacing.xs,
  },
  categoryName: {
    ...typography.labelLarge,
    fontSize: 16,
    fontWeight: '800',
    color: colors.textPrimary,
    letterSpacing: -0.2,
    lineHeight: 20,
  },
  categoryCountPill: {
    alignSelf: 'flex-start',
    backgroundColor: colors.successLight,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: colors.success + '30',
  },
  categoryCountText: {
    ...typography.labelSmall,
    fontSize: 11,
    fontWeight: '700',
    color: colors.successDark,
  },
  categoryArrow: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    backgroundColor: colors.saffronLight,
    borderWidth: 1,
    borderColor: colors.saffron + '35',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.sm,
  },
  skeletonCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgSurface,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    paddingRight: spacing.md,
    paddingLeft: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  skeletonAccent: {
    width: 4,
    alignSelf: 'stretch',
    borderRadius: radius.pill,
    backgroundColor: colors.saffronLight,
    marginRight: spacing.sm,
  },
  skeletonCardImage: {
    aspectRatio: CATEGORY_IMAGE_ASPECT_RATIO,
    borderRadius: radius.lg,
  },
  skeletonCardBody: {
    flex: 1,
    marginLeft: spacing.md,
    justifyContent: 'center',
    gap: spacing.xs,
  },
  skeletonCardTitle: {
    height: 18,
    width: '68%',
    borderRadius: radius.xs,
  },
  skeletonCardPill: {
    height: 22,
    width: 72,
    borderRadius: radius.pill,
  },
  skeletonCardArrow: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    marginLeft: spacing.sm,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: spacing.xxl,
    paddingHorizontal: spacing.xl,
  },
  emptyEmoji: {
    fontSize: 48,
    marginBottom: spacing.md,
  },
  emptyTitle: {
    ...typography.h3,
    color: colors.textPrimary,
    marginBottom: spacing.xs,
  },
  emptyDesc: {
    ...typography.body,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: spacing.xl,
  },
  emptyBtn: {
    minWidth: 200,
  },
});
