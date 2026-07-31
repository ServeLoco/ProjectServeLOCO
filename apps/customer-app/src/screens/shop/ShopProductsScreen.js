import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  ActivityIndicator, FlatList, KeyboardAvoidingView, Modal, Platform, RefreshControl, ScrollView, StyleSheet, Text, TextInput,
  TouchableOpacity, View, Alert,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { colors, spacing, typography, radius, shadows } from '../../theme';
import { shopApi, subscribeRealtime } from '../../api';
import AppIcon from '../../components/AppIcon';
import ShopToggle from '../../components/shop/ShopToggle';

const UNGROUPED_KEY = '__ungrouped__';

/**
 * ShopProductsScreen
 * Premium product catalog for shop owners. Products are sectioned by group,
 * each group with its own Active/Inactive toggle, plus search, group creation,
 * and product reassignment.
 */
export default function ShopProductsScreen() {
  const [products, setProducts] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('all'); // 'all' | group.id | UNGROUPED_KEY
  const [newGroupModalOpen, setNewGroupModalOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [pickerProduct, setPickerProduct] = useState(null); // product being reassigned
  const [expandedGroups, setExpandedGroups] = useState(() => new Set()); // group.id | UNGROUPED_KEY, collapsed by default

  // fetchAll (focus effect, socket foreground/reconnect) can race an in-flight
  // toggle/group-move PATCH and overwrite the optimistic local state with the
  // pre-update DB value — these track which rows are mid-mutation so fetchAll
  // keeps the local (already-correct) copy for them instead of clobbering it.
  const productInFlightRef = useRef(new Set());
  const groupInFlightRef = useRef(new Set());
  const variantInFlightRef = useRef(new Set());

  const fetchAll = useCallback(async () => {
    try {
      const [productsRes, groupsRes] = await Promise.all([
        shopApi.getMyProducts(),
        shopApi.getMyGroups(),
      ]);
      setProducts(prev => {
        const fetched = productsRes.products || [];
        const prevById = new Map(prev.map(p => [p.id, p]));
        return fetched.map(p => {
          if (!p) return p;
          if (productInFlightRef.current.has(p.id) && prevById.has(p.id)) {
            return prevById.get(p.id);
          }
          if (variantInFlightRef.current.size === 0 || !Array.isArray(p.variants)) return p;
          const prevProduct = prevById.get(p.id);
          const prevVariantsById = new Map((prevProduct?.variants || []).map(v => [v.id, v]));
          return {
            ...p,
            variants: p.variants.map(v => (
              variantInFlightRef.current.has(`${p.id}:${v.id}`) && prevVariantsById.has(v.id)
                ? prevVariantsById.get(v.id)
                : v
            )),
          };
        });
      });
      setGroups(prev => {
        const fetched = groupsRes.groups || [];
        const prevById = new Map(prev.map(g => [g.id, g]));
        return fetched.map(g => (
          g && groupInFlightRef.current.has(g.id) && prevById.has(g.id)
            ? prevById.get(g.id)
            : g
        ));
      });
      setLoadError(false);
    } catch (_) {
      setLoadError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    fetchAll();
  }, [fetchAll]);

  useFocusEffect(
    useCallback(() => {
      fetchAll();
    }, [fetchAll])
  );

  useEffect(() => {
    const unsubForeground = subscribeRealtime('lifecycle.foreground', () => fetchAll());
    const unsubReconnected = subscribeRealtime('lifecycle.reconnected', () => fetchAll());
    return () => {
      unsubForeground();
      unsubReconnected();
    };
  }, [fetchAll]);

  const handleProductToggle = useCallback(async (product, value) => {
    if (!product || product.id == null) return;
    const safeValue = Boolean(value);
    productInFlightRef.current.add(product.id);
    setProducts(prev => prev.map(p => (p && p.id === product.id ? { ...p, available: safeValue } : p)));
    try {
      await shopApi.toggleProduct(product.id, safeValue);
    } catch (_) {
      setProducts(prev => prev.map(p => (p && p.id === product.id ? { ...p, available: !safeValue } : p)));
    } finally {
      productInFlightRef.current.delete(product.id);
    }
  }, []);

  const handleVariantToggle = useCallback(async (product, variant, value) => {
    if (!product || product.id == null || !variant || variant.id == null) return;
    const safeValue = Boolean(value);
    const key = `${product.id}:${variant.id}`;
    variantInFlightRef.current.add(key);
    setProducts(prev => prev.map(p => (
      p && p.id === product.id
        ? { ...p, variants: (p.variants || []).map(v => (v.id === variant.id ? { ...v, available: safeValue } : v)) }
        : p
    )));
    try {
      await shopApi.toggleVariant(product.id, variant.id, safeValue);
    } catch (_) {
      setProducts(prev => prev.map(p => (
        p && p.id === product.id
          ? { ...p, variants: (p.variants || []).map(v => (v.id === variant.id ? { ...v, available: !safeValue } : v)) }
          : p
      )));
    } finally {
      variantInFlightRef.current.delete(key);
    }
  }, []);

  const handleGroupToggle = useCallback(async (group, value) => {
    if (!group || group.id == null) return;
    const safeValue = Boolean(value);
    groupInFlightRef.current.add(group.id);
    setGroups(prev => prev.map(g => (g && g.id === group.id ? { ...g, active: safeValue } : g)));
    try {
      await shopApi.updateGroup(group.id, { active: safeValue });
    } catch (_) {
      setGroups(prev => prev.map(g => (g && g.id === group.id ? { ...g, active: !safeValue } : g)));
    } finally {
      groupInFlightRef.current.delete(group.id);
    }
  }, []);

  const handleCreateGroup = useCallback(async () => {
    if (!newGroupName.trim()) return;
    setCreatingGroup(true);
    try {
      await shopApi.createGroup(newGroupName.trim());
      setNewGroupName('');
      setNewGroupModalOpen(false);
      fetchAll();
    } catch (err) {
      Alert.alert('Could not create group', err?.message || 'Please try again.');
    } finally {
      setCreatingGroup(false);
    }
  }, [newGroupName, fetchAll]);

  const handleDeleteGroup = useCallback((group) => {
    if (!group || group.id == null) return;
    Alert.alert(
      'Delete group',
      `Delete "${group.name || 'this group'}"? Its products become ungrouped, not deleted.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive', onPress: async () => {
            try {
              await shopApi.deleteGroup(group.id);
              setActiveTab(prev => (prev === group.id ? 'all' : prev));
              fetchAll();
            } catch (err) {
              Alert.alert('Could not delete group', err?.message || 'Please try again.');
            }
          },
        },
      ]
    );
  }, [fetchAll]);

  const handleAssignGroup = useCallback(async (groupId) => {
    if (!pickerProduct) return;
    const product = pickerProduct;
    const prevGroupId = product.groupId ?? product.group_id ?? null;
    setPickerProduct(null);
    productInFlightRef.current.add(product.id);
    // Optimistic move — was awaiting the PATCH then a full products+groups
    // refetch before the row moved, costing 2 extra network round-trips
    // (~1-1.5s in production) for something the client already knows.
    setProducts(prev => prev.map(p => (
      p && p.id === product.id ? { ...p, groupId, group_id: groupId } : p
    )));
    try {
      await shopApi.assignProductGroup(product.id, groupId);
    } catch (err) {
      setProducts(prev => prev.map(p => (
        p && p.id === product.id ? { ...p, groupId: prevGroupId, group_id: prevGroupId } : p
      )));
      Alert.alert('Could not move product', err?.message || 'Please try again.');
    } finally {
      productInFlightRef.current.delete(product.id);
    }
  }, [pickerProduct]);

  const handleSearchChange = useCallback((text) => {
    setSearchQuery(text);
    setActiveTab('all'); // typing a search resets any tab filter, matches mockup behavior
  }, []);

  const handleTabPress = useCallback((tabId) => {
    setActiveTab(tabId);
  }, []);

  const toggleGroupExpand = useCallback((key) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const isSearching = searchQuery.trim().length > 0;
  // Searching, or filtering to a single group via the tab strip, both imply
  // the user wants to see items — don't make them also tap to expand.
  const isGroupExpanded = useCallback(
    (key) => isSearching || (activeTab !== 'all' && activeTab === key) || expandedGroups.has(key),
    [isSearching, activeTab, expandedGroups]
  );

  const filteredProducts = useMemo(() => {
    if (!isSearching) return products;
    const q = searchQuery.trim().toLowerCase();
    return products.filter(p => p.name?.toLowerCase().includes(q));
  }, [products, searchQuery, isSearching]);

  const sections = useMemo(() => {
    const byGroup = {};
    for (const p of filteredProducts) {
      const key = p.groupId ?? p.group_id ?? UNGROUPED_KEY;
      if (!byGroup[key]) byGroup[key] = [];
      byGroup[key].push(p);
    }
    const showAll = activeTab === 'all';
    const groupSections = groups
      .map(g => ({ group: g, items: byGroup[g.id] || [] }))
      .filter(s => (showAll || activeTab === s.group.id))
      .filter(s => !isSearching || s.items.length > 0);
    const rawUngrouped = byGroup[UNGROUPED_KEY] || [];
    const ungrouped = (showAll || activeTab === UNGROUPED_KEY) ? rawUngrouped : [];
    return { groupSections, ungrouped };
  }, [filteredProducts, groups, isSearching, activeTab]);

  const tabs = useMemo(() => {
    const list = [{ id: 'all', name: 'All' }];
    groups.forEach(g => list.push({ id: g.id, name: g.name, active: g.active }));
    const ungroupedItems = products.filter(p => (p.groupId ?? p.group_id) == null);
    if (ungroupedItems.length > 0) {
      list.push({ id: UNGROUPED_KEY, name: 'Ungrouped', active: ungroupedItems.every(p => p.available) });
    }
    return list;
  }, [groups, products]);

  const totalCount = products.length;
  const availableCount = useMemo(() => products.filter(p => p.available).length, [products]);

  const renderProductRow = (item, index, arr) => {
    if (!item || item.id == null) return null;
    const isAvailable = Boolean(item.available);
    const variants = Array.isArray(item.variants) ? item.variants : [];
    const hasVariants = variants.length > 0;
    const isLast = index === arr.length - 1;
    const initial = (item.name || '?').trim().charAt(0).toUpperCase() || '?';
    const meta = [item.price != null ? `₹${item.price}` : null, item.unit || null].filter(Boolean).join(' · ');
    return (
      <View key={item.id}>
        <View style={[styles.row, isLast && !hasVariants && styles.rowLast]}>
          <View style={[styles.rowAvatar, !isAvailable && styles.rowAvatarOff]}>
            <Text style={[styles.rowAvatarText, !isAvailable && styles.rowAvatarTextOff]}>{initial}</Text>
          </View>
          <View style={styles.rowNameWrap}>
            <Text style={[styles.rowName, !isAvailable && styles.rowNameOff]} numberOfLines={1}>{item.name || 'Unnamed product'}</Text>
            {!!(meta || hasVariants) && (
              <Text style={styles.rowMetaText} numberOfLines={1}>
                {[meta, hasVariants ? `${variants.length} option${variants.length === 1 ? '' : 's'}` : null]
                  .filter(Boolean)
                  .join('  •  ')}
              </Text>
            )}
          </View>
          <TouchableOpacity
            style={styles.rowMoveBtn}
            onPress={() => setPickerProduct(item)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel="Move to group"
          >
            <AppIcon name="chevronRight" size={15} color={colors.saffronDark} />
          </TouchableOpacity>
          <ShopToggle
            value={isAvailable}
            onValueChange={(v) => handleProductToggle(item, v)}
            activeColor={colors.success}
            size="md"
          />
        </View>
        {hasVariants && (
          <View style={[styles.variantGroup, isLast && styles.rowLast]}>
            {variants.map((v, vIdx) => (
              <View
                key={v.id}
                style={[
                  styles.variantRow,
                  vIdx === 0 && styles.variantRowFirst,
                  vIdx === variants.length - 1 && styles.variantRowLast,
                ]}
              >
                <View style={[styles.variantDot, !v.available && styles.variantDotOff]} />
                <Text style={[styles.variantName, !v.available && styles.rowNameOff]} numberOfLines={1}>
                  {v.label || 'Option'}
                </Text>
                {v.price != null && (
                  <Text style={[styles.variantPrice, !v.available && styles.rowNameOff]}>₹{v.price}</Text>
                )}
                <ShopToggle
                  value={Boolean(v.available)}
                  onValueChange={(val) => handleVariantToggle(item, v, val)}
                  activeColor={colors.success}
                  size="sm"
                />
              </View>
            ))}
          </View>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.title}>Products</Text>
        <TouchableOpacity style={styles.newGroupBtn} onPress={() => setNewGroupModalOpen(true)} activeOpacity={0.8}>
          <AppIcon name="add" size={16} color={colors.saffronDark} />
          <Text style={styles.newGroupBtnText}>New Group</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.searchWrap}>
        <View style={styles.searchBox}>
          <AppIcon name="search" size={18} color={colors.textSecondary} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search products"
            placeholderTextColor={colors.textMuted}
            value={searchQuery}
            onChangeText={handleSearchChange}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {isSearching && (
            <TouchableOpacity style={styles.searchClearBtn} onPress={() => handleSearchChange('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <AppIcon name="close" size={16} color={colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {products.length > 0 && (
        <View style={styles.summaryRow}>
          <Text style={styles.summaryText}>
            <Text style={styles.summaryTextBold}>{totalCount}</Text> products
          </Text>
          <View style={styles.summaryPill}>
            <AppIcon name="check" size={12} color={colors.successDark} />
            <Text style={styles.summaryPillText}>{availableCount} available</Text>
          </View>
        </View>
      )}

      {products.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabsRow}
          contentContainerStyle={styles.tabsRowContent}
        >
          {tabs.map(t => {
            const isActive = activeTab === t.id;
            const isAll = t.id === 'all';
            return (
              <TouchableOpacity
                key={t.id}
                style={[styles.tabChip, isActive && styles.tabChipActive]}
                onPress={() => handleTabPress(t.id)}
                activeOpacity={0.8}
              >
                {!isAll && (
                  <View style={[styles.tabDot, !t.active && styles.tabDotOff]} />
                )}
                <Text style={[styles.tabChipText, isActive && styles.tabChipTextActive]}>{t.name}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {loading && products.length === 0 ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={colors.saffron} />
      ) : (
        <FlatList
          data={[{ key: 'sections' }]}
          keyExtractor={(item) => item.key}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.saffron} />}
          renderItem={() => (
            <>
              {sections.groupSections.map(({ group, items }) => {
                const expanded = isGroupExpanded(group.id);
                return (
                  <View key={group.id} style={styles.groupBlock}>
                    <View
                      key={`header-${expanded}`}
                      style={[styles.groupHeader, expanded && styles.groupHeaderExpanded]}
                    >
                      <TouchableOpacity
                        style={styles.groupTitleWrap}
                        onPress={() => toggleGroupExpand(group.id)}
                        activeOpacity={0.7}
                      >
                        <View style={[styles.groupIconWrap, !group.active && styles.groupIconWrapMuted]}>
                          <AppIcon name="box" size={18} color={group.active ? colors.saffronDark : colors.textTertiary} />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.groupName}>{group.name}</Text>
                          <Text style={styles.groupCount}>
                            {items.length} {items.length === 1 ? 'item' : 'items'}
                          </Text>
                        </View>
                        <AppIcon name={expanded ? 'down' : 'chevronRight'} size={16} color={colors.textTertiary} />
                      </TouchableOpacity>
                      <View style={styles.groupActions}>
                        <TouchableOpacity
                          style={styles.groupDeleteBtn}
                          onPress={() => handleDeleteGroup(group)}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                          <AppIcon name="delete" size={18} color={colors.textMuted} />
                        </TouchableOpacity>
                        <ShopToggle
                          value={Boolean(group.active)}
                          onValueChange={(v) => handleGroupToggle(group, v)}
                          activeColor={colors.saffron}
                          size="md"
                        />
                      </View>
                    </View>
                    {expanded && (
                      <View style={styles.groupCard}>
                        {items.length === 0 ? (
                          <View style={styles.emptyGroupWrap}>
                            <AppIcon name="box" size={20} color={colors.textTertiary} />
                            <Text style={styles.emptyGroup}>No products in this group.</Text>
                          </View>
                        ) : (
                          items.map(renderProductRow)
                        )}
                      </View>
                    )}
                  </View>
                );
              })}

              {sections.ungrouped.length > 0 && (
                <View style={styles.groupBlock}>
                  <View
                    key={`header-${isGroupExpanded(UNGROUPED_KEY)}`}
                    style={[styles.groupHeader, isGroupExpanded(UNGROUPED_KEY) && styles.groupHeaderExpanded]}
                  >
                    <TouchableOpacity
                      style={styles.groupTitleWrap}
                      onPress={() => toggleGroupExpand(UNGROUPED_KEY)}
                      activeOpacity={0.7}
                    >
                      <View style={[styles.groupIconWrap, styles.groupIconWrapMuted]}>
                        <AppIcon name="box" size={18} color={colors.textTertiary} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.groupName}>Ungrouped</Text>
                        <Text style={styles.groupCount}>
                          {sections.ungrouped.length} {sections.ungrouped.length === 1 ? 'item' : 'items'}
                        </Text>
                      </View>
                      <AppIcon
                        name={isGroupExpanded(UNGROUPED_KEY) ? 'down' : 'chevronRight'}
                        size={16}
                        color={colors.textTertiary}
                      />
                    </TouchableOpacity>
                  </View>
                  {isGroupExpanded(UNGROUPED_KEY) && (
                    <View style={styles.groupCard}>
                      {sections.ungrouped.map(renderProductRow)}
                    </View>
                  )}
                </View>
              )}

              {products.length === 0 && (
                <View style={styles.emptyState}>
                  <View style={styles.emptyIconWrap}>
                    <AppIcon name="box" size={32} color={colors.saffronDark} />
                  </View>
                  <Text style={styles.emptyTitle}>{loadError ? 'Could not load products' : 'No products yet'}</Text>
                  <Text style={styles.emptyText}>
                    {loadError ? 'Pull down to try again.' : 'Add items from your shop menu to manage them here.'}
                  </Text>
                </View>
              )}
              {products.length > 0 && isSearching && filteredProducts.length === 0 && (
                <View style={styles.emptyState}>
                  <View style={styles.emptyIconWrap}>
                    <AppIcon name="search" size={30} color={colors.saffronDark} />
                  </View>
                  <Text style={styles.emptyTitle}>No matches</Text>
                  <Text style={styles.emptyText}>No products match "{searchQuery.trim()}".</Text>
                </View>
              )}
            </>
          )}
        />
      )}

      {/* New group modal */}
      <Modal visible={newGroupModalOpen} transparent animationType="fade" onRequestClose={() => setNewGroupModalOpen(false)}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setNewGroupModalOpen(false)}>
          <TouchableOpacity style={styles.modalCard} activeOpacity={1}>
            <View style={styles.modalIconWrap}>
              <AppIcon name="add" size={22} color={colors.saffronDark} />
            </View>
            <Text style={styles.modalTitle}>New group</Text>
            <Text style={styles.modalSubtitle}>Group products so customers browse them together.</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="e.g. Starters"
              placeholderTextColor={colors.textMuted}
              value={newGroupName}
              onChangeText={setNewGroupName}
              autoFocus
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setNewGroupModalOpen(false)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalCreateBtn, (!newGroupName.trim() || creatingGroup) && styles.modalCreateDisabled]}
                onPress={handleCreateGroup}
                disabled={creatingGroup || !newGroupName.trim()}
              >
                <LinearGradient
                  colors={[colors.btnHighlightStart, colors.btnHighlightEnd]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.modalCreateGradient}
                >
                  <Text style={styles.modalCreateText}>{creatingGroup ? 'Creating…' : 'Create'}</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
        </KeyboardAvoidingView>
      </Modal>

      {/* Group picker for a product */}
      <Modal visible={!!pickerProduct} transparent animationType="fade" onRequestClose={() => setPickerProduct(null)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setPickerProduct(null)}>
          <TouchableOpacity style={styles.modalCard} activeOpacity={1}>
            <View style={styles.modalIconWrap}>
              <AppIcon name="box" size={22} color={colors.saffronDark} />
            </View>
            <Text style={styles.modalTitle}>Move product</Text>
            <Text style={styles.modalSubtitle}>Choose a group for "{pickerProduct?.name}".</Text>
            <TouchableOpacity style={styles.pickerRow} onPress={() => handleAssignGroup(null)} activeOpacity={0.7}>
              <Text style={styles.pickerRowText}>Ungrouped</Text>
              <AppIcon name="chevronRight" size={18} color={colors.textMuted} />
            </TouchableOpacity>
            {groups.map(g => (
              <TouchableOpacity key={g.id} style={styles.pickerRow} onPress={() => handleAssignGroup(g.id)} activeOpacity={0.7}>
                <Text style={styles.pickerRowText}>{g.name}</Text>
                <AppIcon name="chevronRight" size={18} color={colors.textMuted} />
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={styles.modalCancelBtnWide} onPress={() => setPickerProduct(null)}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgApp },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm,
  },
  title: { ...typography.display, fontSize: 26, color: colors.textPrimary },
  newGroupBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.saffronLight, borderRadius: radius.pill,
    paddingHorizontal: spacing.md, paddingVertical: 9, ...shadows.xs,
  },
  newGroupBtnText: { color: colors.saffronDark, fontWeight: '800', fontSize: 13 },
  searchWrap: { paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  searchBox: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.bgSurface, borderWidth: 1, borderColor: colors.border,
    borderRadius: radius.input, paddingHorizontal: spacing.md, height: 48, ...shadows.sm,
  },
  searchInput: { flex: 1, ...typography.bodyLarge, color: colors.textPrimary, paddingVertical: 0 },
  searchClearBtn: { padding: 2 },
  summaryRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.lg + spacing.xs, marginBottom: spacing.sm,
  },
  summaryText: { ...typography.bodySmall, color: colors.textSecondary, fontWeight: '600' },
  summaryTextBold: { color: colors.textPrimary, fontWeight: '800' },
  summaryPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: colors.successLight, borderRadius: radius.pill,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  summaryPillText: { color: colors.successDark, fontWeight: '800', fontSize: 12 },
  tabsRow: { marginBottom: spacing.md, flexGrow: 0 },
  tabsRowContent: { paddingHorizontal: spacing.lg, gap: spacing.sm, alignItems: 'center' },
  tabChip: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgSurface,
    borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 9,
  },
  tabChipActive: { backgroundColor: colors.textPrimary, borderColor: colors.textPrimary },
  tabChipText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary },
  tabChipTextActive: { color: colors.textInverse },
  tabDot: { width: 7, height: 7, borderRadius: radius.circle, backgroundColor: colors.success },
  tabDotOff: { backgroundColor: colors.textTertiary },
  listContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  groupBlock: { marginBottom: spacing.md },
  groupHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.saffronLight, borderWidth: 1, borderColor: colors.saffron300,
    borderRadius: radius.xl, paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    ...shadows.sm,
  },
  groupHeaderExpanded: {
    borderBottomLeftRadius: 0, borderBottomRightRadius: 0, borderBottomWidth: 0,
  },
  groupTitleWrap: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: spacing.sm },
  groupIconWrap: {
    width: 40, height: 40, borderRadius: radius.md, backgroundColor: colors.bgSurface,
    alignItems: 'center', justifyContent: 'center',
  },
  groupIconWrapMuted: { backgroundColor: colors.surfaceMuted },
  groupName: { ...typography.h4, color: colors.textPrimary },
  groupCount: { ...typography.bodySmall, color: colors.textSecondary, marginTop: 1, fontWeight: '500' },
  groupActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  groupDeleteBtn: { padding: 4 },
  groupCard: {
    backgroundColor: colors.saffronLight, borderRadius: radius.xl, borderTopLeftRadius: 0, borderTopRightRadius: 0,
    borderWidth: 1, borderTopWidth: 0, borderColor: colors.saffron300,
    padding: 6,
  },
  emptyGroupWrap: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs,
    paddingVertical: spacing.lg,
  },
  emptyGroup: { color: colors.textMuted, ...typography.bodySmall, fontWeight: '500' },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingVertical: 10, paddingHorizontal: spacing.sm,
    backgroundColor: colors.bgSurface, borderRadius: radius.lg, marginBottom: 6,
  },
  rowLast: { marginBottom: 0 },
  rowAvatar: {
    width: 34, height: 34, borderRadius: radius.md, backgroundColor: colors.saffronLight,
    alignItems: 'center', justifyContent: 'center',
  },
  rowAvatarOff: { backgroundColor: colors.surfaceMuted },
  rowAvatarText: { color: colors.saffronDark, fontWeight: '800', fontSize: 14 },
  rowAvatarTextOff: { color: colors.textTertiary },
  rowNameWrap: { flex: 1 },
  rowName: { ...typography.bodyLarge, color: colors.textPrimary, fontWeight: '600' },
  rowNameOff: { color: colors.textTertiary },
  rowMetaText: { ...typography.bodySmall, color: colors.textSecondary, fontSize: 12, marginTop: 1, fontWeight: '500' },
  variantGroup: {
    backgroundColor: colors.bgApp, paddingLeft: spacing.md + 34 + spacing.sm,
    borderRadius: radius.lg, marginBottom: 6,
  },
  variantRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingVertical: 8, paddingRight: spacing.md, borderTopWidth: 1, borderTopColor: colors.border,
  },
  variantRowFirst: { borderTopWidth: 0 },
  variantRowLast: { paddingBottom: 10 },
  variantDot: { width: 5, height: 5, borderRadius: radius.circle, backgroundColor: colors.saffronDark },
  variantDotOff: { backgroundColor: colors.textTertiary },
  variantName: { ...typography.bodySmall, color: colors.textSecondary, fontWeight: '500', flex: 1 },
  variantPrice: { ...typography.bodySmall, color: colors.textTertiary, fontSize: 12, fontWeight: '600' },
  rowMoveBtn: {
    width: 30, height: 30, borderRadius: radius.circle, backgroundColor: colors.saffronLight,
    alignItems: 'center', justifyContent: 'center',
  },
  emptyState: { alignItems: 'center', paddingHorizontal: spacing.xl, marginTop: spacing.xl },
  emptyIconWrap: {
    width: 72, height: 72, borderRadius: radius.circle, backgroundColor: colors.saffronLight,
    alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md,
  },
  emptyTitle: { ...typography.h3, color: colors.textPrimary },
  emptyText: {
    ...typography.body, color: colors.textSecondary, textAlign: 'center', marginTop: spacing.xs,
    lineHeight: 20, maxWidth: 260,
  },
  modalOverlay: {
    flex: 1, backgroundColor: colors.overlayDark, justifyContent: 'center', padding: spacing.lg,
  },
  modalCard: {
    backgroundColor: colors.bgSurface, borderRadius: radius.xxl, padding: spacing.xl, ...shadows.lg,
  },
  modalIconWrap: {
    width: 48, height: 48, borderRadius: radius.md, backgroundColor: colors.saffronLight,
    alignItems: 'center', justifyContent: 'center', marginBottom: spacing.sm,
  },
  modalTitle: { ...typography.h3, color: colors.textPrimary },
  modalSubtitle: { ...typography.bodySmall, color: colors.textSecondary, marginTop: 4, marginBottom: spacing.md, lineHeight: 18 },
  modalInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.input,
    paddingHorizontal: spacing.md, paddingVertical: 12, ...typography.bodyLarge, color: colors.textPrimary,
    backgroundColor: colors.bgApp, marginBottom: spacing.md,
  },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  modalCancelBtn: { paddingHorizontal: spacing.md, paddingVertical: 10, justifyContent: 'center' },
  modalCancelText: { color: colors.textSecondary, fontWeight: '700', fontSize: 14 },
  modalCreateBtn: { borderRadius: radius.button, overflow: 'hidden' },
  modalCreateDisabled: { opacity: 0.5 },
  modalCreateGradient: { paddingHorizontal: spacing.lg, paddingVertical: 11, alignItems: 'center' },
  modalCreateText: { color: colors.textInverse, fontWeight: '800', fontSize: 14 },
  pickerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 14, paddingHorizontal: spacing.xs, borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  pickerRowText: { ...typography.bodyLarge, color: colors.textPrimary, fontWeight: '500' },
  modalCancelBtnWide: { alignItems: 'center', paddingVertical: spacing.md, marginTop: spacing.xs },
});
