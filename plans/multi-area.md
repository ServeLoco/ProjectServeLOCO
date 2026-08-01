# ProjectServeLoco — Multi-Area (Super Admin) Expansion

Spec date: 2026-08-01 · Branch: `feat/multi-area-super-admin` · Status: **NOT STARTED**
Instruction spec for an implementing AI. Follow it literally.

Today the whole platform is one area ("Area 1"): one settings row, one set of zones, one admin
password, one flat catalog. This spec turns it into **N independent areas** under a **super admin**,
without forking the codebase, without slowing anything down, and without duplicating logic.

**Core rule of this spec: adding an area must not add a query, a round trip, or a cache miss to any
existing request path.** Every task below is written to keep per-request cost flat as areas grow.

---

## 0. How to read this file

1. Read **BACKGROUND** (§1), **LOCKED DECISIONS** (§2), **PERFORMANCE CONTRACT** (§3) and
   **DRY CONTRACT** (§4) before writing any code. §1 was verified in code on 2026-08-01 — do not
   re-derive unless a path has moved.
2. Execute tasks **in order** (TASK 1 → TASK 24). Later tasks assume earlier ones are done.
3. Surgical changes only. Additive API shapes: where a response already duplicates camelCase +
   snake_case, keep duplicating. One commit per task.
4. Run `npm test` in `apps/api` after **every** backend task. Run `npx eslint <files>` on every file
   you touch. A task is not done if tests fail.
5. Tick each task's checkbox with a one-line note when done.

**Commit format:** `feat: AREA TASK <n> — <short title>`

### DO NOT TOUCH (unless a task explicitly says so)

- Coupon `FOR UPDATE` row locking and the single rule engine in `apps/api/src/utils/coupons.js`
  (you only add an area filter to its *inputs*, never to its rule logic).
- Compare-and-set order status/payment updates and `409 CONCURRENCY_CONFLICT` responses.
- `Idempotency-Key` logic in `createOrder` and its UNIQUE index.
- The rider offer/accept/expiry state machine in `apps/api/src/services/riderAssignment.js` —
  TASK 15 only narrows the *candidate query*, never the offer lifecycle.
- The dual camelCase/snake_case response duplication anywhere.
- Existing order events in `apps/api/src/realtime/orderEvents.js` — you change *which room* they go
  to, never the event names or payload fields.
- Firebase OTP auth flow in `authController.js`.

---

## 1. BACKGROUND — verified in code 2026-08-01

### 1.1 Scale of the change

| Thing | Count | Note |
|---|---|---|
| API source files | 93 | `apps/api/src` |
| Express routes | 188 | 130 behind `requireAdmin` |
| Admin pages | 24 | `apps/admin/src/pages/*.jsx`, 23 routed in `App.jsx` |
| SQL sites: `orders` | 123 | biggest sweep |
| SQL sites: `products` | 79 | |
| SQL sites: `shops` / `users` | 63 / 63 | `users` stays global — see §2.2 |
| SQL sites: `categories` | 44 | |
| SQL sites: `riders` | 33 | |
| SQL sites: `settings` | 27 | all assume a singleton row |
| SQL sites: `dashboard_sections` | 26 | |
| SQL sites: `combos` | 26 | |
| SQL sites: `coupons` | 22 | |
| SQL sites: `offers` | 21 | |
| SQL sites: `delivery_zones` | 18 | |
| SQL sites: `notifications` | 14 | |
| SQL sites: `store_modes` | 13 | |

### 1.2 What exists today

