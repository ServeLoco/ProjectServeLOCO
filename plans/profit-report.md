# Daily Profit & Payout Report — implementation spec

Status: **implemented and verified against live dev data.** Branch `locationzones`. Not yet committed.
Follow-up to [shop-pricing.md](shop-pricing.md) — that spec's "Out of scope" line
("Admin payout report page per shop per date range") is exactly this document.

## Goal

Turn the admin **Reports** page into the daily business ledger. For any period the
owner picks, the page answers, in one screen:

1. **What we sold** — app price total (what customers paid).
2. **What we owe shops** — shop price total of every delivered order (end-of-day payout).
3. **What we keep** — product margin (app − shop) + delivery / night / rain / fast
   charges − coupon discounts = net profit.
4. **Which shop gets how much** — per-shop payout table for settling at end of day.
5. **Every order in the period** — paginated table with app ₹, shop ₹, margin ₹ per row.

Cancelled orders never count. Money is counted on **Delivered** orders only.

## Data already available (no schema change needed)

| what | column | note |
|---|---|---|
| app price paid for items | `orders.subtotal` = SUM(`order_items.line_total`) | snapshot at purchase |
| shop cost per line | `order_items.shop_line_total` | snapshot, NULL = never priced |
| shop attribution | `order_items.shop_id` | NULL = house item / combo |
| item dropped by shop | `order_items.shop_rejected_at` | exclude from payout |
| delivery income | `orders.delivery_charge` | stored **pre-waiver** (gross) |
| surge income | `orders.night_charge`, `orders.rain_charge`, `orders.fast_delivery_charge` | |
| discounts | `orders.discount_amount` | **includes** `free_delivery_waiver_amount` |
| customer paid | `orders.total` | |
| lifecycle | `orders.status`, `orders.created_at`, `orders.delivered_at` | |

Indexes that make this cheap already exist: `orders.idx_created_at`,
`order_items.idx_order_items_shop (shop_id, order_id)`.
**No migration in this spec.**

## Money model (exact formulas — implement these verbatim)

Per order, over **Delivered** orders only:

```
app_items_total   = orders.subtotal
shop_cost         = SUM(oi.shop_line_total)
                      WHERE oi.shop_rejected_at IS NULL AND oi.shop_line_total IS NOT NULL
product_margin    = app_items_total - shop_cost
charges_income    = delivery_charge + night_charge + rain_charge + fast_delivery_charge
discount          = discount_amount            -- already includes free_delivery_waiver_amount
customer_paid     = orders.total               -- = subtotal + charges_income - discount
net_profit        = customer_paid - shop_cost
```

Identity that **must** hold and is asserted by a test:

```
net_profit == product_margin + charges_income - discount
```

Both routes to the number come from the same snapshot columns, so any drift means a
bug in the SQL, not in the data.

### Known distortions — surface them, don't hide them

- **Unpriced cost.** `shop_line_total IS NULL` (house items, combos, or a product whose
  `shop_price` was never set) contributes **zero cost**, so margin reads optimistic.
  Summary returns `unpriced_items_count` + `unpriced_items_app_total`; UI shows an
  amber note when non-zero.
- **Rejected-but-billed items.** Rejecting an item sets `shop_rejected_at` but does
  **not** recompute `orders.total` (verified in `services/shopOrderActions.js`). Cash
  flow stays correct (revenue kept, cost dropped) but the owner should see it —
  summary returns `rejected_items_count`.
- **Rider cost is not subtracted.** No payout/earnings table exists anywhere in the
  schema, so delivery + rain + night + fast charges are counted as gross income. Every
  profit figure is labelled **"before rider payouts"** in the UI.

## Decisions (and why)

1. **Basis = `Delivered` only.** The user asked for "total of each delivered order,
   ignoring cancelled". Delivered is also when money is actually settled and when the
   shop is actually owed. Orders still in flight are reported as a separate
   **Pipeline** tile (count + value, clearly *not* in profit), and Cancelled as its own
   tile — so nothing looks missing when the tiles don't add up to the order count.
   *This differs from the existing `/reports/sales`, which counts every non-cancelled
   order.* Both stay; the new page states its basis on-screen.

