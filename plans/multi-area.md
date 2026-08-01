# ProjectServeLoco — Multi-Area (Super Admin) Expansion

Spec date: 2026-08-01 · Branch: `feat/multi-area-super-admin` · Status: **NOT STARTED**
Instruction spec for an implementing AI. Follow it literally.

Today the whole platform is one area ("Area 1"): one settings row, one set of zones, one admin
password, one flat catalog. This spec turns it into **N independent areas** under a **super admin**,
plus **shared libraries** so a thing is authored once and priced/enabled per area — without forking
the codebase, without slowing anything down, and without duplicating logic.

**Core rule of this spec: adding an area must not add a query, a round trip, or a cache miss to any
existing request path.** Every task below is written to keep per-request cost flat as areas grow.

---

## 0. How to read this file

1. Read **BACKGROUND** (§1), **LOCKED DECISIONS** (§2), **PERFORMANCE CONTRACT** (§3) and
   **DRY CONTRACT** (§4) before writing any code. §1 was verified in code on 2026-08-01 — do not
   re-derive unless a path has moved.
2. Execute tasks **in order** (TASK 0 → TASK 30). Later tasks assume earlier ones are done.
   **Area 1 is live in production. Read §6 (DATA SAFETY) before TASK 0 and obey its ordering rules
   literally — several of them are the difference between a clean migration and losing data.**
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
  reference.** The libraries sit *above* them; they never replace them.
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
| Zone matcher | `deliveryPricing.js` `matchZone` | Nested zones supported: deepest child wins, then smallest area. This is already the right resolution unit — see §2.10. |
| Public zone geometry | `deliveryZonesController.js:164` | Returns all polygons to every app that opens the map. |
| Dashboard | `dashboardController.js:419` | Cache key `dashboard:${storeType}:closed=${0|1}`. 50 query sites in the file. |
| **Product search** | `productController.js:377` and `:635` | **`AND p.name LIKE '%term%'`** — leading wildcard, so no index can ever be used. Full table scan of `products`, per keystroke-ish request. See §3.11. |
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
| `products` | `migrate.js:326` | Owns `name, price, shop_price, image_id, unit, description, category_id, shop_id, group_id, variant_prompt, available_*_time`. `unit` is free-text `VARCHAR(50)`. |
| `product_variants` | `migrate.js:377` | `label, price, shop_price, original_price, is_default`. Soft-deleted so live carts keep resolving. `products.price` **always mirrors the default variant**. |
| `categories` | `migrate.js:268` | `name, slug, type, image_id, active, display_order`. Identity (name + icon) and placement (active + order) are in one row. |
| `store_modes` | `migrate.js:299` | `slug, label, icon_image_id, display_order, active, is_default, is_system`. Same identity/placement mixing. |
| `dashboard_sections` | `migrate.js:948` | Layout definition + content links. A new area starts with an empty home screen. |
| `offers` | `migrate.js:904` | `title, description, image_id, active, store_type` + `offer_products`. Creative and scheduling in one row. |
| `coupons` | `migrate.js:1317` | 30+ columns of rule definition; `coupon_zones` scopes them to zones already. |
| `images` | `migrate.js:1563` | Global already. Has `thumb_url` (320px WebP). **No content hash → the same JPEG re-uploads as a new row every time.** |
| `notification_templates` | `migrate.js:1268` | `event_key` UNIQUE — **already global and already correct.** Leave it alone. |
| `cancelReasons` | `apps/api/src/utils/cancelReasons.js` | Canonical strings in code, no table. **Already centralized.** Leave it alone. |

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

### 2.10 The pin decides everything — and the zone is the unit

**The customer's live pin, resolved to a delivery zone drawn in the admin panel, decides the entire
customer-facing surface:** which catalog loads, which dashboard renders, which store modes exist,
what the search bar can find, which coupons apply, what delivery costs, and whether delivery is
possible at all.

Resolution is always the same chain, computed once per request (§3.1):

```
pin (lat,lng)  →  delivery zone (admin-drawn polygon, nested child wins)  →  area  →  catalog
```

- The **zone** is the atomic unit because it is what the admin actually draws and prices, and
  `matchZone` already implements deepest-child-wins over nested polygons. The area is *derived* from
  the matched zone (`delivery_zones.area_id`), never guessed from a bounding box alone — the bbox is
  only a prefilter (§3.2).
- **Search is scoped exactly like the catalog.** A pin in Area 2 must never surface an Area 1
  product, even by name, even with an exact match. Search that leaks across areas is the most
  likely way a customer ends up looking at a price they cannot buy at. See §3.11 and TASK 22.
- **Pin outside every zone** = no area = a "we don't deliver here yet" state. Not an empty catalog,
  not the default area's catalog. The default area (§2.9) is a fallback for *old clients that send
  no pin at all*, never for a pin that resolved to nothing.
- **Pin moves across an area boundary mid-session** = the cart clears, catalog/dashboard/settings
  refetch, and the socket room is rejoined (TASK 29). A cart assembled at Area 1 prices must never
  be checked out against Area 2 zones.
- Cold start keeps the existing rule already shipped on `main`: live GPS wins over a saved manual
  pin. The area follows the pin that actually wins, not the stored one.

### 2.4 Product library: identity is shared, commerce is per-area

**One product is authored once.** Its name, image, description, unit and variant *labels* live in a
global library. Its **price, availability, category placement, shop linkage and display order are
per-area.**

