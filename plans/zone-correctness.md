# Zone correctness — single-area hardening

Scope: make the CURRENT single admin panel zone-correct. Multi-area /
super-admin (areas table, per-area settings, multi-admin auth, per-area
realtime rooms, zone-scoped catalog) is explicitly OUT — that is future work.

Guiding rule: **when the admin has turned zone pricing ON, the system must
fail closed.** Zone pricing ON means "this business operates by zones"; any
state where the zone cannot be determined must block delivery, never
silently fall back to serving everyone at flat pricing.

Zone pricing OFF stays exactly as it is today (flat pricing, everyone
served) — that is a legitimate operating mode, not a bug.

---

## TASK 1 — Resolver fails closed when zone pricing is ON

`apps/api/src/utils/deliveryPricing.js` → `resolveDeliveryPricing`

Today `flatResult()` is returned whenever any of these hold, *even with the
flag ON*: no customer coords, zero active zones, no zone has a usable
boundary. All three return `outOfRange: false`, so every location on earth
reads as deliverable and the whole location gate becomes decorative.

Change: with `radiusPricingActive` true, only the flag being OFF may reach
`flatResult()`. The other cases return the existing out-of-range shape
(`outOfRange: true`, zero charges, `codAllowed: false`).

Fixes audit B2, and B1 transitively: `createOrder` already rejects
`pricing.outOfRange`, so an order posted with no coordinates is refused
without touching the route validator.

- [x] done — flag OFF still returns flatResult(); flag ON with no coords /
  no zones / no usable boundary now returns the out-of-range shape. Cart
  calculate's missing-coords branch no longer swallows outOfRange (it was an
  else-if, so a coordless cart still reported valid: true). API 822 pass.

## TASK 2 — Cart + Checkout honour `excluded`

`apps/customer-app/src/screens/customer/CheckoutScreen/CheckoutScreen.js`
(and CartScreen if it gates)

Exclusion squares report `outOfRange: false`, and neither screen reads
`excluded` at all, so Place Order stays enabled and the server 400s at
submit. Gate on `outOfRange || excluded`, and surface
`exclusionMessage` when it is the exclusion that blocks.

Fixes audit B3.

- [x] done — CheckoutScreen reads excluded/exclusionMessage, gates every
  control on deliveryBlocked = outOfRange || excluded, and shows the admin's
  message instead of nearest-zone advice. CartScreen had no zone gate to
  change. App 282 pass.

## TASK 3 — Store the matched zone id on the client

`apps/customer-app/src/stores/useDeliveryLocationStore.js`
`apps/customer-app/src/hooks/useDeliveryLocationSync.js`

The store keeps `zoneName` but no `zoneId`, so nothing downstream can be
keyed on the zone. Add `zoneId` alongside `zoneName` everywhere the name is
already set/persisted/cleared.

Prerequisite for TASK 4 and TASK 5. Fixes audit B8.

- [x] done — zoneId added to state, both positional setters, partialize and
  clearManualLocation. setZoneName replaced by setZone(zoneName, zoneId) so
  the pair can never drift apart. HomeScreen passes zone?.id on manual pins.

## TASK 4 — Zone-key the API cache

`apps/customer-app/src/utils/apiCache.js` and its callers

Cache keys are `products:<params>` / `categories:<type>` with no zone
component, so moving the pin from zone A to zone B repaints zone A's
cached catalog. Latent while the catalog is global; becomes a real
correctness bug the moment anything is zone-scoped. Include the active
zone id in the key (or invalidate on zone change).

Fixes audit B4.

- [x] done — ProductListScreen and CategoriesScreen cache keys now fold in
  zoneId (deliveryZoneId from the store); both refetch on zone change
  (effect deps for ProductList, key-change for CategoriesScreen's
  useCachedFetch). ProductDetailScreen untouched — a product's own data
  isn't zone-dependent. App 286 pass.

## TASK 5 — Cart reacts to a zone change

`apps/customer-app/src/stores/useCartStore.js`

The cart persists across pin moves and only reconciles prices, not
availability or zone eligibility. On a zone id change, re-validate the cart
against the new zone (server cart calculate already returns per-item
availability) and tell the user what dropped out.

Fixes audit B5.

- [x] done — syncDeliveryLocation tracks the previous zoneId and, when a
  fresh check resolves a DIFFERENT zoneId (manual-pin revalidate or a GPS
  move), calls cart/calculate with the real cart items and applies
  syncItemPricesFromServer + removeUnavailableItems, toasting on any drop.
  Same mechanism CartScreen/CheckoutScreen already use for their own
  recalculations, now fired proactively instead of waiting for the customer
  to open Cart. Neither shops nor products carry a zone yet, so nothing is
  dropped by zone today — this wires the mechanism correctly for when they
  do, per A3 (deferred). App 291 pass.

## TASK 6 — Stale `insideZone` must not survive a failed check

`apps/customer-app/src/hooks/useDeliveryLocationSync.js`

`checkInsideZone` returns `null` on any error and the caller leaves the
previous flag untouched. `insideZone` is persisted, so a cold start with no
network resumes a stale `true` and shows the full dashboard. Distinguish
"unknown" from "inside" so an unresolved zone never reads as deliverable.

Fixes audit B6.

- [x] done — landed with TASK 3 (same function, same commit). A failed
  check now writes insideZone: null / zone null instead of leaving the
  persisted value, so an offline cold start reads as unknown rather than
  deliverable.

## TASK 7 — Permission-check errors stop failing open

`apps/customer-app/src/hooks/useHomeLocationPermission.js`

The catch sets `'granted'`, which hides the card and lets the dashboard
render with no coords. `'denied'` is both safer and actionable — it shows
the Allow card the user can actually press.

Fixes audit B7.

- [x] done — catch sets 'denied', which surfaces the actionable Allow card
  instead of silently rendering the dashboard with no coords.

---

## Rules

- One task at a time, in order.
- `npm test` in `apps/api` after every backend task; `npm test` in
  `apps/customer-app` after every app task. Both suites must be green
  before ticking a box.
- Existing tests that encode the old fail-open behaviour are updated
  deliberately, with the new expectation spelled out in the test name.
- Tick the checkbox with a one-line note on what changed.
- One commit per task, `fix: TASK <n> — <short title>`.
- DO NOT add an areas/tenant table, per-area settings, multi-admin auth,
  per-area realtime rooms, or zone-scoped catalog queries. Out of scope.
