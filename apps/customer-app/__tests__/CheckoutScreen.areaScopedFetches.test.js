/**
 * Money-routing guard for checkout (plans/multi-area.md §9.4 item 4).
 *
 * Confirming a pin on the checkout screen updates local `coordinates` only —
 * it never writes the delivery-location store. So anything area-derived that
 * still reads `savedDeliveryLocation` stays pinned to wherever the customer
 * was BEFORE they opened checkout.
 *
 * For the settings fetch that is a real-money bug, not a staleness nit:
 * settings carries `upi_id` and the UPI QR image, i.e. WHICH BANK ACCOUNT the
 * customer pays. Price the bill against area B's pin while showing area A's
 * QR and the money lands in the wrong area's account. The rider-capacity poll
 * has the same shape (it would gate checkout on the wrong area's riders).
 *
 * Source assertion, matching this codebase's style for screens that pull in
 * native map modules jest can't render (see LocationPicker.zoneZoom.test.js,
 * CheckoutScreen.gpsErrorReason.test.js).
 */

const fs = require('fs');
const path = require('path');

const { blockAfter, callAfter } = require('../testHelpers/sourceBlock');

const checkout = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'screens', 'customer', 'CheckoutScreen', 'CheckoutScreen.js'),
  'utf8',
);

describe('CheckoutScreen — area-derived fetches follow the pin the order is placed with', () => {
  it('derives effectivePin from the same chain createOrder commits', () => {
    // previewCoordinates is deliberately absent: it tracks a finger mid-drag,
    // and re-resolving the area every frame would thrash these fetches.
    expect(checkout).toMatch(
      /const effectivePinLat = coordinates\?\.lat \?\? savedDeliveryLocation\?\.lat;/,
    );
    expect(checkout).toMatch(
      /const effectivePinLng = coordinates\?\.lng \?\? savedDeliveryLocation\?\.lng;/,
    );
  });

  it('fetches settings (the UPI payment target) with the live pin, never the stale store pin', () => {
    const call = checkout.match(/settingsApi\.getSettings\(\{[^}]*\}\)/);
    expect(call).not.toBeNull();
    expect(call[0]).toContain('effectivePinLat');
    expect(call[0]).toContain('effectivePinLng');
    expect(call[0]).not.toContain('savedDeliveryLocation');
  });

  it('keeps effectivePin in the settings effect deps, so confirming a new pin refetches', () => {
    // Without these deps the fetch fires once on mount and never again —
    // same wrong-account outcome, just harder to spot.
    const deps = checkout.match(/\}, \[setSettings, effectivePinLat, effectivePinLng\]\);/);
    expect(deps).not.toBeNull();
  });

  it('polls rider capacity with the live pin too', () => {
    const call = checkout.match(/riderCapacityApi\.getCapacityStatus\(\{[^}]*\}\)/);
    expect(call).not.toBeNull();
    expect(call[0]).toContain('effectivePinLat');
    expect(call[0]).toContain('effectivePinLng');
    expect(call[0]).not.toContain('savedDeliveryLocation');
  });
});

describe('CheckoutScreen — capacity poll cannot outlive the screen', () => {
  it('runs under useFocusEffect, not a bare useEffect', () => {
    // This screen stays mounted when another is pushed over it, so a plain
    // useEffect interval keeps polling from a screen the user already left —
    // the same stranded-timer shape as the useNetworkStatus ping storm.
    expect(checkout).toMatch(/import \{[^}]*useFocusEffect[^}]*\} from '@react-navigation\/native';/);
    const effect = callAfter(checkout, 'useFocusEffect(');
    expect(effect).not.toBeNull();
    expect(effect).toContain('riderCapacityApi.getCapacityStatus');
  });

  it('skips the round trip while the app is backgrounded', () => {
    const effect = callAfter(checkout, 'useFocusEffect(');
    expect(effect).toMatch(/AppState\.currentState !== 'active'/);
  });

  it('clears its interval on blur', () => {
    const effect = callAfter(checkout, 'useFocusEffect(');
    expect(effect).toMatch(/clearInterval\(intervalId\)/);
  });
});

describe('CheckoutScreen — capacity is realtime, with the poll as reconciler', () => {
  it('subscribes to the pushed capacity verdict', () => {
    // The events that move capacity (order delivered, rider online, admin
    // re-tuning the multiplier) are already realtime everywhere else — making
    // the customer wait out a poll tick for them would be the odd one out.
    expect(checkout).toMatch(/subscribeRiderCapacityEvents/);
    const handler = callAfter(checkout, 'subscribeRiderCapacityEvents(');
    expect(handler).not.toBeNull();
    expect(handler).toMatch(/setAtCapacity\(/);
  });

  it('keeps polling as well — an order ageing out of the window fires no event', () => {
    expect(checkout).toMatch(/setInterval\(checkCapacity, CAPACITY_POLL_MS\)/);
  });

  it('unsubscribes on blur, so a revisit cannot stack listeners', () => {
    const effect = callAfter(checkout, 'useFocusEffect(');
    expect(effect).toMatch(/unsubscribe\(\);/);
  });

  it('drops a pushed verdict meant for a different area than the pin resolved', () => {
    // The socket room follows the delivery-location store's area, and
    // confirming a pin in checkout never writes that store — so while the pin
    // sits in another area the room is still the OLD area's, and its verdict
    // does not describe the order about to be placed.
    const handler = callAfter(checkout, 'subscribeRiderCapacityEvents(');
    expect(handler).toMatch(/capacityAreaIdRef\.current/);
    expect(handler).toMatch(/return;/);
    // And the poll is what populates the area it compares against.
    expect(checkout).toMatch(/capacityAreaIdRef\.current = data\?\.areaId/);
  });
});

describe('CheckoutScreen — capacity gate covers every submit path', () => {
  it('guards createOrder itself, not just the footer button', () => {
    // The "total changed" confirmation re-enters createOrder directly, and
    // capacity can flip while that dialog is open.
    const body = blockAfter(checkout, 'const createOrder = async (currentBill) => {');
    expect(body).not.toBeNull();
    expect(body).toMatch(/if \(atCapacity\) \{/);
  });

  it('resets the submit flags before returning, so the button cannot stick', () => {
    // handlePlaceOrder has no finally — it only clears these in catch — and it
    // sets isSubmittingRef before calling createOrder. Returning without the
    // reset leaves Place Order stuck on "Processing..." forever.
    const body = blockAfter(checkout, 'const createOrder = async (currentBill) => {');
    const guardBody = blockAfter(body, 'if (atCapacity) {');
    expect(guardBody).not.toBeNull();
    expect(guardBody).toMatch(/isSubmittingRef\.current = false;/);
    expect(guardBody).toMatch(/setIsSubmitting\(false\);/);
  });
});