```
product_library          (global)   id, name, description, image_id, unit_id,
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

### 2.5 Images are global, deduplicated on *new* uploads only

`images` is already global. Add `sha256 CHAR(64)` with a **non-unique** index. On upload, hash the
bytes, look for an existing row, and return it instead of inserting. With N areas reusing one
library, this is the difference between one stored JPEG and N copies.

**The index is non-unique on purpose, and historical duplicates are never merged.** Production
already contains duplicate uploads; a UNIQUE index would make the migration fail outright, and
"resolving" the duplicates means repointing `image_id` across six tables that have **no foreign key**
to `images` (`products.image_id` is a bare `VARCHAR(255)`, `migrate.js:333`). One missed reference is
a permanently broken image with nothing to detect it. Report duplicates in the admin Images page;
never auto-merge. See §6.5.

### 2.11 What else gets the library treatment — and what does not

The library pattern is **identity (global, synced) vs placement/commerce (per-area, independent)**.
Applying it everywhere is not free: every synced entity is one more propagation path to test. The
test is: *would an admin want a rename in one place to reach every town?* If yes, library it. If the
towns should diverge, a one-time clone (TASK 24) is enough and cheaper.

**Library it (in this spec):**

| Entity | Global identity | Per-area | Why |
|---|---|---|---|
| Products | name, image, description, unit, variant labels | price, availability, category, shop, order | §2.4 — the whole point |
| **Categories** | name, icon image, `type` | `active`, `display_order`, which products land in it | "Dairy", "Snacks" are the same everywhere. A rename should reach every town. High reuse, trivial propagation. |
| **Store modes** | `slug`, `label`, icon image | `active`, `display_order`, `is_default` | `packed`/`fast_food` are already `is_system` rows. Area 3 may not run fast food at all — that is a per-area toggle, not a different mode. |
| **Units** | the `unit` string itself | — | `products.unit` is free-text `VARCHAR(50)` today. Across N areas that becomes `kg`, `Kg`, `KG`, `kilogram` and the app renders all four. A tiny `units` lookup ends it. Folded into TASK 23. |

**Clone once, then diverge (TASK 24, no ongoing sync):**

| Entity | Why not a library |
|---|---|
| Dashboard sections | Layout is the thing towns *should* differ on — a fast-food-heavy town wants a different home screen. Clone gives a new area a working home screen on day one; after that it is theirs. |
| Offers / banners | Creative is seasonal and local. The *image* is already shared via the global `images` table, which is the part actually worth reusing. |
| Combos | A combo's member products are per-area rows with per-area prices; a shared combo definition would need a per-area price anyway, and combos are far rarer than products. Clone covers it. |

**Already global — leave alone:** `images` (§2.5), `notification_templates` (`event_key` UNIQUE),
`cancelReasons` (constants in code). Do not "improve" these.

**Explicitly not now:** coupon templates. A coupon carries 30+ rule columns plus redemption
accounting, usage limits and `FOR UPDATE` locking. A shared template with per-area budgets is a
real feature with its own audit requirements, not a column on an existing table. v2 — see §7.

### 2.6 Two admin roles only

`super_admin` (area_id NULL, sees everything, creates areas and admins, owns the libraries) and
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

Existing data becomes area `id = 1`, code `A1`. A legacy client (old app build) that hits a public
endpoint **with no pin at all** gets the default area (`areas.is_default = 1`). Nothing 404s during
rollout. A pin that resolves to nothing is *not* covered by this fallback (§2.10). Existing products
stay local-only until someone deliberately promotes them into the library (TASK 18).

---

## 3. PERFORMANCE CONTRACT

Violating any of these fails review, even if tests pass.

### 3.1 Area is resolved once per request, never per row

`req.areaId` and `req.zoneId` are set exactly once, by middleware, and read everywhere downstream.
No controller may issue its own "which area is this?" query. No loop may resolve an area per
iteration. Any `SELECT ... FROM areas` inside a per-row map/loop is a defect.

### 3.2 Point-to-zone lookup is bbox-first, and cached

Today `loadActiveZones` pulls **every** active zone and runs JS point-in-polygon. That is O(all
zones nationwide) on every cart preview. After this spec:

1. `areas` carries `min_lat/max_lat/min_lng/max_lng` (recomputed on zone write, never per read),
   indexed `(active, min_lat, max_lat)`.
2. Resolve pin → candidate areas with an SQL bbox filter (typically 1 row).
3. Load **only that area's** zones, from a per-area TTL cache.
4. Run the existing `matchZone` polygon matcher unchanged on that small set — nested-child-wins
   semantics preserved exactly.

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

### 3.11 Search must stop being a full table scan

`productController.js:377` does `AND p.name LIKE '%term%'` (and `:635` the same for admin). A leading
wildcard **cannot use any index** — it is a full scan of `products` on every search request. That is
survivable with one area's catalog. With N areas it scans N× the rows to return one area's worth of
results, and search is the most latency-sensitive screen in the app.

Required (TASK 22):
- Add `FULLTEXT KEY ft_products_name (name)` on `products` and use
  `WHERE p.area_id = ? AND MATCH(p.name) AGAINST (? IN BOOLEAN MODE)` with a `term*` prefix, keeping
  the `LIKE` path only as a fallback for terms shorter than `innodb_ft_min_token_size`.
- **Search the library, not N copies, for admin-side lookup.** The super admin's "find a product to
  add" search hits `product_library` — one global row per product, one index, no duplication across
  areas — then maps to per-area rows via `library_product_id`. This is the reuse payoff: the search
  index is maintained once instead of N times.
- Customer-side search stays area-scoped and hits `products` (it must reflect that area's
  availability and price), but now via `MATCH` behind the `area_id` predicate.
- Assert in a test that a customer search in Area 2 returns zero Area 1 products (§2.10).

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
Same shape for category and store-mode propagation (TASK 21).

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
resolveAreaForPoint(lat, lng)     // bbox + matchZone, cached. -> { areaId, zoneId, zone } | null
getAreaById(areaId)               // 60s cached row
listAreas({ activeOnly })         // 60s cached
requestAreaId(req)                // the single source of truth for req.areaId
assertAreaAccess(req, areaId)     // throws 403 unless super_admin or matching area_admin
bustAreaCaches(areaId)            // one call fans out to microCache/settings/storeMode
bumpCatalogVersion(areaId)        // §3.10, called from inside bustAreaCaches
```

