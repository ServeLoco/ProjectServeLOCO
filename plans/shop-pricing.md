# Shop Pricing & Commission — implementation spec

Status: implemented, `apps/api` tests green (80 suites / 840 tests), admin + API + customer-app lint clean. Branch `locationzones`. Not yet committed — see "Out of scope" for the one deliberate omission (backfill).

**Extension — admin oversight of shop payable (rider dispatch + order detail):**
Riders' own app (`riderController.js`/`riderRoutes.js`) deliberately does NOT get shop cost data — a delivery rider has no reason to see what VillKro pays a shop. Extended instead to admin-only surfaces:
- `getAdminOrderById` (`adminController.js`) — `shopConfirmations[].shopTotal` per shop, same exclusion rule (rejected lines / cancelled order → 0). Rendered in [Orders.jsx](../apps/admin/src/pages/Orders.jsx) badges and [AdminOrderDetailScreen.js](../apps/customer-app/src/screens/admin/AdminOrderDetailScreen.js) (Admin Mode mobile).
- `getRiderDispatch` (`adminRiderController.js`) — `order.shops[].shopTotal` per pickup shop on active jobs, so a dispatcher sees payable at pickup time without opening the order drawer. Rendered in [Riders.jsx](../apps/admin/src/pages/Riders.jsx) job cards.

## Goal

Every catalog item carries **two** prices:

| name | column | meaning |
|---|---|---|
| **App price** | `products.price` / `product_variants.price` (existing) | what the customer pays on VillKro |
| **Shop price** | `products.shop_price` / `product_variants.shop_price` (new) | what VillKro owes the shop for that item |

Commission = app price − shop price. **Never stored** — always derived, so it can't drift.

Deliverables:

1. Admin Products list gets two inline-editable price columns (App ₹, Shop ₹) with a derived margin readout.
2. Variants are edited as their own rows in that list ("variants are different products").
3. Orders snapshot the shop price at purchase time, same as they already snapshot `unit_price`.
4. Shop-owner app shows **shop-worth** money (never app-worth): per item, per order, and a day total = what VillKro owes that shop.
5. Shop Orders tab already defaults to today + has a History day-picker — verify, don't rebuild.

## Decisions (and why)

- **New column, no rename.** `products.price` stays the app price. Renaming it would touch cart, coupons, combos, offers, order creation, both apps and the web PWA. Zero upside.
- **`shop_price` is NULL-able, no default.** NULL = "never set" and renders as `—`. Defaulting to `0` would make "not configured yet" indistinguishable from "shop supplies it free", and would silently under-report the payout total.
- **Order items snapshot `shop_unit_price` / `shop_line_total`.** Same rationale as the existing `unit_price` snapshot: editing the catalog must never retroactively change what an old order says we owe. Payout reports read the snapshot, never the live catalog.
- **`products.shop_price` mirrors the default variant's `shop_price`,** exactly like the existing load-bearing `products.price` = default variant price invariant in `syncProductVariants`. Both syncs happen on the same connection/transaction.
- **New `PATCH /admin/products/pricing` endpoint** instead of reusing `PUT /admin/products/:id`. The PUT is a full-replace that requires the entire product payload — driving it from a grid would mean re-sending name/category/variants per row, and any omitted field wipes data. `PATCH .../pricing` touches only price columns. Existing `PATCH /admin/products/bulk` doesn't fit either: it applies one value to many ids, whereas the grid needs a different value per row.
- **Payable total excludes what the shop won't supply:** items with `shop_rejected_at` set, and orders with status `Cancelled`. Per-item prices still render on those rows so the owner sees what was dropped.
- **Combos carry no shop price.** `order_items.shop_id` is already forced NULL for combos; shop price follows (NULL).

## Tasks

- [x] **TASK 1 — Schema.** `src/db/migrate.js` via existing `ensureColumn`:
  `products.shop_price DECIMAL(10,2) NULL AFTER price`,
  `product_variants.shop_price DECIMAL(10,2) NULL AFTER price`,
  `order_items.shop_unit_price DECIMAL(10,2) NULL AFTER unit_price`,
  `order_items.shop_line_total DECIMAL(10,2) NULL AFTER line_total`.

- [x] **TASK 2 — Catalog read/write carries shop_price.** `productController.attachVariants` exposes it (camel + snake); `syncProductVariants` upserts it and mirrors the default-variant sync onto `products.shop_price`; `createProduct`/`updateProduct` persist it; `adminRoutes.productSchema` validates it (numeric ≥ 0 or null, per product and per variant).

- [x] **TASK 3 — `PATCH /api/admin/products/pricing`.** Body `{ rows: [{ productId, variantId?, price?, shopPrice? }] }`, max 200 rows. Variant rows update `product_variants` scoped `AND product_id = ?` (blocks cross-product id abuse), then re-sync the owning product from its default variant. One transaction, busts product caches, returns `{ updated, skipped, errors }`.

- [x] **TASK 4 — Order snapshot.** `orderController` selects `shop_price` alongside price for products and variants, and writes `shop_unit_price` / `shop_line_total` into `order_items`.

- [x] **TASK 5 — Shop-owner API returns shop money.** `services/shopOrderActions.listShopActiveOrders` and `shopOwnerController.getMyOrderHistory` select the snapshot columns, expose per-item `shopLineTotal`, per-order `shopTotal` (non-rejected items only), and history adds a top-level `payableTotal` for the queried day (excludes `Cancelled` orders).

- [x] **TASK 6 — Admin Products list UI.** `App ₹` + `Shop ₹` inline inputs, one row per variant, dirty tracking with a single batched "Save prices" call, derived margin per row.

- [x] **TASK 7 — Shop app UI.** `ShopOrdersScreen`: per-item amount, per-card shop total, day payable pill. `ShopDashboardScreen`: per-order shop total on the live queue card.

- [x] **TASK 8 — Tests.** `apps/api` jest: pricing endpoint (validation, variant scoping, default-variant re-sync), order snapshot, shop payload totals + rejected/cancelled exclusion.

## Out of scope (follow-ups)

- Admin payout **report page** per shop per date range. The data it needs (`order_items.shop_line_total` + `shop_id`) lands in TASK 4, so it becomes a pure read-model query later.
- Backfilling `shop_price` for the existing catalog — needs real numbers from the shops, not a guess.
