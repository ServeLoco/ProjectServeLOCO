import { useEffect } from 'react';
import { AppState } from 'react-native';
import * as Location from 'expo-location';
import { cartApi } from '../api';
import { useDeliveryLocationStore } from '../stores/useDeliveryLocationStore';
import { useCartStore } from '../stores/useCartStore';
import { normalizeCartCalculation } from '../utils/apiMappers';
import { showToast } from '../components/Toast';

const GPS_TIMEOUT_MS = 8000;
const INITIAL_SYNC_TIMEOUT_MS = 10_000;
// Widest fix (metres) we will accept as evidence of which zone the customer
// is standing in. Delivery zones here span roughly 2 km, so anything coarser
// than this cannot place someone reliably. iOS returns a fix fuzzed by
// kilometres whenever "Precise Location" is off for the app, and — unlike
// Android's approximate-permission case, which requestPreciseLocationPermission
// already filters — expo-location exposes no precise/reduced flag on iOS, so
// coords.accuracy is the only signal available.
const MAX_TRUSTED_FIX_ACCURACY_M = 1000;
// Throttles the AppState-active re-check so returning from a quick
// backgrounding (e.g. a notification) doesn't re-fire GPS + a network call.
const MIN_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// Resolves zone membership for a coordinate by reusing the cart pricing
// resolver (empty item list) instead of duplicating matchZone's
// point-in-polygon + parent/child nesting logic on the client. Also surfaces
// the admin-assigned zone name so Home can label the pin with it instead of
// a reverse-geocoded address.
async function checkInsideZone(lat, lng) {
  try {
    const res = await cartApi.calculate({ items: [], latitude: lat, longitude: lng });
    const body = res?.data || res || {};
    const outOfRange = Boolean(body.outOfRange ?? body.out_of_range);
    // An exclusion square reports outOfRange: false but still blocks delivery
    // outright — treating it as "inside" would show the normal dashboard and
    // only fail at Place Order. Deliverable means neither.
    const excluded = Boolean(body.excluded ?? body.is_excluded);
    const zone = body.deliveryZone || body.delivery_zone || null;
    return {
      insideZone: !outOfRange && !excluded,
      zoneName: zone?.name || null,
      zoneId: zone?.id ?? null,
    };
  } catch (_) {
    return null; // unknown — see the callers' handling below
  }
}

// The cart persists across a pin move and only ever reconciled PRICES (via
// applyCatalogProductPrices on catalog screens) — never re-checked
// availability against wherever the pin ended up. Neither shops nor products
// carry a zone yet, so there is nothing zone-specific to drop today, but
// shop-closed / OOS lines picked up in one zone are exactly what a full
// cart/calculate call also catches, and that mechanism needs to run
// proactively on a zone change rather than waiting for the customer to
// happen to open Cart/Checkout. Same pattern CartScreen/CheckoutScreen
// already use for their own recalculations.
async function revalidateCartForZoneChange(lat, lng) {
  const { items } = useCartStore.getState();
  if (!Array.isArray(items) || items.length === 0) return;

  try {
    const payload = {
      items: items.map((item) => {
        const type = item.type || (item.product?.isCombo || item.product?.is_combo ? 'combo' : 'product');
        return {
          productId: item.product.id,
          variantId: item.variant?.id ?? null,
          quantity: item.quantity,
          type,
          isCombo: type === 'combo',
        };
      }),
      latitude: lat,
      longitude: lng,
    };
    const bill = normalizeCartCalculation(await cartApi.calculate(payload));
    useCartStore.getState().syncItemPricesFromServer(bill.items);
    if (bill.unavailableItems?.length) {
      const removed = useCartStore.getState().removeUnavailableItems(bill.unavailableItems);
      if (removed.length > 0) {
        const names = removed.map((r) => r.product?.name).filter(Boolean);
        const label = names.length === 1 ? names[0] : `${names.length} items`;
        showToast(`${label} removed — unavailable at this location`, { type: 'info' });
      }
    }
  } catch (_) {
    // Best-effort — the next cart/checkout open reconciles anyway.
  }
}

let lastSyncAt = 0;