### 4.2 One middleware sets `req.areaId`

- `resolveAdminArea` — runs after `requireAdmin`. `area_admin` → own area. `super_admin` → the
  `X-Area-Id` header, `'all'` where the endpoint allows it, or `null`.
- `resolveCustomerArea` — runs on customer routes that need an area. Order of resolution, per §2.10:
  1. request pin (`latitude`/`longitude` in body or query) → zone → area,
  2. `users.last_area_id` — backfilled from the user's most recent order, because the server stores
     no saved customer pin of its own (H1),
  3. default area **only when no pin was supplied at all**.
  A pin that resolves to no zone yields `null`, and the route returns the
  "we don't deliver here yet" shape — never the default area.

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
path so the `products.price` ⇄ default-variant mirror can never drift. Category and store-mode
libraries (TASK 21) follow the identical shape in the same module family — do not invent a second
propagation mechanism.

### 4.6 One guardrail test, written before the sweep

`apps/api/tests/areaScoping.test.js` statically scans `src/controllers`, `src/services`, `src/utils`
for `FROM|JOIN|UPDATE|DELETE FROM <scoped_table>` and fails on any statement lacking an `area_id`
predicate, minus an explicit allowlist of intentionally-global queries (each allowlist entry needs a
one-line comment justifying it — `product_library`, `library_variants`, `category_library`, `images`,
`users`, `notification_templates`, `units` are legitimately global). This is what makes a 500-site
sweep reviewable — build it in TASK 5, before touching controllers.

### 4.7 The admin UI reuses the existing pages

`super_admin` does **not** get a parallel copy of the 24 admin pages. It gets an area switcher in the
existing layout plus 3 new pages (Areas, Admins, Library). Picking an area makes the existing pages
operate on that area, unchanged.

---

## 5. TASKS

### Phase 0 — Safety gate (do this before any schema change)

- [ ] **TASK 0 — Production snapshot + migration rehearsal**
  Read §6 in full. Take a full DB snapshot (MySQL dump + Mongo dump) and confirm it restores on a
  scratch instance. Restore that snapshot to a staging DB and run the **entire** TASK 1–3 migration
  against it (not a synthetic empty database — production's actual row counts and edge cases:
  NULL `shop_latitude`, legacy `products.image_id` values, existing duplicate images, whatever else
  is really in there). Record row counts for every table in §1.1 before and after; they must match
  exactly except for the new columns. Confirm `npm start`'s two-step boot (§6.1) completes clean on
  a **second run against the same already-migrated staging DB** — the whole point of `IF NOT EXISTS`
  / `ensureColumn` is idempotence, and this is the test that proves it before it's proving it in
  production.
  Also in this task: measure `orders` (row count + `information_schema` data length) to size the
  migration window (H12), and add a `npm run db:migrate` step to `.github/workflows/ci.yml` run
  **twice** against the MySQL service container CI already provisions and never uses (H9) — close to
  free, and the only automated protection this repo will have against a migration that fails on boot.
  Read §9 and resolve the §9.4 open product decisions before Phase C begins.
  Do not proceed to TASK 1 against production until this rehearsal is clean.

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
  Backfill `= 1` in 5,000-row batches (§6.2 rule 6, resumable via `WHERE area_id IS NULL`). Verify
  zero orphans (§6.2 rule 3) before each step below.
  Then `MODIFY ... NOT NULL`, add FKs, add the composite indexes from §3.3. **Do not drop the
  superseded single-column `orders` indexes in this task** — that is a separate, later deploy
  per §6.2 rule 5.
  Rewrite the UNIQUE keys listed in §1.3, **dropping each old global UNIQUE before the new
  composite is added** (§6.2 rule 2 and rule 4 — this ordering is what makes TASK 11's per-area
  `packed`/`fast_food` seeding actually insert rows instead of silently no-op'ing).
  Add `users.last_area_id INT NULL` (no FK cascade, cache only), and **backfill it from each user's
  most recent order's `latitude`/`longitude`** run through the zone matcher — the server has no saved
  customer pin of its own (H1). Users with no orders stay NULL.
  Update `src/db/seed_demo.js` in this task so dev machines stop producing area-less rows (H11).
  **`daily_order_counters` PK change to `(area_id, counter_date)` moves to TASK 13**, landing in the
  same commit as the order-number query change — see §6.3. Do not change this PK here.
  Run `npm test` — nothing should change yet. Re-run the row-count check from TASK 0 against this
  real migration before calling the task done.

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
  Implement §4.1 and §4.2 in full, with the bbox-first zone resolver of §3.2. Unit-test
  `resolveAreaForPoint` against: point in one zone, point in a nested child zone (child must win),
  point in an exclusion square, point outside every zone (must return `null`, **not** the default
  area), missing/NaN coordinates. No controller uses it yet.

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
  row when an area is created. **Find all 27 sites by `grep -rn "FROM settings" src/`, not by
  reading `settingsController.js` alone** — `imageController.js:20`'s `getUsedImageIds` reads
  `settings.upi_qr_image_id` and is the concrete example in §6.4 of what breaks (an area's payment
  QR code gets reported as orphaned and deleted) if a stray `LIMIT 1` survives the sweep. Un-skip
  the guardrail test for `settings`.
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
  the resolved zone's area. **In the same commit** (§6.3, non-negotiable — splitting this across two
  deploys breaks checkout): backfill `daily_order_counters.area_id = 1`, change its PK to
  `(area_id, counter_date)`, and update `generateOrderNumber` to
  `INSERT INTO daily_order_counters (area_id, counter_date, seq) VALUES (?, ?, LAST_INSERT_ID(1)) ON
  DUPLICATE KEY UPDATE seq = LAST_INSERT_ID(seq + 1)` with format `OD-<date>-<AREACODE>-<seq>`.
  Historical `order_number` values are never rewritten (§6.3). **Do not touch** the idempotency or
  compare-and-set logic. Test: two areas placing an order on the same date get independent,
  non-colliding sequences starting at 1 each.
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

