# ProjectServeLoco — Multi-Area (Super Admin) Expansion

Spec date: 2026-08-01 · Branch: `feat/multi-area-super-admin` · Status: **NOT STARTED**
Instruction spec for an implementing AI. Follow it literally.

Today the whole platform is one area ("Area 1"): one settings row, one set of zones, one admin
password, one flat catalog. This spec turns it into **N independent areas** under a **super admin**,
plus a **shared product library** so the same item is authored once and priced per area — without
forking the codebase, without slowing anything down, and without duplicating logic.

**Core rule of this spec: adding an area must not add a query, a round trip, or a cache miss to any
existing request path.** Every task below is written to keep per-request cost flat as areas grow.

---

## 0. How to read this file

1. Read **BACKGROUND** (§1), **LOCKED DECISIONS** (§2), **PERFORMANCE CONTRACT** (§3) and
   **DRY CONTRACT** (§4) before writing any code. §1 was verified in code on 2026-08-01 — do not
   re-derive unless a path has moved.
2. Execute tasks **in order** (TASK 1 → TASK 28). Later tasks assume earlier ones are done.
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
- **The `products.price` ⇄ default-variant mirror** (`productController.js:244`, `syncProductVariants`).
  It is the backward-compat keystone for old app builds. The product library must not break it.
- **`products.id` and `product_variants.id` stay the identifiers that carts and order snapshots
  reference.** The library sits *above* them; it never replaces them.
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
| Customer cold start | `HomeScreen.js:355,359` | `settingsApi.getSettings()` + `dashboardApi.getDashboard()` as **separate** round trips, plus store modes and zone geometry elsewhere. |
| `compression` middleware | `apps/api/src/app.js:42` | Already on, `threshold: 1024`. No ETag / conditional GET on catalog. |
| API containers | `docker-compose.prod.yml` | **Single `api` service, no replicas** — in-process caches are currently safe. See §3.8. |
| `products` | `migrate.js:326` | Owns `name, price, shop_price, image_id, unit, description, category_id, shop_id, group_id, variant_prompt, available_*_time`. |
| `product_variants` | `migrate.js:377` | `label, price, shop_price, original_price, is_default`. Soft-deleted so live carts keep resolving. `products.price` **always mirrors the default variant**. |
| `images` | `migrate.js:1563` | Global already. Has `thumb_url` (320px WebP). **No content hash → the same JPEG re-uploads as a new row every time.** |

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
Only a `super_admin` may target another area, and only via the `X-Area-Id` header (TASK 8).

### 2.4 Product library: identity is shared, commerce is per-area

**One product is authored once.** Its name, image, description, unit and variant *labels* live in a
global library. Its **price, availability, category placement, shop linkage and display order are
per-area.**

```
product_library          (global)   id, name, description, image_id, unit,
                                    variant_prompt, default_store_type,
                                    default_category_slug, suggested_price,
                                    status ENUM('draft','published'), archived
library_variants         (global)   id, library_product_id, label, display_order, is_default

products                 (per-area) …existing columns… + area_id + library_product_id
product_variants         (per-area) …existing columns… + library_variant_id
```

Adding a library item to an area creates the normal `products` + `product_variants` rows it would
have created by hand. Everything downstream — cart, orders, dashboard, coupons, shop dashboards —
is unchanged and never learns the library exists.

**Identity fields are denormalized into `products`, not joined.** `products.name` and
`products.image_id` keep existing and keep being read exactly as today; linking to a library item
*copies* them, and a library edit propagates with a single
`UPDATE products SET name = ?, image_id = ? WHERE library_product_id = ?`.

Why copy instead of join: the catalog read path is the hottest thing in the system (dashboard alone
issues 50 queries, and it runs on every app open). Adding a `JOIN product_library` to every product
read, in every area, to save a few hundred bytes of duplication is the wrong trade — reads outnumber
library edits by orders of magnitude. Copying also means **zero changes to the 79 existing `products`
query sites** and zero response-shape drift.

Rules:
- Library-owned fields (`name`, `description`, `image_id`, `unit`, variant `label`, `variant_prompt`)
  are **read-only in the per-area product editor.** The UI shows them with a "Managed in Library —
  edit there" affordance and a link.
- Area-owned fields (`price`, `shop_price`, `original_price`, `discount_label`, `available`,
  `category_id`, `shop_id`, `group_id`, `display_order`, `featured`, `available_from/until_time`) are
  fully editable per area and are **never** touched by propagation.