| Thing | Where | Multi-area problem |
|---|---|---|
| Admin login | `apps/api/src/controllers/adminController.js:47` | Single `ADMIN_PASSWORD_HASH` env var. **No `admins` table at all.** |
| Admin session revocation | `migrate.js:1592` `admin_auth_state` | Singleton row `id = 1`. One revoke logs out every area. |
| `requireAdmin` | `apps/api/src/middleware/authMiddleware.js:55` | Sets `req.admin = { id, role }`. No area. |
| Settings | `migrate.js:704` | **Singleton row.** 27 read sites do `LIMIT 1`. |
| Settings cache | `settingsController.js:12` | `createTtlCache({ttlMs:15_000})`, single key `'settings'`. |
| Zone load | `deliveryPricing.js:291` | `SELECT * FROM delivery_zones WHERE active = 1` — **loads every zone on the planet**, then does point-in-polygon in JS. Called on every cart preview and every order create. |
| Public zone geometry | `deliveryZonesController.js:164` | Same — returns all polygons to every app that opens the map. |
| Dashboard | `dashboardController.js:419` | Cache key `dashboard:${storeType}:closed=${0|1}`. 50 query sites in the file. |
| Micro-cache | `apps/api/src/utils/microCache.js` | Global `Map`, **`MAX_ENTRIES = 100`**, FIFO. `bust(prefix)` wipes *every* key with that prefix. |
| Store-mode cache | `apps/api/src/utils/storeMode.js:17` | Single key `'active_slugs'`. |
| Global shop-open sync | `apps/api/src/utils/shops.js:250` | `SELECT ... FROM shops` with **no WHERE** → writes one global `settings.shop_open`, then `emitToAllCustomers`. |
| Socket rooms | `apps/api/src/realtime/socket.js:72-80` | `customer:<id>`, `customers`, `admin`. Flat — a zone edit in Area 7 wakes every customer in the country. |
| Rider candidates | `apps/api/src/utils/riders.js:95` | `FROM riders r WHERE r.active = 1 AND r.is_online = 1` — no area filter. |
| Order counter | `migrate.js:618` | `daily_order_counters` PK is `counter_date` alone. |
| Mongo analytics | `apps/api/src/services/analytics/collections.js:29` | `analytics_daily` unique index `{date: 1}`. |
| Admin HTTP client | `apps/admin/src/api/client.js:15` | Single `apiClient()` chokepoint — one place to inject a header. |
| Customer HTTP client | `apps/customer-app/src/api/httpClient.js` | Single chokepoint, 8s timeout, retry on 502/503/504. |
| Customer persisted stores | `apps/customer-app/src/stores/` | `useAuthStore`, `useCartStore`, `useSettingsStore`, `useDeliveryLocationStore` all AsyncStorage-persisted. |
| `products.shop_id` | `migrate.js:361` | Nullable. A product may already belong to a shop. |

### 1.3 UNIQUE keys that break silently under multi-area

These are the landmines. Each one, left alone, lets Area 2 collide with Area 1 and *look* like a
random bug months later.

| Table | Current key | Must become |
|---|---|---|
| `categories` | `slug VARCHAR(255) NOT NULL UNIQUE` (`migrate.js:271`) | `UNIQUE (area_id, slug)` |
| `store_modes` | `slug VARCHAR(50) NOT NULL UNIQUE` (`:301`) | `UNIQUE (area_id, slug)` |
| `coupons` | `uniq_live_coupon_code (code, deleted)` (`:1387`) | `UNIQUE (area_id, code, deleted)` |
| `dashboard_sections` | `idx_section_store_slug (store_type, slug, deleted_at)` (`:968`) | prepend `area_id` |
| `daily_order_counters` | `PRIMARY KEY (counter_date)` (`:619`) | `PRIMARY KEY (area_id, counter_date)` |
| `admin_notifications` | `uniq_admin_inbox_event (type, related_id)` (`:1550`) | prepend `area_id` |
| `analytics_daily` (Mongo) | `{date: 1}` unique (`collections.js:29`) | `{areaId: 1, date: 1}` unique |
| `orders.order_number` | globally UNIQUE | **keep global unique**, but prefix with area code |
| `mobile_admins.phone` | UNIQUE | **keep global unique** — a phone admins at most one area |
| `riders.user_id` | UNIQUE | **keep global unique** — a phone rides for at most one area |
| `users.phone` | UNIQUE | **keep global unique** — see §2.2 |

---

## 2. LOCKED DECISIONS — do not re-ask, do not invent policy

### 2.1 `area_id INT`, not `area_code VARCHAR`