2. **Bucket by `created_at`, not `delivered_at`.** Every other report and the Orders
   page date filter bucket by `created_at`; using it here means the owner can click
   through from a profit row to the Orders list for the same day and get the same set.
   `delivered_at` is the more "accounting-pure" choice — noted as a future toggle, not
   built now.

3. **Timezone-correct from day one.** Use
   `DATE(CONVERT_TZ(o.created_at, '+00:00', ?))` with `config.RIDER_TODAY_TZ`
   (`+05:30`), the pattern `getAdminOrders` (adminController.js:520) and
   `shopOwnerController` already use. The existing `/reports/*` endpoints use bare
   `DATE(created_at) = CURDATE()`, which puts late-night orders on the wrong day when
   the DB session isn't IST. **Do not "fix" those endpoints in this spec** — their
   response shape is a client contract; changing their numbers is a separate decision.

4. **Two endpoints, not one.** `/summary` (aggregates + per-shop breakdown) and
   `/orders` (paginated rows). Flipping to page 4 of the order table must not re-run
   the aggregate scans.

5. **New endpoints, never an extension of `/reports/sales`.** That payload is read by
   the admin panel *and* Admin Mode mobile; per CLAUDE.md, response fields are a
   contract. Additive-only elsewhere.

6. **Every money field ships camelCase *and* snake_case,** matching the repo-wide dual
   casing rule.

7. **Period presets resolve server-side** into a concrete `[from, to]` date pair in
   `RIDER_TODAY_TZ`, returned in the response so the UI can print the exact range it is
   showing. Allowlist:
   `today | yesterday | this_week | last_week | this_month | last_month | all | custom`.
   `custom` requires `from`/`to` as `YYYY-MM-DD`, max span 366 days.
   Week starts Monday (`YEARWEEK(..., 1)` semantics, matching existing reports).

## API contract

### `GET /api/admin/reports/profit/summary`

Query: `period` (allowlist above, default `today`), `from`, `to` (when `period=custom`).

```jsonc
{
  "period": { "key": "today", "from": "2026-07-31", "to": "2026-07-31", "timezone": "+05:30" },
  "totals": {
    "deliveredOrders": 42,        "delivered_orders": 42,
    "appSales": 18450.00,         "app_sales": 18450.00,        // SUM(subtotal) delivered
    "shopCost": 12980.00,         "shop_cost": 12980.00,        // what we owe shops
    "productMargin": 5470.00,     "product_margin": 5470.00,
    "deliveryCharge": 1260.00,    "delivery_charge": 1260.00,
    "nightCharge": 90.00,         "night_charge": 90.00,
    "rainCharge": 150.00,         "rain_charge": 150.00,
    "fastDeliveryCharge": 200.00, "fast_delivery_charge": 200.00,
    "chargesIncome": 1700.00,     "charges_income": 1700.00,    // sum of the four above
    "discount": 620.00,           "discount": 620.00,
    "freeDeliveryWaiver": 180.00, "free_delivery_waiver": 180.00,
    "customerPaid": 20530.00,     "customer_paid": 20530.00,    // SUM(orders.total)
    "netProfit": 7550.00,         "net_profit": 7550.00,        // customerPaid - shopCost
    "avgOrderValue": 488.81,      "avg_order_value": 488.81,
    "avgProfitPerOrder": 179.76,  "avg_profit_per_order": 179.76,
    "marginPercent": 36.78,       "margin_percent": 36.78       // netProfit / customerPaid * 100
  },
  "pipeline":  { "orders": 6, "value": 2840.00 },   // not Delivered, not Cancelled
  "cancelled": { "orders": 3, "value": 1120.00 },
  "paymentSplit": { "cash": { "orders": 30, "amount": 14200.00 },
                    "upi":  { "orders": 12, "amount": 6330.00 } },
  "shops": [
    { "shopId": 3, "shopName": "Sharma Kirana", "deliveredOrders": 11,
      "itemsSold": 34, "appSales": 6100.00, "shopCost": 4400.00,
      "margin": 1700.00, "unpricedItems": 0 }
  ],
  "warnings": { "unpricedItemsCount": 4, "unpricedItemsAppTotal": 320.00,
                "rejectedItemsCount": 2 }
}
```