- A product row with `library_product_id IS NULL` is a **local-only product** — legacy rows and
  one-off area specials. Fully editable, exactly as today. Nothing is forced into the library.
- Deleting a library item never deletes area rows. It archives the library item and leaves the area
  products standing (they become local-only). Destructive fan-out across areas is not allowed.

### 2.5 Images are global, deduplicated by content hash

`images` is already global. Add `sha256 CHAR(64)` with a UNIQUE index: re-uploading the same file
returns the existing row instead of writing a duplicate. With N areas reusing one library, this is
the difference between one stored JPEG and N copies.

### 2.6 Two admin roles only

`super_admin` (area_id NULL, sees everything, creates areas and admins, owns the library) and
`area_admin` (bound to exactly one area). No per-page permission matrix in v1.

### 2.7 Super admin operates every area's panel — and an all-areas view

- Every one of the 23 existing admin pages works for a super admin against **any** area, selected
  from one switcher in the shared layout. No parallel copy of any page.
- In addition, Orders, Reports and Analytics accept `X-Area-Id: all` and return a cross-area
  roll-up with an `areaCode`/`area_code` column added to each row. Pages that make no sense
  aggregated (Settings, Delivery Zones, Store Modes) reject `all` with a clear message telling the
  super admin to pick an area.
- Super admin joins **every** area's admin socket room, so live order feeds work in all-areas mode.

### 2.8 Area boundary = union of its delivery zones

An area has no separate polygon to maintain. Its footprint is the union of its `delivery_zones`.
For fast lookup, each area caches a **bounding box** (`min_lat, max_lat, min_lng, max_lng`)
recomputed on every zone write. See §3.2.

### 2.9 Backward compatibility for existing installs

Existing data becomes area `id = 1`, code `A1`. Every legacy client (old app build with no area
awareness) that hits a public endpoint with no resolvable pin gets the **default area**
(`areas.is_default = 1`). Nothing 404s during rollout. Existing products stay local-only until
someone deliberately promotes them into the library (TASK 18).

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
products             (library_product_id)          -- propagation fan-out (TASK 20)
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

### 3.7 Library propagation is one batched UPDATE, off the request path

A library edit touching 20 areas must not be 20 queries in a request handler. It is:
`UPDATE products SET name=?, image_id=?, unit=?, description=? WHERE library_product_id = ?`
(one statement, covered by the `(library_product_id)` index), then one
`bustAreaCaches(areaId)` per affected area — the affected list comes from a single
`SELECT DISTINCT area_id`. Respond to the admin immediately; do the bust fan-out after the response.

### 3.8 In-process caches pin the API to one container

`docker-compose.prod.yml` runs a single `api` service today, so the in-process `microCache` /
`settingsCache` are consistent. Multi-area is the thing most likely to justify scaling out — and the
moment there are two containers, one container's `bust()` does not reach the other, and admins will
see stale catalogs at random. **Do not add API replicas without first moving these caches behind a
shared store.** The `ttlCache` interface was written to be swappable (see its header comment); keep
it that way. Out of scope for this spec, but do not let it be discovered in production.

### 3.9 No new N+1 anywhere

The area name/code shown in admin lists comes from a single `areas` lookup joined once, or from a
process-level `areas` map cached for 60s (there will be tens of areas, not millions). Never one
`SELECT` per order row. Same for library names in the per-area product list — they are already
denormalized into `products.name` (§2.4), so no join is needed at all.

### 3.10 Public catalog reads become conditional