The column is `area_id INT NOT NULL` with a real FK to `areas(id)`. The human-facing short code
lives once, in `areas.code` (e.g. `FTB`, `HSR`). Reason: a 4-byte int is the leftmost column of
every hot composite index in this system — a varchar there inflates every secondary index, slows
every range scan, and makes renaming an area a data migration instead of one `UPDATE`.

### 2.2 Customers are global; orders are area-scoped

One phone = one `users` row nationwide. A customer who travels from Area 1 to Area 2 keeps their
account, history and saved addresses. `users` gets **no** `area_id`. Each order records the area it
was placed in. `users` gets one nullable convenience column, `last_area_id`, which is a **cache for
cold start only** and is never used as an authorization input.

### 2.3 The server resolves the area. The client never asserts it.

A customer request's area is derived server-side from the delivery pin (lat/lng) via zone polygons.
A client-sent `areaId` is accepted only as a *hint for cold start with no pin*, and is re-validated.
An `area_admin`'s area comes from their JWT and cannot be overridden by any header or body field.
Only a `super_admin` may target another area, and only via the `X-Area-Id` header (TASK 6).

### 2.4 Catalog is per-area, not shared

`categories`, `products`, `combos`, `offers`, `dashboard_sections`, `store_modes` all carry
`area_id`. Area 2's admin builds their own catalog. Reason: the user's stated requirement is "new
riders, new shops, everything different"; a shared catalog with per-area overrides doubles every
read path (base row + override row) for a sharing benefit nobody asked for. `images` stays global
and shared — an uploaded JPEG has no geography, and sharing it saves storage.

### 2.5 Two admin roles only

`super_admin` (area_id NULL, sees everything, creates areas and admins) and `area_admin` (bound to
exactly one area). No per-page permission matrix in v1.

### 2.6 Area boundary = union of its delivery zones

An area has no separate polygon to maintain. Its footprint is the union of its `delivery_zones`.
For fast lookup, each area caches a **bounding box** (`min_lat, max_lat, min_lng, max_lng`)
recomputed on every zone write. See §3.2.

### 2.7 Backward compatibility for existing installs

Existing data becomes area `id = 1`, code `A1`. Every legacy client (old app build with no area
awareness) that hits a public endpoint with no resolvable pin gets the **default area**
(`areas.is_default = 1`). Nothing 404s during rollout.

---

## 3. PERFORMANCE CONTRACT

Violating any of these fails review, even if tests pass.

### 3.1 Area is resolved once per request, never per row

`req.areaId` is set exactly once, by middleware, and read everywhere downstream. No controller may
issue its own "which area is this?" query. No loop may resolve an area per iteration. Any
`SELECT ... FROM areas` inside a per-row map/loop is a defect.

### 3.2 Point-to-area lookup is bbox-first, and cached

Today `loadActiveZones` pulls **every** active zone and runs JS point-in-polygon. That is O(all
zones nationwide) on every cart preview. After this spec:

1. `areas` carries `min_lat/max_lat/min_lng/max_lng` (recomputed on zone write, never per read),
   indexed `(active, min_lat, max_lat)`.
2. Resolve pin → candidate areas with an SQL bbox filter (typically 1 row).
3. Load **only that area's** zones, from a per-area TTL cache.
4. Run the existing polygon matcher unchanged on that small set.

Net effect: the per-request polygon workload **shrinks** compared to today, because Area 1's cart
preview stops walking Area 5's polygons.

### 3.3 Every hot index leads with `area_id`

Adding `area_id` to a WHERE clause without putting it first in the index turns an index seek into a
scan. Required composite indexes (TASK 3):

```
orders               (area_id, status, created_at)
orders               (area_id, created_at)
orders               (area_id, customer_id, created_at)
products             (area_id, category_id, available, display_order)
products             (area_id, deleted, available)
categories           (area_id, active, display_order)
dashboard_sections   (area_id, store_type, active, display_order)
delivery_zones       (area_id, active)
shops                (area_id, active, is_open)
riders               (area_id, active, is_online)
coupons              (area_id, deleted, active)
offers               (area_id, active, deleted)
```

