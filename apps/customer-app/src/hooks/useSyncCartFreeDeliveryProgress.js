import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { cartApi } from '../api/cartApi';
import { useCartStore } from '../stores';
import { useDeliveryLocationStore } from '../stores/useDeliveryLocationStore';
import { normalizeCartCalculation } from '../utils';

/**
 * Keeps free-delivery progress on the cart store in sync whenever items
 * change (Home / ProductList / Categories sticky pill), not only when the
 * user opens Cart or Checkout.
 *
 * Also re-runs when the app returns to foreground so admin price changes
 * land in local cart lines (list + sticky mini-cart) without needing a
 * qty change.
 *
 * Debounced cart/calculate; sequence-guarded so rapid +/− doesn't apply stale
 * responses. Failures are silent — the pill falls back to last-known progress
 * + live recompute from local subtotal.
 */
export function useSyncCartFreeDeliveryProgress({ enabled = true, debounceMs = 350 } = {}) {
  const items = useCartStore((s) => s.items);
  const appliedCouponCode = useCartStore((s) => s.appliedCouponCode);
  const appliedCouponId = useCartStore((s) => s.appliedCouponId);
  const couponAutoApplyDisabled = useCartStore((s) => s.couponAutoApplyDisabled);
  const setFreeDeliveryProgress = useCartStore((s) => s.setFreeDeliveryProgress);
  const setFreeDeliveryUnlocked = useCartStore((s) => s.setFreeDeliveryUnlocked);

  const seqRef = useRef(0);
  // Bumped when app becomes active so cart prices re-pull from the server
  // even if line ids/qty are unchanged.
  const [resumeTick, setResumeTick] = useState(0);

  // Mirrors CartScreen's validItems filter — a malformed/stale cart entry
  // (no product.id) must not throw inside the debounced calculate below.
  const validItems = items.filter((item) => item?.product?.id);

  // Fingerprint so we re-run on qty/price identity, not only array length.
  const cartKey = validItems
    .map((item) => {
      const id = item?.product?.id ?? '';
      const variantId = item?.variant?.id ?? '';
      const type = item?.type || 'product';
      const qty = item?.quantity ?? 0;
      return `${type}:${id}:${variantId}:${qty}`;
    })
    .join('|');

  useEffect(() => {
    if (!enabled) return undefined;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') setResumeTick((n) => n + 1);
    });
    return () => sub.remove();
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;

    if (!validItems.length) {
      setFreeDeliveryProgress(null);
      setFreeDeliveryUnlocked(false);
      return undefined;
    }

    let cancelled = false;
    const seq = ++seqRef.current;
    const timer = setTimeout(async () => {
      try {
        // Always read latest cart lines (not only the effect-closure snapshot)
        // so a resume re-fetch sees any qty edits during debounce.
        const {
          items: liveItems,
          appliedCouponCode: code,
          appliedCouponId: couponId,
          couponAutoApplyDisabled: noAuto,
          appliedCoupon,
          setAppliedCoupon,
          softClearAppliedCoupon,
        } = useCartStore.getState();

        const lines = (liveItems || []).filter((item) => item?.product?.id);
        if (!lines.length) return;

        // Without the pin, the server falls back to the account's
        // last/default area (resolveCustomerArea) instead of wherever the
        // customer's cart actually was assembled — every line looks
        // "unavailable" there and removeUnavailableItems below silently
        // empties the cart a few hundred ms after every add.
        const { coords } = useDeliveryLocationStore.getState();
        const payload = {
          items: lines.map((item) => ({
            productId: item.product.id,
            variantId: item.variant?.id ?? null,
            quantity: item.quantity,
            type: item.type || (item.product?.isCombo || item.product?.is_combo ? 'combo' : 'product'),
            isCombo: (item.type || (item.product?.isCombo || item.product?.is_combo ? 'combo' : 'product')) === 'combo',
          })),
          coupon_code: code || undefined,
          coupon_id: !code && couponId ? couponId : undefined,
          no_auto_apply: noAuto,
          latitude: coords?.lat,
          longitude: coords?.lng,
        };

        const calculated = normalizeCartCalculation(await cartApi.calculate(payload));
        if (cancelled || seq !== seqRef.current) return;

        setFreeDeliveryProgress(calculated.freeDeliveryProgress);
        const unlocked = Boolean(
          calculated.appliedCoupon
          && Number(calculated.appliedCoupon.freeDeliveryWaiver || 0) > 0,
        );
        setFreeDeliveryUnlocked(unlocked);

        // Keep sticky mini-cart totals + free-delivery progress on live prices
        // (admin can change product price while items sit in the local cart).
        useCartStore.getState().syncItemPricesFromServer(calculated.items);

        // Drop OOS lines discovered during calculate (shop marked unavailable).
        if (calculated.unavailableItems?.length) {
          useCartStore.getState().removeUnavailableItems(calculated.unavailableItems);
        }

        // Keep coupon row in store consistent with bill (same as CartScreen).
        if (calculated.appliedCoupon) {
          setAppliedCoupon(calculated.appliedCoupon.code, calculated.appliedCoupon);
        } else if (appliedCoupon || code || couponId) {
          softClearAppliedCoupon();
        }
      } catch (_) {
        // Non-fatal: keep last progress; live recompute still works for amount.
      }
    }, debounceMs);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // cartKey captures item identity; coupon flags affect free-delivery apply;
    // resumeTick re-pulls live unit prices after background.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    cartKey,
    appliedCouponCode,
    appliedCouponId,
    couponAutoApplyDisabled,
    debounceMs,
    resumeTick,
  ]);
}

export default useSyncCartFreeDeliveryProgress;