`shops[]` includes a `shopId: null` row named `"House (No Shop)"` when house items
sold, exactly like `getShopsReport` does today. Sort by `shopCost` descending — that
row is the payout worksheet.

### `GET /api/admin/reports/profit/orders`

Query: `period`/`from`/`to` (same resolver), `page` (default 1), `limit`
(default 20, max 100), optional `shopId`, optional `sort` = `time|profit|value`
(default `time` desc).

```jsonc
{
  "data": [
    { "id": 8123, "orderNumber": "VK-8123", "createdAt": "...", "deliveredAt": "...",
      "customerName": "…", "paymentMethod": "Cash", "status": "Delivered",
      "appItemsTotal": 430.00, "shopCost": 310.00, "productMargin": 120.00,
      "chargesIncome": 40.00, "discount": 20.00,
      "customerPaid": 450.00, "netProfit": 140.00,
      "shops": [{ "shopId": 3, "shopName": "Sharma Kirana", "shopCost": 310.00 }],
      "hasUnpricedItems": false }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 42, "totalPages": 3 }
}
```

Shape of `pagination` matches `getAdminOrders` so the admin UI reuses its pattern.

## Tasks

Rules: one commit per task, `feat: TASK <n> — <short title>`. Run `npm test` in
`apps/api` after every backend task. Tick the box with a one-line note when done.

- [x] **TASK 1 — Period resolver util.** Done — `apps/api/src/utils/reportPeriods.js`, 15 unit tests green. New `apps/api/src/utils/reportPeriods.js`:
  `resolvePeriod({ period, from, to })` → `{ key, from, to, timezone }` using
  `config.RIDER_TODAY_TZ`, or throws a validation error. Handles the 8 allowlist
  values, Monday week start, `YYYY-MM-DD` format check, 366-day cap, `from <= to`.
  Pure function, no DB. Unit-tested in TASK 8.

- [x] **TASK 2 — `getProfitSummary` controller.** Done — added to `adminController.js`. In `adminController.js`, next to the
  existing report handlers. Queries, all parameterized with the TZ offset:
  1. Order-level aggregate over Delivered orders in range (sales, charges, discounts,
     paid, counts, payment split).
  2. `shop_cost` aggregate joining `order_items` (exclude `shop_rejected_at IS NOT NULL`
     and `shop_line_total IS NULL`).
  3. Per-shop breakdown (`GROUP BY oi.shop_id`), `LEFT JOIN shops`, deleted shop →
     `"Deleted Shop"`, NULL shop → `"House (No Shop)"`.
  4. Pipeline + cancelled counts.
  5. Warning counts (unpriced items, rejected items).
  Derive the computed fields in JS with the existing `roundMoney` helper; emit both
  casings. Never divide without a zero guard.

- [x] **TASK 3 — `getProfitOrders` controller.** Done — same file, no N+1 (paged ids batched into one shop-breakdown query). Paginated order rows: one aggregate
  query for `total` (count), one page query with `LIMIT/OFFSET` via
  `validatePagination`, then a second query fetching per-order shop costs for just the
  ids on the page (`WHERE order_id IN (?)`) — no N+1. Optional `shopId` filter narrows
  to orders containing that shop's non-rejected items.

- [x] **TASK 4 — Routes + admin API client.**
  `adminRoutes.js`: `router.get('/reports/profit/summary', requireAdmin, asyncHandler(getProfitSummary))`
  and `.../profit/orders` — placed with the other `/reports/*` routes (line ~832).
  `apps/admin/src/api/index.js`: add `getProfit` and `getProfitOrders` to `ReportsApi`.

