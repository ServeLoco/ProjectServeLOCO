# Checkout saved delivery location

## Goal

The mobile customer checkout must use the delivery location selected when the
app starts or later changed from the Home dashboard. It must not auto-fetch or
display the device's live GPS location at checkout.

## Behaviour

- Checkout initializes its map, delivery address, pricing coordinates, and
  order coordinates from `useDeliveryLocationStore`.
- The saved location is obtained in the background by the existing app-level
  delivery-location sync, and a manual Home-dashboard selection continues to
  override GPS until the customer changes it.
- The checkout map remains editable. While the customer moves the pin, the
  delivery charge preview is recalculated from the pin's current position.
- Moving the pin is only a preview. The saved/default checkout location is
  replaced only after the customer taps **Confirm location**.
- Confirming a pin updates the address and coordinates used to place the
  order and calculate its delivery charge. It does not trigger a live-GPS
  lookup.

## Boundaries

This applies only to `apps/customer-app`'s mobile checkout. The web checkout,
the app-level location sync, and Home dashboard selection flow are unchanged.

## Verification

Add a focused regression test for the location source/initialization logic.
Verify that moving a pin changes the calculated delivery coordinates before
confirmation, and confirming uses the new pin for the order.