### Phase D — Shared libraries

- [ ] **TASK 18 — Library tables + image dedupe + backfill**
  Create `product_library` and `library_variants` per §2.4. Add `products.library_product_id INT
  NULL` and `product_variants.library_variant_id INT NULL` (both at end of row, both indexed).
  Add `images.sha256 CHAR(64) NULL` + **non-unique** index (§2.5); compute the hash on upload and
  return the existing row on a duplicate. Backfill existing images' hashes in a batched sweep —
  this only populates the column, it never deletes or merges anything. Add the same "in this
  release, not later" rule as `getUsedImageIds` below: this task and TASK 21 must each extend
  `imageController.js`'s `getUsedImageIds` (`:15-43`) with their new table in the **same commit**
  that creates it (`product_library.image_id` here; `category_library.image_id` and
  `store_mode_library.icon_image_id` in TASK 21) — see §6.5.
  **Do not auto-promote existing products into the library** — they stay local-only until an admin
  promotes them (TASK 19). Auto-promotion would guess at which of 3 near-identical rows is canonical.

- [ ] **TASK 19 — Library CRUD, "Add from Library", and promote**
  `apps/api/src/utils/productLibrary.js` per §4.5. Endpoints (all `requireSuperAdmin` except the
  add-to-my-area one, which any admin may call for their own area):
  - `GET /admin/library` — search/filter/paginate; each row reports which areas already carry it.
  - `POST /admin/library`, `PATCH /admin/library/:id`, `POST /admin/library/:id/archive`.
  - `POST /admin/library/:id/add-to-area` — body: `areaId`, `categoryId`, `storeType`, `price`,
    optional `shopId`, `shopPrice`, per-variant prices. One transaction. Idempotent: adding a
    library item an area already has returns the existing product with an "already linked" flag
    rather than creating a duplicate.
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
  Propagation writes an **explicit column list** and never touches commerce columns (§6.7).
  Test that the `products.price` ⇄ default-variant mirror survives every propagation path, and that
  editing a library item leaves every per-area price, `available` flag and `display_order`
  byte-identical.

- [ ] **TASK 21 — Category + store-mode libraries**
  Per §2.11. `category_library (id, name, slug, type, image_id, archived)` and
  `store_mode_library (id, slug, label, icon_image_id, is_system, archived)`; `categories` and
  `store_modes` gain a nullable `library_*_id`. Identity (name/slug/icon) propagates via the same
  batched-UPDATE mechanism as TASK 20 — **reuse it, do not write a second one** (§4.5). `active`,
  `display_order` and `is_default` stay strictly per-area and are never propagated. A category with
  a NULL library link is a local-only category and stays fully editable.

- [ ] **TASK 22 — Search: fulltext + area scoping + units lookup**
  Per §3.11. Replace the `LIKE '%term%'` scans at `productController.js:377` and `:635` with
  `MATCH … AGAINST` behind an `area_id` predicate, keeping `LIKE` only for sub-minimum-token terms.
  Add `FULLTEXT` to `products.name` and `product_library.name`. Admin "find a product to add"
  searches the **library** (one global index) and maps to area rows via `library_product_id`.
  Add the `units` lookup table (§2.11) and point `product_library.unit_id` at it, backfilling
  distinct existing `products.unit` strings; `products.unit` keeps its current free-text column and
  value so no response shape changes.
  **Test: a customer search in Area 2 returns zero Area 1 products.**

### Phase E — Realtime

- [ ] **TASK 23 — Per-area socket rooms**
  `socket.js`: `customers:<areaId>`, `admin:<areaId>`. Customer socket joins on connect using
  `users.last_area_id`, and **rejoins** when the app reports an area change. `emitToAllCustomers`
  and `emitToAdmins` take an `areaId`. Super admin joins every admin room. Event names and payloads
  unchanged.

### Phase F — Super admin API + UI

- [ ] **TASK 24 — Super-admin endpoints + clone-area**
  `POST /admin/areas` (creates the area, its settings row and its system store_modes in one
  transaction), `GET /admin/areas`, `PATCH /admin/areas/:id`, `POST /admin/admins`,
  `GET /admin/admins`, `PATCH /admin/admins/:id`.
  Plus `POST /admin/areas/:id/clone-from/:sourceId` — copies categories, store modes, dashboard
  sections, offers and library-linked products (with a price multiplier or a flat copy) from an
  existing area. **Never** copies orders, customers, riders, shops or coupons. This is what makes
  launching area #3 a ten-minute job instead of a week of data entry, and it is the mechanism for
  everything in the "clone once, then diverge" column of §2.11.
  Clone **refuses with 409** against a target area that already has categories or products, so a
  double click cannot duplicate a catalog (§6.8).
  **Ship the §6.6 gate in this task, not as a follow-up:** `POST /admin/areas` returns 409 unless
  an `areas_sweep_complete` flag is set; only TASK 30 sets it. Until then the platform stays
  single-area and every deploy is verifiable against unchanged production behaviour.
  Deleting an area is **not** supported in v1 — deactivate only; say so in the response of any
  delete attempt.

- [ ] **TASK 25 — Admin client, area switcher, all-areas mode**
  `apps/admin/src/api/client.js`: attach `X-Area-Id` from a single store, one place (§4.4). Area
  dropdown in the existing layout, visible only to `super_admin`, including an "All areas" option
  that sends `X-Area-Id: all`. Switching areas clears client-side query caches. Pages that reject
  `all` (§2.7) show an inline "pick an area" state instead of an error toast. `area_admin` sees no
  switcher, no Areas page, no Library editing.