- [x] **TASK 5 — Reports page UI** (`apps/admin/src/pages/Reports.jsx`). Restructure as
  tabs: **Profit & Payouts** (new, default) and **Overview** (today's existing content,
  moved unchanged). Profit tab:
  - **Filter bar**: Today / Yesterday / This Week / Last Week / This Month / Last Month
    / All + a custom date-range pair. Selected range printed as text
    ("31 Jul 2026", "Mon 27 Jul – Sun 2 Aug 2026").
  - **KPI row** (5 cards): Net Profit *(before rider payouts)*, App Sales, Shop Payout
    Due, Delivered Orders, Margin %.
  - **Profit breakdown** — a single waterfall list that visibly adds up:
    `App sales − Shop cost = Product margin` → `+ Delivery + Night + Rain + Fast`
    → `− Discounts` → `= Net profit`. Amber inline note when
    `warnings.unpricedItemsCount > 0`.
  - **Shop payout table**: Shop · Orders · Items · App ₹ · Shop ₹ (payable) · Margin ₹.
    Footer row totals. This is what gets settled at end of day.
  - **Orders table**, server-paginated 20/page, reusing the `.pagination-controls` /
    `.pagination-btn` markup from `Orders.jsx:877`. Columns: Order # · Time · Customer ·
    Payment · App ₹ · Shop ₹ · Margin ₹ · Charges ₹ · Discount ₹ · Paid ₹ · Profit ₹.
    Row click → existing order drawer route if cheap, otherwise no-op.
  - **Pipeline / Cancelled** strip under the KPIs so excluded orders are visible.
  - Keep the existing realtime refresh wiring (`subscribeAdminOrderEvents` +
    `queueReportsRefresh`); on refresh, re-fetch the summary and the **current** page.
  - Empty state per section; never render `NaN` or bare `0` where data failed to load.

- [x] **TASK 6 — CSV export.** Two buttons: *Export summary* and *Export orders
  (full range)*. The orders export fetches with `limit=100` in a loop up to a hard cap
  of 5000 rows, so the file covers the whole period, not the visible page. Reuse the
  existing `escapeCsvCell` (keeps formula-injection neutralization). Filename:
  `villkro_profit_<periodKey>_<from>_<to>.csv`.

- [x] **TASK 7 — Professional restyle** (`Reports.css`). Existing CSS variables only —
  no new palette. Money right-aligned and tabular (`font-variant-numeric: tabular-nums`),
  profit green / loss red via `--success-color` / `--danger-color`, sticky table headers,
  tables horizontally scrollable on narrow screens, KPI grid collapsing to 2-up then
  1-up. No layout regression to the Overview tab.

- [x] **TASK 8 — Tests** (11 + 15 = 26 new tests green; full suite 84/84 suites, 913/914 passing, 1 pre-existing skip). (`apps/api/tests/profitReport.test.js`, plus period-resolver
  unit tests). Cover:
  - period resolver: all 8 keys, bad format, reversed range, over-long range;
  - cancelled orders excluded from every money figure;
  - non-delivered orders land in `pipeline`, not in profit;
  - `shop_rejected_at` items excluded from `shop_cost` but still in `app_items_total`;
  - `shop_line_total IS NULL` counts as zero cost **and** increments
    `unpricedItemsCount`;
  - the identity `net_profit == product_margin + charges_income − discount`;
  - per-shop breakdown sums to `totals.shopCost`, house row included;
  - pagination: `total`/`totalPages` correct, page 2 disjoint from page 1;
  - both casings present on every money field;
  - invalid `period` → 400 `VALIDATION_ERROR`; non-admin → 401/403.

## Out of scope (deliberate)

- **No schema migration.** Every number comes from columns that already exist.
- **Rider payout / cost accounting.** No table exists; adding one is its own spec.
- **`delivered_at` bucketing toggle.** Noted in Decision 2; not built.
- **Backfilling `shop_price`** on the old catalog — old orders keep NULL cost and will
  show as unpriced. Inherited from shop-pricing.md's out-of-scope list.
- **Fixing the timezone handling of the existing `/reports/sales|customers|shops|top-products`
  endpoints.** Real issue, separate decision, different blast radius.
