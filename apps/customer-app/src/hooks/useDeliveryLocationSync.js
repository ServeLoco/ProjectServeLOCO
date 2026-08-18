import { useEffect } from 'react';
import { AppState } from 'react-native';
import * as Location from 'expo-location';
import { cartApi, bootstrapApi, emitAreaChanged } from '../api';
import { useDeliveryLocationStore } from '../stores/useDeliveryLocationStore';
import { useCartStore } from '../stores/useCartStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { normalizeCartCalculation, normalizeSettings } from '../utils/apiMappers';
import { showToast } from '../components/Toast';
import { invalidate } from '../utils/apiCache';

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

// Mirrors bootstrapRoutes.js's bootstrapCatalogETag exactly — sending back
// anything else just means the server never 304s and a full body comes back
// (correct, just not the fast path). Shared with HomeScreen's own cold-start
// bootstrap call so the format can't drift between the two call sites.
function buildAreaETag({ areaId, zoneId, catalogVersion }) {
  return areaId != null && catalogVersion != null
    ? `"${areaId}-${zoneId ?? 'none'}-${catalogVersion}"`
    : undefined;
}

// TASK 29.1/29.2/29.3 — an AREA change, not merely a zone change within the
// same area: clear the cart (an area-1-priced cart must never reach
// checkout against area-2 zones — §2.4), drop the SWR catalog/dashboard
// cache (ProductListScreen's search results ride the same `products:` key
// as browsing — see its own cache-key comment — so this covers search too,
// 29.2's "clear cached search results"), and push the socket into the new
// area's room so admin broadcasts reach it. Deliberately only fires between
// two REAL areas (both non-null, and different) — a first-ever resolve
// (null -> id) has nothing assembled against the wrong area yet, and a pin
// that leaves every zone (id -> null) is already covered by the existing
// "we don't deliver here yet" gate (29.4) without needing a cart wipe.
function invalidateForAreaChange(newAreaId) {
  useCartStore.getState().clearCart();
  invalidate('products:');
  invalidate('product:');
  invalidate('categories:');
  invalidate('dashboard:');
  emitAreaChanged(newAreaId);
}

// Fans a GET /bootstrap response out into the two stores it feeds. Shared
// between this hook's own periodic sync and HomeScreen's cold-start call so
// "what a bootstrap response means" is defined exactly once (§4.5-style
// chokepoint). A 304 (null) is a deliberate no-op — the caller keeps
// whatever it already had.
function applyBootstrapResult(result) {
  // A null bootstrap result is a successful conditional GET (304). Mark the
  // settings fresh too, otherwise each pull-to-refresh immediately schedules
  // an avoidable settings request even though bootstrap confirmed it is fresh.
  if (result === null) {
    useSettingsStore.getState().markFetched();
    return;
  }
  const previousAreaId = useDeliveryLocationStore.getState().areaId;
  const nextAreaId = result.area?.id ?? null;
  useDeliveryLocationStore.getState().setAreaInfo({
    deliverable: Boolean(result.deliverable),
    areaId: nextAreaId,
    areaName: result.area?.name ?? null,
    brandColor: result.area?.brandColor ?? result.area?.brand_color ?? null,
    catalogVersion: result.catalogVersion ?? null,
  });
  if (previousAreaId != null && nextAreaId != null && previousAreaId !== nextAreaId) {
    invalidateForAreaChange(nextAreaId);
  }
  // 28.6 — support_phone/whatsapp_number/UPI must reflect the resolved
  // area, not a stale globally-cached value. Same store, same normalizer
  // CheckoutScreen/ProfileScreen/OrderDetailScreen already read from.
  if (result.settings) {
    useSettingsStore.getState().setSettings(normalizeSettings(result));
  }
}