- [ ] **TASK 26 — Areas, Admins and Library pages**
  Three new pages under `apps/admin/src/pages/`, styled with the existing page CSS conventions.
  The Library page is the "add from library" surface: grid of image + name + variants, a per-row
  "Add to area…" action opening a price form, a multi-select "Add to areas…" bulk action, and a
  visible list of which areas already carry each item. Tabs for Products / Categories / Store Modes
  libraries — one page, three tabs, not three pages. The existing Products page gains a
  "+ Add from Library" button next to "+ New Product", and shows library-managed fields as
  read-only with a link to the library entry (§2.4).

### Phase G — Payload optimization + customer app

- [ ] **TASK 27 — Catalog version, ETags, and a single bootstrap endpoint** (backend)
  Implement `catalog_version` bumping inside `bustAreaCaches` (§4.3). Add `ETag` /
  `If-None-Match` → `304` on the public catalog, categories, settings and zone-geometry endpoints
  (§3.10).
  Add `GET /bootstrap?lat=&lng=` returning `{ area, zone, settings, storeModes, zoneGeometry,
  catalogVersion }` in one response, or the "we don't deliver here yet" shape when the pin resolves
  to no zone (§2.10). Today the app cold-starts with `settingsApi.getSettings()` and
  `dashboardApi.getDashboard()` as separate round trips (`HomeScreen.js:355,359`) plus store modes
  and zones elsewhere — on a rural 3G connection that is four sequential handshakes before the first
  pixel. Keep every existing endpoint working unchanged; `bootstrap` is additive.

- [ ] **TASK 28 — Pin-driven area resolution in the app**
  On cold start and on every pin change, the app calls `/bootstrap` with the live pin and stores
  `areaId`, `zoneId`, `areaName`, `brandColor`, `catalogVersion` alongside the pin in
  `useDeliveryLocationStore`. Catalog, dashboard, store modes and search all key off the stored
  `areaId` (§2.10). Respect the existing cold-start rule already on `main`: live GPS wins over a
  saved manual pin — the area follows the pin that actually wins. Send `If-None-Match` from the
  stored `catalogVersion` on subsequent catalog fetches.

- [ ] **TASK 29 — Area-change invalidation**
  Extend the existing cart zone revalidation so an **area** change (not just a zone change) clears
  the cart, refetches settings/dashboard/catalog, clears any cached search results, and rejoins the
  socket room. An out-of-every-zone pin shows the "we don't deliver here yet" state instead of an
  empty catalog or the default area's catalog. Update
  `apps/customer-app/__tests__/cartZoneRevalidation.test.js` to cover the area-change case.

### Phase H — Verification

- [ ] **TASK 30 — Cross-area isolation E2E**
  Create Area 2 with its own admin, shop, rider, zone and catalog. Assert, with tests:
  Area 2's admin cannot read or write any Area 1 row (403/empty, never partial); an Area 1 customer
  pin gets Area 1 catalog, dashboard, search results and pricing; **a search in Area 2 for an
  Area-1-only product name returns nothing**; moving the pin from Area 1 to Area 2 clears the cart
  and swaps the catalog; a pin outside every zone shows the no-delivery state rather than any
  catalog; an Area 2 order never offers to an Area 1 rider; a zone edit in Area 2 does not bust
  Area 1's caches or reach Area 1's socket room; coupon code `SAVE10` can exist independently in
  both areas; order numbers do not collide; one library product added to both areas shows the same
  name/image/variant labels and **different prices**; a library rename updates both areas and
  changes neither price; a category rename in the library reaches both areas but does not change
  either area's `display_order`; a super admin can load all 23 pages against either area and the
  all-areas roll-up. Guardrail test green with no new allowlist entries.
  **Area 1's production data is unchanged throughout:** re-run the TASK 0 row-count comparison and
  spot-check that Area 1's prices, order history and order-number formats are exactly what they were
  before TASK 1. Only once every assertion above passes may you set the `areas_sweep_complete` flag
  from TASK 24 (§6.6) — that flag is what unlocks creating a real second area.

---

## 6. DATA SAFETY & ROLLOUT — **Area 1 is live in production**

Everything in this section is a hard requirement, not advice. Each rule below exists because
violating it loses or corrupts production data.

### 6.1 The migration runs itself on deploy — there is no manual gate

`apps/api/package.json:7`:

```
"start": "node src/db/migrate.js && node src/server.js"
```

**Deploying this branch runs the migration unattended, on boot, against production.** There is no
review step between merge and schema change.

- **CI does not cover this.** `.github/workflows/ci.yml` provisions MySQL 8 and Mongo 7 service
  containers, but every test mocks `src/db/mysql` and `db:migrate` is never invoked — the databases
  are provisioned and unused. See H9 for the one-line fix that turns every PR into a migration smoke
  test.
- `migrate.js` has **no transaction wrapper**, and MySQL DDL is non-transactional anyway — a failure
  halfway through leaves the schema partly changed with no rollback. The file survives this today by
  being **re-runnable**: `CREATE TABLE IF NOT EXISTS`, `ensureColumn` existence checks, and
  try/catch blocks that swallow only "already exists". Every statement you add must keep that
  property. Copy the pattern at `migrate.js:810-822`, which explicitly **rethrows** anything that is
  not `ER_DUP_KEYNAME`/`ER_FK_DUP_NAME` instead of swallowing all errors.
- **`npm test` cannot catch a migration bug.** The suite runs against `tests/__mocks__` and never
  touches a real database. Migration correctness is proven only by TASK 0's snapshot rehearsal.

### 6.2 Column and index ordering — each rule prevents a specific loss

1. **Nullable → backfill → NOT NULL.** Never `ADD COLUMN area_id INT NOT NULL` directly: MySQL fills
   existing rows with **`0`**, not `1`. `0` has no `areas` row, so the FK add then fails, or worse
   succeeds against a table where every historical row points at a non-existent area.
2. **Backfill before the composite UNIQUE.** `UNIQUE (area_id, slug)` while `area_id` is still NULL
   enforces nothing — MySQL treats NULLs as distinct, so duplicate slugs slip straight through and
   surface later as two "Dairy" categories in one area.