/**
 * One-shot: obtains the customer's delivery location — live GPS unless
 * they've dropped a manual pin (Home's "Change Location", which wins until
 * they change it again on a resume sync) — and checks it against the admin's
 * delivery zones. Feeds useDeliveryLocationStore, which Home reads for the
 * outside-zone banner and Cart/Checkout read for pricing. Exported so
 * LocationPermissionGate can fire it the instant permission is granted,
 * instead of waiting for the next foreground/background cycle.
 *
 * `coldStart`: true only for the mount-time call from a full app
 * close+reopen — live GPS overrides even a saved manual pin as the default
 * in that case. Foreground-resume calls omit it, keeping the manual pin's
 * normal precedence.
 */
async function syncDeliveryLocation({ coldStart = false } = {}) {
  lastSyncAt = Date.now();
  const {
    coords, source, zoneId: previousZoneId,
    setGpsLocation, setInsideZone, setZone, markInitialSyncComplete,
  } = useDeliveryLocationStore.getState();

  const sync = async () => {
    // A full app close+reopen always defaults to live GPS, even over a saved
    // manual pin — only a background/foreground resume respects the manual
    // pin's normal precedence.
    if (!coldStart && source === 'manual' && coords) {
      // Re-validate the saved pin (a zone may have since changed/been
      // removed) without moving it — only Home's Change Location does that.
      const result = await checkInsideZone(coords.lat, coords.lng);
      if (result !== null) {
        setInsideZone(result.insideZone);
        setZone(result.zoneName, result.zoneId);
        if (result.zoneId !== previousZoneId) {
          revalidateCartForZoneChange(coords.lat, coords.lng);
        }
      } else {
        // Check failed (offline, server down). insideZone is persisted, so a
        // stale `true` would resume asserting "verified deliverable" for a
        // pin nobody could actually check — downgrade that to null (unknown).
        //
        // A stale `false` is deliberately KEPT. Every gate tests
        // `insideZone === false`, so null reads as allowed: clearing a
        // confirmed out-of-zone pin to null would hand the full catalogue to
        // a customer we already know we cannot deliver to, on nothing worse
        // than a dropped connection. Losing a block is far more costly than
        // holding a stale one, and the next successful check lifts it.
        if (useDeliveryLocationStore.getState().insideZone !== false) {
          setInsideZone(null);
          setZone(null, null);
        }
      }
      return;
    }

    const perm = await Location.getForegroundPermissionsAsync();
    if (!perm?.granted) {
      useDeliveryLocationStore.getState().clearGpsLocation();
      return;
    }
    // Timer is cleared either way — an uncleared 8s handle keeps the JS
    // runtime awake and fires long after a fast fix already resolved.
    let gpsTimeoutId;
    let position;
    try {
      position = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        new Promise((_, reject) => {
          gpsTimeoutId = setTimeout(() => reject(new Error('GPS_TIMEOUT')), GPS_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (gpsTimeoutId) clearTimeout(gpsTimeoutId);
    }
    const { latitude, longitude, accuracy } = position.coords;
    // A fix too coarse to place the customer must not produce a zone verdict:
    // it would report a customer standing inside a zone as out of range, and
    // on a cold start the `force` below would overwrite the manual pin they
    // set precisely to avoid that. Leaving state untouched keeps the last
    // known pin and lets Home offer the location picker instead.
    if (typeof accuracy === 'number' && accuracy > MAX_TRUSTED_FIX_ACCURACY_M) {
      return;
    }
    const result = await checkInsideZone(latitude, longitude);
    setGpsLocation(
      latitude,
      longitude,
      result?.insideZone ?? null,
      result?.zoneName ?? null,
      result?.zoneId ?? null,
      { force: coldStart },
    );
    if (result !== null && result.zoneId !== previousZoneId) {
      revalidateCartForZoneChange(latitude, longitude);
    }
  };

  let timeoutId;
  try {
    await Promise.race([
      sync(),
      new Promise((resolve) => {
        timeoutId = setTimeout(resolve, INITIAL_SYNC_TIMEOUT_MS);
      }),
    ]);
  } catch (_) {
    // Best-effort — banner/pricing just fall back to whatever was last saved.
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    markInitialSyncComplete();
  }
}

/**
 * Global, always-mounted (once authenticated) background sync — runs
 * syncDeliveryLocation() on mount and again on each foreground resume
 * (throttled).
 */
function useDeliveryLocationSync() {
  useEffect(() => {
    syncDeliveryLocation({ coldStart: true });

    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      if (Date.now() - lastSyncAt < MIN_REFRESH_INTERVAL_MS) return;
      syncDeliveryLocation();
    });

    return () => sub.remove();
  }, []);
}

export { useDeliveryLocationSync, syncDeliveryLocation };
