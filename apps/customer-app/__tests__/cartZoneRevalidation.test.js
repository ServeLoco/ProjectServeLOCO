/**
 * The cart persists across a pin move and used to only reconcile prices
 * (applyCatalogProductPrices, on catalog screens) — never re-checked
 * availability against wherever the pin ended up. syncDeliveryLocation now
 * revalidates the cart against cart/calculate as soon as the resolved zone
 * id actually changes, dropping unavailable lines the same way
 * Cart/Checkout already do for their own recalculations.
 */
jest.mock('../src/api', () => ({
  cartApi: { calculate: jest.fn() },
  bootstrapApi: { getBootstrap: jest.fn() },
  emitAreaChanged: jest.fn(),
}));
jest.mock('../src/components/Toast', () => ({ showToast: jest.fn() }));

const Location = require('expo-location');
const { cartApi, bootstrapApi, emitAreaChanged } = require('../src/api');
const { showToast } = require('../src/components/Toast');
const { useDeliveryLocationStore } = require('../src/stores/useDeliveryLocationStore');
const { useCartStore } = require('../src/stores/useCartStore');
const { useSettingsStore } = require('../src/stores/useSettingsStore');
const {
  syncDeliveryLocation,
  __setColdStartGpsAppliedForTests,
} = require('../src/hooks/useDeliveryLocationSync');

const CART_ITEM = {
  product: { id: 501, name: 'Milk 1L', price: 40, available: true },
  quantity: 2,
  type: 'product',
  variant: null,
};

function zoneCalculateResponse({ zoneId, zoneName, unavailableItems = [] }) {
  return {
    outOfRange: false,
    excluded: false,
    deliveryZone: zoneId != null ? { id: zoneId, name: zoneName } : null,
    items: [{ id: 501, type: 'product', unitPrice: 40 }],
    unavailableItems,
  };
}

