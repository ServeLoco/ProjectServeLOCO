/* eslint-disable react-hooks/exhaustive-deps */
import React, { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  LayoutAnimation,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import { useNavigation, useRoute, useFocusEffect } from '@react-navigation/native';
import {
  AppScreen,
  AppHeader,
  TextInputField,
  ProductCard,
  AppIcon,
  StickyMiniCart,
  SkeletonRow,
  EmptyState,
  ErrorState,
  VariantSheet,
  LocationPermissionCard,
} from '../../../components';
import { colors, typography, spacing, radius, layout } from '../../../theme';
import { useCartStore, useDeliveryLocationStore } from '../../../stores';
import { useAuthGate, useStoreModes, useHomeLocationPermission } from '../../../hooks';
import { productsApi, dashboardApi } from '../../../api';
import { subscribeProductAvailabilityEvents, subscribeShopEvents } from '../../../api/realtimeClient';
import { asArray, normalizeProduct } from '../../../utils';
import { getCached, setCached, stableKey, isFresh } from '../../../utils/apiCache';

const SORT_OPTIONS = ['Popular', 'Price Low to High', 'Price High to Low'];

const MODE_BADGE_STYLES = {
  packed: { emoji: '📦', bg: '#E8F5E9', text: '#2E7D32' },
  fast_food: { emoji: '🍔', bg: '#FFF3E0', text: '#E65100' },
  default: { emoji: '🏷️', bg: '#EDE7F6', text: '#5E35B1' },
};

export default function ProductListScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const { requireAuth } = useAuthGate();
  
  // Params
  const mode = route.params?.mode || 'category'; // 'search' | 'category'
  const initialCategory = route.params?.categoryName || 'All';
  const offerId = route.params?.offerId || null;
  const offerTitle = route.params?.offerTitle || null;
  const sectionSlug = route.params?.sectionSlug || null;
  const sectionTitle = route.params?.sectionTitle || null;
  const sectionStoreType = route.params?.storeType || 'all';
  const initialQuery = route.params?.initialQuery || '';

  const { width: windowWidth } = useWindowDimensions();
  const cardWidth = Math.floor((windowWidth - (spacing.lg * 2) - spacing.md) / 2);
  const { modes } = useStoreModes();

  // Stores
  const items = useCartStore(state => state.items);
  const addItem = useCartStore(state => state.addItem);
  const addCombo = useCartStore(state => state.addCombo);
  const decrementCombo = useCartStore(state => state.decrementCombo);
  const getComboQuantity = useCartStore(state => state.getComboQuantity);
  const getProductQuantity = useCartStore(state => state.getProductQuantity);
  const updateQuantity = useCartStore(state => state.updateQuantity);
  const removeItem = useCartStore(state => state.removeItem);
  const [variantSheetProduct, setVariantSheetProduct] = useState(null);

  // Delivery zone gating — same rule as HomeScreen: everything in this admin
  // panel is zone-based, so search/category results must never show items
  // for a pin the user hasn't set or that falls outside every zone.
  const deliveryCoords = useDeliveryLocationStore(state => state.coords);
  const insideDeliveryZone = useDeliveryLocationStore(state => state.insideZone);
  const deliveryZoneId = useDeliveryLocationStore(state => state.zoneId);
  const isInitialLocationSyncComplete = useDeliveryLocationStore(state => state.isInitialSyncComplete);
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

  // State
  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [activeCategory, setActiveCategory] = useState(initialCategory);
  const [showAvailableOnly, setShowAvailableOnly] = useState(false);
  const [sortBy, setSortBy] = useState('Popular');
  
  const PAGE_SIZE = 30;
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isError, setIsError] = useState(false);
  const [products, setProducts] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  // Next SQL offset advances by PAGE_SIZE always (time-window may shrink pages).
  const nextOffsetRef = useRef(0);
  // Actual item count of the page-0 window (post time-window/search filter,
  // often < PAGE_SIZE) — silent revalidate splices here, not at PAGE_SIZE.
  const page0LengthRef = useRef(0);
  const loadMoreInFlightRef = useRef(false);
  // Monotonic gens so a slow response for an old category/search cannot overwrite.
  const fetchGenRef = useRef(0);
  const loadMoreGenRef = useRef(0);
  const cartItemCount = useMemo(
    () => items.reduce((total, item) => total + (Number(item.quantity) || 0), 0),
    [items]
  );
  const cartDisplayTotal = useMemo(
    () => items.reduce((total, item) => total + ((Number(item.variant?.price ?? item.product?.price) || 0) * (Number(item.quantity) || 0)), 0),
    [items]
  );

  // Live catalog prices → cart lines (qty preserved) so sticky total stays current.
  useEffect(() => {
    if (Array.isArray(products) && products.length > 0) {
      useCartStore.getState().applyCatalogProductPrices(products);
    }
  }, [products]);

  // Live OOS: grey the product out as soon as shop marks it unavailable,
  // instead of removing it — ProductCard renders the greyed-out state.
  useEffect(() => {
    return subscribeProductAvailabilityEvents(({ payload }) => {
      const productId = payload?.productId ?? payload?.id;
      if (productId == null || productId === '') return;
      const available = payload?.available;
      if (available === false || available === 0 || available === '0') {
        setProducts((prev) =>
          (prev || []).map((p) =>
            String(p?.id) === String(productId) ? { ...p, available: false, isAvailable: false } : p
          ),
        );
      }
    });
  }, []);

  // Live shop-closed: same instant grey-out as OOS above, patched by shopId
  // — shop-closed and out-of-stock render as one unavailable card, so both
  // must flip in the same tick instead of waiting on a refetch.
  useEffect(() => {
    return subscribeShopEvents(({ eventName, payload }) => {
      if (eventName !== 'shop.status.updated') return;
      const shopId = payload?.shopId;
      const isOpen = payload?.isOpen;
      if (shopId == null || isOpen == null) return;
      setProducts((prev) =>
        (prev || []).map((p) =>
          String(p?.shopId) === String(shopId)
            ? { ...p, shopIsOpen: Boolean(isOpen), shop_is_open: Boolean(isOpen) }
            : p
        ),
      );
    });
  }, []);

  /**
   * @param {boolean|{ refresh?: boolean, loadMore?: boolean, silent?: boolean }} opts
   *   boolean true = pull-to-refresh (legacy)
   *   silent = revalidate page 0 without dropping already-loaded pages
   */
  const fetchProducts = async (opts = false) => {
    // No zone-resolved location yet — nothing to query, and showing catalog
    // items before we know the zone is exactly the bug this gate fixes.
    if (isLocationGated) {
      setIsLoading(false);
      setIsRefreshing(false);
      setIsLoadingMore(false);
      return;
    }

    const options = typeof opts === 'boolean' ? { refresh: opts } : (opts || {});
    const refresh = !!options.refresh;
    const loadMore = !!options.loadMore;
    const silent = !!options.silent && !refresh && !loadMore;

    const isOriginalCategory = activeCategory === initialCategory;
    const queryCategoryId = isOriginalCategory ? route.params?.categoryId : undefined;
    const pageOffset = loadMore ? nextOffsetRef.current : 0;

    // Cache key covers network params including offset (each page is its own
    // entry) and the active delivery zone — the catalog isn't zone-scoped
    // server-side yet, but keying on zoneId means the cache is already
    // correct the day it becomes so, instead of painting zone A's cached
    // results the instant the pin moves into zone B.
    const requestParams = sectionSlug
      ? {
          sectionSlug,
          storeType: sectionStoreType,
          include_closed_shops: 1,
          zoneId: deliveryZoneId,
        }
      : {
          category: activeCategory !== 'All' ? activeCategory : undefined,
          categoryId: queryCategoryId,
          q: searchQuery || undefined,
          search: searchQuery || undefined,
          offerId: offerId || undefined,
          isCombo: mode === 'combos',
          featured: mode === 'combos' ? true : undefined,
          type: sectionStoreType !== 'all' ? sectionStoreType : undefined,
          storeType: sectionStoreType !== 'all' ? sectionStoreType : undefined,
          include_closed_shops: 1,
          mode,
          limit: PAGE_SIZE,
          offset: pageOffset,
          zoneId: deliveryZoneId,
        };
    const cacheKey = `products:${stableKey(requestParams)}`;
    const cached = getCached(cacheKey);

    let gen;
    if (loadMore) {
      if (loadMoreInFlightRef.current || !hasMore) return;
      loadMoreInFlightRef.current = true;
      gen = ++loadMoreGenRef.current;
      setIsLoadingMore(true);
    } else {
      // New primary fetch invalidates any in-flight load-more.
      gen = ++fetchGenRef.current;
      loadMoreGenRef.current += 1;
      loadMoreInFlightRef.current = false;
      if (refresh) {
        setIsRefreshing(true);
      } else if (cached && !silent) {
        // Instant paint from cache; revalidate silently below (no skeleton).
        // Do not apply page-0 cache over a multi-page list on silent paths.
        const cachedProducts = Array.isArray(cached.data) ? cached.data : (cached.data?.products || []);
        const cachedHasMore = Array.isArray(cached.data) ? false : !!cached.data?.hasMore;
        setProducts(cachedProducts);
        setHasMore(cachedHasMore);
        nextOffsetRef.current = PAGE_SIZE;
        page0LengthRef.current = cachedProducts.length;
        setIsLoading(false);
        setIsError(false);
      } else if (!cached && !silent) {
        setIsLoading(true);
        setIsError(false);
      } else {
        // silent revalidate with or without cache: keep current list painted
        setIsLoading(false);
      }
    }

    const isStale = () => (
      loadMore
        ? gen !== loadMoreGenRef.current
        : gen !== fetchGenRef.current
    );

    try {
      let response;
      let filtered = [];
      let pageHasMore = false;

      if (sectionSlug) {
        // Section items endpoint has no pagination — full list, hasMore false.
        response = await dashboardApi.getSectionItems(sectionSlug, {
          storeType: sectionStoreType,
          include_closed_shops: 1,
          // Same reasoning as the getProducts pin below.
          latitude: deliveryCoords?.lat,
          longitude: deliveryCoords?.lng,
        });
        if (isStale()) return;
        filtered = asArray(response, ['items']).map(normalizeProduct);
        pageHasMore = false;
      } else {
        response = await productsApi.getProducts({
          category: activeCategory !== 'All' ? activeCategory : undefined,
          categoryId: queryCategoryId,
          q: searchQuery || undefined,
          search: searchQuery || undefined,
          // showAvailableOnly + sortBy are applied client-side only (see displayProducts).
          offerId: offerId || undefined,
          isCombo: mode === 'combos',
          featured: mode === 'combos' ? true : undefined,
          type: sectionStoreType !== 'all' ? sectionStoreType : undefined,
          storeType: sectionStoreType !== 'all' ? sectionStoreType : undefined,
          include_closed_shops: 1,
          limit: PAGE_SIZE,
          offset: pageOffset,
          // Without a pin, resolveCustomerArea (server) falls back to the
          // default area for this route — every customer would browse the
          // SAME area's catalog regardless of where they actually are
          // (multi-area audit finding #4).
          latitude: deliveryCoords?.lat,
          longitude: deliveryCoords?.lng,
        });
        if (isStale()) return;
        filtered = asArray(response, ['products']).map(normalizeProduct);
        pageHasMore = !!(
          response?.hasMore ?? response?.has_more ?? response?.data?.hasMore ?? response?.data?.has_more
        );
        if (mode !== 'combos') {
          filtered = filtered.filter(p => !(p.isCombo || p.is_combo || p.comboItems?.length));
        }

        // Category Filter
        if (activeCategory !== 'All') {
          if (!queryCategoryId) {
            filtered = filtered.filter(p => String(p.category || '').toLowerCase() === String(activeCategory).toLowerCase());
          }
        }
      }

      // Search Filter
      if (searchQuery) {
        filtered = filtered.filter(p => p.name.toLowerCase().includes(searchQuery.toLowerCase()));
      }

      if (isStale()) return;

      setCached(cacheKey, { products: filtered, hasMore: pageHasMore });
      if (loadMore) {
        setProducts(prev => [...prev, ...filtered]);
        setHasMore(pageHasMore);
        // Advance by SQL page size, never by received row count.
        nextOffsetRef.current = pageOffset + PAGE_SIZE;
      } else if (silent) {
        // Revalidate page 0 only: replace first window, keep later pages.
        // Splice at the previous page-0 window's actual (post-filter) length,
        // not PAGE_SIZE — time-window/search filtering can shrink a page well
        // below PAGE_SIZE, and splicing at PAGE_SIZE would drop or duplicate
        // items from page 1+.
        const priorPage0Length = page0LengthRef.current || PAGE_SIZE;
        setProducts(prev => {
          if (prev.length <= priorPage0Length) return filtered;
          return [...filtered, ...prev.slice(priorPage0Length)];
        });
        page0LengthRef.current = filtered.length;
        if (nextOffsetRef.current <= PAGE_SIZE) {
          nextOffsetRef.current = PAGE_SIZE;
          setHasMore(pageHasMore);
        } else {
          // Already load-more'd: keep ability to fetch further if page0 or prior said so.
          setHasMore(pageHasMore || nextOffsetRef.current > PAGE_SIZE);
        }
      } else {
        setProducts(filtered);
        setHasMore(pageHasMore);
        nextOffsetRef.current = pageOffset + PAGE_SIZE;
        page0LengthRef.current = filtered.length;
      }
      setIsError(false);
    } catch (err) {
      if (isStale()) return;
      // Keep cached list on revalidation failure; error only when nothing to show.
      if (!loadMore && !silent && !getCached(cacheKey)) {
        setIsError(true);
      }
    } finally {
      if (!isStale()) {
        setIsLoading(false);
        setIsRefreshing(false);
        setIsLoadingMore(false);
        if (loadMore) loadMoreInFlightRef.current = false;
      } else if (loadMore && gen === loadMoreGenRef.current) {
        loadMoreInFlightRef.current = false;
        setIsLoadingMore(false);
      }
    }
  };

  const handleRefresh = () => {
    nextOffsetRef.current = 0;
    fetchProducts({ refresh: true });
  };

  const handleLoadMore = () => {
    if (!hasMore || isLoadingMore || isLoading || sectionSlug) return;
    fetchProducts({ loadMore: true });
  };

  // Client-side only: availability filter + sort (no network).
  const displayProducts = useMemo(() => {
    let list = products;
    if (showAvailableOnly) {
      list = list.filter(p => p.available && p.shopIsOpen !== false);
    }
    if (sortBy === 'Price Low to High') {
      list = [...list].sort((a, b) => a.price - b.price);
    } else if (sortBy === 'Price High to Low') {
      list = [...list].sort((a, b) => b.price - a.price);
    }
    return list;
  }, [products, showAvailableOnly, sortBy]);

  // Initial fetch and dependency fetch (sort/availability are client-side only).
  useEffect(() => {
    fetchProducts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCategory, offerId, sectionSlug, sectionStoreType, mode, route.params?.categoryId, isLocationGated, deliveryZoneId]);

  // Debounced Search
  useEffect(() => {
    if (mode === 'search') {
      const timer = setTimeout(() => {
        fetchProducts();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [searchQuery, mode, isLocationGated, deliveryZoneId]);

  // Silent revalidate on refocus (skip first focus — mount effect already loaded).
  // Freshness throttle 15s: skip network if list page-0 cache is still fresh.
  const hasFocusedOnceRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (hasFocusedOnceRef.current) {
        const isOriginalCategory = activeCategory === initialCategory;
        const queryCategoryId = isOriginalCategory ? route.params?.categoryId : undefined;
        const requestParams = sectionSlug
          ? { sectionSlug, storeType: sectionStoreType, include_closed_shops: 1, zoneId: deliveryZoneId }
          : {
              category: activeCategory !== 'All' ? activeCategory : undefined,
              categoryId: queryCategoryId,
              q: searchQuery || undefined,
              search: searchQuery || undefined,
              offerId: offerId || undefined,
              isCombo: mode === 'combos',
              featured: mode === 'combos' ? true : undefined,
              type: sectionStoreType !== 'all' ? sectionStoreType : undefined,
              storeType: sectionStoreType !== 'all' ? sectionStoreType : undefined,
              include_closed_shops: 1,
              mode,
              limit: PAGE_SIZE,
              offset: 0,
              zoneId: deliveryZoneId,
            };
        const focusKey = `products:${stableKey(requestParams)}`;
        if (!isFresh(focusKey, 15_000)) {
          // silent: refresh page 0 without dropping already-loaded pages
          fetchProducts({ silent: true });
        }
      } else {
        hasFocusedOnceRef.current = true;
      }
    }, [
      activeCategory,
      offerId,
      sectionSlug,
      sectionStoreType,
      mode,
      searchQuery,
      route.params?.categoryId,
      initialCategory,
      deliveryZoneId,
    ]),
  );

  // Callbacks
  const handleAddToCart = useCallback((product) => {
    requireAuth(null, () => {
      if (product.isCombo || product.is_combo || product.comboItems?.length) {
        addCombo(product);
      } else if ((product.variants?.length ?? 0) > 1) {
        setVariantSheetProduct(product);
      } else {
        addItem(product, 1, product.variants?.[0] ?? null);
      }
    });
  }, [requireAuth, addCombo, addItem]);

  const handleIncrement = useCallback((product) => {
    requireAuth(null, () => {
      if (product.isCombo || product.is_combo || product.comboItems?.length) {
        addCombo(product);
      } else {
        // Reuse the variant already in the cart for this product — a
        // single-variant product is stored WITH its variant attached, so
        // adding with variant=null here would miss the match and create a
        // duplicate line instead of incrementing it.
        const existing = items.find(i => i.product.id === product.id && (i.type || 'product') !== 'combo');
        addItem(product, 1, existing?.variant ?? product.variants?.[0] ?? null);
      }
    });
  }, [requireAuth, addCombo, addItem, items]);

  const handleDecrement = useCallback((product) => {
    if (product.isCombo || product.is_combo || product.comboItems?.length) {
      decrementCombo(product);
      return;
    }

    const existing = items.find(i => i.product.id === product.id && (i.type || 'product') !== 'combo');
    const variantId = existing?.variant?.id ?? null;
    const currentQty = existing?.quantity || 0;
    if (currentQty <= 1) {
      removeItem(product.id, 'product', variantId);
    } else {
      updateQuantity(product.id, currentQty - 1, 'product', variantId);
    }
  }, [decrementCombo, items, removeItem, updateQuantity]);

  // Renders
  const renderItem = ({ item }) => {
    const itemStoreType = item.storeType || item.store_type || item.type;
    const showModeBadge = mode === 'search' && sectionStoreType === 'all' && !!itemStoreType;
    const modeInfo = MODE_BADGE_STYLES[itemStoreType] || MODE_BADGE_STYLES.default;
    const modeBadgeLabel = `${modeInfo.emoji} ${modes.find(m => m.slug === itemStoreType)?.label || itemStoreType}`;
    const modeBadgeColor = modeInfo.bg;
    const modeBadgeTextColor = modeInfo.text;

    return (
      <View style={[styles.productWrap, { width: cardWidth }]}>
        {/* Card body tap intentionally does nothing — purchases happen on the
            card itself (Buy button / variant sheet), there is no product page
            in the customer flow. */}
        <ProductCard
          product={item}
          name={item.name}
          price={item.price}
          originalPrice={item.originalPrice}
          discountLabel={item.discountLabel}
          unit={item.unit}
          isCombo={item.isCombo}
          comboItems={item.comboItems}
          imageUri={item.imageUri}
          quantity={item.isCombo || item.is_combo || item.comboItems?.length ? getComboQuantity(item) : getProductQuantity(item.id)}
          onAdd={() => handleAddToCart(item)}
          onIncrement={() => handleIncrement(item)}
          onDecrement={() => handleDecrement(item)}
          disabled={!item.available}
          style={{ width: '100%' }}
        />
        {showModeBadge && (
          <View style={[styles.modeBadge, { backgroundColor: modeBadgeColor }]}>
            <Text style={[styles.modeBadgeText, { color: modeBadgeTextColor }]}>{modeBadgeLabel}</Text>
          </View>
        )}
      </View>
    );
  };

  const renderSkeleton = () => (
    <View style={styles.skeletonContainer}>
      {[1, 2, 3, 4, 5].map((k) => (
        <View key={k} style={styles.productWrap}>
          <SkeletonRow />
        </View>
      ))}
    </View>
  );

  const renderEmptyState = () => (
    <EmptyState
      icon={<AppIcon name="search" size={56} color={colors.textTertiary} />}
      title={mode === 'offer' ? 'No offer products available' : 'No products found'}
      subtitle={mode === 'offer'
        ? 'No products are currently available for this offer.'
        : "Try adjusting your search or filters to find what you're looking for."}
      actionLabel={mode === 'offer' ? null : 'Clear Search & Filters'}
      onAction={mode === 'offer' ? undefined : () => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setSearchQuery('');
        setActiveCategory('All');
        setShowAvailableOnly(false);
        setSortBy('Popular');
      }}
      style={styles.emptyState}
    />
  );

  const renderErrorState = () => (
    <ErrorState
      icon={<AppIcon name="close" size={48} color={colors.error} />}
      message="We couldn't load the products. Please check your connection and try again."
      onRetry={() => fetchProducts()}
      style={styles.emptyState}
    />
  );

  return (
    <AppScreen style={styles.container} safeAreaBottom={false}>
      <AppHeader
        title={
          sectionTitle
            ? sectionTitle
            : mode === 'search'
            ? 'Search Products'
            : mode === 'combos'
            ? 'Popular Combos'
            : offerId
            ? offerTitle || 'Offer Products'
            : 'Products'
        }
        onBack={() => navigation.goBack()}
        cartCount={cartItemCount}
        onCartPress={() => navigation.navigate('Cart')}
      />

      <View style={styles.controlsArea}>
        {mode === 'search' && (
          <View style={styles.searchWrap}>
            <TextInputField
              placeholder="Search items, snacks..."
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoFocus
            />
          </View>
        )}


        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterScroll}>
          {SORT_OPTIONS.map(opt => (
            <TouchableOpacity
              key={opt}
              style={[styles.chip, sortBy === opt && styles.chipActive, { borderRadius: radius.sm }]}
              onPress={() => {
                LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
                setSortBy(opt);
              }}
            >
              <Text style={[styles.chipText, sortBy === opt && styles.chipTextActive]}>Sort: {opt}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

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
          renderSkeleton()
        ) : isError ? (
          renderErrorState()
        ) : displayProducts.length === 0 ? (
          renderEmptyState()
        ) : (
          <FlatList
            data={displayProducts}
            keyExtractor={item => item.id}
            renderItem={renderItem}
            numColumns={2}
            columnWrapperStyle={styles.row}
            contentContainerStyle={styles.flatListContent}
            showsVerticalScrollIndicator={false}
            // removeClippedSubviews + windowSize tuning dramatically improves
            // scroll FPS on long Android lists by detaching off-screen rows
            // from the native view hierarchy. Has no effect on iOS but is
            // free perf on Android.
            removeClippedSubviews
            initialNumToRender={6}
            maxToRenderPerBatch={6}
            windowSize={7}
            onEndReached={handleLoadMore}
            // Start next page ~60% from the end so scroll rarely waits on the footer spinner.
            onEndReachedThreshold={0.6}
            ListFooterComponent={
              isLoadingMore ? (
                <View style={styles.loadMoreFooter}>
                  <ActivityIndicator color={colors.primary} />
                </View>
              ) : null
            }
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
          />
        )}
      </View>

      <StickyMiniCart
        itemCount={cartItemCount}
        totalAmount={cartDisplayTotal}
        onPress={() => navigation.navigate('Cart')}
      />

      <VariantSheet
        visible={!!variantSheetProduct}
        product={variantSheetProduct}
        onClose={() => setVariantSheetProduct(null)}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgApp,
  },
  controlsArea: {
    backgroundColor: colors.bgSurface,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  searchWrap: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  filterScroll: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.bgApp,
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
  loadMoreFooter: {
    paddingVertical: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flatListContent: {
    padding: spacing.lg,
    paddingBottom: layout.stickyCartScrollPadding,
  },
  row: {
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  productWrap: {
    // Wrap padding inside flatlist item
  },
  modeBadge: {
    alignSelf: 'flex-start',
    marginTop: 4,
    marginLeft: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  modeBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  skeletonContainer: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    marginTop: spacing.xxxl,
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
});