Drop the now-redundant single-column indexes these supersede (`idx_status`, `idx_created_at` on
`orders`) — a leftmost-prefix composite already covers them, and every retained duplicate costs
write throughput on the hottest table in the system.

### 3.4 Caches are keyed by area and busted by area

`microCache` today is a 100-entry global `Map` and `bust('dashboard')` wipes **all** dashboards.
With N areas that is (a) instant thrash — 100 entries divided by N areas — and (b) a cross-tenant
invalidation storm: Area 3 editing one product cold-starts Area 1's dashboard.

Required (TASK 4):
- Key format is fixed: `<namespace>:<areaId>:<rest>`.
- `bust(namespace, areaId)` clears one area's slice. `bust(namespace)` with no areaId stays
  available for genuinely global data only.
- `MAX_ENTRIES` becomes configurable, default `600`, so ~20 areas keep working sets resident.
- Same treatment for `settingsCache` (`settingsController.js:12`) and the store-mode cache
  (`storeMode.js:17`): key by area, invalidate by area.

### 3.5 Socket fan-out is per-area

`emitToAllCustomers` currently reaches every connected customer nationwide. Under multi-area that is
both a privacy leak (Area 1 learns Area 7 edited a zone) and a scaling problem — every zone save
broadcasts to the entire user base. Rooms become `customers:<areaId>` and `admin:<areaId>`, with
super admins joining all admin rooms. `emitToAllCustomers(areaId, ...)` is the new signature.

### 3.6 Migration must not lock the `orders` table

`ensureColumn` in `migrate.js` always uses `AFTER <col>`. On MySQL 8, `ADD COLUMN ... AFTER` forces
an `INPLACE` table rebuild; only appending at the **end** of the row qualifies for `ALGORITHM=INSTANT`.
On a large `orders` table that is minutes of rebuild on boot.

Therefore: **`area_id` is appended at the end of every table — no `AFTER` clause.** Add a sibling
helper `ensureColumnAtEnd()` rather than bending `ensureColumn` (whose `AFTER` behaviour other
migrations depend on). Backfill `UPDATE ... SET area_id = 1` in batches of 5,000 by primary key, not
one statement. Add indexes *after* backfill.

### 3.7 No new N+1 anywhere

The area name/code shown in admin lists comes from a single `areas` lookup joined once, or from a
process-level `areas` map cached for 60s (there will be tens of areas, not millions). Never one
`SELECT` per order row.

---

## 4. DRY CONTRACT

The failure mode for this kind of change is 500 hand-edited `WHERE area_id = ?` clauses, three of
which are wrong. Structure it so most sites change in one place.

### 4.1 One module owns scoping: `apps/api/src/utils/areaScope.js`

Every consumer uses these; nobody hand-rolls the logic.

```js
resolveAreaForPoint(lat, lng)     // bbox + polygon, cached. -> { areaId, zone } | null
getAreaById(areaId)               // 60s cached row
listAreas({ activeOnly })         // 60s cached
requestAreaId(req)                // the single source of truth for req.areaId
assertAreaAccess(req, areaId)     // throws 403 unless super_admin or matching area_admin
bustAreaCaches(areaId)            // one call fans out to microCache/settings/storeMode
```

### 4.2 One middleware sets `req.areaId`

- `resolveAdminArea` — runs after `requireAdmin`. `area_admin` → own area. `super_admin` → the
  `X-Area-Id` header, or `null` for genuinely cross-area endpoints.
- `resolveCustomerArea` — runs on customer routes that need an area. Order of resolution:
  1. request pin (`latitude`/`longitude` in body or query),
  2. the customer's saved delivery pin,
  3. `users.last_area_id`,
  4. default area.

### 4.3 One cache-bust helper

`bustAreaCaches(areaId)` replaces the scattered pairs of `microCache.bust('dashboard')` +
`microCache.bust('categories')` currently duplicated across `productController` (9 call sites),
`categoryController` (3), `shopAdminController` (2), `shopOwnerController` (3), `settingsController`
(8), `deliveryZonesController` and `shops.js`. Those 25+ sites collapse to one call each.