describe('syncDeliveryLocation revalidates the cart on a zone change', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Steady state: this process already applied its cold-start live-GPS
    // default, so the normal manual-pin-wins rule is in force. Without this
    // the suite only passed in file order — the first test to store a fix
    // silently spent the override for every test after it.
    __setColdStartGpsAppliedForTests(true);
    useDeliveryLocationStore.setState({
      coords: null, source: null, insideZone: null, zoneName: null, zoneId: null,
      areaId: null, areaName: null, brandColor: null, catalogVersion: null,
      recentLocations: [], isInitialSyncComplete: false,
    });
    useCartStore.setState({ items: [] });
    require('../src/utils/apiCache').clearAll();
    Location.getForegroundPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true });
    Location.getCurrentPositionAsync.mockResolvedValue({ coords: { latitude: 12.9, longitude: 77.6 } });
    // Default: no bootstrap response configured — the sync's own try/catch
    // swallows this exactly like a real network failure, and tests that
    // don't care about area/settings state never have to configure it.
    bootstrapApi.getBootstrap.mockResolvedValue(null);
  });

  it('does nothing when the cart is empty', async () => {
    cartApi.calculate.mockResolvedValueOnce(zoneCalculateResponse({ zoneId: 9, zoneName: 'Zone A' }));

    await syncDeliveryLocation();

    // Only the zone-check call (items: []), never a second revalidation call.
    expect(cartApi.calculate).toHaveBeenCalledTimes(1);
  });

  it('revalidates the cart the first time a zone resolves (previous zoneId null -> 9)', async () => {
    useCartStore.setState({ items: [CART_ITEM] });
    cartApi.calculate
      .mockResolvedValueOnce(zoneCalculateResponse({ zoneId: 9, zoneName: 'Zone A' })) // zone check
      .mockResolvedValueOnce(zoneCalculateResponse({ zoneId: 9, zoneName: 'Zone A' })); // cart revalidation

    await syncDeliveryLocation();

    expect(cartApi.calculate).toHaveBeenCalledTimes(2);
    const revalidationCall = cartApi.calculate.mock.calls[1][0];
    expect(revalidationCall.items).toEqual([
      { productId: 501, variantId: null, quantity: 2, type: 'product', isCombo: false },
    ]);
    expect(useDeliveryLocationStore.getState().zoneId).toBe(9);
  });

  it('does NOT revalidate the cart when the resolved zone is unchanged', async () => {
    useDeliveryLocationStore.setState({ zoneId: 9, zoneName: 'Zone A', source: 'gps' });
    useCartStore.setState({ items: [CART_ITEM] });
    cartApi.calculate.mockResolvedValueOnce(zoneCalculateResponse({ zoneId: 9, zoneName: 'Zone A' }));

    await syncDeliveryLocation();

    // Just the zone check — same zoneId as before, no revalidation call.
    expect(cartApi.calculate).toHaveBeenCalledTimes(1);
  });

  it('drops unavailable lines and toasts when the new zone invalidates a cart item', async () => {
    useDeliveryLocationStore.setState({ zoneId: 9, zoneName: 'Zone A', source: 'gps' });
    useCartStore.setState({ items: [CART_ITEM] });
    cartApi.calculate
      .mockResolvedValueOnce(zoneCalculateResponse({ zoneId: 12, zoneName: 'Zone B' })) // zone check: moved zones
      .mockResolvedValueOnce(zoneCalculateResponse({
        zoneId: 12,
        zoneName: 'Zone B',
        unavailableItems: [{ id: 501, type: 'product', reason: 'product_unavailable' }],
      }));

    await syncDeliveryLocation();

    expect(useCartStore.getState().items).toHaveLength(0);
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining('Milk 1L'),
      expect.objectContaining({ type: 'info' }),
    );
  });

  // Every gate tests `insideZone === false`, so null reads as ALLOWED.
  // Clearing a confirmed-out-of-zone pin to null on a failed check would
  // hand the full catalogue to a customer we already know we cannot serve.
  describe('a failed zone check never lifts an existing block', () => {
    it('keeps insideZone false when the check throws', async () => {
      useDeliveryLocationStore.setState({
        coords: { lat: 12.9, lng: 77.6 }, source: 'manual',
        insideZone: false, zoneId: null, zoneName: null,
      });
      cartApi.calculate.mockRejectedValueOnce(new Error('offline'));

      await syncDeliveryLocation();

      expect(useDeliveryLocationStore.getState().insideZone).toBe(false);
    });

    it('downgrades an unverified true to null when the check throws', async () => {
      useDeliveryLocationStore.setState({
        coords: { lat: 12.9, lng: 77.6 }, source: 'manual',
        insideZone: true, zoneId: 9, zoneName: 'Zone A',
      });
      cartApi.calculate.mockRejectedValueOnce(new Error('offline'));

      await syncDeliveryLocation();

      const state = useDeliveryLocationStore.getState();
      expect(state.insideZone).toBeNull();
      expect(state.zoneId).toBeNull();
    });
  });

  // A full app close+reopen defaults to the customer's live location even if
  // they had dropped a manual pin — the one documented exception to
  // manual-pin-wins. Which sync applies it varies, so it is tracked by process
  // state rather than by the caller.
  describe('cold start defaults to live GPS over a saved manual pin', () => {
    beforeEach(() => {
      __setColdStartGpsAppliedForTests(false);
      useDeliveryLocationStore.setState({
        coords: { lat: 12.9, lng: 77.6 }, source: 'manual', zoneId: 9, zoneName: 'Zone A',
      });
    });

    it('overrides the manual pin with the live fix', async () => {
      Location.getCurrentPositionAsync.mockResolvedValue({ coords: { latitude: 13.5, longitude: 80.2 } });
      cartApi.calculate.mockResolvedValue(zoneCalculateResponse({ zoneId: 12, zoneName: 'Zone B' }));

      await syncDeliveryLocation();

      const state = useDeliveryLocationStore.getState();
      expect(state.coords).toEqual({ lat: 13.5, lng: 80.2 });
      expect(state.source).toBe('gps');
    });

    it('keeps the pin re-pickable — recent locations survive the override', async () => {
      useDeliveryLocationStore.setState({
        recentLocations: [{ lat: 12.9, lng: 77.6, label: 'Home' }],
      });
      Location.getCurrentPositionAsync.mockResolvedValue({ coords: { latitude: 13.5, longitude: 80.2 } });
      cartApi.calculate.mockResolvedValue(zoneCalculateResponse({ zoneId: 12, zoneName: 'Zone B' }));

      await syncDeliveryLocation();

      expect(useDeliveryLocationStore.getState().recentLocations)
        .toEqual([{ lat: 12.9, lng: 77.6, label: 'Home' }]);
    });

    it('spends the override once, so a later resume respects a new manual pin', async () => {
      Location.getCurrentPositionAsync.mockResolvedValue({ coords: { latitude: 13.5, longitude: 80.2 } });
      cartApi.calculate.mockResolvedValue(zoneCalculateResponse({ zoneId: 12, zoneName: 'Zone B' }));

      await syncDeliveryLocation();
      useDeliveryLocationStore.setState({
        coords: { lat: 11.1, lng: 76.5 }, source: 'manual', zoneId: 12, zoneName: 'Zone B',
      });
      Location.getCurrentPositionAsync.mockClear();

      await syncDeliveryLocation();

      expect(Location.getCurrentPositionAsync).not.toHaveBeenCalled();
      expect(useDeliveryLocationStore.getState().coords).toEqual({ lat: 11.1, lng: 76.5 });
    });

    // The launch that grants permission bails before storing anything, so the
    // override has to survive for the sync that fires right after the grant —
    // otherwise a customer with a saved pin never gets the live-GPS default.
    it('still applies after a launch that started without permission', async () => {
      Location.getForegroundPermissionsAsync.mockResolvedValueOnce({ granted: false, canAskAgain: true });

      await syncDeliveryLocation();

      expect(useDeliveryLocationStore.getState().coords).toEqual({ lat: 12.9, lng: 77.6 });

      Location.getCurrentPositionAsync.mockResolvedValue({ coords: { latitude: 13.5, longitude: 80.2 } });
      cartApi.calculate.mockResolvedValue(zoneCalculateResponse({ zoneId: 12, zoneName: 'Zone B' }));

      await syncDeliveryLocation();

      const state = useDeliveryLocationStore.getState();
      expect(state.coords).toEqual({ lat: 13.5, lng: 80.2 });
      expect(state.source).toBe('gps');
    });
  });

  it('re-validates a saved manual pin too, not just GPS moves', async () => {
    useDeliveryLocationStore.setState({
      coords: { lat: 12.9, lng: 77.6 }, source: 'manual', zoneId: 9, zoneName: 'Zone A',
    });
    useCartStore.setState({ items: [CART_ITEM] });
    cartApi.calculate
      .mockResolvedValueOnce(zoneCalculateResponse({ zoneId: 12, zoneName: 'Zone B' }))
      .mockResolvedValueOnce(zoneCalculateResponse({ zoneId: 12, zoneName: 'Zone B' }));

    await syncDeliveryLocation();

    expect(cartApi.calculate).toHaveBeenCalledTimes(2);
    // GPS is never touched on the manual-pin path.
    expect(Location.getCurrentPositionAsync).not.toHaveBeenCalled();
  });

  // TASK 28.1/28.2/28.5/28.6 — bootstrap runs alongside the existing zone
  // check (never replacing it — see syncAreaInfo's own comment on why
  // checkInsideZone stays authoritative for insideZone) and feeds the new
  // area fields plus useSettingsStore.
  describe('bootstrap-driven area resolution (TASK 28)', () => {
    function bootstrapResponse({ areaId = 1, areaName = 'Area 1', zoneId = 9, catalogVersion = 3 } = {}) {
      return {
        deliverable: true,
        area: { id: areaId, code: 'A', name: areaName, brandColor: '#123456' },
        zone: { id: zoneId, name: 'Zone A' },
        settings: { support_phone: '9990001111', upi_id: 'area1@upi' },
        storeModes: [],
        zoneGeometry: [],
        catalogVersion,
      };
    }

    it('calls bootstrap with the live pin alongside the zone check and stores areaId/areaName/brandColor/catalogVersion', async () => {
      cartApi.calculate.mockResolvedValueOnce(zoneCalculateResponse({ zoneId: 9, zoneName: 'Zone A' }));
      bootstrapApi.getBootstrap.mockResolvedValueOnce(bootstrapResponse());

      await syncDeliveryLocation();

      expect(bootstrapApi.getBootstrap).toHaveBeenCalledWith(
        expect.objectContaining({ latitude: 12.9, longitude: 77.6 }),
      );
      const state = useDeliveryLocationStore.getState();
      expect(state.areaId).toBe(1);
      expect(state.areaName).toBe('Area 1');
      expect(state.brandColor).toBe('#123456');
      expect(state.catalogVersion).toBe(3);
    });

    it('pushes support_phone/UPI from bootstrap settings into useSettingsStore, not a stale cached value (28.6)', async () => {
      cartApi.calculate.mockResolvedValueOnce(zoneCalculateResponse({ zoneId: 9, zoneName: 'Zone A' }));
      bootstrapApi.getBootstrap.mockResolvedValueOnce(bootstrapResponse());

      await syncDeliveryLocation();

      const settings = useSettingsStore.getState();
      expect(settings.supportPhone).toBe('9990001111');
      expect(settings.upiId).toBe('area1@upi');
    });

    it('sends If-None-Match built from the stored area+zone+catalogVersion on the next sync', async () => {
      useDeliveryLocationStore.setState({ areaId: 1, zoneId: 9, catalogVersion: 3 });
      cartApi.calculate.mockResolvedValue(zoneCalculateResponse({ zoneId: 9, zoneName: 'Zone A' }));
      bootstrapApi.getBootstrap.mockResolvedValueOnce(bootstrapResponse());

      await syncDeliveryLocation();

      expect(bootstrapApi.getBootstrap).toHaveBeenCalledWith(
        expect.objectContaining({ ifNoneMatch: '"1-9-3"' }),
      );
    });

    it('a 304 (null) response leaves the previously stored area info untouched', async () => {
      useDeliveryLocationStore.setState({ areaId: 1, areaName: 'Area 1', brandColor: '#123456', catalogVersion: 3 });
      cartApi.calculate.mockResolvedValueOnce(zoneCalculateResponse({ zoneId: 9, zoneName: 'Zone A' }));
      bootstrapApi.getBootstrap.mockResolvedValueOnce(null);

      await syncDeliveryLocation();

      const state = useDeliveryLocationStore.getState();
      expect(state.areaId).toBe(1);
      expect(state.catalogVersion).toBe(3);
    });

    it('clears the stored area when bootstrap reports the pin is not deliverable (pin left every zone)', async () => {
      useDeliveryLocationStore.setState({ areaId: 1, areaName: 'Area 1', brandColor: '#123456', catalogVersion: 3 });
      cartApi.calculate.mockResolvedValueOnce(zoneCalculateResponse({ zoneId: null, zoneName: null }));
      bootstrapApi.getBootstrap.mockResolvedValueOnce({
        deliverable: false, area: null, zone: null, settings: null, storeModes: [], zoneGeometry: [], catalogVersion: null,
      });

      await syncDeliveryLocation();

      const state = useDeliveryLocationStore.getState();
      expect(state.areaId).toBeNull();
      expect(state.areaName).toBeNull();
      expect(state.catalogVersion).toBeNull();
    });

    it('a bootstrap failure is best-effort — the zone check and cart revalidation still complete', async () => {
      useCartStore.setState({ items: [CART_ITEM] });
      cartApi.calculate.mockResolvedValueOnce(zoneCalculateResponse({ zoneId: 9, zoneName: 'Zone A' }));
      bootstrapApi.getBootstrap.mockRejectedValueOnce(new Error('network down'));

      await syncDeliveryLocation();

      const state = useDeliveryLocationStore.getState();
      expect(state.insideZone).toBe(true);
      expect(state.zoneId).toBe(9);
    });
  });

  // TASK 29.1/29.2/29.3 — an AREA change (not merely a zone change within
  // the same area) clears the cart, drops the catalog/dashboard/search SWR
  // cache, and rejoins the realtime room for the new area.
  describe('area-change invalidation (TASK 29)', () => {
    function bootstrapResponse({ areaId, catalogVersion = 3 } = {}) {
      return {
        deliverable: true,
        area: { id: areaId, code: 'A', name: `Area ${areaId}`, brandColor: '#123456' },
        zone: { id: 9, name: 'Zone A' },
        settings: { support_phone: '9990001111', upi_id: `area${areaId}@upi` },
        storeModes: [],
        zoneGeometry: [],
        catalogVersion,
      };
    }

    it('does NOT clear the cart/cache/socket room on the first-ever area resolve (null -> id)', async () => {
      useCartStore.setState({ items: [CART_ITEM] });
      cartApi.calculate.mockResolvedValueOnce(zoneCalculateResponse({ zoneId: 9, zoneName: 'Zone A' }));
      bootstrapApi.getBootstrap.mockResolvedValueOnce(bootstrapResponse({ areaId: 1 }));

      await syncDeliveryLocation();

      expect(useCartStore.getState().items).toHaveLength(1);
      expect(emitAreaChanged).not.toHaveBeenCalled();
    });

    it('clears the cart, invalidates the catalog/dashboard cache, and rejoins the socket room when the resolved area actually changes', async () => {
      const { setCached } = require('../src/utils/apiCache');
      useDeliveryLocationStore.setState({ areaId: 1, zoneId: 9, catalogVersion: 3 });
      useCartStore.setState({ items: [CART_ITEM], appliedCouponCode: 'SAVE10', appliedCouponId: 7 });
      // A cached catalog/dashboard/search entry from area 1 that must not
      // survive into area 2 — ProductListScreen's search results ride the
      // same `products:` cache key as browsing.
      setCached('products:{"zoneId":9}', { data: [{ id: 1 }] });
      setCached('dashboard:fast_food', { data: [{ id: 1 }] });

      cartApi.calculate.mockResolvedValueOnce(zoneCalculateResponse({ zoneId: 12, zoneName: 'Zone B' }));
      bootstrapApi.getBootstrap.mockResolvedValueOnce(bootstrapResponse({ areaId: 2 }));

      await syncDeliveryLocation();

      expect(useCartStore.getState().items).toEqual([]);
      expect(useCartStore.getState().appliedCouponCode).toBeNull();
      const { getCached } = require('../src/utils/apiCache');
      expect(getCached('products:{"zoneId":9}')).toBeNull();
      expect(getCached('dashboard:fast_food')).toBeNull();
      expect(emitAreaChanged).toHaveBeenCalledWith(2);
    });

    it('does NOT clear the cart when the zone changes but the area stays the same', async () => {
      useDeliveryLocationStore.setState({ areaId: 1, zoneId: 9, catalogVersion: 3 });
      useCartStore.setState({ items: [CART_ITEM] });
      cartApi.calculate.mockResolvedValueOnce(zoneCalculateResponse({ zoneId: 12, zoneName: 'Zone B' }));
      bootstrapApi.getBootstrap.mockResolvedValueOnce(bootstrapResponse({ areaId: 1 }));

      await syncDeliveryLocation();

      expect(useCartStore.getState().items).toHaveLength(1);
      expect(emitAreaChanged).not.toHaveBeenCalled();
    });

    it('does NOT clear the cart when the pin leaves every zone (area id -> null) — the "we don\'t deliver here yet" gate handles that, not a cart wipe', async () => {
      useDeliveryLocationStore.setState({ areaId: 1, zoneId: 9, catalogVersion: 3 });
      useCartStore.setState({ items: [CART_ITEM] });
      cartApi.calculate.mockResolvedValueOnce(zoneCalculateResponse({ zoneId: null, zoneName: null }));
      bootstrapApi.getBootstrap.mockResolvedValueOnce({
        deliverable: false, area: null, zone: null, settings: null, storeModes: [], zoneGeometry: [], catalogVersion: null,
      });

      await syncDeliveryLocation();

      expect(useCartStore.getState().items).toHaveLength(1);
      expect(emitAreaChanged).not.toHaveBeenCalled();
    });
  });
});
