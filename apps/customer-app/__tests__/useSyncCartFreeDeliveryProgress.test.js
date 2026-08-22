/**
 * useSyncCartFreeDeliveryProgress must send the pin on its cart/calculate
 * call. Without it, the server falls back to the account's last/default
 * area (resolveCustomerArea) instead of wherever the cart was actually
 * assembled — every line looks "unavailable" there, and the debounced
 * calculate below silently empties the cart ~350ms after every add.
 */
import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';

jest.mock('../src/api/cartApi', () => ({
  cartApi: { calculate: jest.fn() },
}));

const { cartApi } = require('../src/api/cartApi');
const { useCartStore } = require('../src/stores/useCartStore');
const { useDeliveryLocationStore } = require('../src/stores/useDeliveryLocationStore');
const { useSyncCartFreeDeliveryProgress } = require('../src/hooks/useSyncCartFreeDeliveryProgress');

const CART_ITEM = {
  product: { id: 501, name: 'Milk 1L', price: 40, available: true },
  quantity: 1,
  type: 'product',
  variant: null,
};

function Probe() {
  useSyncCartFreeDeliveryProgress({ enabled: true, debounceMs: 0 });
  return null;
}

describe('useSyncCartFreeDeliveryProgress', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    useCartStore.setState({ items: [], appliedCouponCode: null, appliedCouponId: null, couponAutoApplyDisabled: false });
    useDeliveryLocationStore.setState({ coords: { lat: 29.45, lng: 75.67 } });
    cartApi.calculate.mockResolvedValue({
      data: { freeDeliveryProgress: null, items: [], unavailableItems: [] },
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('includes the current pin on the debounced cart/calculate call', async () => {
    useCartStore.setState({ items: [CART_ITEM] });

    await act(async () => {
      ReactTestRenderer.create(<Probe />);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(50);
    });

    expect(cartApi.calculate).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 29.45, longitude: 75.67 }),
    );
  });
});
