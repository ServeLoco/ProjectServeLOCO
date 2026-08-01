# Multi-Area — Execution Checklist

Companion to [`multi-area.md`](./multi-area.md). That file is the **contract** (why, locked
decisions, performance/DRY/data-safety rules). This file is the **do-list**.

Branch: `feat/multi-area-super-admin` · 31 tasks (0–30) · Status: **NOT STARTED**

## Rules

1. Read `multi-area.md` §2 (locked decisions), §3 (performance), §4 (DRY), §6 (data safety) and
   §9 (hurdles) **before TASK 0**. Every `§x.y` below points there.
2. Tasks run **in order**. Later tasks assume earlier ones landed.
3. One commit per task, format `feat: AREA TASK <n> — <short title>`.
4. After every backend task: `npm test` in `apps/api`, then `npx eslint` on each file touched.
   A task is not done if either fails.
5. Tick each subtask as you go; tick the task heading with a one-line note when the whole task lands.
6. **Do not invent scope.** If a subtask seems to require touching something in the spec's
   DO-NOT-TOUCH list, stop and ask.
7. Response shapes stay byte-identical for a single-area install until TASK 27. Where a response
   already duplicates camelCase + snake_case, keep duplicating.

**Legend:** `[api]` `apps/api` · `[adm]` `apps/admin` · `[app]` `apps/customer-app` · `[ci]` workflows

---

## Phase 0 — Safety gate

### [ ] TASK 0 — Production snapshot + migration rehearsal
**Spec:** §6.1, §6.2, §9 · **Files:** `[ci] .github/workflows/ci.yml`, staging only

- [ ] 0.1 Full MySQL dump of production + full Mongo dump. Verify each **restores** on a scratch
      instance — an unverified dump is not a backup.
- [ ] 0.2 Record baseline row counts for every table in §1.1 and
      `SELECT COUNT(*) FROM orders` + `information_schema.TABLES` data length for `orders` (H12).
      Write the numbers into this file under 0.9.
- [ ] 0.3 Restore the snapshot to a staging MySQL. Point a staging API at it.
- [ ] 0.4 Write TASK 1–3's migration code locally, run it against staging. Not against an empty dev
      DB — production's real edge cases (NULL `shop_latitude`, legacy `products.image_id`, duplicate
      images) are the point.
- [ ] 0.5 Re-run row counts. Every table must match 0.2 exactly. Any delta = stop.
- [ ] 0.6 Run the migration a **second time** against the now-migrated staging DB. Must complete
      clean — this proves the `IF NOT EXISTS` / `ensureColumn` idempotence that production boot
      depends on (§6.1).
- [ ] 0.7 `[ci]` Add to `.github/workflows/ci.yml`, after "Install dependencies" and before
      "Run Tests": a `npm run db:migrate` step against the MySQL service container, then a second
      identical step. CI already provisions `mysql:8.0` and never uses it (H9).
- [ ] 0.8 Time the staging migration. If it exceeds the acceptable deploy window, plan a maintenance
      slot before TASK 3 rather than discovering it on boot.
- [ ] 0.9 Record here: `orders` rows = ____, data length = ____, migration duration = ____.

**Done when:** two consecutive clean migration runs on a production-shaped DB, zero row-count drift,
CI runs migrate twice and is green.
**Commit:** `feat: AREA TASK 0 — migration rehearsal + CI migrate step`

---

## Phase A — Foundations (no behaviour change)

### [ ] TASK 1 — `areas` table + seed Area 1
**Spec:** §2.1, §2.12 · **Files:** `[api] src/db/migrate.js`

- [ ] 1.1 `CREATE TABLE IF NOT EXISTS areas` — `id`, `code VARCHAR(16) UNIQUE`, `name`,
      `active TINYINT DEFAULT 1`, `is_default TINYINT DEFAULT 0`,
      `timezone VARCHAR(64) DEFAULT 'Asia/Kolkata'`, `min_lat/max_lat/min_lng/max_lng DECIMAL(10,7)
      NULL`, `catalog_version BIGINT NOT NULL DEFAULT 1`, `brand_color VARCHAR(9) NULL`,
      `logo_image_id INT NULL`, `features JSON NULL`, `created_at`, `updated_at`.
- [ ] 1.2 Index `(active, min_lat, max_lat)` for the bbox prefilter (§3.2).
- [ ] 1.3 `INSERT IGNORE` seed row: `id=1, code='A1', name='Area 1', is_default=1`.
- [ ] 1.4 Confirm nothing reads the table yet — this task is purely additive.

**Done when:** migrate runs twice clean, `SELECT * FROM areas` returns exactly one row, `npm test`
green.
**Commit:** `feat: AREA TASK 1 — areas table + seed Area 1`

### [ ] TASK 2 — `admins` table + per-admin session state
**Spec:** §2.9 · **Files:** `[api] src/db/migrate.js`

- [ ] 2.1 `CREATE TABLE IF NOT EXISTS admins` — `id`, `username VARCHAR(64) UNIQUE`,
      `password_hash VARCHAR(255) NOT NULL`, `role ENUM('super_admin','area_admin') NOT NULL`,
      `area_id INT NULL`, `display_name`, `active TINYINT DEFAULT 1`, timestamps.
- [ ] 2.2 FK `area_id → areas(id)`; index `(active, area_id)`.
- [ ] 2.3 `ensureColumn('admin_auth_state', 'admin_id', 'admin_id INT NULL')`. Row `id=1` keeps
      working as the legacy global revoke.
- [ ] 2.4 Seed one `super_admin` row from `ADMIN_PASSWORD_HASH` (or bcrypt `ADMIN_PASSWORD`) **only
      when `admins` is empty**, so the current login keeps working after deploy.
