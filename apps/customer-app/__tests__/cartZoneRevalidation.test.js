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
}));
jest.mock('../src/components/Toast', () => ({ showToast: jest.fn() }));

const Location = require('expo-location');
const { cartApi } = require('../src/api');
const { showToast } = require('../src/components/Toast');
const { useDeliveryLocationStore } = require('../src/stores/useDeliveryLocationStore');
const { useCartStore } = require('../src/stores/useCartStore');
const { syncDeliveryLocation } = require('../src/hooks/useDeliveryLocationSync');

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
    useDeliveryLocationStore.setState({
      coords: null, source: null, insideZone: null, zoneName: null, zoneId: null,
      recentLocations: [], isInitialSyncComplete: false,
    });
    useCartStore.setState({ items: [] });
    Location.getForegroundPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true });
    Location.getCurrentPositionAsync.mockResolvedValue({ coords: { latitude: 12.9, longitude: 77.6 } });
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
});