3. **Verify zero orphans before each FK.**
   `SELECT COUNT(*) FROM <t> WHERE area_id IS NULL OR area_id NOT IN (SELECT id FROM areas)` must
   return 0. Abort the migration if not.
4. **Drop the old global UNIQUE on `categories.slug` and `store_modes.slug` before seeding per-area
   rows.** If the old key is still in place, TASK 11's `INSERT IGNORE` of Area 2's `packed` /
   `fast_food` rows **silently does nothing** — no error, no log — and Area 2 launches with no store
   modes and a blank app.
5. **Add the new composite indexes before dropping the old single-column `orders` indexes, and drop
   them in a separate, later deploy.** Dropping first leaves production running unindexed under
   live load.
6. **Backfills are batched (5,000 rows), outside any long transaction, and resumable** —
   `WHERE area_id IS NULL` so a re-run skips what is already set.

### 6.3 Order numbers — the failure that stops checkout

`orderController.js:38` reserves sequences like this:

```sql
INSERT INTO daily_order_counters (counter_date, seq) VALUES (?, LAST_INSERT_ID(1))
  ON DUPLICATE KEY UPDATE seq = LAST_INSERT_ID(seq + 1)
```

Its correctness depends **entirely** on colliding with today's row via the PRIMARY KEY.

Change the PK to `(area_id, counter_date)` without changing this statement in the **same commit**,
and the insert stops colliding with today's existing row. `seq` restarts at 1, the generated number
duplicates one already issued today, `orders.order_number` UNIQUE fires, and **order creation fails
in production**.

Required:
- Backfill `daily_order_counters SET area_id = 1` **before** the PK change.
- PK change and the query change land in the same commit (TASK 13).
- New format is `OD-<date>-<AREACODE>-<seq>` (e.g. `OD-20260801-A1-0042`). The extra segment makes
  collision with a legacy `OD-20260801-0042` structurally impossible.
- **No row in `orders` is ever rewritten.** Historical order numbers keep their existing format
  forever. Nothing in this spec issues an `UPDATE orders SET order_number = …`.
- Grep confirmed no client parses `order_number` — it is display-only — so the format change is
  safe. Re-confirm before shipping if the apps have changed.

### 6.4 `settings` is a singleton today, and `LIMIT 1` hides in other domains

Making `settings` per-area (TASK 9) is not confined to `settingsController`. Concrete example already
in the code — `imageController.js:20`, inside `getUsedImageIds`:

```sql
SELECT upi_qr_image_id FROM settings WHERE upi_qr_image_id IS NOT NULL LIMIT 1
```

Once there are N settings rows, only the **first** area's UPI QR image counts as "in use". Every
other area's QR image is then reported as orphaned, and both `cleanupOrphanedImage` and the admin
Images delete button will remove it — **N-1 areas silently lose their payment QR code.**

TASK 9 must sweep **all 27 `FROM settings` sites by grep**, not by domain. Do not assume a settings
query lives in the settings controller.

### 6.5 Image deletion must know about the libraries

- `products.image_id` is `VARCHAR(255)` with **no foreign key** to `images.id` (`migrate.js:333`).
  Nothing at the database level prevents deleting an image row that live products still reference.
- `getUsedImageIds` (`imageController.js:15-43`) protects against that by scanning a **hard-coded
  list of six tables**: `products`, `categories`, `combos`, `offers`, `settings`, `store_modes`.
- TASK 18 and TASK 21 introduce `product_library.image_id`, `category_library.image_id` and
  `store_mode_library.icon_image_id`. **If those are not added to `getUsedImageIds` in the same
  commit that creates each table**, deleting the last per-area product using an image deletes an
  image the library still needs — and every area that later adopts that library item gets a broken
  image, with no error anywhere.
- Historical duplicate images are reported, never merged (§2.5).

### 6.6 Exactly one area exists until the sweep is finished

This is the single most important rule in the spec.

Creating Area 2 while **any** controller still runs an unscoped query or a `LIMIT 1` means Area 2's
rows can be served to Area 1 customers, and Area 1's admin can overwrite Area 2's data. The window
between TASK 1 (the `areas` table exists) and TASK 30 (isolation proven) is exactly when that
mistake is easiest to make.

Hard gate: `POST /admin/areas` returns **409** with a clear message unless an
`areas_sweep_complete` flag is set. Only TASK 30 sets it, and only after the isolation E2E passes.
Ship the gate in TASK 24 with the endpoint itself — never as a follow-up.

### 6.7 Library propagation must never touch commerce columns

Propagation writes an **explicit column list**, always:

```sql
UPDATE products SET name = ?, description = ?, image_id = ?, unit = ?
WHERE library_product_id = ?
```

Never a `SET` clause assembled from a spread of the request body. A propagation that reaches
`price`, `shop_price`, `original_price`, `available`, `display_order`, `category_id` or `shop_id`
silently overwrites every area's pricing in one statement, with no way to tell which values were
lost.

TASK 20 ships a test that edits a library item and asserts every per-area price, availability flag
and display order is byte-identical afterwards.

### 6.8 Nothing in this spec hard-deletes anything

| Operation | Behaviour |
|---|---|
| Delete an area | Not supported. Deactivate only. |
| Delete a library item | Archive only. Per-area products survive as local-only (§2.4). |
| Remove a library variant | Soft-delete per-area rows (`deleted = 1`). Live carts and order snapshots hold `product_variants.id` and must keep resolving. |
| Clone an area | Refuses to run against an area that already has categories or products, so a double click cannot duplicate a catalog. |
| Promote to library | Creates a library row and links the source product. Touches no other area's rows. |
| Existing products | Stay local-only until an admin explicitly promotes them. No auto-promotion (§2.9). |

### 6.9 Rollback posture per phase