- [ ] 2.5 Application-level invariant (documented in a comment, enforced in TASK 24's endpoint):
      `area_admin` ⇒ `area_id NOT NULL`; `super_admin` ⇒ `area_id IS NULL`.

**Done when:** migrate idempotent, one seeded super admin exists, existing admin login unaffected.
**Commit:** `feat: AREA TASK 2 — admins table + per-admin session state`

### [ ] TASK 3 — `area_id` columns, backfill, indexes, UNIQUE key rewrites
**Spec:** §3.3, §3.6, §6.2, H1, H11 · **Files:** `[api] src/db/migrate.js`, `src/db/seed_demo.js`

> The riskiest task in the project. Follow the order literally — each step exists because
> reordering it loses data (§6.2).

- [ ] 3.1 Add helper `ensureColumnAtEnd(table, name, definition)` — same existence check as
      `ensureColumn` but **no `AFTER` clause**, so MySQL 8 can use `ALGORITHM=INSTANT` (§3.6).
      Leave `ensureColumn` untouched; other migrations depend on its `AFTER` behaviour.
- [ ] 3.2 Add nullable `area_id INT` **at end of row** to: `shops, riders, mobile_admins,
      delivery_zones, delivery_exclusion_zones, settings, orders, order_items, coupons, offers,
      dashboard_sections, dashboard_section_items, categories, products, combos, product_groups,
      store_modes, admin_notifications, notification_batches`.
- [ ] 3.3 Backfill each to `1` in **5,000-row batches** keyed on primary key, `WHERE area_id IS NULL`
      so a re-run resumes. Outside any long transaction.
- [ ] 3.4 Verify per table: `SELECT COUNT(*) WHERE area_id IS NULL OR area_id NOT IN
      (SELECT id FROM areas)` must be `0`. **Abort the migration if not** — do not proceed to 3.5.
- [ ] 3.5 `MODIFY area_id INT NOT NULL` on each. (Never add it as NOT NULL directly — MySQL fills
      existing rows with `0`, not `1`.)
- [ ] 3.6 Add FK `area_id → areas(id)` on each, wrapped in the rethrow-unless-duplicate pattern from
      `migrate.js:810-822`.
- [ ] 3.7 **Drop the old global UNIQUE keys first**, then add the composites (§6.2 rule 4 — if the
      old key survives, TASK 11's per-area `packed`/`fast_food` seed silently no-ops):
      `categories.slug` → `UNIQUE (area_id, slug)`;
      `store_modes.slug` → `UNIQUE (area_id, slug)`;
      `coupons uniq_live_coupon_code` → `(area_id, code, deleted)`;
      `dashboard_sections idx_section_store_slug` → prepend `area_id`;
      `admin_notifications uniq_admin_inbox_event` → prepend `area_id`.
- [ ] 3.8 Add the composite indexes from §3.3 (all leading with `area_id`).
- [ ] 3.9 **Do not drop** `orders.idx_status` / `idx_created_at` here — separate later deploy
      (§6.2 rule 5).
- [ ] 3.10 Add `users.last_area_id INT NULL` (no FK cascade — cache only).
- [ ] 3.11 Backfill `users.last_area_id` from each user's **most recent order's `latitude`/
      `longitude`** run through the zone matcher (H1 — the server has no saved customer pin).
      Users with no orders stay NULL.
- [ ] 3.12 Update `src/db/seed_demo.js` to stamp `area_id = 1` on everything it creates (H11).
- [ ] 3.13 **Do not touch `daily_order_counters` here** — its PK change moves to TASK 13 (§6.3).
- [ ] 3.14 Re-run the TASK 0 row-count comparison against the real migration.

**Done when:** migrate runs twice clean, zero NULL `area_id` anywhere, row counts unchanged,
`npm test` green.
**Commit:** `feat: AREA TASK 3 — area_id columns, backfill, indexes, unique key rewrites`

### [ ] TASK 4 — Area-aware caches
**Spec:** §3.4 · **Files:** `[api] src/utils/microCache.js`, `src/utils/storeMode.js`,
`src/controllers/settingsController.js`, all current cache callers, `tests/microCache.test.js`

- [ ] 4.1 `microCache.js`: enforce key format `<namespace>:<areaId>:<rest>`; throw in dev on a
      malformed key so mistakes surface immediately.
- [ ] 4.2 `bust(namespace, areaId)` clears one area's slice. Keep `bust(namespace)` (no areaId) for
      genuinely global data only.
- [ ] 4.3 Raise `MAX_ENTRIES` 100 → 600, exported as a named constant.
- [ ] 4.4 `settingsController` cache key `settings` → `settings:<areaId>`.
- [ ] 4.5 `storeMode.js` cache key `active_slugs` → `active_slugs:<areaId>`.
- [ ] 4.6 Update every existing caller to pass area `1`. Behaviour identical; plumbing in place.
- [ ] 4.7 Extend `tests/microCache.test.js`: per-area busting does not evict another area's entries.

**Done when:** single-area behaviour unchanged, cross-area bust isolation covered by a test.
**Commit:** `feat: AREA TASK 4 — area-aware caches`

### [ ] TASK 5 — Guardrail test, before the sweep
**Spec:** §4.6 · **Files:** `[api] tests/areaScoping.test.js` (new)

- [ ] 5.1 Static scan of `src/controllers`, `src/services`, `src/utils` for
      `FROM|JOIN|UPDATE|DELETE FROM <scoped_table>`.
- [ ] 5.2 Fail any statement lacking an `area_id` predicate.
- [ ] 5.3 Allowlist with a **one-line justification comment per entry**: `users`, `images`,
      `notification_templates`, `product_library`, `library_variants`, `category_library`,
      `store_mode_library`, `units`, `purgeExpiredDeletions`, auth paths.
- [ ] 5.4 Expect it to fail loudly for every un-swept table. `test.skip` with a TODO **only** if it
      blocks TASK 6–8; un-skip in TASK 9 and keep green from then on.
- [ ] 5.5 Document in the test header that loosening an assertion to make it pass is a review
      failure — the point is to catch a missed table.

**Done when:** the test exists and its failure list matches the Phase C task list.
**Commit:** `feat: AREA TASK 5 — area scoping guardrail test`

### [ ] TASK 6 — `areaScope.js` + resolution middleware
**Spec:** §3.1, §3.2, §4.1, §4.2 · **Files:** `[api] src/utils/areaScope.js` (new),
`src/middleware/areaMiddleware.js` (new), `tests/areaScope.test.js` (new)

- [ ] 6.1 `resolveAreaForPoint(lat, lng)` — SQL bbox prefilter on `areas`, then the **existing**
      `matchZone` from `deliveryPricing.js` on that area's zones only. Returns
      `{ areaId, zoneId, zone }` or `null`. Never re-implement polygon matching.
- [ ] 6.2 `getAreaById(areaId)` and `listAreas({activeOnly})` — 60s process cache (tens of areas, not
      millions; §3.9).
- [ ] 6.3 `requestAreaId(req)` — single source of truth for `req.areaId`.
- [ ] 6.4 `assertAreaAccess(req, areaId)` — throws 403 unless `super_admin`, or `area_admin` whose
      own area matches.
- [ ] 6.5 `bustAreaCaches(areaId)` — fans out to microCache namespaces + settings + storeMode, and
      calls `bumpCatalogVersion(areaId)` internally so no caller can forget the ETag (§4.3).
- [ ] 6.6 `bumpCatalogVersion(areaId)` — `UPDATE areas SET catalog_version = catalog_version + 1`.
- [ ] 6.7 `resolveAdminArea` middleware — `area_admin` → own area; `super_admin` → `X-Area-Id`
      header, `'all'` where allowed, else `null`.
- [ ] 6.8 `resolveCustomerArea` middleware — request pin → `users.last_area_id` → default area
      **only when no pin was supplied at all**. A pin resolving to no zone yields `null`, never the
      default (§2.4).
- [ ] 6.9 Unit tests: point in one zone; point in a nested child zone (**child must win**); point in
      an exclusion square; point outside every zone (**returns `null`, not the default area**);
      missing/NaN coordinates; area with no zones yet.
- [ ] 6.10 No controller uses any of this yet.

**Done when:** full unit coverage of the resolver, zero controller changes.
**Commit:** `feat: AREA TASK 6 — areaScope module + resolution middleware`

---

## Phase B — Auth (the gate)

### [ ] TASK 7 — Admin login against `admins`
**Spec:** §2.9, H10 · **Files:** `[api] src/controllers/adminController.js`, `src/config/env.js`,
`tests/adminAuth.test.js`

- [ ] 7.1 Look up `admins` by `username`, bcrypt-compare `password_hash`.
- [ ] 7.2 Mint JWT with `sub`, `role: 'admin'`, `adminRole`, `areaId`.
- [ ] 7.3 Keep the env-password path as a fallback **only when `admins` is empty**; `console.warn`
      when it fires.
- [ ] 7.4 Response gains `adminRole` and `areaId` in **both casings**.
- [ ] 7.5 `env.js`: `ADMIN_PASSWORD`/`ADMIN_PASSWORD_HASH` becomes optional once `admins` is
      populated — a deploy with a seeded admins table and no env password must still boot (H10).
      Keep the weak-password rejection for the bootstrap path.
- [ ] 7.6 Preserve the existing brute-force lockout (`admin_auth_state.failed_attempts` /
      `locked_until`) — now per admin where `admin_id` is set.
- [ ] 7.7 Tests: super admin login, area admin login, wrong password, empty-table env fallback,
      lockout still trips.

**Done when:** existing credentials still work, JWT carries area, `npm test` green.
**Commit:** `feat: AREA TASK 7 — admin login against admins table`

### [ ] TASK 8 — `requireAdmin` sets area; `requireSuperAdmin`
**Spec:** §2.3, §4.2 · **Files:** `[api] src/middleware/authMiddleware.js`, `src/app.js`,
`src/routes/adminRoutes.js`, `tests/roleProtection.test.js`

- [ ] 8.1 `req.admin` gains `adminRole` and `areaId` from the JWT.
- [ ] 8.2 Add `requireSuperAdmin`.
- [ ] 8.3 Wire `resolveAdminArea` **once at router level** (`app.js:134` mount or the top of
      `adminRoutes.js`), not on 130 individual routes.
- [ ] 8.4 Per-admin revocation: check `admin_auth_state` by `admin_id` when set, falling back to the
      legacy `id=1` row.
- [ ] 8.5 **Security:** `area_admin` sending `X-Area-Id` for another area → **403**, never a silent
      fallback. `X-Area-Id: all` from an `area_admin` → **403**. Explicit test for each.
- [ ] 8.6 Test that a super admin with no `X-Area-Id` on an area-required endpoint gets a clear
      error, not a wrong-area read.

**Done when:** both 403 tests pass, all existing admin routes still authorize correctly.
**Commit:** `feat: AREA TASK 8 — admin area middleware + requireSuperAdmin`

---

## Phase C — Backend sweep

> Per task: add `area_id` to reads **and** writes, use `req.areaId`, key caches by area, replace
> scattered `microCache.bust(...)` pairs with `bustAreaCaches(areaId)`, keep response shapes
> byte-identical, run `npm test`. Expect test-fixture churn to exceed source churn (H3) — fix
> fixtures properly, never by loosening an assertion.

### [ ] TASK 9 — Settings (27 sites)
**Spec:** §6.4 · **Files:** `[api] src/controllers/settingsController.js`,
`src/controllers/imageController.js`, everything `grep -rn "FROM settings" src/` finds

- [ ] 9.1 **Find sites by grep, not by file** — `grep -rn "FROM settings" src/`. There are 27.
- [ ] 9.2 `getSettings` / `updateSettings` select and write by `area_id`.
- [ ] 9.3 Auto-create a settings row whenever an area is created (used by TASK 24).
- [ ] 9.4 **`imageController.js:20`** — `getUsedImageIds` reads `settings.upi_qr_image_id` with
      `LIMIT 1`. Make it scan **all** areas' rows, or every area but the first loses its payment QR
      to the orphan cleaner (§6.4).
- [ ] 9.5 Replace `microCache.bust('dashboard')` calls in this file with `bustAreaCaches(areaId)`.
- [ ] 9.6 Un-skip the guardrail test for `settings`.
- [ ] 9.7 Test: two settings rows exist; area 1's read never returns area 2's values; both areas'
      UPI images report as in-use.

**Commit:** `feat: AREA TASK 9 — per-area settings`

### [ ] TASK 10 — Delivery zones, exclusion zones, pricing (18 sites)
**Spec:** §3.2 · **Files:** `[api] src/utils/deliveryPricing.js`,
`src/controllers/deliveryZonesController.js`, `src/controllers/cartController.js`,
`src/controllers/orderController.js`, `tests/deliveryPricing.test.js`, `tests/deliveryZones*.test.js`

- [ ] 10.1 `loadActiveZones(db, areaId)` and `loadActiveExclusionZones(db, areaId)` — signature gains
      `areaId`, query gains the predicate.
- [ ] 10.2 Per-area TTL cache for zone rows (order creation still reads on the transaction
      connection — keep the existing "not cached inside a transaction" reasoning intact).
- [ ] 10.3 `listActiveZonesPublic` takes a resolved area; cache key `delivery-zones:<areaId>:public`.
- [ ] 10.4 `notifyZonesChanged` recomputes `areas.min_lat/max_lat/min_lng/max_lng` from that area's
      zones, then `bustAreaCaches(areaId)`.
- [ ] 10.5 `matchZone` itself unchanged — nested-child-wins must still hold.
- [ ] 10.6 **Perf assertion test:** a cart preview in area 1 loads only area 1's zones. This is the
      biggest win in the spec; prove it.

**Commit:** `feat: AREA TASK 10 — per-area delivery zones and pricing`

### [ ] TASK 11 — Catalog: categories, products, combos, groups, store modes (162 sites)
**Spec:** §6.2 rule 4, H4, H5, H8 · **Files:** `[api] src/controllers/productController.js`,
`categoryController.js`, `comboController.js`, `storeModeController.js`, `bulkImportController.js`,
`shopAdminController.js`, `shopOwnerController.js`, `src/utils/storeMode.js`

- [ ] 11.1 `products` (79), `categories` (44), `combos` (26), `store_modes` (13), `product_groups`.
- [ ] 11.2 Seed `store_modes` `is_system` rows (`packed`, `fast_food`) **per area**. Verify the old
      global UNIQUE really was dropped in 3.7 — otherwise `INSERT IGNORE` silently does nothing.
- [ ] 11.3 `utils/storeMode.js` `normalizeStoreType` validates a slug **within the area**, not
      against a global list (H4).
- [ ] 11.4 `bulkImportController.js:529` raw `INSERT INTO products` gains `area_id` — imports land in
      the admin's current area (H8).
- [ ] 11.5 Both combo representations get `area_id` (`combos` table **and** `products.is_combo` rows;
      H5). Do not attempt to unify them.
- [ ] 11.6 Replace the 9 `bustProductCaches()` / scattered bust pairs with `bustAreaCaches(areaId)`.
- [ ] 11.7 Search stays `LIKE` for now — TASK 22 replaces it.

**Commit:** `feat: AREA TASK 11 — per-area catalog`

### [ ] TASK 12 — Dashboard sections + offers (47 sites)
**Files:** `[api] src/controllers/dashboardController.js`, `offerRoutes.js` + offer handlers

- [ ] 12.1 `dashboard_sections`, `dashboard_section_items`, `offers`, `offer_products`.
- [ ] 12.2 Cache key → `dashboard:<areaId>:<storeType>:closed=<0|1>`.
- [ ] 12.3 All 50 query sites in `dashboardController.js` scoped; section fan-out unchanged.
- [ ] 12.4 Test: area 2's dashboard returns only area 2's sections and items.

**Commit:** `feat: AREA TASK 12 — per-area dashboard and offers`

### [ ] TASK 13 — Orders, order items, order numbers (123 sites)
**Spec:** §6.3 — **read it before starting** · **Files:** `[api] src/controllers/orderController.js`,
`src/db/migrate.js`, `src/services/shopOrderActions.js`, `tests/orderNumber.test.js`,
`tests/cartOrder.test.js`, `tests/orderIdempotency.test.js`

> 13.2–13.5 must land in **one commit**. Splitting them across deploys breaks checkout in production.

- [ ] 13.1 Order create stamps `area_id` from the resolved zone's area.
- [ ] 13.2 Backfill `daily_order_counters.area_id = 1`.
- [ ] 13.3 Change its PK to `(area_id, counter_date)`.
- [ ] 13.4 `generateOrderNumber` → `INSERT INTO daily_order_counters (area_id, counter_date, seq)
      VALUES (?, ?, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE seq = LAST_INSERT_ID(seq + 1)`.
- [ ] 13.5 Format → `OD-<date>-<AREACODE>-<seq>`. The extra segment makes collision with a legacy
      `OD-<date>-<seq>` structurally impossible.
- [ ] 13.6 **Never** `UPDATE orders SET order_number` — historical numbers keep their old format
      forever.
- [ ] 13.7 Scope the remaining ~120 `orders` / `order_items` sites.
- [ ] 13.8 **Do not touch** idempotency or compare-and-set logic.
- [ ] 13.9 Test: two areas ordering on the same date get independent sequences, both starting at 1,
      no `order_number` collision.
- [ ] 13.10 Test: an existing order's number is unchanged after migration.

**Commit:** `feat: AREA TASK 13 — per-area orders and order numbers`

### [ ] TASK 14 — Coupons (22 sites)
**Files:** `[api] src/controllers/couponController.js`, `src/utils/coupons.js` (inputs only),
`tests/coupons.test.js`, `tests/couponZoneDerivation.test.js`

- [ ] 14.1 `coupons`, `coupon_zones`, `coupon_users`, `coupon_redemptions` scoped by area.
- [ ] 14.2 Area filter goes into the **inputs** of `utils/coupons.js`. **The rule engine itself is
      untouched** — no area logic inside it.
- [ ] 14.3 `FOR UPDATE` locking unchanged.
- [ ] 14.4 On write, assert the coupon and its `coupon_zones` share an area.
- [ ] 14.5 Test: code `SAVE10` exists independently in two areas; area 1's cart cannot redeem area
      2's coupon.

**Commit:** `feat: AREA TASK 14 — per-area coupons`

### [ ] TASK 15 — Shops, riders, rider assignment, sweepers (96 sites)
**Spec:** H2 · **Files:** `[api] src/utils/shops.js`, `src/utils/riders.js`,
`src/services/riderAssignment.js`, `src/controllers/shopAdminController.js`, `riderController.js`,
`adminRiderController.js`, `src/realtime/shopScheduleSweeper.js`, `src/realtime/riderOfferSweeper.js`

- [ ] 15.1 `shops` (63) and `riders` (33) scoped.
- [ ] 15.2 `utils/riders.js:95` eligible-rider query gains `r.area_id = ?` — an area 2 order must
      never offer to an area 1 rider.
- [ ] 15.3 `syncGlobalShopOpenState` → `syncAreaShopOpenState(areaId)`; stops scanning the whole
      `shops` table; writes that area's `settings.shop_open`.
- [ ] 15.4 `shopScheduleSweeper` loops areas (H2) and emits into the right area room.
- [ ] 15.5 `riderOfferSweeper` — decide and **write down in a comment**: stays global for expiry, but
      its emits target the offer's area room.
- [ ] 15.6 `purgeExpiredDeletions` stays global (users are global) — add to the guardrail allowlist
      with that justification.
- [ ] 15.7 **Do not touch** the offer/accept/expiry state machine.
- [ ] 15.8 Test: area 2 order offers only to area 2 riders.

**Commit:** `feat: AREA TASK 15 — per-area shops, riders, assignment, sweepers`

### [ ] TASK 16 — Notifications + broadcast push (14 sites)
**Spec:** H6 · **Files:** `[api] src/controllers/notificationController.js`,
`src/utils/notificationService.js`, `src/utils/adminNotifications.js`, `src/utils/expoPush.js`

- [ ] 16.1 `notifications`, `notification_batches`, `admin_notifications` scoped.
- [ ] 16.2 `notification_templates` stays **global** — already correct, leave it.
- [ ] 16.3 Broadcast targets one area by `users.last_area_id`, unless a super admin opts into
      all-areas.
- [ ] 16.4 Surface the imprecision in the admin UI copy (H6): last-known-area targeting misses users
      who have never ordered.
- [ ] 16.5 Order-related pushes unaffected (they target a specific user about a specific order).

**Commit:** `feat: AREA TASK 16 — per-area notifications and broadcast`

### [ ] TASK 17 — Analytics + reports (MySQL + Mongo)
**Spec:** §9.5 — **follow it exactly** · **Files:** `[api] src/services/analytics/collections.js`,
`eventStore.js`, `sessionStore.js`, `rollup.js`, `src/controllers/analyticsController.js`,
`src/realtime/presence.js`, `src/utils/reportPeriods.js`, report handlers

- [ ] 17.1 `insertEvents` and the session insert take `areaId` from `resolveCustomerArea`; fall back
      to `users.last_area_id`, then default area.
- [ ] 17.2 **No backfill for `analytics_sessions` or `analytics_events`** — 30-day TTL ages them out.
- [ ] 17.3 `analytics_daily`: one `updateMany({areaId:{$exists:false}}, {$set:{areaId:1}})` (~365
      docs). Run **before** creating the new unique index.
- [ ] 17.4 Drop `{date:1}` unique → create `{areaId:1, date:1}` unique.
- [ ] 17.5 Add `{areaId:1, createdAt:-1}` to sessions and events; remap
      `{type,createdAt}` → `{areaId,type,createdAt}` and
      `{productId,type,createdAt}` → `{areaId,productId,type,createdAt}`.
- [ ] 17.6 **Leave every TTL index single-field on `createdAt`.** A compound TTL index silently
      stops expiry and the collections grow without bound.
- [ ] 17.7 Rollup groups by `(areaId, date)`, writes one daily doc per area.
- [ ] 17.8 `presence.js:134` `emitLiveSnapshot` — per-area snapshot to `admin:<areaId>` (H2), or
      every area admin sees every area's live traffic.
- [ ] 17.9 MySQL report endpoints group by area; super admin gets the all-areas roll-up (§2.10).
- [ ] 17.10 Transition window: treat a missing `areaId` as area 1 at query time.

**Commit:** `feat: AREA TASK 17 — per-area analytics and reports`

---

## Phase D — Shared libraries

### [ ] TASK 18 — Library tables + image dedupe
**Spec:** §2.5, §2.6, §6.5 · **Files:** `[api] src/db/migrate.js`,
`src/controllers/imageController.js`, `src/utils/imageStorage.js`

- [ ] 18.1 `product_library` — `id, name, description, image_id, unit_id, variant_prompt,
      default_store_type, default_category_slug, suggested_price,
      status ENUM('draft','published'), archived`, timestamps.
- [ ] 18.2 `library_variants` — `id, library_product_id, label, display_order, is_default`.
- [ ] 18.3 `products.library_product_id INT NULL` + index `(library_product_id)` (propagation
      fan-out, §3.3). `product_variants.library_variant_id INT NULL` + index. Both at end of row.
- [ ] 18.4 `images.sha256 CHAR(64) NULL` + **non-unique** index. Production already holds duplicate
      uploads; a UNIQUE index fails the migration outright (§2.6).
- [ ] 18.5 Hash on upload; return the existing row instead of inserting a duplicate.
- [ ] 18.6 Batched backfill of `sha256` on existing rows. **Populates the column only** — never
      deletes, never merges.
- [ ] 18.7 **Extend `getUsedImageIds` (`imageController.js:15-43`) with `product_library.image_id` in
      this same commit** (§6.5). It scans a hard-coded list of six tables and `products.image_id` has
      no FK — a missed table means deleting an image the library still needs.
- [ ] 18.8 **No auto-promotion** of existing products into the library. They stay local-only until an
      admin promotes them in TASK 19.

**Commit:** `feat: AREA TASK 18 — product library tables + image dedupe`

### [ ] TASK 19 — Library CRUD, add-from-library, promote
**Spec:** §4.5 · **Files:** `[api] src/utils/productLibrary.js` (new),
`src/controllers/libraryController.js` (new), `src/routes/adminRoutes.js`

- [ ] 19.1 `materializeToArea(conn, {libraryProductId, areaId, categoryId, price, shopId, ...})` —
      **the only writer of `products.library_product_id`**. Reuses the existing
      `syncProductVariants` path so the `products.price` ⇄ default-variant mirror cannot drift.
- [ ] 19.2 `GET /admin/library` — search/filter/paginate; each row reports which areas carry it.
- [ ] 19.3 `POST /admin/library`, `PATCH /admin/library/:id`, `POST /admin/library/:id/archive`.
      All `requireSuperAdmin`.
- [ ] 19.4 `POST /admin/library/:id/add-to-area` — `areaId`, `categoryId`, `storeType`, `price`,
      optional `shopId`, `shopPrice`, per-variant prices. One transaction. Any admin may call it for
      **their own** area.
- [ ] 19.5 Idempotent: adding an item the area already has returns the existing product with an
      "already linked" flag, never a duplicate.
- [ ] 19.6 `POST /admin/library/:id/add-to-areas` — fan out to many areas in one transaction with a
      per-area price map.
- [ ] 19.7 `POST /admin/products/:id/promote-to-library` — lift name/image/variants into a new
      library item and link the source. Touches no other area's rows.
- [ ] 19.8 Test: materialize into two areas at different prices; both carry identical
      name/image/variant labels.

**Commit:** `feat: AREA TASK 19 — library CRUD, add-from-library, promote`

### [ ] TASK 20 — Library edit propagation
**Spec:** §3.7, §6.7 · **Files:** `[api] src/utils/productLibrary.js`, `libraryController.js`

- [ ] 20.1 `propagateLibraryEdit(conn, libraryProductId)` — **one** batched
      `UPDATE products SET name=?, description=?, image_id=?, unit=? WHERE library_product_id=?`.
- [ ] 20.2 **Explicit column list, always.** Never a `SET` built from a spread of the request body —
      one stray column overwrites every area's pricing in a single statement (§6.7).
- [ ] 20.3 One batched `UPDATE product_variants` for labels.
- [ ] 20.4 Affected areas from a single `SELECT DISTINCT area_id`; `bustAreaCaches` per area **after
      the response is sent**.
- [ ] 20.5 Variant **adds** → new per-area rows at `suggested_price` with `available = 0`, so a new
      size never goes on sale at a price nobody chose.
- [ ] 20.6 Variant **removals** → soft-delete (`deleted = 1`). Live carts and order snapshots hold
      `product_variants.id` and must keep resolving. Never a hard delete.
- [ ] 20.7 Test: after a library edit, every per-area `price`, `available` and `display_order` is
      byte-identical.
- [ ] 20.8 Test: the `products.price` ⇄ default-variant mirror survives every propagation path.

**Commit:** `feat: AREA TASK 20 — library edit propagation`

### [ ] TASK 21 — Category + store-mode libraries
**Spec:** §2.7 · **Files:** `[api] src/db/migrate.js`, `src/utils/productLibrary.js` (reuse),
`src/controllers/categoryController.js`, `storeModeController.js`, `imageController.js`

- [ ] 21.1 `category_library (id, name, slug, type, image_id, archived)`;
      `store_mode_library (id, slug, label, icon_image_id, is_system, archived)`.
- [ ] 21.2 `categories.library_category_id` and `store_modes.library_store_mode_id`, both nullable
      + indexed.
- [ ] 21.3 Propagate identity (name/slug/icon) via the **same** batched mechanism as TASK 20.
      **Do not write a second propagation path** (§4.5).
- [ ] 21.4 `active`, `display_order`, `is_default` are strictly per-area and **never** propagated.
- [ ] 21.5 NULL library link = local-only, fully editable, exactly as today.
- [ ] 21.6 **Extend `getUsedImageIds` with `category_library.image_id` and
      `store_mode_library.icon_image_id` in this same commit** (§6.5).
- [ ] 21.7 Test: renaming a library category reaches both areas and changes neither area's
      `display_order`.

**Commit:** `feat: AREA TASK 21 — category and store-mode libraries`

### [ ] TASK 22 — Fulltext search, area scoping, units lookup
**Spec:** §3.11, H4 · **Files:** `[api] src/db/migrate.js`,
`src/controllers/productController.js` (`:377`, `:635`), `tests/productCategory.test.js`

- [ ] 22.1 `FULLTEXT KEY ft_products_name (name)` on `products`; same on `product_library.name`.
- [ ] 22.2 Customer search → `WHERE p.area_id = ? AND MATCH(p.name) AGAINST (? IN BOOLEAN MODE)`
      with a `term*` prefix. Replaces the unindexable `LIKE '%term%'` full scan.
- [ ] 22.3 Keep `LIKE` only as a fallback for terms shorter than `innodb_ft_min_token_size`.
- [ ] 22.4 Admin "find a product to add" searches **`product_library`** — one global index instead of
      N per-area copies — then maps to area rows via `library_product_id`.
- [ ] 22.5 `units` lookup table; `product_library.unit_id` points at it; backfill from distinct
      existing `products.unit` strings.
- [ ] 22.6 `products.unit` **keeps its current free-text column and value** — no response shape
      changes.
- [ ] 22.7 **Test: a customer search in area 2 returns zero area 1 products.**
- [ ] 22.8 Benchmark before/after on a realistic row count; record the numbers in the commit body.

**Commit:** `feat: AREA TASK 22 — fulltext search, area scoping, units lookup`

---

## Phase E — Realtime

### [ ] TASK 23 — Per-area socket rooms
**Spec:** §3.5, H7 · **Files:** `[api] src/realtime/socket.js`, `orderEvents.js`,
`src/services/riderAssignment.js`, `tests/realtime*.test.js`

- [ ] 23.1 Rooms → `customers:<areaId>`, `admin:<areaId>`. `customer:<userId>` unchanged.
- [ ] 23.2 `emitToAllCustomers(areaId, event, payload)` and `emitToAdmins(areaId, ...)`.
- [ ] 23.3 Customer socket joins on connect using `users.last_area_id`, and **rejoins** on an area
      change pushed by the client.
- [ ] 23.4 Tolerate a socket that has joined **no** area room yet — cold start races the pin (H7).
      Never block the connection waiting for an area.
- [ ] 23.5 Super admin joins every `admin:<areaId>` room.
- [ ] 23.6 **Event names and payload fields unchanged** — only the room changes.
- [ ] 23.7 Test: a zone edit in area 2 reaches no area 1 socket.

**Commit:** `feat: AREA TASK 23 — per-area socket rooms`

---

## Phase F — Super admin API + UI

### [ ] TASK 24 — Super-admin endpoints, clone-area, the 409 gate
**Spec:** §2.12, §6.6, §6.8 · **Files:** `[api] src/controllers/areaController.js` (new),
`src/routes/adminRoutes.js`, `src/validators/index.js`

- [ ] 24.1 `POST /admin/areas` — one transaction creating the area, its `settings` row, and its
      system store modes. **A new area is created empty** — no catalog, shops, riders or offers.
- [ ] 24.2 `GET /admin/areas`, `PATCH /admin/areas/:id`.
- [ ] 24.3 `POST /admin/admins`, `GET /admin/admins`, `PATCH /admin/admins/:id`. Enforce the §2.9
      role/area invariant here.
- [ ] 24.4 **Ship the §6.6 gate in this task:** `POST /admin/areas` returns **409** unless
      `areas_sweep_complete` is set. Only TASK 30 sets it. Never a follow-up commit.
- [ ] 24.5 `POST /admin/areas/:id/clone-from/:sourceId` — copies categories, store modes, dashboard
      sections, offers and library-linked products (flat copy or price multiplier). Copies are
      **independent rows with no ongoing link** to the source.
- [ ] 24.6 Clone **never** copies orders, customers, riders, shops or coupons.
- [ ] 24.7 Clone returns **409** against a target that already has categories or products, so a
      double click cannot duplicate a catalog (§6.8).
- [ ] 24.8 Area delete is **not supported** — deactivate only; say so in the response of any delete
      attempt.

**Commit:** `feat: AREA TASK 24 — super admin endpoints, clone-area, creation gate`

### [ ] TASK 25 — Admin client, area switcher, all-areas mode
**Spec:** §2.10, §4.4 · **Files:** `[adm] src/api/client.js:15`, `src/layout/AdminLayout.jsx`,
`src/components/AuthProvider.jsx`, a new area store

- [ ] 25.1 `client.js` attaches `X-Area-Id` from a single store — **the only place** it is set (§4.4).
      No page component passes an area.
- [ ] 25.2 Area dropdown in `AdminLayout`, visible only to `super_admin`, including an
      **"All areas"** option sending `X-Area-Id: all`.
- [ ] 25.3 Switching areas clears client-side cached data (each page fetches in `useEffect`; there is
      no react-query layer, so a remount or a keyed effect dependency is the mechanism).
- [ ] 25.4 Pages that reject `all` (Settings, Delivery Zones, Store Modes) render an inline
      "pick an area" state, not an error toast.
- [ ] 25.5 `area_admin` sees no switcher, no Areas page, no library editing.
- [ ] 25.6 Persist the selected area across reloads; validate it against `GET /admin/areas` on boot.

**Commit:** `feat: AREA TASK 25 — admin area switcher and all-areas mode`

### [ ] TASK 26 — Areas, Admins and Library pages
**Spec:** §2.10, §4.7 · **Files:** `[adm] src/pages/Areas.jsx`, `Admins.jsx`, `Library.jsx` + CSS,
`src/App.jsx`, `src/pages/Products.jsx`

- [ ] 26.1 Areas page — list, create, edit, deactivate, brand colour, logo, feature toggles.
- [ ] 26.2 Admins page — list, create, edit, deactivate; role + area picker.
- [ ] 26.3 Library page — **one page, three tabs** (Products / Categories / Store Modes), not three
      pages. Grid of image + name + variants.
- [ ] 26.4 Per-row "Add to area…" opening a price form; multi-select "Add to areas…" bulk action
      with a per-area price map.
- [ ] 26.5 Each library row shows which areas already carry it.
- [ ] 26.6 `Products.jsx` gains "+ Add from Library" next to "+ New Product".
- [ ] 26.7 `Products.jsx` renders library-managed fields (name, image, description, unit, variant
      labels) **read-only** with a "Managed in Library — edit there" link (§2.5).
- [ ] 26.8 Route the three pages in `App.jsx` behind a super-admin guard.
- [ ] 26.9 **No parallel copies of the existing 23 pages** (§4.7).

**Commit:** `feat: AREA TASK 26 — areas, admins and library admin pages`

---

## Phase G — Payload optimization + customer app

### [ ] TASK 27 — Catalog version, ETags, `/bootstrap`
**Spec:** §3.10, §9.4 item 4 · **Files:** `[api] src/utils/areaScope.js`,
`src/controllers/bootstrapController.js` (new), `src/app.js`, public GET handlers

- [ ] 27.1 `catalog_version` bumps inside `bustAreaCaches` (already wired in 6.5) — verify every
      catalog/settings/zone write path reaches it.
- [ ] 27.2 `ETag: "<areaId>-<catalogVersion>"` + `If-None-Match` → **304** on the public catalog,
      categories, settings and zone-geometry endpoints.
- [ ] 27.3 `GET /bootstrap?lat=&lng=` → `{ area, zone, settings, storeModes, zoneGeometry,
      catalogVersion }` in one response.
- [ ] 27.4 Pin resolving to no zone → the "we don't deliver here yet" shape, **never** the default
      area (§2.4).
- [ ] 27.5 **`settings` in the payload carries the resolved area's `upi_id`, `upi_qr_image_id`,
      `support_phone`, `whatsapp_number`.** The UPI target decides which bank account receives real
      money — get this wrong and payments go to the wrong area.
- [ ] 27.6 Every existing endpoint keeps working unchanged; `/bootstrap` is purely additive.
- [ ] 27.7 Measure: cold-start round trips before vs after. Record in the commit body.

**Commit:** `feat: AREA TASK 27 — catalog version, ETags, bootstrap endpoint`

### [ ] TASK 28 — Pin-driven area resolution in the app
**Spec:** §2.4 · **Files:** `[app] src/api/httpClient.js`, `src/api/index.js` (new bootstrap client),
`src/stores/useDeliveryLocationStore.js`, `src/hooks/useDeliveryLocationSync.js`,
`src/screens/customer/HomeScreen/HomeScreen.js`

- [ ] 28.1 Call `/bootstrap` with the live pin on cold start and on every pin change.
- [ ] 28.2 Store `areaId`, `zoneId`, `areaName`, `brandColor`, `catalogVersion` alongside the pin in
      `useDeliveryLocationStore`.
- [ ] 28.3 Catalog, dashboard, store modes and search all key off the stored `areaId`.
- [ ] 28.4 **Respect the existing cold-start rule already on `main`:** live GPS wins over a saved
      manual pin. The area follows the pin that actually wins, not the stored one.
- [ ] 28.5 Send `If-None-Match` from the stored `catalogVersion` on subsequent catalog fetches.
- [ ] 28.6 Render the area's `support_phone` / `whatsapp_number` and checkout UPI from bootstrap, not
      from a hardcoded or globally-cached value.
- [ ] 28.7 Replace the separate `getSettings()` + `getDashboard()` cold-start calls
      (`HomeScreen.js:355,359`) with the single bootstrap where it is a clean swap.

**Commit:** `feat: AREA TASK 28 — pin-driven area resolution in the app`

### [ ] TASK 29 — Area-change invalidation
**Spec:** §2.4 · **Files:** `[app] src/hooks/useDeliveryLocationSync.js`, `src/stores/useCartStore.js`,
`src/api/realtimeClient.js`, `__tests__/cartZoneRevalidation.test.js`

- [ ] 29.1 Detect an **area** change, not only a zone change.
- [ ] 29.2 On area change: clear the cart, refetch settings/dashboard/catalog, clear cached search
      results, rejoin the socket room.
- [ ] 29.3 A cart assembled at area 1 prices must never reach checkout against area 2 zones.
- [ ] 29.4 Pin outside every zone → "we don't deliver here yet" state. Not an empty catalog, not the
      default area's catalog.
- [ ] 29.5 Extend `__tests__/cartZoneRevalidation.test.js` with the area-change case.
- [ ] 29.6 Reorder from an old order whose product does not exist in the current area: show the
      order, **disable** reorder, explain why. Never substitute another area's product (§9.4 item 2).

**Commit:** `feat: AREA TASK 29 — area-change invalidation`

---

## Phase H — Verification

### [ ] TASK 30 — Cross-area isolation E2E
**Spec:** §6.6, §9.4 · **Files:** `[api] tests/areaIsolation.test.js` (new)

Set up: area 2 with its own admin, shop, rider, zone and catalog.

- [ ] 30.1 Area 2's admin cannot read or write any area 1 row — 403 or empty, **never partial**.
- [ ] 30.2 An area 1 pin gets area 1's catalog, dashboard, search results and pricing.
- [ ] 30.3 A search in area 2 for an area-1-only product name returns **nothing**.
- [ ] 30.4 Moving the pin from area 1 to area 2 clears the cart and swaps the catalog.
- [ ] 30.5 A pin outside every zone shows the no-delivery state, not any catalog.
- [ ] 30.6 An area 2 order never offers to an area 1 rider.
- [ ] 30.7 A zone edit in area 2 busts no area 1 cache and reaches no area 1 socket.
- [ ] 30.8 Coupon code `SAVE10` exists independently in both areas.
- [ ] 30.9 Order numbers do not collide; an existing order's number is unchanged.
- [ ] 30.10 One library product in both areas: **same** name/image/variant labels, **different**
      prices.
- [ ] 30.11 A library rename updates both areas and changes neither price.
- [ ] 30.12 A library category rename reaches both areas and changes neither `display_order`.
- [ ] 30.13 **Independence (§2.12):** changing an area 1 product's price, availability, shop or
      category produces **zero** change in area 2.
- [ ] 30.14 **Money routing (§9.4 item 4):** an area 2 pin shows area 2's `support_phone` and
      `whatsapp_number`, and checkout targets area 2's `upi_id` / QR.
- [ ] 30.15 A super admin loads all 23 existing pages against either area, plus the all-areas
      roll-up.
- [ ] 30.16 Guardrail test green with **no new allowlist entries**.
- [ ] 30.17 Re-run the TASK 0 row-count comparison; spot-check that area 1's prices, order history
      and order-number formats are exactly what they were before TASK 1.
- [ ] 30.18 **Only after every assertion above passes:** set `areas_sweep_complete`. That flag is
      what unlocks creating a real second area (§6.6).

**Commit:** `feat: AREA TASK 30 — cross-area isolation E2E`

---

## Progress

| Phase | Tasks | Status |
|---|---|---|
| 0 — Safety gate | 0 | ☐ |
| A — Foundations | 1–6 | ☐ |
| B — Auth | 7–8 | ☐ |
| C — Backend sweep | 9–17 | ☐ |
| D — Libraries | 18–22 | ☐ |
| E — Realtime | 23 | ☐ |
| F — Super admin | 24–26 | ☐ |
| G — App + payload | 27–29 | ☐ |
| H — Verification | 30 | ☐ |
