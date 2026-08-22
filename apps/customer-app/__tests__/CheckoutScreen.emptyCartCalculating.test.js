/**
 * Checkout bug, confirmed live on a real device via adb logcat instrumentation
 * (not just source reading): dragging the delivery pin into a zone that
 * doesn't stock the item currently in cart returns it in the calculate
 * response's unavailableItems, removeUnavailableItems empties the cart, and
 * checkoutItems.length drops to 0. The pricing effect re-fires, hits its
 * checkoutItems.length === 0 early-return branch, and that branch reset
 * bill/calcError/freeDelivery state but never isCalculating — which had been
 * left true by whichever run was in flight. Nothing was ever going to flip
 * it back: "Please wait, checking delivery…" spun forever with zero pending
 * work and zero network requests, confirmed by logging { items: [] } at the
 * exact moment of the hang.
 *
 * Source assertion, matching this codebase's style for screens/components
 * that pull in native map modules jest can't render (see
 * LocationPicker.zoneZoom.test.js, CheckoutScreen.gpsErrorReason.test.js).
 */

const fs = require('fs');
const path = require('path');

const checkout = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'screens', 'customer', 'CheckoutScreen', 'CheckoutScreen.js'),
  'utf8',
);

describe('CheckoutScreen — pricing effect empty-cart branch', () => {
  it('resets isCalculating when checkoutItems empties out, not just bill/calcError', () => {
    const idx = checkout.indexOf('if (checkoutItems.length === 0) {');
    expect(idx).toBeGreaterThan(-1);
    const branch = checkout.slice(idx, idx + 900);
    expect(branch).toMatch(/setIsCalculating\(false\);/);
    // Order matters for readability but not correctness — just confirm it's
    // actually inside this branch, not accidentally the one further down
    // that resets it after a successful/failed calculate.
    expect(branch).toMatch(/setBill\(null\);/);
    expect(branch).toMatch(/return undefined;/);
  });

  it('the reset lands before the early return, so it cannot be skipped', () => {
    const idx = checkout.indexOf('if (checkoutItems.length === 0) {');
    const branch = checkout.slice(idx, idx + 900);
    const setIsCalculatingIdx = branch.indexOf('setIsCalculating(false);');
    const returnIdx = branch.indexOf('return undefined;');
    expect(setIsCalculatingIdx).toBeGreaterThan(-1);
    expect(returnIdx).toBeGreaterThan(setIsCalculatingIdx);
  });
});