### 4.4 One admin client chokepoint

`apps/admin/src/api/client.js:15` is the only place `X-Area-Id` is attached. No page component ever
passes an area explicitly.

### 4.5 One guardrail test, written before the sweep

`apps/api/tests/areaScoping.test.js` statically scans `src/controllers`, `src/services`, `src/utils`
for `FROM|JOIN|UPDATE|DELETE FROM <scoped_table>` and fails on any statement lacking an `area_id`
predicate, minus an explicit allowlist of intentionally-global queries (each allowlist entry needs a
one-line comment justifying it). This is what makes a 500-site sweep reviewable — build it in
TASK 5, before touching controllers.

### 4.6 Admin UI reuses the existing pages

`super_admin` does **not** get a parallel copy of the 24 admin pages. It gets an area switcher in the
existing layout plus 2 new pages (Areas, Admins). Picking an area makes the existing pages operate on
that area, unchanged.

---

## 5. TASKS

### Phase A — Foundations (no behaviour change)

- [ ] **TASK 1 — `areas` table + seed Area 1**
  `migrate.js`: create `areas (id, code VARCHAR(16) UNIQUE, name, active TINYINT DEFAULT 1,
  is_default TINYINT DEFAULT 0, timezone VARCHAR(64) DEFAULT 'Asia/Kolkata', min_lat, max_lat,
  min_lng, max_lng DECIMAL(10,7) NULL, created_at, updated_at)`, index `(active, min_lat, max_lat)`.
  `INSERT IGNORE` one row: `id=1, code='A1', name='Area 1', is_default=1`. Nothing reads it yet.

- [ ] **TASK 2 — `admins` table + `admin_auth_state` per admin**
  `admins (id, username VARCHAR(64) UNIQUE, password_hash VARCHAR(255) NOT NULL,
  role ENUM('super_admin','area_admin') NOT NULL, area_id INT NULL, display_name, active TINYINT
  DEFAULT 1, created_at, updated_at)`, FK `area_id → areas(id)`, index `(active, area_id)`.
  Add `admin_id INT` to `admin_auth_state` (keep row `id=1` working as the legacy global revoke).
  Seed one `super_admin` from `ADMIN_PASSWORD_HASH` on first migrate so the existing login keeps
  working. Constraint enforced in application code: `role='area_admin'` requires non-null `area_id`;
  `role='super_admin'` requires `area_id IS NULL`.

- [ ] **TASK 3 — `area_id` column + indexes on all scoped tables**
  Add `ensureColumnAtEnd()` helper (§3.6). Add nullable `area_id INT` **at end of row** to:
  `shops, riders, mobile_admins, delivery_zones, delivery_exclusion_zones, settings, orders,
  order_items, coupons, offers, dashboard_sections, dashboard_section_items, categories, products,
  combos, product_groups, store_modes, admin_notifications, notification_batches`.
  Backfill `= 1` in 5,000-row batches. Then `MODIFY ... NOT NULL`, add FKs, add the composite
  indexes from §3.3, and drop the superseded single-column `orders` indexes.
  Rewrite the UNIQUE keys listed in §1.3.
  Add `users.last_area_id INT NULL` (no FK cascade, cache only).
  Add `daily_order_counters` PK change to `(area_id, counter_date)`.
  Run `npm test` — nothing should change yet.

- [ ] **TASK 4 — Area-aware caches**
  `microCache.js`: enforce `<namespace>:<areaId>:<rest>` keys, add `bust(namespace, areaId)`, raise
  `MAX_ENTRIES` to 600 via an exported constant. `ttlCache.js` gains nothing (already generic).
  `settingsController` settings cache keyed `settings:<areaId>`. `storeMode.js` cache keyed
  `active_slugs:<areaId>`. Update every existing caller to pass area 1 for now — behaviour identical,
  plumbing in place.