// TASK 28.1/28.2/28.5 — resolves the pin's area/zone/settings/storeModes/
// catalogVersion in one round trip. Kept separate from checkInsideZone
// (still the source of truth for insideZone) rather than replacing it:
// bootstrap's `zone` comes from the same matchZone chain but knows nothing
// about exclusion zones, which checkInsideZone's cart/calculate call
// deliberately does — see its own comment. Sends the previously stored
// area+zone+catalogVersion back as If-None-Match so an unchanged area/zone
// comes back as a bare 304. Best-effort: any failure leaves the store's
// existing area/settings exactly as they were, same as every other
// best-effort call in this hook.
async function syncAreaInfo(lat, lng) {
  const { areaId, zoneId, catalogVersion } = useDeliveryLocationStore.getState();
  try {
    const result = await bootstrapApi.getBootstrap({
      latitude: lat, longitude: lng, ifNoneMatch: buildAreaETag({ areaId, zoneId, catalogVersion }),
    });
    applyBootstrapResult(result);
  } catch (_) {
    // Best-effort — see comment above.
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
    // This call is fire-and-forget from sync()'s point of view and can take
    // an abnormally long time to resolve (slow network, slow device) — long
    // enough for the customer to have since moved to a different pin. Apply
    // the result only if `lat`/`lng` are still the pin currently in effect;
    // otherwise this is a stale answer to a question nobody's asking
    // anymore, and pruning/re-pricing the cart against it would be wrong.
    const currentCoords = useDeliveryLocationStore.getState().coords;
    if (currentCoords?.lat !== lat || currentCoords?.lng !== lng) return;
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
// Flipped by the first live GPS fix actually stored in this JS process. Module
// scope is the point: a full app close+reopen builds a fresh JS context, so
// this resets exactly when a cold start happens and never on a warm resume.
// It is deliberately NOT set when the fix is skipped (permission not granted,
// GPS timeout) — otherwise a cold start that only gets permission part-way
// through would burn the override on a sync that never wrote anything.
let coldStartGpsApplied = false;

// Test seam. In the app this state resets only when the JS context is rebuilt
// (a real cold start), which tests cannot reproduce — so they set the side of
// that boundary they mean to exercise instead of depending on execution order.
function __setColdStartGpsAppliedForTests(value) {
  coldStartGpsApplied = value;
}

// Persisted coords/source land asynchronously from AsyncStorage. Deciding the
// manual-pin branch before that arrives would both misread `source` and let a
// late hydration overwrite the fix this sync just stored.
function waitForHydration() {
  const persistApi = useDeliveryLocationStore.persist;
  if (!persistApi?.onFinishHydration || persistApi.hasHydrated?.()) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      resolve();
    };
    const unsubscribe = persistApi.onFinishHydration(finish);
    // Hydration can land between the check above and this subscription, which
    // would leave nothing left to fire `finish`.
    if (persistApi.hasHydrated?.()) finish();
  });
}

/**
 * One-shot: obtains the customer's delivery location — live GPS unless
 * they've dropped a manual pin (Home's "Change Location", which wins until
 * they change it again) — and checks it against the admin's delivery zones.
 * Feeds useDeliveryLocationStore, which Home reads for the outside-zone
 * banner and Cart/Checkout read for pricing. Exported so
 * LocationPermissionGate can fire it the instant permission is granted,
 * instead of waiting for the next foreground/background cycle.
 *
 * The one exception to "manual pin wins": the first live fix after a cold
 * start always becomes the default delivery location. That is tracked by
 * process state rather than a caller-passed flag because the launch that ends
 * up applying it varies — with permission already granted it is App's
 * mount-time call, but when the customer grants permission during the launch
 * that call bails early and the Home permission card / LocationPermissionGate
 * fires the sync that actually lands the fix.
 */
