import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AppIcon from '../AppIcon';
import PressableScale from '../PressableScale';
import LocationPicker from '../LocationPicker';
import { colors, typography, spacing, radius, shadows } from '../../theme';
import { searchPlaces } from '../../utils/mapboxGeocoding';
import { mapboxAvailable } from '../../utils/mapbox';

const SEARCH_DEBOUNCE_MS = 350;
// A confirmed point must be within ~50m of the searched place for that
// place's name to still be an honest label for it. 0.0005 degrees is roughly
// that at these latitudes, and is far below the width of any village.
const LABEL_MATCH_TOLERANCE_DEG = 0.0005;

/**
 * Full-screen "change delivery location" flow: search-by-name (village/area,
 * Mapbox geocoding with suggestions) plus the same pin-and-confirm map used
 * at checkout. Runs LocationPicker in immersive+inline mode inside our own
 * plain Modal/View — LocationPicker's own built-in (non-inline) Modal wraps
 * the map in nested Pressables that were swallowing pan gestures on Android,
 * so this flow always drives it in the mode already proven at checkout.
 */
function ChangeLocationModal({ visible, initialCenter, recentLocations = [], onSelectRecent, onConfirm, onClose }) {
  const insets = useSafeAreaInsets();
  const pickerRef = useRef(null);

  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selectedLabel, setSelectedLabel] = useState(null);
  const debounceRef = useRef(null);
  const abortRef = useRef(null);
  // Where the currently-held selectedLabel actually points.
  const labelCoordRef = useRef(null);

  useEffect(() => {
    if (!visible) {
      setQuery('');
      setSuggestions([]);
      setSearching(false);
      setSelectedLabel(null);
      labelCoordRef.current = null;
    }
  }, [visible]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort?.();

    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      setSearching(false);
      return undefined;
    }

    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const results = await searchPlaces(trimmed, {
          proximity: initialCenter
            ? { lat: initialCenter.latitude, lng: initialCenter.longitude }
            : undefined,
          signal: controller.signal,
        });
        setSuggestions(results);
      } catch (_) {
        // Aborted or network error — leave the previous suggestions as-is.
      } finally {
        setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const handleSelectSuggestion = useCallback((place) => {
    Keyboard.dismiss();
    setQuery(place.name);
    setSuggestions([]);
    setSelectedLabel(place.placeName || place.name);
    // Remember where the label belongs. Panning the map afterwards moves the
    // pin somewhere the label no longer describes, so onConfirm below drops
    // the label unless the confirmed point is still essentially this one.
    labelCoordRef.current = { lat: place.lat, lng: place.lng };
    pickerRef.current?.flyToCoordinate(place.lat, place.lng);
  }, []);

  const labelForConfirmedPoint = useCallback((lat, lng) => {
    const anchor = labelCoordRef.current;
    if (!selectedLabel || !anchor) return null;
    const moved = Math.abs(anchor.lat - lat) > LABEL_MATCH_TOLERANCE_DEG
      || Math.abs(anchor.lng - lng) > LABEL_MATCH_TOLERANCE_DEG;
    return moved ? null : selectedLabel;
  }, [selectedLabel]);

  const handleClose = useCallback(() => {
    Keyboard.dismiss();
    onClose?.();
  }, [onClose]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <PressableScale
            onPress={handleClose}
            style={styles.closeBtn}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <AppIcon name="close" size={20} color={colors.textPrimary} />
          </PressableScale>
          <Text style={styles.headerTitle}>Change delivery location</Text>
        </View>

        {recentLocations.length > 0 ? (
          <View style={styles.recentLocations}>
            <Text style={styles.recentLocationsTitle}>Last saved location</Text>
            {recentLocations.map((location) => (
              <PressableScale
                key={`${location.lat}:${location.lng}`}
                onPress={() => onSelectRecent?.(location)}
                style={styles.recentLocationRow}
              >
                <AppIcon name="location" size={15} color={colors.saffron} />
                <Text style={styles.recentLocationText} numberOfLines={1}>
                  {location.label || 'Last saved location'}
                </Text>
              </PressableScale>
            ))}
          </View>
        ) : null}

        <View style={styles.mapArea}>
          <LocationPicker
            apiRef={pickerRef}
            inline
            immersive
            centeredPin
            autoLocateOnMount={!initialCenter}
            initialCenter={initialCenter}
            onConfirm={(lat, lng) => onConfirm?.(lat, lng, labelForConfirmedPoint(lat, lng))}
            onMapTouchStart={() => { setSuggestions([]); Keyboard.dismiss(); }}
            showZoneOverlay
          />

          {mapboxAvailable ? (
            <View style={[styles.searchWrap, { top: spacing.md }]} pointerEvents="box-none">
              <View style={styles.searchBar}>
                <AppIcon name="search" size={16} color={colors.textTertiary} />
                <TextInput
                  value={query}
                  onChangeText={setQuery}
                  // Deliberately no blur handler that clears the suggestion
                  // list: tapping a suggestion blurs the input first, so
                  // clearing on blur unmounts the row before its onPress can
                  // fire and the results become untappable (reliably so on
                  // Android). The list is dismissed by selecting a row,
                  // clearing the query, or touching the map (onMapTouchStart).
                  placeholder="Search your village or area"
                  placeholderTextColor={colors.textTertiary}
                  style={styles.searchInput}
                  returnKeyType="search"
                  autoCorrect={false}
                />
                {searching ? (
                  <ActivityIndicator size="small" color={colors.saffron} />
                ) : query.length > 0 ? (
                  <PressableScale
                    onPress={() => { setQuery(''); setSuggestions([]); }}
                    accessibilityRole="button"
                    accessibilityLabel="Clear search"
                  >
                    <AppIcon name="close" size={16} color={colors.textTertiary} />
                  </PressableScale>
                ) : null}
              </View>

              {suggestions.length > 0 ? (
                <View style={styles.suggestionsList}>
                  {suggestions.map((place, index) => (
                    <PressableScale
                      key={place.id}
                      onPress={() => handleSelectSuggestion(place)}
                      style={[
                        styles.suggestionRow,
                        index < suggestions.length - 1 && styles.suggestionRowDivider,
                      ]}
                    >
                      <AppIcon name="location" size={15} color={colors.saffron} />
                      <View style={styles.suggestionTextCol}>
                        <Text style={styles.suggestionName} numberOfLines={1}>{place.name}</Text>
                        <Text style={styles.suggestionPlace} numberOfLines={1}>{place.placeName}</Text>
                      </View>
                    </PressableScale>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
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
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  headerTitle: {
    ...typography.h4,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  recentLocations: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    gap: spacing.xs,
  },
  recentLocationsTitle: {
    ...typography.caption,
    color: colors.textSecondary,
    fontWeight: '700',
  },
  recentLocationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.bgSurface,
  },
  recentLocationText: {
    flex: 1,
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  mapArea: {
    flex: 1,
  },
  searchWrap: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    zIndex: 10,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgSurface,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    height: 46,
    ...shadows.md,
  },
  searchInput: {
    flex: 1,
    ...typography.body,
    color: colors.textPrimary,
    padding: 0,
  },
  suggestionsList: {
    marginTop: spacing.xs,
    backgroundColor: colors.bgSurface,
    borderRadius: radius.lg,
    overflow: 'hidden',
    ...shadows.md,
  },
  suggestionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  suggestionRowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  suggestionTextCol: {
    flex: 1,
    minWidth: 0,
  },
  suggestionName: {
    ...typography.label,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  suggestionPlace: {
    ...typography.caption,
    color: colors.textSecondary,
  },
});

export default ChangeLocationModal;
