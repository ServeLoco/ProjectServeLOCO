import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Location from 'expo-location';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, radius, shadows } from '../../theme';
import { riderApi } from '../../api';
import {
  Mapbox,
  DEFAULT_MAP_CENTER,
  mapboxAvailable,
} from '../../utils/mapbox';
import AnimatedRouteLine from '../AnimatedRouteLine';
import { RIDER_WATCH_OPTIONS, shouldSendPing } from '../../utils/riderTracking';

const CUSTOMER_COLOR = '#FF7A3A';
const OFF_ROUTE_METERS = 150;
// Min gap between Directions attempts — keeps a failing API from being re-hit
// on every location ping (cost budget: ~1-3 calls per delivery).
const DIRECTIONS_RETRY_COOLDOWN_MS = 30_000;

function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Haversine distance in meters. */
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function minDistanceToRouteMeters(lat, lng, routeCoords) {
  if (!routeCoords?.length) return Infinity;
  let min = Infinity;
  for (let i = 0; i < routeCoords.length; i += 1) {
    const [rlng, rlat] = routeCoords[i];
    const d = distanceMeters(lat, lng, rlat, rlng);
    if (d < min) min = d;
  }
  return min;
}

/** 🛵 scooty marker for the rider */
function ScootyMarker() {
  return (
    <View style={styles.scootyWrap} pointerEvents="none">
      <View style={styles.scootyBubble}>
        <Text style={styles.scootyEmoji}>🛵</Text>
      </View>
      <Text style={styles.scootyLabel}>You</Text>
    </View>
  );
}

/** Store-front marker — home only, soft pulse + bounce. */
function ShopMarker({ name }) {
  const pulse = useRef(new Animated.Value(0)).current;
  const bounce = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const pulseLoop = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 1600,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    );
    const bounceLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(bounce, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(bounce, {
          toValue: 0,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    pulseLoop.start();
    bounceLoop.start();
    return () => {
      pulseLoop.stop();
      bounceLoop.stop();
      pulse.setValue(0);
      bounce.setValue(0);
    };
  }, [pulse, bounce]);

  const ringScale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.55, 1.75],
  });
  const ringOpacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.5, 0],
  });
  const emojiScale = bounce.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.12],
  });
  const emojiY = bounce.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -3],
  });

  return (
    <View style={styles.shopWrap} pointerEvents="none">
      <View style={styles.shopIconStage}>
        <Animated.View
          style={[
            styles.shopPulseRing,
            { opacity: ringOpacity, transform: [{ scale: ringScale }] },
          ]}
        />
        <Animated.Text
          style={[
            styles.shopEmoji,
            { transform: [{ translateY: emojiY }, { scale: emojiScale }] },
          ]}
        >
          🏠
        </Animated.Text>
      </View>
      <Text style={styles.shopLabel} numberOfLines={1}>{name || 'Shop'}</Text>
    </View>
  );
}

/** Customer delivery pin */
function CustomerMarker() {
  return (
    <View style={styles.pinRoot} pointerEvents="none">
      <View style={[styles.pinHead, styles.customerPinHead]}>
        <Text style={styles.customerEmoji}>🏠</Text>
      </View>
      <View style={[styles.pinTail, styles.customerPinTail]} />
      <View style={[styles.pinLabel, styles.customerLabel]}>
        <Text style={styles.pinLabelText}>Customer</Text>
      </View>
    </View>
  );
}

/**
 * Rider-facing delivery map: shop(s) + rider GPS + customer + driving route.
 * Directions: one fetch on mount/waypoint change + re-fetch only when rider
 * drifts >150 m from the route polyline (MAP locked decision §4.7).
 */