- [ ] **TASK 5 — Guardrail test (before the sweep)**
  Write `apps/api/tests/areaScoping.test.js` per §4.5. Seed the allowlist with today's genuinely
  global queries (`users` lookups by phone, `images`, `notification_templates`, auth paths). It will
  fail loudly for every table you have not yet swept — that is the point. Mark it `test.skip` with a
  TODO **only** if it blocks TASK 6-8; un-skip in TASK 9 and keep it green from then on.

- [ ] **TASK 6 — `areaScope.js` + middleware**
  Implement §4.1 and §4.2 in full, with the bbox-first resolver of §3.2. Unit-test
  `resolveAreaForPoint` against: point in one area, point in overlapping child zone, point outside
  every area, missing/NaN coordinates. No controller uses it yet.

### Phase B — Auth (the gate)

- [ ] **TASK 7 — Admin login against `admins`**
  `adminController.js` login: look up `admins` by username, bcrypt-compare, mint a JWT carrying
  `sub`, `role: 'admin'`, `adminRole: 'super_admin'|'area_admin'`, `areaId`. Keep the env-password
  path as a fallback **only** when the `admins` table is empty (fresh install bootstrap), and log a
  warning when it fires. Response adds `adminRole` and `areaId` in both casings.

- [ ] **TASK 8 — `requireAdmin` sets area; add `requireSuperAdmin`**
  `authMiddleware.js`: `req.admin` gains `adminRole` and `areaId`. Add `requireSuperAdmin`. Wire
  `resolveAdminArea` after `requireAdmin` on all 130 admin routes via a router-level `use()`, not
  130 individual edits. Per-admin revocation check replaces the singleton where `admin_id` is set.
  **Security note:** an `area_admin` sending `X-Area-Id` for another area must get 403, not silent
  fallback. Add an explicit test for this.

### Phase C — Backend sweep (one commit per domain)

Each task: add `area_id` to reads and writes, use `req.areaId`, key caches by area, keep response
shapes byte-identical for a single-area install, run `npm test`.

- [ ] **TASK 9 — Settings** (27 sites). `settings` becomes one row per area; `getSettings` selects
  by area; `updateSettings` writes by area; auto-create a settings row when an area is created.
  Un-skip the guardrail test for `settings`.
- [ ] **TASK 10 — Delivery zones + exclusion zones + pricing** (18 sites).
  `loadActiveZones(db, areaId)`, `loadActiveExclusionZones(db, areaId)`. Public geometry endpoint
  takes a resolved area and caches per area. Recompute `areas.min_lat/max_lat/min_lng/max_lng` in
  `notifyZonesChanged`. **This is the single biggest perf win in the spec — verify with a timing
  assertion that a cart preview loads only its own area's zones.**
- [ ] **TASK 11 — Catalog: categories, products, combos, product_groups, store_modes**
  (79 + 44 + 26 + 13 sites). Note `store_modes.is_system` rows (`packed`, `fast_food`) must be seeded
  per area, not globally.
- [ ] **TASK 12 — Dashboard sections + offers** (26 + 21 sites). Cache key becomes
  `dashboard:<areaId>:<storeType>:closed=<0|1>`.
- [ ] **TASK 13 — Orders + order items + counters** (123 sites). Order create stamps `area_id` from
  the resolved pin. `order_number` gets the `areas.code` prefix. Per-area daily counter.
  **Do not touch** the idempotency or compare-and-set logic.
- [ ] **TASK 14 — Coupons** (22 sites). Area filter goes into the *inputs* of
  `utils/coupons.js`; the rule engine itself stays untouched. `coupon_zones` inherits the area from
  its zone — assert the coupon and zone share an area on write.
- [ ] **TASK 15 — Shops + riders + rider assignment** (63 + 33 sites).
  `utils/riders.js` candidate query gains `r.area_id = ?`. `syncGlobalShopOpenState` becomes
  `syncAreaShopOpenState(areaId)` and stops scanning the whole `shops` table.
  **Do not touch** the offer lifecycle.