| Phase | Reversible | How |
|---|---|---|
| A — columns, indexes | Mostly | Columns are additive. **The UNIQUE-key rewrites of §1.3 are the exception** — they rebuild indexes and are not free to undo. Snapshot first. |
| B — auth | Yes | The env-password fallback stays live until `admins` is populated. Revert the deploy. |
| C — sweep | Per domain | One commit per domain; revert that commit. The sweep only *adds* predicates — no data is rewritten. |
| D — libraries | Yes | Library tables are additive, `library_*_id` links are nullable. Dropping the links returns every product to local-only. |
| E–G | Yes | Behaviour only, no schema. |
| **Order-number PK change (TASK 13)** | **No** | Numbers already issued cannot be reissued. This one must be right in rehearsal, not in production. |

### 6.10 Rollout order

Phases A–B are additive: old code ignores `area_id`, old clients keep working. Phase C is the risky
stretch — ship it domain by domain, each with `npm test` green and the guardrail test tightening.
Phase D is additive again (nothing is forced into a library). Phase G requires an app release, so
keep the API tolerant of area-unaware clients (§2.9) until adoption is high.

**Area 2 is not created until TASK 30 passes (§6.6).** Everything before that runs single-area,
which means every deploy in Phases A–F is verifiable against production behaviour that must not
change at all: same catalog, same prices, same order flow, same dashboard.

---

## 7. CUSTOMIZATION ROADMAP — what else is worth doing

Included in this spec because they are cheap once the area plumbing exists:

- **Per-area branding** — `areas.brand_color` + `logo_image_id`, served by `/bootstrap`. Each town
  can look like its own service without a separate app build. (TASK 1 + 27 + 28.)
- **Per-area feature flags** — `areas.features JSON` instead of another boolean column on `settings`
  every time a feature lands. (TASK 1.)
- **Clone an area** — stand up area #3 from area #1's catalog and home screen in minutes. (TASK 24.)
- **Bulk add-to-many-areas with a per-area price map** — launch a product across towns in one
  action. (TASK 19.)
- **Promote an existing product into the library** — no big-bang data migration needed. (TASK 19.)
- **Category + store-mode libraries** — rename "Dairy" once, every town follows; Area 3 can still
  switch fast food off entirely. (TASK 21.)
- **Units lookup** — kills the `kg`/`Kg`/`KG`/`kilogram` drift before it starts. (TASK 22.)
- **Fulltext search** — removes the full-table-scan `LIKE '%term%'` that multi-area would multiply.
  (TASK 22.)
- **Image dedupe by content hash** — one stored JPEG instead of N. (TASK 18.)
- **ETag/304 + single bootstrap call** — the biggest felt speed win on a slow connection. (TASK 27.)

Deliberately **v2, not now** — each is a real feature, and bundling them into a tenancy migration is
how tenancy migrations fail:

- **Coupon templates** — a shared rule definition with per-area activation and budgets. Coupons carry
  30+ rule columns, redemption accounting, usage limits and `FOR UPDATE` locking; a cross-area
  template needs its own audit trail. (§2.11.)
- Per-area price *rules* (e.g. "Area 3 = Area 1 + 8%") as a live formula rather than a copied number.
  The bulk price map in TASK 19 covers the practical need.
- Scheduled price changes / time-boxed price lists.
- Combo and offer libraries — clone covers them today (§2.11).
- Moving a shop, rider or order between areas.
- Per-page or per-capability admin permissions beyond the two roles.
- Customer-visible area switching in the app — the area always follows the delivery pin (§2.10).
- A separate database per area — revisit only if one area's write volume starves the others.
- Shared caches in Redis — required *before* running more than one API container (§3.8).

## 8. OUT OF SCOPE (v1)

- Deleting an area (deactivate only).
- Hard-deleting a library item (archive only — §2.4).
- Cross-area customer accounts merging or splitting.

---

## 9. KNOWN HURDLES — found by reading the code 2026-08-01

Everything here is a real obstacle already present in the codebase, not a hypothetical. The three
in §9.1 must be resolved **before TASK 1**, because they change the design rather than the schedule.

### 9.1 Blockers — resolve before starting

**H1. The server does not store the customer's pin. §4.2 step 2 was wrong.**
`users` has `address` and `short_address` but **no latitude/longitude** (`migrate.js:103-118`). The
delivery pin lives only in the app's AsyncStorage (`useDeliveryLocationStore`). So the server-side
resolution chain in §4.2 has no "saved delivery pin" step to use — it is:

```
request pin  →  users.last_area_id  →  default area (only when no pin was sent at all)
```

Mitigation, folded into TASK 3: backfill `users.last_area_id` from each user's **most recent order's
`latitude`/`longitude`** (orders do carry the pin), resolved through the zone matcher. Users who have
never ordered stay NULL and fall through to the default area until their first pin arrives.
**Do not add lat/lng columns to `users` for this** — that is a new product surface (saved addresses)
and belongs in its own spec.

**H2. Background jobs have no request context and therefore no `req.areaId`.**
Five things run on timers, outside any HTTP request, and every one of them currently operates
globally:

| Job | Where | What breaks |
|---|---|---|
| `riderOfferSweeper` | `src/realtime/riderOfferSweeper.js` | expires offers across all areas — fine to stay global, but its **emits** must go to the right area room |
| `shopScheduleSweeper` | `src/realtime/shopScheduleSweeper.js` | flips `is_open`; calls `syncGlobalShopOpenState`, which TASK 15 makes per-area — the sweeper must loop areas |
| `purgeExpiredDeletions` | `src/server.js:96-98` | genuinely global (users are global) — leave it, but add it to the guardrail allowlist |
| analytics rollup | `src/services/analytics/rollup.js:154` | writes one `analytics_daily` doc per date; must become one per `(areaId, date)` |
| `emitLiveSnapshot` | `src/realtime/presence.js:134-145` | pushes `analytics.live` to the flat `admin` room **every 5s** — with per-area rooms this needs a per-area snapshot, or every area admin sees every area's live traffic |