async function syncDeliveryLocation() {
  lastSyncAt = Date.now();
  const { markInitialSyncComplete } = useDeliveryLocationStore.getState();
  // The outer Promise.race below only stops the CALLER from waiting past
  // INITIAL_SYNC_TIMEOUT_MS — it does not cancel `sync()`, which keeps
  // running for as long as the real GPS fetch takes (device GPS can hang
  // well past its own GPS_TIMEOUT_MS on some hardware). Without this flag,
  // a sync the app has already given up on can still resolve seconds later
  // — after the customer has moved on and started shopping normally — and
  // silently apply a now-irrelevant location fix, right down to revalidating
  // (and pruning) whatever they've since added to the cart. Once the race
  // times out this sync is abandoned: it may still finish, but every
  // side-effecting continuation below checks this first and no-ops instead.
  let abandoned = false;

  const sync = async () => {
    await waitForHydration();

    const {
      coords, source, zoneId: previousZoneId,
      setGpsLocation, setInsideZone, setZone,
    } = useDeliveryLocationStore.getState();

    // See coldStartGpsApplied above — true only until this process has stored
    // its first live fix, which is what lets a cold start override a manual pin.
    const forceGps = !coldStartGpsApplied;

    if (!forceGps && source === 'manual' && coords) {
      // Re-validate the saved pin (a zone may have since changed/been
      // removed) without moving it — only Home's Change Location does that.
      const [result] = await Promise.all([
        checkInsideZone(coords.lat, coords.lng),
        syncAreaInfo(coords.lat, coords.lng),
      ]);
      if (abandoned) return;
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
    // The GPS fetch above can take up to GPS_TIMEOUT_MS (8s) — long enough
    // for the customer to open Change Location and confirm a NEW manual pin
    // while this fix is still in flight. That explicit, later choice must
    // win: applying a GPS fix gathered before it would silently snap the
    // pin back and (via syncAreaInfo's area-mismatch check) wipe whatever
    // they just added to the cart under the manual pin's area. Only bail
    // when the store actually changed underneath this await — a `source`
    // that was ALREADY 'manual' before this sync started must still be
    // overridden once, same as always (that's the cold-start-GPS-wins
    // rule this function exists to enforce).
    const storeNow = useDeliveryLocationStore.getState();
    if (abandoned || storeNow.source !== source || storeNow.coords?.lat !== coords?.lat || storeNow.coords?.lng !== coords?.lng) {
      return;
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
    const [result] = await Promise.all([
      checkInsideZone(latitude, longitude),
      syncAreaInfo(latitude, longitude),
    ]);
    // Re-check after this second network round trip too — the customer can
    // just as easily act during checkInsideZone/syncAreaInfo as during the
    // GPS fetch itself, and `abandoned` may have flipped while we awaited.
    if (abandoned) return;
    setGpsLocation(
      latitude,
      longitude,
      result?.insideZone ?? null,
      result?.zoneName ?? null,
      result?.zoneId ?? null,
      { force: forceGps },
    );
    // Only now — a fix was actually stored, so the cold-start override is
    // spent and every later sync this process respects the manual pin again.
    coldStartGpsApplied = true;
    if (result !== null && result.zoneId !== previousZoneId) {
      revalidateCartForZoneChange(latitude, longitude);
    }
  };

  let timeoutId;
  try {
    await Promise.race([
      sync(),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => {
          abandoned = true;
          resolve();
        }, INITIAL_SYNC_TIMEOUT_MS);
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
 * (throttled). The mount call is normally the one that applies the
 * cold-start live-GPS default; when permission is still ungranted it bails
 * and whichever sync follows the grant applies it instead.
 */
function useDeliveryLocationSync() {
  useEffect(() => {
    syncDeliveryLocation();

    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      if (Date.now() - lastSyncAt < MIN_REFRESH_INTERVAL_MS) return;
      syncDeliveryLocation();
    });

    return () => sub.remove();
  }, []);
}

export {
  useDeliveryLocationSync, syncDeliveryLocation, __setColdStartGpsAppliedForTests,
  buildAreaETag, applyBootstrapResult,
};