export default function RiderDeliveryMap({ order, pickedUp, style, onRouteInfo }) {
  const insets = useSafeAreaInsets();
  // Edge-to-edge map: push overlays + Mapbox chrome below the status bar.
  // Extra gap so legend/compass never sit under system icons (clock, battery).
  const topPad = Math.max(insets.top, 0) + spacing.md;
  const cameraRef = useRef(null);
  const routeCoordsRef = useRef([]);
  const waypointKeyRef = useRef('');
  const directionsInFlightRef = useRef(false);
  const directionsLastAttemptRef = useRef(0);
  const lastSentRef = useRef(null);
  const [loading, setLoading] = useState(!order);
  const [riderCoord, setRiderCoord] = useState(null);
  const [routeGeoJson, setRouteGeoJson] = useState(null);
  const [routeInfo, setRouteInfo] = useState(null); // { distanceKm, etaMinutes }
  const pulse = useRef(new Animated.Value(0)).current;

  const customer = useMemo(() => {
    if (!order) return null;
    const lat = numOrNull(order.latitude ?? order.lat);
    const lng = numOrNull(order.longitude ?? order.lng);
    if (lat == null || lng == null) return null;
    return { latitude: lat, longitude: lng };
  }, [order]);

  const shops = useMemo(() => {
    const list = order?.shops || [];
    return list
      .map((s) => {
        const lat = numOrNull(s.latitude ?? s.lat);
        const lng = numOrNull(s.longitude ?? s.lng);
        if (lat == null || lng == null) return null;
        return { id: s.id, name: s.name, latitude: lat, longitude: lng };
      })
      .filter(Boolean);
  }, [order]);

  const waypointKey = useMemo(() => {
    const shopPart = shops.map((s) => `${s.id}:${s.latitude},${s.longitude}`).join('|');
    const custPart = customer
      ? `${customer.latitude},${customer.longitude}`
      : 'none';
    return `${pickedUp ? 'p1' : 'p0'}|${shopPart}|${custPart}`;
  }, [shops, customer, pickedUp]);

  useEffect(() => {
    if (order) setLoading(false);
  }, [order]);

  // Live GPS for rider pin (updates every sample, for a smooth marker) +
  // server location pings (first fix, then ~150 m / sharp turn — see
  // shouldSendPing). Also seeds an immediate position so the map is not
  // blank until first watch tick.
  useEffect(() => {
    let sub = null;
    let cancelled = false;

    const maybeSendPing = (next) => {
      const ping = { ...next, at: Date.now() };
      if (!shouldSendPing(lastSentRef.current, ping)) return;
      lastSentRef.current = ping;
      riderApi.updateLocation(next.latitude, next.longitude).catch(() => {});
    };

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (cancelled || status !== 'granted') return;

      try {
        const current = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        });
        if (!cancelled && current?.coords) {
          const { latitude, longitude, heading } = current.coords;
          if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
            setRiderCoord({ latitude, longitude });
            maybeSendPing({ latitude, longitude, heading });
          }
        }
      } catch (_) { /* watch still starts below */ }

      if (cancelled) return;

      const watchSub = await Location.watchPositionAsync(
        RIDER_WATCH_OPTIONS,
        (pos) => {
          const { latitude, longitude, heading } = pos.coords || {};
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
          setRiderCoord({ latitude, longitude });
          maybeSendPing({ latitude, longitude, heading });
        },
      );
      if (cancelled) {
        watchSub?.remove?.();
        return;
      }
      sub = watchSub;
    })();

    return () => {
      cancelled = true;
      sub?.remove?.();
    };
  }, []);

  useEffect(() => {
    if (!riderCoord) return undefined;
    const loop = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 1200,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [riderCoord, pulse]);

  const fetchRoute = useCallback(async ({ force = false } = {}) => {
    if (!mapboxAvailable || !customer) return;
    const token = process.env.EXPO_PUBLIC_MAPBOX_PUBLIC_TOKEN;
    if (!token) return;
    if (directionsInFlightRef.current) return;

    const stops = [];
    if (riderCoord) stops.push(riderCoord);
    if (!pickedUp && shops.length > 0) {
      shops.forEach((s) => stops.push(s));
    }
    stops.push(customer);
    if (stops.length < 2) return;

    const hasRoute = routeCoordsRef.current.length >= 2;
    const waypointsChanged = waypointKey !== waypointKeyRef.current;

    if (!force && hasRoute && !waypointsChanged) {
      // Only re-fetch when rider drifts >150 m from the polyline.
      if (riderCoord) {
        const drift = minDistanceToRouteMeters(
          riderCoord.latitude,
          riderCoord.longitude,
          routeCoordsRef.current,
        );
        if (drift <= OFF_ROUTE_METERS) return;
      } else {
        return;
      }
    }

    const now = Date.now();
    // Cooldown applies even before the first successful route — otherwise a
    // failing Directions call (bad token, network) gets retried on every GPS
    // sample (~3s) instead of waiting out the cooldown like the customer map
    // (RiderLiveMap.js) already does. directionsLastAttemptRef starts at 0,
    // so the very first attempt is never blocked by this.
    if (!force && now - directionsLastAttemptRef.current < DIRECTIONS_RETRY_COOLDOWN_MS) {
      return;
    }
    directionsLastAttemptRef.current = now;
    directionsInFlightRef.current = true;

    const coordStr = stops.map((p) => `${p.longitude},${p.latitude}`).join(';');
    try {
      const url =
        `https://api.mapbox.com/directions/v5/mapbox/driving/${coordStr}` +
        `?geometries=geojson&overview=full&access_token=${encodeURIComponent(token)}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const route = data?.routes?.[0];
      const coords = route?.geometry?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return;
      routeCoordsRef.current = coords;
      waypointKeyRef.current = waypointKey;
      setRouteGeoJson({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: coords },
      });
      if (Number.isFinite(route.distance) && Number.isFinite(route.duration)) {
        const info = {
          distanceKm: route.distance / 1000,
          etaMinutes: Math.round(route.duration / 60),
        };
        setRouteInfo(info);
        onRouteInfo?.(info);
      }
    } catch (_) {
      // Keep last route on network / Directions failure.
    } finally {
      directionsInFlightRef.current = false;
    }
  }, [riderCoord, customer, shops, pickedUp, waypointKey, onRouteInfo]);

  // Fetch on mount / GPS / waypoint changes. fetchRoute itself decides whether
  // a Directions call is needed (first route, waypoint change, or >150 m drift).
  useEffect(() => {
    const waypointsChanged = waypointKey !== waypointKeyRef.current;
    const needsForce = waypointsChanged && Boolean(customer);
    fetchRoute({ force: needsForce });
  }, [fetchRoute, waypointKey, customer]);

  const fitAll = useCallback(() => {
    if (!cameraRef.current) return;
    const points = [];
    if (riderCoord) points.push(riderCoord);
    shops.forEach((s) => points.push(s));
    if (customer) points.push(customer);
    if (points.length === 0) return;
    try {
      const lngs = points.map((p) => p.longitude);
      const lats = points.map((p) => p.latitude);
      // Padding: top / right / bottom / left — leave room for status bar + sheet.
      cameraRef.current.fitBounds(
        [Math.max(...lngs), Math.max(...lats)],
        [Math.min(...lngs), Math.min(...lats)],
        [topPad + 48, 40, 200, 40],
        500,
      );
    } catch (_) { /* ignore */ }
  }, [riderCoord, shops, customer, topPad]);

  // Auto-fit only on real context changes (new assignment, or the
  // shop/customer waypoint set changing — e.g. pickup happened). Deliberately
  // NOT keyed on `fitAll` itself, which is recreated on every GPS tick
  // (riderCoord updates every few seconds) — including it here was snapping
  // the camera back to fitBounds() on every tick, fighting the rider's manual
  // zoom/pan (reported bug: map "auto centers" and won't stay where shifted).
  useEffect(() => {
    const t = setTimeout(fitAll, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id, waypointKey]);

  // One-time fit when the rider's GPS fix first resolves, so the initial
  // view frames the rider dot too — but never again after that, so later
  // ticks can't re-trigger it.
  const riderFirstFitDoneRef = useRef(false);
  useEffect(() => {
    if (!riderCoord || riderFirstFitDoneRef.current) return undefined;
    riderFirstFitDoneRef.current = true;
    const t = setTimeout(fitAll, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [riderCoord]);

  const center = customer || shops[0] || riderCoord || DEFAULT_MAP_CENTER;

  if (loading) {
    return (
      <View style={[styles.wrap, style, styles.centered]}>
        <ActivityIndicator color={colors.saffron} />
      </View>
    );
  }

  if (!mapboxAvailable) {
    return (
      <View style={[styles.wrap, style, styles.centered]}>
        <Text style={styles.errorText}>Map unavailable — Mapbox token missing</Text>
      </View>
    );
  }

  return (
    <View style={[styles.wrap, style]}>
      <Mapbox.MapView
        style={styles.map}
        styleURL={Mapbox.StyleURL.SatelliteStreet}
        compassEnabled
        // Margins are from the map edges; y must clear status bar + leave a gap.
        compassViewMargins={{ x: 12, y: topPad }}
        scaleBarEnabled={false}
      >
        <Mapbox.Camera
          ref={cameraRef}
          defaultSettings={{
            centerCoordinate: [center.longitude, center.latitude],
            zoomLevel: 13,
          }}
        />

        <AnimatedRouteLine
          routeGeoJson={routeGeoJson}
          active={Boolean(routeGeoJson)}
          idPrefix="rider-delivery"
        />

        {shops.map((shop) => (
          <Mapbox.MarkerView
            key={`shop-${shop.id}`}
            id={`shop-${shop.id}`}
            coordinate={[shop.longitude, shop.latitude]}
            allowOverlap
            anchor={{ x: 0.5, y: 1 }}
          >
            <ShopMarker name={shop.name} />
          </Mapbox.MarkerView>
        ))}

        {customer ? (
          <Mapbox.MarkerView
            id="customer-dest"
            coordinate={[customer.longitude, customer.latitude]}
            allowOverlap
            anchor={{ x: 0.5, y: 1 }}
          >
            <CustomerMarker />
          </Mapbox.MarkerView>
        ) : null}

        {riderCoord ? (
          <Mapbox.MarkerView
            id="rider-self"
            coordinate={[riderCoord.longitude, riderCoord.latitude]}
            allowOverlap
            anchor={{ x: 0.5, y: 0.5 }}
          >
            <ScootyMarker />
          </Mapbox.MarkerView>
        ) : null}
      </Mapbox.MapView>

      <View style={[styles.legend, { top: topPad }]} pointerEvents="none">
        <View style={styles.legendItem}>
          <Text style={styles.legendEmoji}>🛵</Text>
          <Text style={styles.legendText}>You</Text>
        </View>
        <View style={styles.legendItem}>
          <Text style={styles.legendEmoji}>🏠</Text>
          <Text style={styles.legendText}>Shop</Text>
        </View>
        <View style={styles.legendItem}>
          <Text style={styles.legendEmoji}>🏠</Text>
          <Text style={styles.legendText}>Customer</Text>
        </View>
      </View>

      {routeInfo ? (
        <View style={styles.routeInfoChip}>
          <Text style={styles.routeInfoText}>
            {routeInfo.distanceKm.toFixed(1)} km · {routeInfo.etaMinutes} min
          </Text>
        </View>
      ) : null}

      {!customer ? (
        <View style={[styles.warnChip, { top: topPad }]}>
          <Text style={styles.warnText}>Customer pin missing on this order</Text>
        </View>
      ) : null}
      {shops.length === 0 ? (
        <View style={[styles.warnChip, { top: topPad + 36 }]}>
          <Text style={styles.warnText}>No shop location set — ask admin</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    minHeight: 280,
    backgroundColor: colors.bgInput,
    overflow: 'hidden',
  },
  map: { flex: 1 },
  centered: { alignItems: 'center', justifyContent: 'center' },
  errorText: { color: colors.error, fontWeight: '600', textAlign: 'center', padding: spacing.md },

  scootyWrap: { alignItems: 'center' },
  scootyBubble: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#fff',
    borderWidth: 3,
    borderColor: '#8b5cf6',
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.md,
  },
  scootyEmoji: { fontSize: 26 },
  scootyLabel: {
    marginTop: 2,
    fontSize: 10,
    fontWeight: '800',
    color: '#5b21b6',
    backgroundColor: '#ede9fe',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 8,
  },

  shopWrap: { alignItems: 'center', maxWidth: 90 },
  shopIconStage: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shopPulseRing: {
    position: 'absolute',
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(22, 163, 74, 0.28)',
    borderWidth: 2,
    borderColor: 'rgba(22, 163, 74, 0.75)',
  },
  shopEmoji: {
    fontSize: 32,
    lineHeight: 36,
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.45)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  shopLabel: {
    marginTop: 2,
    fontSize: 9,
    fontWeight: '800',
    color: '#fff',
    textShadowColor: 'rgba(0,0,0,0.55)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
    maxWidth: 88,
    textAlign: 'center',
  },

  pinRoot: { alignItems: 'center', width: 72 },
  pinHead: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2.5,
    borderColor: '#fff',
    ...shadows.md,
  },
  pinTail: {
    width: 12,
    height: 12,
    marginTop: -8,
    transform: [{ rotate: '45deg' }],
  },
  customerPinHead: { backgroundColor: CUSTOMER_COLOR },
  customerPinTail: { backgroundColor: '#E05A1A' },
  customerEmoji: { fontSize: 16 },
  pinLabel: {
    marginTop: 4,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  customerLabel: { backgroundColor: CUSTOMER_COLOR },
  pinLabelText: { color: '#fff', fontSize: 10, fontWeight: '800' },

  legend: {
    position: 'absolute',
    // top set at runtime via safe-area insets (status bar / notch)
    left: spacing.sm,
    // content-sized only — do not stretch under the compass
    maxWidth: '72%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: 'rgba(255,255,255,0.95)',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.lg,
    ...shadows.sm,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendEmoji: { fontSize: 14 },
  legendText: { fontSize: 10, fontWeight: '700', color: colors.textSecondary },

  routeInfoChip: {
    position: 'absolute',
    bottom: spacing.sm,
    right: spacing.sm,
    backgroundColor: 'rgba(37, 99, 235, 0.95)',
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.md,
    ...shadows.sm,
  },
  routeInfoText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#fff',
  },
  warnChip: {
    position: 'absolute',
    // top set at runtime via safe-area insets
    right: spacing.sm,
    maxWidth: '55%',
    backgroundColor: colors.warningLight,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.md,
  },
  warnText: { fontSize: 10, fontWeight: '700', color: colors.warning },
});