Each area gets a monotonically increasing `catalog_version`, bumped on any catalog/settings/zone
write. Public GETs return `ETag: "<areaId>-<catalog_version>"` and honour `If-None-Match` with a
304. On a phone on 3G, an unchanged dashboard becomes a ~200-byte 304 instead of a full JSON body.
This also gives the client a cheap way to know it must refetch, without polling payloads.

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
bumpCatalogVersion(areaId)        // §3.10, called from the same place as bustAreaCaches
```

### 4.2 One middleware sets `req.areaId`

- `resolveAdminArea` — runs after `requireAdmin`. `area_admin` → own area. `super_admin` → the
  `X-Area-Id` header, `'all'` where the endpoint allows it, or `null`.
- `resolveCustomerArea` — runs on customer routes that need an area. Order of resolution:
  1. request pin (`latitude`/`longitude` in body or query),
  2. the customer's saved delivery pin,
  3. `users.last_area_id`,
  4. default area.

### 4.3 One cache-bust helper

`bustAreaCaches(areaId)` replaces the scattered pairs of `microCache.bust('dashboard')` +
`microCache.bust('categories')` currently duplicated across `productController` (9 call sites),
`categoryController` (3), `shopAdminController` (2), `shopOwnerController` (3), `settingsController`
(8), `deliveryZonesController` and `shops.js`. Those 25+ sites collapse to one call each, and
`bumpCatalogVersion` rides along inside it so no caller can forget the ETag.

### 4.4 One admin client chokepoint

`apps/admin/src/api/client.js:15` is the only place `X-Area-Id` is attached. No page component ever
passes an area explicitly.

### 4.5 One library→area materializer

`apps/api/src/utils/productLibrary.js` owns the only code that turns a library item into area rows:

```js
materializeToArea(conn, { libraryProductId, areaId, categoryId, price, shopId, ... })
propagateLibraryEdit(conn, libraryProductId)   // §3.7
```

Add-from-library (single), bulk add-to-many-areas, and clone-area all call `materializeToArea`. It
is the only writer of `products.library_product_id`. It reuses the existing `syncProductVariants`
path so the `products.price` ⇄ default-variant mirror can never drift.

### 4.6 One guardrail test, written before the sweep

`apps/api/tests/areaScoping.test.js` statically scans `src/controllers`, `src/services`, `src/utils`
for `FROM|JOIN|UPDATE|DELETE FROM <scoped_table>` and fails on any statement lacking an `area_id`
predicate, minus an explicit allowlist of intentionally-global queries (each allowlist entry needs a
one-line comment justifying it — `product_library`, `library_variants`, `images`, `users`,
`notification_templates` are legitimately global). This is what makes a 500-site sweep reviewable —
build it in TASK 5, before touching controllers.

### 4.7 The admin UI reuses the existing pages

`super_admin` does **not** get a parallel copy of the 24 admin pages. It gets an area switcher in the
existing layout plus 3 new pages (Areas, Admins, Product Library). Picking an area makes the
existing pages operate on that area, unchanged.

---

## 5. TASKS

### Phase A — Foundations (no behaviour change)

- [ ] **TASK 1 — `areas` table + seed Area 1**
  `migrate.js`: create `areas (id, code VARCHAR(16) UNIQUE, name, active TINYINT DEFAULT 1,
  is_default TINYINT DEFAULT 0, timezone VARCHAR(64) DEFAULT 'Asia/Kolkata', min_lat, max_lat,
  min_lng, max_lng DECIMAL(10,7) NULL, catalog_version BIGINT NOT NULL DEFAULT 1,
  brand_color VARCHAR(9) NULL, logo_image_id INT NULL, features JSON NULL, created_at, updated_at)`,
  index `(active, min_lat, max_lat)`. `INSERT IGNORE` one row: `id=1, code='A1', name='Area 1',
  is_default=1`. Nothing reads it yet.
  `features JSON` is deliberate: per-area feature toggles (fast delivery, night charge, rain charge,
  COD) go in there instead of growing `settings` a boolean column at a time forever.

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
  Change `daily_order_counters` PK to `(area_id, counter_date)`.
  Run `npm test` — nothing should change yet.

- [ ] **TASK 4 — Area-aware caches**
  `microCache.js`: enforce `<namespace>:<areaId>:<rest>` keys, add `bust(namespace, areaId)`, raise
  `MAX_ENTRIES` to 600 via an exported constant. `settingsController` settings cache keyed
  `settings:<areaId>`. `storeMode.js` cache keyed `active_slugs:<areaId>`. Update every existing
  caller to pass area 1 for now — behaviour identical, plumbing in place.

- [ ] **TASK 5 — Guardrail test (before the sweep)**
  Write `apps/api/tests/areaScoping.test.js` per §4.6. Seed the allowlist with today's genuinely
  global queries. It will fail loudly for every table you have not yet swept — that is the point.
  Mark it `test.skip` with a TODO **only** if it blocks TASK 6-8; un-skip in TASK 9 and keep it
  green from then on.

- [ ] **TASK 6 — `areaScope.js` + middleware**
  Implement §4.1 and §4.2 in full, with the bbox-first resolver of §3.2. Unit-test
  `resolveAreaForPoint` against: point in one area, point in an overlapping child zone, point
  outside every area, missing/NaN coordinates. No controller uses it yet.

### Phase B — Auth (the gate)

- [ ] **TASK 7 — Admin login against `admins`**
  `adminController.js` login: look up `admins` by username, bcrypt-compare, mint a JWT carrying
  `sub`, `role: 'admin'`, `adminRole: 'super_admin'|'area_admin'`, `areaId`. Keep the env-password
  path as a fallback **only** when the `admins` table is empty (fresh-install bootstrap), and log a
  warning when it fires. Response adds `adminRole` and `areaId` in both casings.

- [ ] **TASK 8 — `requireAdmin` sets area; add `requireSuperAdmin`**
  `authMiddleware.js`: `req.admin` gains `adminRole` and `areaId`. Add `requireSuperAdmin`. Wire
  `resolveAdminArea` after `requireAdmin` on all 130 admin routes via a router-level `use()`, not
  130 individual edits. Per-admin revocation check replaces the singleton where `admin_id` is set.
  **Security note:** an `area_admin` sending `X-Area-Id` for another area must get 403, not a silent
  fallback. `X-Area-Id: all` from an `area_admin` must also 403. Add explicit tests for both.

### Phase C — Backend sweep (one commit per domain)

Each task: add `area_id` to reads and writes, use `req.areaId`, key caches by area, keep response
shapes byte-identical for a single-area install, run `npm test`.

- [ ] **TASK 9 — Settings** (27 sites). `settings` becomes one row per area; auto-create a settings
  row when an area is created. Un-skip the guardrail test for `settings`.
- [ ] **TASK 10 — Delivery zones + exclusion zones + pricing** (18 sites).
  `loadActiveZones(db, areaId)`, `loadActiveExclusionZones(db, areaId)`. Public geometry endpoint
  takes a resolved area and caches per area. Recompute `areas.min_lat/max_lat/min_lng/max_lng` in
  `notifyZonesChanged`. **Biggest perf win in the spec — assert in a test that a cart preview loads
  only its own area's zones.**
- [ ] **TASK 11 — Catalog: categories, products, combos, product_groups, store_modes**
  (79 + 44 + 26 + 13 sites). `store_modes.is_system` rows (`packed`, `fast_food`) must be seeded
  per area, not globally.
- [ ] **TASK 12 — Dashboard sections + offers** (26 + 21 sites). Cache key becomes
  `dashboard:<areaId>:<storeType>:closed=<0|1>`.
- [ ] **TASK 13 — Orders + order items + counters** (123 sites). Order create stamps `area_id` from
  the resolved pin. `order_number` gets the `areas.code` prefix. Per-area daily counter.
  **Do not touch** the idempotency or compare-and-set logic.
- [ ] **TASK 14 — Coupons** (22 sites). The area filter goes into the *inputs* of
  `utils/coupons.js`; the rule engine itself stays untouched. `coupon_zones` inherits the area from
  its zone — assert on write that the coupon and zone share an area.
- [ ] **TASK 15 — Shops + riders + rider assignment** (63 + 33 sites).
  `utils/riders.js` candidate query gains `r.area_id = ?`. `syncGlobalShopOpenState` becomes
  `syncAreaShopOpenState(areaId)` and stops scanning the whole `shops` table.
  **Do not touch** the offer lifecycle.
- [ ] **TASK 16 — Notifications, admin notifications, broadcast push** (14 sites). A broadcast is
  scoped to one area unless a super admin explicitly opts into "all areas".
- [ ] **TASK 17 — Analytics + reports** (MySQL + Mongo). Mongo docs gain `areaId`; indexes become
  `{areaId:1, date:1}` unique for `analytics_daily` and `{areaId:1, createdAt:-1}` compounds for
  sessions/events. Report endpoints group by area; super admin gets the all-areas roll-up of §2.7.

### Phase D — Product library

- [ ] **TASK 18 — Library tables + image dedupe + backfill**
  Create `product_library` and `library_variants` per §2.4. Add `products.library_product_id INT
  NULL` and `product_variants.library_variant_id INT NULL` (both at end of row, both indexed).
  Add `images.sha256 CHAR(64) NULL` + UNIQUE index; compute the hash on upload and return the
  existing row on a duplicate (§2.5). Backfill existing images' hashes in a batched sweep.
  **Do not auto-promote existing products into the library** — they stay local-only until an admin
  promotes them (TASK 19). Auto-promotion would guess at which of 3 near-identical rows is canonical.

- [ ] **TASK 19 — Library CRUD, "Add from Library", and promote**
  `apps/api/src/utils/productLibrary.js` per §4.5. Endpoints (all `requireSuperAdmin` except the
  add-to-my-area one, which any admin may call for their own area):
  - `GET /admin/library` — search/filter/paginate; each row reports which areas already carry it.
  - `POST /admin/library`, `PATCH /admin/library/:id`, `POST /admin/library/:id/archive`.
  - `POST /admin/library/:id/add-to-area` — body: `areaId`, `categoryId`, `storeType`, `price`,
    optional `shopId`, `shopPrice`, per-variant prices. One transaction. Idempotent: adding a
    library item an area already has returns the existing product with a `409`-free "already
    linked" flag rather than creating a duplicate.
  - `POST /admin/library/:id/add-to-areas` — the same, fanned out to many areas in one transaction,
    with a per-area price map. This is the "launch this product in 5 towns" button.
  - `POST /admin/products/:id/promote-to-library` — lifts an existing local product's name/image/
    variants into a new library item and links it. Other areas can then adopt it.

- [ ] **TASK 20 — Library edit propagation**
  `propagateLibraryEdit` per §3.7: one batched `UPDATE products …`, one batched `UPDATE
  product_variants …` for labels, then `bustAreaCaches` per affected area **after** the response is
  sent. Variant *adds* propagate as new per-area variant rows priced at the library's
  `suggested_price` and flagged `available = 0`, so a new size never goes on sale in an area at a
  price nobody chose. Variant *removals* soft-delete per-area rows (`deleted = 1`) so live carts and
  order snapshots keep resolving — never a hard delete.
  Test that the `products.price` ⇄ default-variant mirror survives every propagation path.

### Phase E — Realtime

- [ ] **TASK 21 — Per-area socket rooms**
  `socket.js`: `customers:<areaId>`, `admin:<areaId>`. Customer socket joins on connect using
  `users.last_area_id`, and **rejoins** when the app reports an area change. `emitToAllCustomers`
  and `emitToAdmins` take an `areaId`. Super admin joins every admin room. Event names and payloads
  unchanged.

### Phase F — Super admin API + UI

- [ ] **TASK 22 — Super-admin endpoints + clone-area**
  `POST /admin/areas` (creates the area, its settings row and its system store_modes in one
  transaction), `GET /admin/areas`, `PATCH /admin/areas/:id`, `POST /admin/admins`,
  `GET /admin/admins`, `PATCH /admin/admins/:id`.
  Plus `POST /admin/areas/:id/clone-from/:sourceId` — copies categories, store modes, dashboard
  sections and library-linked products (with a price multiplier or a flat copy) from an existing
  area. **Never** copies orders, customers, riders, shops or coupons. This is what makes launching
  area #3 a ten-minute job instead of a week of data entry.
  Deleting an area is **not** supported in v1 — deactivate only; say so in the response of any
  delete attempt.

- [ ] **TASK 23 — Admin client, area switcher, all-areas mode**
  `apps/admin/src/api/client.js`: attach `X-Area-Id` from a single store, one place (§4.4). Area
  dropdown in the existing layout, visible only to `super_admin`, including an "All areas" option
  that sends `X-Area-Id: all`. Switching areas clears client-side query caches. Pages that reject
  `all` (§2.7) show an inline "pick an area" state instead of an error toast. `area_admin` sees no
  switcher, no Areas page, no Library editing.

- [ ] **TASK 24 — Areas, Admins and Product Library pages**
  Three new pages under `apps/admin/src/pages/`, styled with the existing page CSS conventions.
  The Library page is the "add from library" surface: grid of image + name + variants, a per-row
  "Add to area…" action opening a price form, a multi-select "Add to areas…" bulk action, and a
  visible list of which areas already carry each item. The existing Products page gains a
  "+ Add from Library" button next to "+ New Product", and shows library-managed fields as
  read-only with a link to the library entry (§2.4).

### Phase G — Payload optimization + customer app

- [ ] **TASK 25 — Catalog version, ETags, and a single bootstrap endpoint** (backend)
  Implement `catalog_version` bumping inside `bustAreaCaches` (§4.3). Add `ETag` /
  `If-None-Match` → `304` on the public catalog, categories, settings and zone-geometry endpoints
  (§3.10).
  Add `GET /bootstrap?lat=&lng=` returning `{ area, settings, storeModes, zoneGeometry,
  catalogVersion }` in one response. Today the app cold-starts with `settingsApi.getSettings()` and
  `dashboardApi.getDashboard()` as separate round trips (`HomeScreen.js:355,359`) plus store modes
  and zones elsewhere — on a rural 3G connection that is four sequential handshakes before the first
  pixel. Keep every existing endpoint working unchanged; `bootstrap` is additive.

- [ ] **TASK 26 — Area resolution in the app**
  On pin change / cold start, the app calls `/bootstrap` and stores `areaId`, `areaName`,
  `brandColor`, `catalogVersion`. Persist alongside the delivery pin in `useDeliveryLocationStore`.
  Respect the existing cold-start rule: a cold start defaults to live GPS over a saved manual pin —
  the area follows the pin that actually wins, not the stored one. Send `If-None-Match` from the
  stored `catalogVersion` on subsequent catalog fetches.

- [ ] **TASK 27 — Area-change invalidation**
  Extend the existing cart zone revalidation so an **area** change (not just a zone change) clears
  the cart, refetches settings/dashboard/catalog, and rejoins the socket room. An
  out-of-every-area pin shows a "we don't deliver here yet" state instead of an empty catalog.
  Update `apps/customer-app/__tests__/cartZoneRevalidation.test.js` to cover the area-change case.

### Phase H — Verification

- [ ] **TASK 28 — Cross-area isolation E2E**
  Create Area 2 with its own admin, shop, rider, zone and catalog. Assert, with tests:
  Area 2's admin cannot read or write any Area 1 row (403/empty, never partial); an Area 1 customer
  pin gets Area 1 catalog and pricing; an Area 2 order never offers to an Area 1 rider; a zone edit
  in Area 2 does not bust Area 1's caches or reach Area 1's socket room; coupon code `SAVE10` can
  exist independently in both areas; order numbers do not collide; one library product added to both
  areas shows the same name/image/variant labels and **different prices**; a library rename updates
  both areas and changes neither price; a super admin can load all 23 pages against either area and
  the all-areas roll-up. Guardrail test green with no new allowlist entries.

---

## 6. ROLLOUT

Phases A–B are additive: old code ignores `area_id`, old clients keep working. Phase C is the risky
stretch — ship it domain by domain, each with `npm test` green. Phase D is additive again (nothing
is forced into the library). Phase G requires an app release, so keep the API tolerant of
area-unaware clients (§2.9) until adoption is high.

**Before the TASK 3 migration runs against production: take a DB snapshot.** The column adds are
INSTANT, but the UNIQUE-key rewrites in §1.3 rebuild indexes and are not free to reverse.

---

## 7. CUSTOMIZATION ROADMAP — what else is worth doing

Included in this spec because they are cheap once the area plumbing exists:

- **Per-area branding** — `areas.brand_color` + `logo_image_id`, served by `/bootstrap`. Each town
  can look like its own service without a separate app build. (TASK 1 + 25 + 26.)
- **Per-area feature flags** — `areas.features JSON` instead of another boolean column on `settings`
  every time a feature lands. (TASK 1.)
- **Clone an area** — stand up area #3 from area #1's catalog in minutes. (TASK 22.)
- **Bulk add-to-many-areas with a per-area price map** — launch a product across towns in one
  action. (TASK 19.)
- **Promote an existing product into the library** — no big-bang data migration needed. (TASK 19.)
- **Image dedupe by content hash** — one stored JPEG instead of N. (TASK 18.)
- **ETag/304 + single bootstrap call** — the biggest felt speed win on a slow connection. (TASK 25.)

Deliberately **v2, not now** — each is a real feature, and bundling them into a tenancy migration is
how tenancy migrations fail:

- Per-area price *rules* (e.g. "Area 3 = Area 1 + 8%") as a live formula rather than a copied number.
  The bulk price map in TASK 19 covers the practical need; a live formula needs its own audit trail.
- Scheduled price changes / time-boxed price lists.
- Moving a shop, rider or order between areas.
- Per-page or per-capability admin permissions beyond the two roles.
- Customer-visible area switching in the app (today the area always follows the delivery pin).
- A separate database per area — revisit only if one area's write volume starves the others.
- Shared caches in Redis — required *before* running more than one API container (§3.8).

## 8. OUT OF SCOPE (v1)

- Deleting an area (deactivate only).
- Hard-deleting a library item (archive only — §2.4).
- Cross-area customer accounts merging or splitting.