The rule from §3.1 ("area resolved once per request") has no meaning here. These jobs need an
explicit `for (const area of await listAreas())` loop, or a documented decision to stay global.
Decide per job in TASK 15 and TASK 17; do not leave it to the implementer to guess.

**H3. 58 of 85 test files are coupled to SQL text or mocked query order.**
Every test file does `jest.mock('../src/db/mysql')` and drives controllers with ordered
`mockResolvedValueOnce` sequences, plus assertions like
`expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('active = 1'))`
(`tests/deliveryZonesPublic.test.js:58`, `tests/coupons.test.js:490`).

Adding an `area_id` predicate changes the SQL string. Adding a query changes the sequence position.
Both break tests that are otherwise correct. This is the single biggest **schedule** risk in the
project — expect test churn to exceed source churn in Phase C.

Two things reduce it, both already in the design: resolving the area once in middleware (§3.1) means
controllers gain **no new queries**, only new predicates; and keeping response shapes byte-identical
(§5 Phase C preamble) means assertions on output survive. Budget the fixture updates explicitly —
do not let a broken test get "fixed" by loosening an assertion that was catching something real.

### 9.2 Structural friction — plan for it, it will not block

**H4. `store_type` is a free-text VARCHAR pointing at `store_modes.slug`.**
It appears on `categories`, `combos`, `offers`, `dashboard_sections`, `products` (via category) and
`coupons.applies_to`. With per-area store modes, the same string `'fast_food'` is a *different row*
in each area. Validation must be "does this slug exist and is it active **in this area**", not "is it
in the global list". `utils/storeMode.js`'s `normalizeStoreType` is the chokepoint — fix it there,
once (TASK 11).

**H5. Combos exist twice.**
There is a `combos` table *and* `products.is_combo`, with a one-time backfill copying between them
(`migrate.js:461-462`), and `product_combo_items` linking products to products. Any area work on
combos touches both representations. This is pre-existing debt; do not attempt to unify it inside
this spec — scope `area_id` onto both and move on.

**H6. Broadcast push cannot target an area precisely.**
Customers are global (§2.2) and carry only `last_area_id`, a cache. "Notify every Area 2 customer"
is therefore approximate — it reaches people whose last known area was 2, misses someone who has
never ordered, and includes someone who has since moved. Acceptable for marketing pushes; state it
in the admin UI so nobody assumes it is a precise audience. Order-related pushes are unaffected
(they target a specific user about a specific order).

**H7. Socket join races the pin.**
`joinRoleRoom` (`socket.js:67-80`) runs at connect time, but the app may not have resolved its area
yet on a cold start. The client must be able to **rejoin** after `/bootstrap` returns (already
required by TASK 23/28) and the server must tolerate a customer socket that has joined no area room
yet. Do not block the connection waiting for an area.

**H8. `bulkImportController` writes products directly.**
`bulkImportController.js:529` does a raw `INSERT INTO products (...)`. CSV import needs an area, and
the natural UX is "import into the area I am currently switched to". Easy, but it is a 578-line file
that the catalog sweep must not miss.

### 9.3 Ops and tooling gaps

**H9. CI provisions MySQL and Mongo but never runs the migration.**
`.github/workflows/ci.yml` spins up `mysql:8.0` and `mongo:7.0` service containers and passes their
credentials to `npm test` — but every test mocks `src/db/mysql`, so **nothing ever connects**, and
`db:migrate` is never invoked. The databases are provisioned and unused.

This makes the untested-migration problem of §6.1 worse than it looks: it is easy to assume CI covers
schema changes because the services are right there in the workflow file. It does not.

**Cheap, high-value fix — do it in TASK 0:** add a `npm run db:migrate` step to `ci.yml` against the
MySQL service, then run it **twice** to assert idempotence. That turns every future PR into a
migration smoke test for free, and it is the only automated protection this repo will have against
a migration that fails on boot in production.

**H10. `config/env.js` hard-requires `ADMIN_PASSWORD`.**
`env.js:107,114-117` treats admin auth as env-only and validates it at boot (rejecting weak values
in production). TASK 7 makes the `admins` table the source of truth with env as a fresh-install
fallback — the validation contract has to change with it, or a deployment with a populated `admins`
table and no `ADMIN_PASSWORD` env var will refuse to start.

**H11. `seed_demo.js` predates areas.** It will produce area-less rows. Update it in TASK 3 or it
becomes a source of NULL `area_id` rows that fail the NOT NULL step on any dev machine.

**H12. The `orders` table's real size is unknown.** Every timing claim in §3.6 and §6 assumes it is
large but not enormous. Measure it in TASK 0 (`SELECT COUNT(*) FROM orders`, plus
`information_schema.TABLES` data length) before estimating the migration window.

### 9.4 Open product decisions — answer before Phase C, not during

These have no technically correct answer; they need the product owner. Leaving them open until the
sweep is underway means a mid-sweep schema change.

1. **A shop or rider near an area boundary.** `riders.area_id` and `shops.area_id` are single-valued
   in this spec. If a rider genuinely serves two towns, the model needs a join table — a schema
   change, not a tweak. Confirm single-area is acceptable.
2. **A customer in Area 2's geography with order history from Area 1's config.** Their past orders
   stay `area_id = 1` (that is where they were placed). Confirm that reorder/repeat-order flows are
   allowed to fail gracefully when the product no longer exists in their current area.
3. **Historical Mongo analytics have no area** and cannot be reconstructed. Recommendation: stamp all
   pre-migration docs `areaId: 1` and accept that cross-area history starts at the migration date.
4. **Does Area 2 launch with its own phone number, UPI ID and support contact?** These live in
   `settings`, so per-area is free — but the customer app currently shows one support number, and
   somebody has to actually staff a second one.