- [ ] **TASK 16 — Notifications, admin notifications, broadcast push** (14 sites). A broadcast is
  scoped to one area unless a super admin explicitly opts into "all areas".
- [ ] **TASK 17 — Analytics + reports** (MySQL + Mongo). Mongo docs gain `areaId`; indexes become
  `{areaId:1, date:1}` unique for `analytics_daily` and `{areaId:1, createdAt:-1}` compounds for
  sessions/events. Report endpoints group by area; super admin gets an all-areas roll-up.

### Phase D — Realtime

- [ ] **TASK 18 — Per-area socket rooms**
  `socket.js`: `customers:<areaId>`, `admin:<areaId>`. Customer socket joins on connect using
  `users.last_area_id`, and **rejoins** when the app reports an area change. `emitToAllCustomers`
  and `emitToAdmins` take an `areaId`. Super admin joins every admin room. Event names and payloads
  unchanged.

### Phase E — Super admin API + UI

- [ ] **TASK 19 — Super-admin endpoints**
  `POST /admin/areas` (creates area + its settings row + its system store_modes in one
  transaction), `GET /admin/areas`, `PATCH /admin/areas/:id`, `POST /admin/admins`,
  `GET /admin/admins`, `PATCH /admin/admins/:id`. All behind `requireSuperAdmin`.
  Deleting an area is **not** supported in v1 — deactivate only. Say so in the response of any
  delete attempt.
- [ ] **TASK 20 — Admin client + area switcher**
  `apps/admin/src/api/client.js`: attach `X-Area-Id` from a single store, one place (§4.4). Add an
  area dropdown in the existing layout, visible only to `super_admin`. Switching areas clears
  client-side query caches. `area_admin` sees no switcher and no Areas page.
- [ ] **TASK 21 — Areas + Admins pages**
  Two new pages under `apps/admin/src/pages/`, styled with the existing page CSS conventions. No
  duplication of existing pages.

### Phase F — Customer app

- [ ] **TASK 22 — Area resolution in the app**
  On pin change / cold start, the app calls the resolve endpoint and stores `areaId` +
  `areaName`. Persist alongside the delivery pin in `useDeliveryLocationStore`. Respect the existing
  cold-start rule: a cold start defaults to live GPS over a saved manual pin — area follows the pin
  that actually wins, not the stored one.
- [ ] **TASK 23 — Area-change invalidation**
  Extend the existing cart zone revalidation so an **area** change (not just a zone change) clears
  the cart, refetches settings/dashboard/catalog, and rejoins the socket room. Out-of-every-area pin
  shows a "we don't deliver here yet" state instead of an empty catalog. Update
  `apps/customer-app/__tests__/cartZoneRevalidation.test.js` to cover the area-change case.

### Phase G — Verification

- [ ] **TASK 24 — Cross-area isolation E2E**
  Create Area 2 with its own admin, shop, rider, zone, catalog. Assert, with tests:
  Area 2's admin cannot read or write any Area 1 row (403/empty, never partial); an Area 1 customer
  pin gets Area 1 catalog and pricing; an Area 2 order never offers to an Area 1 rider; a zone edit
  in Area 2 does not bust Area 1's caches or reach Area 1's socket room; coupon code `SAVE10` can
  exist independently in both areas; order numbers do not collide. Guardrail test green with no new
  allowlist entries.

---

## 6. ROLLOUT

Phases A–B are additive: old code ignores `area_id`, old clients keep working. Phase C is the risky
stretch — ship it domain by domain, each with `npm test` green. Phase F requires an app release, so
keep the API tolerant of area-unaware clients (§2.7) until adoption is high.

**Before the TASK 3 migration runs against production: take a DB snapshot.** The column adds are
INSTANT, but the UNIQUE-key rewrites in §1.3 rebuild indexes and are not free to reverse.

## 7. OUT OF SCOPE (v1)

- Deleting an area (deactivate only).
- Moving a shop, rider or order between areas.
- Per-page admin permissions beyond the two roles.
- Separate database per area (revisit only if one area's write volume starves the others).
- Customer-visible area switching in-app (area follows the delivery pin, always).
