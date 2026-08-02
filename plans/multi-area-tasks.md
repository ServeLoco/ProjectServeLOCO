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

### [~] TASK 0 — Production snapshot + migration rehearsal
**Spec:** §6.1, §6.2, §9 · **Files:** `[ci] .github/workflows/ci.yml`, staging only
**Status note (2026-08-01):** 0.1–0.6, 0.8–0.9 need real production/staging access this session
doesn't have — deferred to whoever runs the actual prod deploy. Only 0.7 (CI step) done here.
Instead rehearsed TASK 1–3 twice against the **local dev DB** (`serveloco`, not synthetic-empty:
9 products / 79 orders / 6 users / 1 shop) and took a `mysqldump` snapshot first. Row counts
verified unchanged after both runs. This is not a substitute for 0.1–0.6 against production.

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
- [x] 0.7 `[ci]` Added to `.github/workflows/ci.yml`, after "Install dependencies" and before
      "Run Tests": two `npm run db:migrate` steps (first pass + idempotence pass) against the
      MySQL service container, with the env vars `config/env.js` requires (`JWT_SECRET`,
      `ADMIN_OWNER_ID`, `ADMIN_PASSWORD`) added since migrate.js now seeds a super_admin.
- [ ] 0.8 Time the staging migration. If it exceeds the acceptable deploy window, plan a maintenance
      slot before TASK 3 rather than discovering it on boot.
- [ ] 0.9 Record here: `orders` rows = ____, data length = ____, migration duration = ____.

**Done when:** two consecutive clean migration runs on a production-shaped DB, zero row-count drift,
CI runs migrate twice and is green.
**Commit:** `feat: AREA TASK 0 — migration rehearsal + CI migrate step`

---

## Phase A — Foundations (no behaviour change)

### [x] TASK 1 — `areas` table + seed Area 1
**Spec:** §2.1, §2.12 · **Files:** `[api] src/db/migrate.js`

- [x] 1.1 `CREATE TABLE IF NOT EXISTS areas` — `id`, `code VARCHAR(16) UNIQUE`, `name`,
      `active TINYINT DEFAULT 1`, `is_default TINYINT DEFAULT 0`,
      `timezone VARCHAR(64) DEFAULT 'Asia/Kolkata'`, `min_lat/max_lat/min_lng/max_lng DECIMAL(10,7)
      NULL`, `catalog_version BIGINT NOT NULL DEFAULT 1`, `brand_color VARCHAR(9) NULL`,
      `logo_image_id INT NULL`, `features JSON NULL`, `created_at`, `updated_at`.
- [x] 1.2 Index `(active, min_lat, max_lat)` for the bbox prefilter (§3.2).
- [x] 1.3 `INSERT IGNORE` seed row: `id=1, code='A1', name='Area 1', is_default=1`.
- [x] 1.4 Confirmed nothing reads the table yet — purely additive.

**Done when:** migrate runs twice clean, `SELECT * FROM areas` returns exactly one row, `npm test`
green. **Verified locally** 2026-08-01 against `serveloco` dev DB — both true.
**Commit:** `feat: AREA TASK 1 — areas table + seed Area 1`

### [x] TASK 2 — `admins` table + per-admin session state
**Spec:** §2.9 · **Files:** `[api] src/db/migrate.js`

- [x] 2.1 `CREATE TABLE IF NOT EXISTS admins` — `id`, `username VARCHAR(64) UNIQUE`,
      `password_hash VARCHAR(255) NOT NULL`, `role ENUM('super_admin','area_admin') NOT NULL`,
      `area_id INT NULL`, `display_name`, `active TINYINT DEFAULT 1`, timestamps.
- [x] 2.2 FK `area_id → areas(id)`; index `(active, area_id)`.
- [x] 2.3 `ensureColumn('admin_auth_state', 'admin_id', 'admin_id INT NULL')`. Row `id=1` keeps
      working as the legacy global revoke.
- [x] 2.4 Seed one `super_admin` row from `ADMIN_PASSWORD_HASH` (or bcrypt-hashed `ADMIN_PASSWORD`,
      whichever is set) **only when `admins` is empty**. Verified locally: seeded on first run,
      silently skipped on second run.
- [x] 2.5 Application-level invariant documented as a comment above the `admins` seed insert
      (`area_id: NULL` for the seeded `super_admin`); enforcement at the endpoint is TASK 24 — not
      yet built, so nothing stops a hand-written INSERT from violating it today. Flagging this as a
      real gap until TASK 24 lands, not just a checklist formality.

**Done when:** migrate idempotent, one seeded super admin exists, existing admin login unaffected.
**Verified locally** 2026-08-01 — `admins` has exactly one `super_admin` row (`area_id NULL`) after
two runs; `adminController.js` login not yet touched (TASK 7) so existing login is provably
unaffected — it doesn't read this table yet.
**Commit:** `feat: AREA TASK 2 — admins table + per-admin session state`

### [x] TASK 3 — `area_id` columns, backfill, indexes, UNIQUE key rewrites
**Spec:** §3.3, §3.6, §6.2, H1, H11 · **Files:** `[api] src/db/migrate.js`, `src/db/seed_demo.js`

> The riskiest task in the project. Follow the order literally — each step exists because
> reordering it loses data (§6.2).

- [x] 3.1 Added `ensureColumnAtEnd(table, name, definition)` — same existence check as
      `ensureColumn` but **no `AFTER` clause**. `ensureColumn` itself untouched.
- [x] 3.2 Added nullable `area_id INT` **at end of row** to all 19 tables via a shared
      `AREA_SCOPED_TABLES` list (single source of truth reused by every step below — avoids the
      table list drifting between the column/backfill/NOT-NULL/FK loops).
- [x] 3.3 Backfilled each to `1` in **5,000-row batches**, `ORDER BY id LIMIT 5000`,
      `WHERE area_id IS NULL`, looped until `affectedRows === 0`. Outside any transaction.
- [x] 3.4 Orphan check (`assertNoAreaOrphans`) run per table before NOT NULL — throws and aborts
      the whole migration on any violation. Verified locally: 0 orphans on every scoped table.
- [x] 3.5 `MODIFY area_id INT NOT NULL` only after the orphan check passes (checked
      `IS_NULLABLE` first so re-running after it's already NOT NULL is a no-op, not an error).
- [x] 3.6 FK `area_id → areas(id) ON DELETE RESTRICT` on all 19, via `ensureForeignKey` (same
      rethrow-unless-duplicate pattern as the existing `delivery_zones` parent FK). Verified: 19
      `fk_*_area` constraints present in `information_schema`.
- [x] 3.7 Old global UNIQUE keys dropped **before** the new composite on all 5: `categories.slug`,
      `store_modes.slug`, `coupons.uniq_live_coupon_code`, `dashboard_sections.idx_section_store_slug`,
      `admin_notifications.uniq_admin_inbox_event`. Verified via `SHOW INDEX` — none of the old
      global keys remain, all 5 new per-area composites present.
- [x] 3.8 All 12 composite indexes from §3.3 added (`ensureIndex`, reused from the existing helper
      already in scope in this function). Verified present via `SHOW INDEX`.
- [x] 3.9 Confirmed `orders.idx_status` / `idx_created_at` **not** touched — grepped the diff.
- [x] 3.10 Added `users.last_area_id INT NULL` via `ensureColumnAtEnd` — no FK (§2.2: cache only,
      areas are deactivate-only per §6.8 so it can never dangle).
- [x] 3.11 **Deviated from the literal wording, documented in a code comment why:** backfilled
      `last_area_id = 1` for every user with ≥1 order, rather than actually running each user's
      most recent order's lat/lng through a zone matcher. Reason: the polygon matcher
      (`matchZone`/`areaScope.js`) doesn't exist until TASK 6, and — more fundamentally — the §6.6
      gate means **only Area 1 can exist** at the point this backfill ever runs for real, so
      "match against zones" and "= 1" produce an identical result. Real per-request resolution
      takes over from TASK 6 onward; this is a one-time historical seed, not the resolution path.
      Verified locally: 4/6 users (those with orders) got `last_area_id = 1`, 2 stayed `NULL`.
- [x] 3.12 `seed_demo.js` — all 10 INSERT statements (`settings`, `offers`, `categories`×2,
      `products`×3, `orders`, `order_items`×2, `coupons`) updated to stamp `area_id = 1`.
- [x] 3.13 Confirmed `daily_order_counters` untouched in this task.
- [x] 3.14 Row-count comparison re-run against the **local dev DB** (not production/staging — see
      TASK 0 status note): `products=9, orders=79, users=6, shops=1` before and after, unchanged.

**Done when:** migrate runs twice clean, zero NULL `area_id` anywhere, row counts unchanged,
`npm test` green. **All true, verified locally** 2026-08-01. `npm test`: 85 suites / 919 tests
passed (mocked DB, so this proves application code is unaffected, not migration correctness —
that's what the two live runs above proved). `npx eslint` clean on both touched files.
**Commit:** `feat: AREA TASK 3 — area_id columns, backfill, indexes, unique key rewrites`

### [x] TASK 4 — Area-aware caches
**Spec:** §3.4 · **Files:** `[api] src/utils/microCache.js`, `src/utils/storeMode.js`,
`src/controllers/settingsController.js`, all current cache callers, `tests/microCache.test.js`

- [x] 4.1 `microCache.js`: `set()` validates `<namespace>:<areaId>:<rest>` (or bare
      `<namespace>:<areaId>`) via regex, throws outside `NODE_ENV=production`. `get()` deliberately
      stays lenient — a malformed/missing read key just misses the cache rather than crashing a
      request; only writes are validated, since that's where a bad key actually gets baked in.
- [x] 4.2 `bust(namespace, areaId)` matches the exact `namespace:areaId` key plus everything under
      `namespace:areaId:`, with a trailing-colon guard so area 1 can't accidentally sweep area 10's
      keys via a naive substring prefix. `bust(namespace)` with no areaId kept as the original
      plain-`startsWith` global fallback.
- [x] 4.3 `MAX_ENTRIES` 100 → 600, exported.
- [x] 4.4 `settingsController`: internal `settingsKey(areaId)` helper, hardcoded to area 1 via a
      named `SETTINGS_AREA_ID_STOPGAP` constant at all 3 internal read/write sites.
      `bustSettingsCache` stays zero-arg (its 2 external callers — `shops.js`, `riders.js` — aren't
      touched in this task; that's real DB scoping, deferred to TASK 15).
- [x] 4.5 `storeMode.js`: internal `cacheKeyForArea(areaId)` helper, same stopgap pattern.
      `normalizeStoreType`/`invalidateStoreModeCache`/`getActiveStoreModeSlugs` keep their existing
      zero-arg signatures — their 9 external callers across the codebase are untouched; the
      underlying query itself isn't area-scoped yet (that's TASK 11, H4).
- [x] 4.6 Every `microCache` caller updated to pass `1` explicitly — found via
      `grep -rln "microCache" src/`, not by only checking the files the checklist named. That grep
      caught 2 files the plan missed (`shopAdminController.js`, `shopOwnerController.js`), which is
      exactly why the grep-first approach matters more than trusting a file list. Final verification:
      `grep -rn "\.bust(" src/ | grep -v microCache.js | grep -vE "bust\('[a-z-]+', "` returns nothing
      — no caller left without an explicit areaId argument.
- [x] 4.7 Rewrote `tests/microCache.test.js`: per-area bust isolation, the area-1-vs-area-10
      substring-collision guard, bare `namespace:areaId` busting, malformed-key throw (and the
      production bypass), lenient `get()`, and `MAX_ENTRIES` eviction at the new 600 threshold.
      11 tests (was 5).

**Done when:** single-area behaviour unchanged, cross-area bust isolation covered by a test.
**Verified locally** 2026-08-01: `npm test` 85/85 suites, 925/926 (1 pre-existing skip) passed;
`npx eslint` clean on every touched file; booted the real dev server against the migrated local DB
and hit `/api/categories`, `/api/dashboard`, `/api/delivery-zones`, `/api/settings` live — all
returned real cached data with no errors.
**Commit:** `feat: AREA TASK 4 — area-aware caches`

### [x] TASK 5 — Guardrail test, before the sweep
**Spec:** §4.6 · **Files:** `[api] tests/areaScoping.test.js` (new)

- [x] 5.1 Static scan of `src/controllers`, `src/services`, `src/utils`. Implementation note: rather
      than a bare text search, it finds every `.query(` call, captures its full (paren/bracket/
      brace/string-aware) argument text, and checks that against a per-table
      `\b(?:FROM|JOIN|UPDATE|INTO)\s+\`?table\`?\b` regex — precise enough that `orders` doesn't
      false-positive on `order_items`, `combos` doesn't on `combo_items`, `products` doesn't on
      `product_variants` (covered by its own test). When the query is passed as a bare variable
      (`pool.query(query, params)`) rather than an inline literal, it widens the search to the
      enclosing function body (found via brace-balance scanning from the nearest function-start
      marker) since that's where the `let query = ...` / `query += ...` building actually lives —
      falls back to the whole file if no enclosing function is found, a safe over-approximation.
- [x] 5.2 Fails any `.query()` call referencing a `SCOPED_TABLES` entry whose search text contains
      no `area_id` (case-insensitive).
- [x] 5.3 Allowlist mechanism built (`{file, line, reason}`, checked before flagging) but **left
      empty** — every table in the spec's suggested allowlist (`users`, `images`,
      `notification_templates`, `product_library`, etc.) is a table that never enters
      `SCOPED_TABLES` in the first place (they're not in migrate.js's `AREA_SCOPED_TABLES`), so they
      can never be flagged and never need an entry. The allowlist exists for a different, real case:
      a scoped-table query that's correctly global for some other reason, discovered during the
      Phase C sweep — none exist yet.
- [x] 5.4 Ran it standalone (jest globals stubbed) to get the real baseline before deciding to skip:
      **437 violations across all 19 scoped tables** (orders 107, products 59, shops 46, order_items
      48, categories 29, product_groups 23, dashboard_section_items 23, combos 22, delivery_zones 16,
      settings 18, coupons 18, dashboard_sections 17, mobile_admins 14, offers 14, store_modes 12,
      admin_notifications 8, notification_batches 6, riders 31, delivery_exclusion_zones 1). Order of
      magnitude matches §1.1's per-table SQL-site counts (this scanner counts distinct `.query()`
      call sites, not raw grep hits, so it's lower but tracks the same shape). Top offending files:
      `adminController.js` (48), `dashboardController.js` (48), `productController.js` (31),
      `riderController.js` (29), `adminRiderController.js` (27). **`it.skip`'d** with the TODO to
      un-skip starting TASK 9, per §5.4 — this count is real, not a guess, and is what "the failure
      list matches the Phase C task list" (below) is checked against.
- [x] 5.5 Header comment states explicitly: loosening the scanner or padding the allowlist to make a
      real finding disappear is a review failure, not a fix.
      Two more tests guard the scanner itself (not skipped, run every `npm test`): it must find at
      least one real violation right now (catches a scanner regression going silently vacuous), and
      the word-boundary regex must not false-positive on the three collision cases above.

**Done when:** the test exists and its failure list matches the Phase C task list. **Verified
locally** 2026-08-01 — 437-violation baseline recorded above, matches §1.1's table sizes in shape;
`npm test` 86/86 suites (927/929, 2 skips: the new one + the pre-existing one); `npx eslint` clean
(one `eslint-disable` comment for a non-existent rule was written then removed once eslint caught
it — this project has no `eslint-plugin-jest` configured).
**Commit:** `feat: AREA TASK 5 — area scoping guardrail test`

### [x] TASK 6 — `areaScope.js` + resolution middleware
**Spec:** §3.1, §3.2, §4.1, §4.2 · **Files:** `[api] src/utils/areaScope.js` (new),
`src/middleware/areaMiddleware.js` (new), `tests/areaScope.test.js` (new)

- [x] 6.1 `resolveAreaForPoint(lat, lng)` — bbox prefilter over `areas` (an area with no bbox yet —
      true for every area until TASK 10 starts recomputing it on zone writes — is always a
      candidate, a safe over-approximation), then the **existing** `matchZone` from
      `deliveryPricing.js`, imported and called unchanged, never reimplemented. Zones themselves are
      loaded with a small dedicated `WHERE area_id = ?` query in `areaScope.js` — deliberately *not*
      routed through `deliveryPricing.js`'s `loadActiveZones(db)`, which still loads every zone
      platform-wide until TASK 10 gives it an area filter. This means area resolution is genuinely
      area-scoped starting now, not just after TASK 10 catches up. Returns
      `{ areaId, zoneId, zone }` or `null`.
- [x] 6.2 `getAreaById(areaId)` and `listAreas({activeOnly})` — both backed by one 60s-cached
      `SELECT * FROM areas` (`getAreaById` filters the cached list rather than caching per-id, so
      there's one cache entry to invalidate, not N).
- [x] 6.3 `requestAreaId(req)` — throws only when `req.areaId` is `undefined` (middleware never ran);
      `null` and `'all'` are treated as legitimately resolved values and returned as-is.
- [x] 6.4 `assertAreaAccess(req, areaId)` — throws `{statusCode: 403, code: 'FORBIDDEN'}` (shaped for
      `errorHandler.js`, matching its `err.statusCode`/`err.code` convention) unless `super_admin`,
      or `area_admin` whose own area matches.
- [x] 6.5 `bustAreaCaches(areaId)` — busts the three now-area-shaped microCache namespaces
      (`dashboard`, `categories`, `delivery-zones`) for real, plus this module's own zone cache, then
      calls `bumpCatalogVersion(areaId)`. Also calls `bustSettingsCache()` / `invalidateStoreModeCache()`
      (lazy-required, same circular-import reasoning as `utils/shops.js`'s existing lazy requires) —
      **documented as partial**: those two stay zero-arg/area-1-only until TASK 9/11 parameterize
      them, so calling them here is forward-compatible plumbing, not yet a real per-area bust. Wrapped
      in try/catch so a unit test that hasn't loaded `settingsController`/`storeMode` doesn't fail.
- [x] 6.6 `bumpCatalogVersion(areaId)` — the increment update, plus invalidates the areas cache (the
      row it just changed would otherwise read stale for up to 60s).
- [x] 6.7 `resolveAdminArea` middleware, **including the TASK 8 security requirement built in now
      rather than retrofitted**: an `area_admin` sending *any* `X-Area-Id` (including `'all'`) gets
      403, never a silent override — tested directly via mock `req`/`res`/`next`, independent of
      TASK 7/8's real JWT wiring. `super_admin` gets the header as a positive integer, the literal
      `'all'`, or `null` when absent; a non-numeric, non-`'all'` header is a 400.
- [x] 6.8 `resolveCustomerArea` middleware — pin (checks `latitude`/`longitude` then `lat`/`lng` in
      body then query, matching the exact precedence already used in `cartController.js`) → zone →
      area; else `users.last_area_id`; else the default area **only when no pin was supplied at
      all**. A pin resolving to no zone sets `req.areaId = null` and `req.zoneId = null` — verified
      by an explicit test that this is `null`, not the default area's id.
- [x] 6.9 Unit tests, all passing: point in one zone; nested child zone winning over its parent
      (proves `matchZone` reuse); a point inside an exclusion square still resolving normally
      (proves exclusion zones are — correctly — never consulted by this function, and that the
      exclusion-zones table is never even queried: `pool.query` called exactly twice); point outside
      every zone returning `null`; missing/NaN/non-numeric coordinates short-circuiting with zero DB
      calls; an area with zero zone rows matching nothing without erroring; the bbox prefilter
      actually excluding a real-bboxed area that can't contain the point.
- [x] 6.10 Confirmed zero controller/route changes — `grep -rln "areaScope\|areaMiddleware" src/` only
      matches the two new files themselves and their test.

**Done when:** full unit coverage of the resolver, zero controller changes. **Verified locally**
2026-08-01: 32/32 new tests pass on first run; `npm test` 87/87 suites (959/961, same 2
pre-existing skips); `npx eslint` clean on all three new files; guardrail baseline (TASK 5) unchanged
at 437 — confirms `areaScope.js`'s own `delivery_zones` query is correctly recognized as
`area_id`-scoped and doesn't itself add a new finding.
**Commit:** `feat: AREA TASK 6 — areaScope module + resolution middleware`

---

## Phase B — Auth (the gate)

### [x] TASK 7 — Admin login against `admins`
**Spec:** §2.9, H10 · **Files:** `[api] src/controllers/adminController.js`, `src/config/env.js`,
`tests/adminAuth.test.js`

- [x] 7.1 `SELECT ... FROM admins WHERE username = ?`, `bcrypt.compare` against `password_hash`. A
      row that exists but is `active = 0` is treated as not-found for matching purposes — it does
      **not** fall through to the env path either, since that path only ever fires when the whole
      table is empty (a deactivated admin existing at all means it isn't).
- [x] 7.2 JWT via a small extension to `utils/auth.js`'s `signAdminToken(adminId, {adminRole,
      areaId} = {})` rather than a bespoke `jwt.sign` call — the second argument defaults to `{}`,
      so `mobileAdminController.js`'s existing unrelated call (`signAdminToken(\`mobile:${id}\`)`,
      a completely different admin concept) is untouched and keeps minting a token with no
      `adminRole`/`areaId` field at all, exactly as before.
- [x] 7.3 Env fallback fires only when `SELECT COUNT(*) FROM admins` is `0` **and** the submitted
      username matches `ADMIN_OWNER_ID`. `console.warn`'d when it fires, naming the fix (run
      migrate, or create a real admin).
- [x] 7.4 Both the fallback path and the real-admin path return `adminRole`/`admin_role` and
      `areaId`/`area_id` on `user`. Bootstrap logins are always `super_admin` / `areaId: null`.
- [x] 7.5 Removed `ADMIN_PASSWORD` from `env.js`'s `requiredKeys` entirely (with the splice-based
      conditional-removal logic that existed only to support it) rather than trying to make it
      conditionally required — `env.js` runs before any DB connection exists, so it structurally
      cannot know whether `admins` is populated; only the login handler, at request time, can
      decide that. The production weak-password check keeps validating *whichever* of
      `ADMIN_PASSWORD`/`ADMIN_PASSWORD_HASH` is set, but the `else { throw }` that previously
      required at least one to be set was removed — a real production deploy past the bootstrap
      admin is expected to have neither.
- [x] 7.6 Lockout stays a **shared** single-row threshold (`admin_auth_state` was never restructured
      into one-row-per-admin — TASK 2 only added a nullable `admin_id` column to the existing
      singleton). `admin_id` is now recorded on every success/failure for audit ("who tripped or
      cleared this"), but the counter itself isn't isolated per admin. Documented as a deliberate,
      in-scope-appropriate choice, not an oversight: a shared threshold still stops distributed
      brute-forcing across multiple admin usernames, and a genuinely per-admin-isolated counter is a
      schema change beyond what TASK 2 built.
- [x] 7.7 `tests/adminAuth.test.js` rewritten, 7 tests: env-fallback success/failure, env fallback
      correctly refusing once the table is non-empty (even with matching env creds), real
      super_admin login (both-casing response asserted), real area_admin login (area id round-trips),
      wrong password against a real row never falling through to env, and a deactivated admin
      rejected outright.

**Done when:** existing credentials still work, JWT carries area, `npm test` green. **Verified
locally** 2026-08-01, including against the real local dev DB (not just mocks): booted the server,
hit `/api/admin/login` with wrong/nonexistent credentials (clean 401s, no 500s — confirms the new
two-query lookup+fallback flow doesn't crash for real), then inserted a throwaway `area_admin` row
with a known bcrypt hash, logged in successfully, and confirmed the JWT payload
(`sub`/`role`/`adminRole`/`areaId`) and response body both carry the right shape — then deleted the
throwaway row and reset `admin_auth_state` back to clean. `npm test` 87/87 suites (964/966, same 2
pre-existing skips); `npx eslint` clean on all 4 touched files.
**Commit:** `feat: AREA TASK 7 — admin login against admins table`

### [x] TASK 8 — `requireAdmin` sets area; `requireSuperAdmin`
**Spec:** §2.3, §4.2 · **Files:** `[api] src/middleware/authMiddleware.js`,
`tests/roleProtection.test.js`

- [x] 8.1 `req.admin` gains `adminRole` and `areaId` read straight from the JWT payload (`areaId`
      defaults to `null` if the claim is absent, so `req.admin.areaId` is never `undefined`).
- [x] 8.2 `requireSuperAdmin` added and exported — 403s unless `req.admin.adminRole ===
      'super_admin'`. Not wired into any route yet (no super-admin-only route exists before
      TASK 24); unit-tested directly.
- [x] 8.3 **Deviated from "via a `router.use()`", with the reason written into a code comment right
      at the call site:** `requireAdmin` is applied **per-route**, 113 separate call sites in
      `adminRoutes.js` — it was never a single `router.use()` to begin with (verified by grep before
      writing any code). A `router.use(resolveAdminArea)` mounted before those 113 routes would run
      before `req.admin` exists (always a no-op); mounted after, it would never run at all for any
      route that already sent a response (Express doesn't fall through a completed request to later
      middleware). The mechanism that actually reaches "once, not 130 times" here is `requireAdmin`
      **chaining into** `resolveAdminArea` as its own last step before `next()` — one edit to
      `authMiddleware.js`, zero edits to `adminRoutes.js`'s 113 call sites, and every one of them
      gets area resolution "for free" since they already call `requireAdmin`. `src/app.js` and
      `src/routes/adminRoutes.js` end up untouched — not in the final file list above.
- [x] 8.4 Investigated what "check by `admin_id`, falling back to `id=1`" could mean given the real
      schema (TASK 2 gave `admin_auth_state` a nullable `admin_id` *column* on its existing singleton
      row, not a genuine one-row-per-admin structure — there is only ever one row, `id=1`, so there
      is nothing to fall back *from*). Rather than write filtering logic against a table that
      structurally can't support it, kept the revocation check exactly as it was — a shared
      kill-switch across every admin — and documented why in a comment at the call site. A real
      per-admin revocation store is a schema change beyond TASK 2/8's built scope, noted as a
      possible future enhancement, not silently implied to already exist.
- [x] 8.5 **Security, verified two ways:** unit tests in `tests/areaScope.test.js` (TASK 6, direct
      mock req/res/next) and now integration tests here in `tests/roleProtection.test.js` through
      real JWTs and real routes — an `area_admin` sending `X-Area-Id` for another area gets 403; so
      does `X-Area-Id: all`. **Also verified live**, not just against tests: booted the real dev
      server, logged in as a throwaway `area_admin` via a real `POST /api/admin/login`, hit
      `GET /api/admin/me` with `X-Area-Id: 9` and got a real `403 {"code":"FORBIDDEN","message":
      "area_admin may not set X-Area-Id"}` back over HTTP.
- [x] 8.6 A `super_admin` with no `X-Area-Id` completes the request (`req.areaId = null`) rather than
      erroring — confirmed live the same way. An endpoint that actually *requires* an area is
      expected to call `requestAreaId(req)` itself and get a clear error from `null`/`'all'`; no such
      endpoint exists yet to assert against (Phase C's job), so this subtask is proven at the
      middleware level, not yet at a real area-required route.

**Done when:** both 403 tests pass, all existing admin routes still authorize correctly. **Verified
locally** 2026-08-01: 12/12 new/updated tests in `roleProtection.test.js` pass; `npm test` 87/87
suites (974/976, same 2 pre-existing skips — **zero existing tests broke**, because every hand-rolled
JWT in the other 86 suites predates `adminRole` and hits `resolveAdminArea`'s no-op branch exactly as
designed); `npx eslint` clean; live-verified end-to-end against the real dev DB as described above,
then cleaned up the throwaway admin rows and reset `admin_auth_state`.
**Commit:** `feat: AREA TASK 8 — admin area middleware + requireSuperAdmin`

---

## Phase C — Backend sweep

> Per task: add `area_id` to reads **and** writes, use `req.areaId`, key caches by area, replace
> scattered `microCache.bust(...)` pairs with `bustAreaCaches(areaId)`, keep response shapes
> byte-identical, run `npm test`. Expect test-fixture churn to exceed source churn (H3) — fix
> fixtures properly, never by loosening an assertion.

### [x] TASK 9 — Settings (27 sites)
**Spec:** §6.4 · **Files:** `[api] src/controllers/settingsController.js`,
`src/controllers/imageController.js`, everything `grep -rn "FROM settings\|INTO settings\|UPDATE
settings" src/` finds, plus `src/routes/settingsRoutes.js`, `src/db/migrate.js`,
`tests/areaScoping.test.js`, `tests/settingsArea.test.js` (new), and 4 existing test files whose
mocked admin JWTs/query-text assertions needed updating for the new shape.

- [x] 9.1 Grepped `FROM settings|INTO settings|UPDATE settings\b` (the plain `FROM settings` alone
      undercounted writes) across 9 files, 20 real call sites (the spec's "27" used a looser count
      style — every actual site is accounted for regardless).
- [x] 9.2 `getSettings`/`updateSettings` now select/write by `area_id`, resolved via
      `requestAreaId(req)`. `getSettings` (public, `resolveCustomerArea` newly mounted on
      `settingsRoutes.js`) falls back to the **default area** when `req.areaId` is `null` — settings
      is lightweight, non-delivery-critical info, so this is deliberately more lenient than the
      catalog/dashboard endpoints, which must show "we don't deliver here" for that same `null`
      (§2.4). `updateSettings` (admin, `resolveAdminArea` already wired by TASK 8) instead **rejects
      `null` and `'all'` with 400** — a write must target exactly one area (§2.10).
- [x] 9.3 `createSettingsForArea(areaId, connection)` exported, ready for TASK 24; not called from
      anywhere yet. **Found and fixed a real gap while implementing this:** `settings` had no
      UNIQUE constraint on `area_id` at all (TASK 3 gave it a column and an FK, not a uniqueness
      guarantee) — added `uniq_settings_area (area_id)` in `migrate.js`, or `INSERT IGNORE` here
      wouldn't actually have prevented a second settings row per area under a race. Verified via two
      migration runs against the local dev DB — idempotent, index present.
- [x] 9.4 `imageController.js`'s `getUsedImageIds` — dropped the `LIMIT 1` on the settings query;
      `addUsage` already iterates every row, so every area's UPI image now counts as in-use.
- [x] 9.5 All 8 `microCache.bust('dashboard', 1)` sites in `settingsController.js` replaced. The one
      inside `updateSettings` itself uses the real resolved `areaId`; the other 7 are inside the
      offer handlers (`createOffer`/`updateOffer`/`deleteOffer`/`addOfferProduct`/
      `removeOfferProduct`/`reorderOfferProducts`) — those stay on the area-1 stopgap since `offers`
      itself isn't scoped until TASK 12, but the cache-bust plumbing upgrade (`bustAreaCaches`,
      which also bumps `catalog_version`) didn't need to wait.
- [x] 9.6 Guardrail test **restructured**, not just un-skipped: added `SWEPT_TABLES` (starts with
      just `settings`) so the enforcement test can be active without requiring all 19 tables to be
      done — the original single global `it.skip` couldn't have been un-skipped until TASK 17.
      `settings` violations: 18 → 0. Total remaining (informational, non-failing): 419.
- [x] 9.7 New `tests/settingsArea.test.js` (7 tests): area 1 and area 2 reads hit distinct
      `WHERE area_id = ?` queries and distinct cache keys with no cross-contamination; a `null`
      areaId falls back to the default area; `updateSettings` 400s on `null`/`'all'`; a write to
      area 2 only touches area 2's row; **both areas' UPI QR images report `in_use: true`** via
      `GET /admin/images` (proves the 9.4 fix).

**Stopgap sites (documented per-site, owned by later tasks, all guardrail-clean since each
literally contains `area_id = 1`):** `cartController.js` ×3 and `orderController.js` ×1 (TASK 13),
`deliveryZonesController.js` ×1 (TASK 10), `utils/shops.js` ×3 and `utils/riders.js` ×2 (TASK 15),
`adminController.js` ×1 (TASK 17), `services/shopOrderActions.js` ×1 (TASK 13).

**Test churn from this task (H3, as expected):** `tests/ridersUtils.test.js` (2 SQL-text
assertions), `tests/settingsDeliveryGate.test.js` (token shape + 2 SQL-text assertions),
`tests/deliveryZonesAdmin.test.js` (token shape only — 26 unrelated tests in the file stayed green,
confirming the token change is harmless where `req.areaId` isn't read), `tests/
shopGlobalStatusSync.test.js` (6 SQL-text assertions), `tests/settingsOffers.test.js` (token shape,
which also resolved a stale-mock-queue cascade across 6 of its 9 tests — see the fix commit for the
full mechanism — plus one call-count bump from the new catalog-version query).

**Done when:** two settings rows exist, area isolation holds, both areas' images report in-use.
**Verified locally** 2026-08-01: migration run twice against the local dev DB (idempotent,
`uniq_settings_area` present); booted the real dev server and exercised `GET /api/settings`
(no-pin and with-pin) and `PATCH /api/admin/settings` (via a throwaway `area_admin` login) live,
confirmed the write landed on the correct area's row in MySQL, then reverted and cleaned up.
`npm test`: 88/88 suites (983/984, same 1 pre-existing skip — unrelated, in `cartOrder.test.js`,
predates this session). `npx eslint` clean on all 17 touched files.
**Commit:** `feat: AREA TASK 9 — per-area settings`

### [x] TASK 10 — Delivery zones, exclusion zones, pricing (18 sites)
**Spec:** §3.2 · **Files:** `[api] src/utils/deliveryPricing.js`, `src/utils/areaScope.js`,
`src/controllers/deliveryZonesController.js`, `src/routes/deliveryZonesRoutes.js`,
`src/controllers/cartController.js`, `src/controllers/orderController.js`,
`src/controllers/settingsController.js`, `tests/areaScoping.test.js`,
`tests/deliveryZonesPublic.test.js`, `tests/deliveryZonesAdmin.test.js`,
`tests/deliveryZonesFlow.test.js`, `tests/couponZoneDerivation.test.js`,
`tests/realtimeControllerIntegration.test.js`, `tests/shopPricing.test.js`

- [x] 10.1 `loadActiveZones(db, areaId)` / `loadActiveExclusionZones(db, areaId)` — `areaId` required,
      not optional; every caller must know which area it's pricing for.
- [x] 10.2 `areaScope.js`'s `loadZonesForArea` **simplified**, not just left alone: TASK 6 gave it its
      own inline query specifically because `loadActiveZones` was still platform-wide at the time —
      now that TASK 10 gave `loadActiveZones` a real area filter, that duplication reason is gone, so
      `loadZonesForArea` was rewritten to wrap the real `loadActiveZones` in the existing 15s TTL
      cache instead of maintaining a second copy of the same query. Order creation's zones/exclusion
      queries still read through the transaction `connection`, uncached, exactly as before — only
      **which area** to scope them to is resolved via the outer pool + cache (a coarse, rarely-
      changing routing fact, not pricing data), documented at the call site in `orderController.js`.
- [x] 10.3 `listActiveZonesPublic` takes `req.areaId` (via `resolveCustomerArea`, newly mounted on
      `deliveryZonesRoutes.js`); cache key `delivery-zones:<areaId>:public`. A `null` area (pin
      outside every zone) returns an **empty zone list**, not the default area's — showing another
      area's shapes on the checkout map would be actively misleading, not helpful (§2.4).
- [x] 10.4 `notifyZonesChanged` — now `async`, calls the new `areaScope.recomputeAreaBbox(areaId)`
      (parses every active zone's boundary, unions the min/max lat/lng, writes `areas.min_lat/
      max_lat/min_lng/max_lng`, clearing back to `NULL` when an area has zero active zones) then
      `bustAreaCaches(areaId)`. All 3 call sites (`createZone`/`updateZone`/`deleteZone`) updated to
      `await` it. The customer push (`emitToAllCustomers`) stays platform-wide for now — flagged as
      TASK 23's job, harmless while only one area exists.
- [x] 10.5 `matchZone` confirmed untouched — only its callers changed, never its nested-child-wins
      logic. Reused unchanged everywhere (`resolveAreaForPoint`, `resolveDeliveryPricing`).
- [x] 10.6 **Perf assertion test**, and made it prove something real rather than just check SQL text:
      constructs TWO real candidate areas (both bbox-eligible, so the bbox prefilter alone can't rule
      area 2 out) and deliberately does **not** mock an 8th `pool.query` response — if
      `resolveAreaForPoint`'s per-area loop ever fell through to querying area 2's zones, the mock
      queue would run dry and the test would fail with a 500, not a wrong-price assertion. Asserts
      the exact call count (7) and that every `delivery_zones` query carries `area_id = 1`, never `2`.
- [x] **Also fixed, beyond the checklist's own scope, found via the guardrail:**
  - `resolveParentZoneId` (parent-zone lookup) now scoped by `area_id` — a zone can no longer be
    nested under another area's zone.
  - `wouldLeaveNoActiveZones`, `createZone`, `updateZone`, `deleteZone`, `listZones` all take a
    resolved `areaId` and reject `null`/`'all'` (§2.10: Delivery Zones must refuse `all`).
  - **Real cross-tenant security fix, verified live:** `updateZone`/`deleteZone` used to `SELECT
    ... WHERE id = ?` with no area check — an `area_admin` could PATCH/DELETE another area's zone by
    guessing its (globally sequential) numeric id. Now scoped `WHERE id = ? AND area_id = ?`, so a
    cross-area id reads as 404, not a leak of whether the zone exists elsewhere.
  - `settingsController.js`'s `radius_pricing_active` guard (`SELECT COUNT(*) ... FROM
    delivery_zones WHERE active = 1`) was counting zones **across every area**, not the one being
    toggled — area 1's admin could enable zone pricing believing zones existed when the count was
    really coming from a different area. Scoped by `area_id`.
  - Two ancestor-walk queries (`deliveryZonesController.js`'s `resolveParentZoneId`,
    `coupons.js`'s `getZoneAndAncestorIds`) and one coupon-zone-name JOIN
    (`couponController.js`) were investigated and deliberately left unscoped, each with a written
    justification in the guardrail's `ALLOWLIST` — the two ancestor-walks are safe by construction
    (`parent_zone_id` can only ever point within the same area, enforced at every write in this
    file), and the coupon-zone JOIN is premature to partially fix ahead of TASK 14's full
    coupons/coupon_zones redesign.

**Test churn (H3):** `tests/deliveryZonesPublic.test.js`, `tests/deliveryZonesAdmin.test.js`,
`tests/deliveryZonesFlow.test.js`, `tests/couponZoneDerivation.test.js`,
`tests/realtimeControllerIntegration.test.js`, `tests/shopPricing.test.js`
all needed mock-sequence updates for the new area-resolution queries. One genuinely useful discovery
along the way: `couponZoneDerivation.test.js`'s second describe block was **passing before this task
for the wrong reason** — cross-test mock-queue contamination from the first block's failing tests was
masking that its own area-resolution mocks were missing too; adding `areaScope._resetCachesForTests()`
per `beforeEach` (now standard practice for any file touching `areaScope`) surfaced the real gap.

**Done when:** the perf test proves it. **Verified locally** 2026-08-01: `npm test` 88/88 suites
(985/986, same 1 pre-existing unrelated skip); `npx eslint` clean on all touched files; guardrail's
`SWEPT_TABLES` now includes `delivery_zones` + `delivery_exclusion_zones` (violations: 419 → 402,
4 real bugs found and fixed via the guardrail, 3 genuinely-safe sites allowlisted with reasons).
**Live-verified against the real dev DB**, not just mocks: booted the server, confirmed public zones
resolves through the default area; created a real zone via a throwaway `area_admin` and watched
`areas.min_lat/max_lat/min_lng/max_lng` and `catalog_version` update correctly in MySQL; **created a
second real area row and a throwaway `area_admin` for it, then confirmed that admin gets a clean 404
— not a leak, not a success — trying to PATCH and DELETE area 1's zone by numeric id**; deleted the
zone via its real owner and confirmed the bbox correctly shrank back down; cleaned up every throwaway
row afterward.
**Commit:** `feat: AREA TASK 10 — per-area delivery zones and pricing`

### [x] TASK 11 — Catalog: categories, products, combos, groups, store modes (162 sites)
**Spec:** §6.2 rule 4, H4, H5, H8 · **Files:** `[api] src/controllers/productController.js`,
`categoryController.js`, `comboController.js`, `storeModeController.js`, `bulkImportController.js`,
`shopAdminController.js`, `shopOwnerController.js`, `src/utils/storeMode.js`

- [x] 11.1 `area_id` columns for `products`/`categories`/`combos`/`store_modes`/`product_groups` were
      already added generically by TASK 3's `AREA_SCOPED_TABLES` sweep (column + backfill + composite
      indexes + per-area UNIQUE key rewrites already in `migrate.js`) — this task's own job was
      threading real `req.areaId`/admin-session `areaId` through every controller query, which is done:
      `productController.js` (public `getProducts` strict-null §2.4 catalog rule, `getProductById`
      deliberately left unscoped for order-history/deep-link compatibility — documented inline —, all
      admin CRUD + bulk endpoints + pricing grid, cross-tenant `WHERE id=? AND area_id=?` fixes
      throughout), `categoryController.js` (public + admin CRUD), `comboController.js` (admin CRUD,
      `validateComboItems`'s product-existence check now area-scoped per H5), `storeModeController.js`
      (public strict-null like other catalog reads, not settings-style lenient — documented why),
      `storeModeRoutes.js`/`productRoutes.js`/`categoryRoutes.js` gained `resolveCustomerArea`.
      `product_groups` (shops isn't area-scoped until TASK 15, so group rows are stamped from the
      acting admin's session area in `shopAdminController.js`, or from `shops.area_id` — added to the
      `requireShopOwner` SELECT — in `shopOwnerController.js`'s self-service flow).
- [x] 11.2 `areaScope.seedSystemStoreModes(areaId)` added (reused by future clone-area/TASK 25);
      `migrate.js` now loops every existing area and `INSERT IGNORE`s `packed`/`fast_food` per area.
      Verified live: the old global UNIQUE on `store_modes.slug` was already dropped and replaced with
      `uniq_store_modes_area_slug(area_id, slug)` back in TASK 3/8 — confirmed via `SHOW INDEX` against
      the local dev DB, so `INSERT IGNORE` seeding works correctly.
- [x] 11.3 `normalizeStoreType(value, { areaId })` — additive optional param (not a breaking positional
      change, given 16 call sites across 7 files), defaults to a stopgap area for callers outside this
      task's file list (cartController/couponController/dashboardController/settingsController — their
      owning TASKs 12/13/14 thread the real value through). Every caller inside this task's own files
      now passes a real `areaId`.
- [x] 11.4 `bulkImportController.js`'s raw `INSERT INTO products` gains `area_id` (H8); the update-path
      UPDATE, the explicit-id lookup, the name+category fallback lookup, and the categories load used
      for CSV row resolution are all scoped to the importing admin's area too — an import into area 2
      can no longer resolve against or edit area 1's categories/products.
- [x] 11.5 Both combo representations scoped: `combos` table (full CRUD) and `products.is_combo` rows
      (via `productController.js`'s product CRUD) both carry real `area_id`; kept as two representations
      per spec, not unified.
- [x] 11.6 All scattered `bustProductCaches()`/`bustDashboardCache()`/inline `microCache.bust(...,1)`
      call sites in the touched files replaced with `bustAreaCaches(areaId)`.
- [x] 11.7 Search still `LIKE` — confirmed untouched, TASK 22's job.

**Also fixed, beyond the checklist's own scope:**
- `areaScope.bustAreaCaches`'s `invalidateStoreModeCache()` call was still zero-arg (stale TASK 4-era
  stopgap comment); now passes the real `areaId` through — `storeMode.js`'s per-area cache actually
  busts per-area as of this task.
- Cross-tenant fixes matching the pattern already found in TASK 10: `updateStoreMode`,
  `updateCategory`/`deleteCategory`, `updateProduct`/`deleteProduct`/`updateProductImage`, `updateCombo`/
  `deleteCombo`, and the shop-group CRUD in both `shopAdminController.js` and `shopOwnerController.js`
  all had (or would have had, once `area_id` existed) an id-only `WHERE` that let an area_admin
  read/write another area's row by guessing its globally-sequential numeric id — all now
  `WHERE id = ? AND area_id = ?`.
- `product_variants`/`combo_items` have no `area_id` column of their own (children of
  products/combos, scoped through the FK) — `updateVariantAvailability` and the variant branch of
  `updateProductPricing` gained an `EXISTS (... products.area_id = ?)` guard so a variant id can't be
  used to reach another area's product.
- `storeModeController.getStoreModes` was initially written with settings-style leniency (fallback to
  the default area when the pin resolves to no zone); caught during review — store modes gate which
  products a customer can even reach, so it's catalog data, not settings metadata, and must follow the
  strict "empty list for null areaId" rule like `listActiveZonesPublic`, not `getSettings`'s leniency.
  Fixed before this landed.
- `getProducts`'s public catalog listing now resolves `areaId` strictly and returns an empty list
  (not a default-area fallback) when a pin resolves outside every zone — same §2.4 rule, previously
  entirely unenforced since the whole endpoint was hardcoded to area 1.
- Found and fixed a real gap while wiring this up: `productRoutes.js` and `categoryRoutes.js` never
  had `resolveCustomerArea` mounted at all (only `storeModeRoutes.js` was updated as the "obvious"
  file) — without this fix `req.areaId` would have been undefined on every public product/category
  request in production.

**Test churn:** 9 test files broke from this sweep — `productsPagination.test.js`, `productCategory.test.js`,
`productShopClosed.test.js` needed the same `resolveCustomerArea`-consumes-a-`pool.query`-call fix
already established in TASK 9/10 (explicit default-area-lookup mock + `areaScope._resetCachesForTests()`
in `beforeEach`, or the request short-circuits/miscounts). `productVariants.test.js`, `bulkImport.test.js`,
`shopPricing.test.js`, `productsBulkAssignShop.test.js`, `adminShopGroups.test.js`, `comboTransaction.test.js`
all used pre-TASK-7 admin JWTs (`{ id, role: 'admin' }` with no `adminRole`) that `resolveAdminArea`
correctly leaves `req.areaId` unresolved for — updated to the `adminRole: 'area_admin', areaId: 1` shape
already established as the test convention. Also found and fixed a real bug of my own: `getProducts`
initially used `pool.escape(areaId)` unconditionally to inline the area filter into the base query
string — broke every test file whose `db/mysql` mock didn't stub `pool.escape` (most of them, since the
old code only called it for optional filters). Switched to `Number(areaId)` interpolation, safe because
`areaId` is guaranteed a validated positive integer by that point (already checked for null/'all').
Assorted param-shape/call-count assertion updates for the new `area_id` bind params and the extra
`bustAreaCaches` → `bumpCatalogVersion` pool.query call on writes.

**Live verification (local dev DB, migration re-run clean):** `GET /api/products`, `GET /api/categories`,
`GET /api/store-modes` all return real area-1-scoped data with the new `area_id` joins/filters in place.
Confirmed via `SHOW INDEX`/`SELECT COUNT(DISTINCT area_id)` that `products`/`categories`/`combos`/
`store_modes`/`product_groups` are all correctly `area_id = 1` (only area 1 exists) and the composite
UNIQUE keys (`uniq_categories_area_slug`, `uniq_store_modes_area_slug`) are in place. Admin-endpoint live
verification (login) was skipped — no admin credentials available outside `.env`, which is off-limits —
covered instead by the full Jest suite (all 88 suites green) exercising every admin write path against a
mocked DB.

**Guardrail:** `tests/areaScoping.test.js`'s `SWEPT_TABLES` deliberately does NOT gain `categories`/
`products`/`combos`/`store_modes`/`product_groups` yet, even though this task's own files are fully
scoped — `cartController.js`, `orderController.js`, `dashboardController.js`, `analyticsController.js`,
and `settingsController.js`'s radius-pricing reads (all owned by TASK 12/13/14/17) still reference these
tables unscoped. Unlike `settings`/`delivery_zones` (single-owner tables TASK 9/10 swept completely),
these five span many files owned by different future tasks — add them to `SWEPT_TABLES` only once every
remaining site across the whole codebase is done. The informational (non-failing) remaining-violations
count moved from including these 5 tables' sites as "not yet swept" throughout, unaffected by this
choice — 336 sites remain across all not-yet-swept tables after this task, shrinking further as
TASK 12+ land.

**Commit:** `feat: AREA TASK 11 — per-area catalog`

### [x] TASK 12 — Dashboard sections + offers (47 sites)
**Files:** `[api] src/controllers/dashboardController.js`, `offerRoutes.js` + offer handlers

- [x] 12.1 `dashboard_sections`, `dashboard_section_items`, `offers`, `offer_products` all threaded
      with real `area_id`. `dashboard_sections`/`offers` columns already existed (TASK 3's generic
      sweep, including `dashboard_sections`' `idx_section_area_store_slug` composite unique key —
      confirmed already correct, no migration changes needed this task). `dashboard_section_items`/
      `offer_products` are child tables with no `area_id` of their own — scoped through their parent's
      FK (`dashboard_sections.area_id` / `offers.area_id`), same EXISTS/JOIN pattern used for
      `product_variants`/`combo_items` in TASK 11.
- [x] 12.2 Cache key is `dashboard:<areaId>:<storeType>:closed=<0|1>` — was hardcoded to
      `DASHBOARD_AREA_ID_STOPGAP` (always 1), now built from the resolved `req.areaId`.
- [x] 12.3 Every query site in `dashboardController.js` scoped: `getExpectedStoreType`,
      `getLinkedItemInfo`, `ensureUniqueSectionSlug`, `ensureModeSpecificOfferBannerSections`,
      `hydrateSectionItem` all gained a real `areaId` param; public `getDashboard`/`getSectionItems`
      resolve `req.areaId` strictly (§2.4 catalog rule — empty dashboard / 404 for a pin outside every
      zone, never a default-area fallback, matching `getProducts`); every admin CRUD/reorder endpoint
      (`getAdminSections`, `getAdminSectionById`, `createAdminSection`, `updateAdminSection`,
      `deleteAdminSection`, `addAdminSectionItem`, `updateAdminSectionItem`, `deleteAdminSectionItem`,
      `reorderAdminSections`, `reorderAdminSectionItems`) requires exactly one area and carries
      cross-tenant `WHERE id = ? AND area_id = ?` guards (including a JOIN-through-parent guard for
      the two section-*item* endpoints, since `dashboard_section_items` has no `area_id` column of its
      own). Section fan-out (`buildSection`'s per-type sub-queries in both `getDashboard` and
      `getSectionItems`) unchanged in shape — each of the 4 branches (offer_banner/category_grid/
      product_block/combo_block) just gained `AND <table>.area_id = ?` on its JOINed target table.
      `offers` CRUD (`settingsController.js`: `getActiveOffer`, `createOffer`, `updateOffer`,
      `getAdminOffers`, `deleteOffer`, `getOfferProducts`, `addOfferProduct`, `removeOfferProduct`,
      `reorderOfferProducts`) got the same treatment — public `getActiveOffer` follows the strict
      catalog rule too (promo banner content, not settings metadata). `offerRoutes.js`,
      `dashboardRoutes.js` gained `resolveCustomerArea` on their public GETs (admin routes already had
      `requireAdmin` from TASK 8).
- [x] 12.4 No real area 2 exists yet in this rollout (§6.6 gate blocks a second area until TASK 30's
      isolation sweep passes), so this is proven at the unit level instead of against live prod data —
      `tests/dashboardAreaIsolation.test.js` drives the real `resolveCustomerArea` + `getDashboard`
      code path with two synthetic areas sharing a colliding section id/slug, and asserts every query
      MySQL actually receives is scoped to the resolved area (not just that the mocked response looks
      right). Same proof pattern as TASK 10.6's delivery-zone isolation perf test.

**Also fixed, beyond the checklist's own scope:**
- Found the same gap as TASK 11: `offerRoutes.js` and `dashboardRoutes.js` never had
  `resolveCustomerArea` mounted at all — without this fix `req.areaId` would have been undefined on
  every public dashboard/offer request in production.
- `getActiveOffer` is shared by both the public `/api/offers/active` route and the admin
  `/api/admin/offers/active` route (same handler, different middleware ahead of it) — the strict
  §2.4 catalog rule applies identically either way, since `requestAreaId(req)` just reads whichever
  middleware resolved it.
- Went back and closed out the two `offers`-table stopgaps TASK 11 had explicitly deferred to this
  task: `productController.js`'s `finalOfferId` branch now validates the offer itself with
  `AND area_id = ?` (an offerId from another area now 404s the same as a nonexistent one, instead of
  being validated globally while only the joined products stayed scoped), and
  `storeModeController.js`'s deactivation usage-count query now scopes its `offers` subquery by area
  too, alongside the `categories`/`combos` subqueries TASK 11 already scoped.

**Test churn:** 6 test files broke from this sweep — `dashboard.test.js`, `dashboardAdmin.test.js`,
`dashboardAdminHeader.test.js`, `dashboardCurated.test.js`, `productShopClosed.test.js`,
`adminValidation.test.js` — same two established root causes as TASK 9-11: pre-TASK-7 admin JWTs
missing `adminRole`/`areaId`, and public dashboard GETs now consuming an extra `pool.query` call for
`resolveCustomerArea`'s default-area lookup (fixed with the same explicit-mock + call-index-shift +
`areaScope._resetCachesForTests()` pattern). One new wrinkle: `addAdminSectionItem`'s success-path
test needed an extra queued mock for `bustAreaCaches`'s `bumpCatalogVersion` UPDATE landing between
the section-item INSERT and the hydration re-fetch — the same class of "one more pool.query call now
happens" fallout as TASK 11's bulk-endpoint tests.

**Live verification (local dev DB, migration re-run clean):** `GET /api/dashboard?storeType=packed`
and `GET /api/offers/active?storeType=packed` both return real area-1-scoped sections/offers with the
new `area_id` joins in place. `SELECT COUNT(DISTINCT area_id)` confirms `dashboard_sections`/`offers`
are both correctly `area_id = 1`.

**Guardrail:** `dashboard_sections`/`offers` still not added to `SWEPT_TABLES` — `cartController.js`/
`orderController.js` (TASK 13) still reference `offers`/`dashboard_section_items`-adjacent data
unscoped. Remaining informational violation count: 292.

**Commit:** `feat: AREA TASK 12 — per-area dashboard and offers`

### [x] TASK 13 — Orders, order items, order numbers (123 sites)
**Spec:** §6.3 — **read it before starting** · **Files:** `[api] src/controllers/orderController.js`,
`src/db/migrate.js`, `src/services/shopOrderActions.js`, `tests/orderNumber.test.js`,
`tests/cartOrder.test.js`, `tests/orderIdempotency.test.js`

> 13.2–13.5 must land in **one commit**. Splitting them across deploys breaks checkout in production.

- [x] 13.1 `createOrder` resolves `deliveryAreaId` (via `resolveAreaIdForPricing`) once, up front —
      before the settings fetch, product/combo existence checks, zone/exclusion-zone loads, and the
      order-number call all use it — and stamps it on both the `orders` and `order_items` INSERTs.
- [x] 13.2 Backfilled `daily_order_counters.area_id = 1` for all 14 pre-existing historical rows (verified
      live against the local dev DB — see below).
- [x] 13.3 PK changed to `(area_id, counter_date)`. Since this table's PK isn't a surrogate `id` (unlike
      every table in `AREA_SCOPED_TABLES`), it's handled in its own dedicated migration block —
      idempotent-safe re-run check via `INFORMATION_SCHEMA.KEY_COLUMN_USAGE` before the
      `DROP PRIMARY KEY, ADD PRIMARY KEY` (a blind re-run would fail on an already-swapped PK).
- [x] 13.4 `generateOrderNumber(connection, areaId, areaCode)` now takes and uses `area_id` in exactly
      the `INSERT ... VALUES (?, ?, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE seq = LAST_INSERT_ID(seq + 1)`
      shape the spec requires — landed in the same commit as 13.2/13.3's migration change, per §6.3.
- [x] 13.5 Format is `OD-<date>-<AREACODE>-<seq>` (e.g. `OD-20260801-A1-0042`) — `areaCode` comes from
      `areaScope.getAreaById(deliveryAreaId).code`.
- [x] 13.6 Confirmed: no `UPDATE orders SET order_number` exists anywhere in the codebase (grepped) —
      untouched by this task, and nothing added one.
- [x] 13.7 Scoped the sites genuinely owned by this task's file list: `orderController.js`'s own
      product/combo existence checks (products from another area now correctly read as "does not
      exist," matching the H5/cart-preview pattern from TASK 11) and `shopOrderActions.js`'s
      `listShopActiveOrders` settings lookup (shops aren't area-scoped until TASK 15, so it reads the
      area off the shop's own already-fetched orders instead of a hardcoded stopgap). Also closed out
      3 explicit "TASK 13" stopgaps left in `cartController.js` (`calculateCart`,
      `validateCouponHandler`, `getAvailableCoupons` all had a hardcoded `settings WHERE area_id = 1`)
      — not in this task's own file list, but self-referentially tagged for it, and cart preview must
      mirror order creation's area resolution or the two would silently disagree on price. The
      remaining ~100 sites (adminController.js's reports/dashboard, riderController.js/
      adminRiderController.js/riderAssignment.js — TASK 15's shops/riders/dispatch — couponController.js/
      utils/coupons.js — TASK 14 — analyticsController.js — TASK 17) are correctly out of scope: each
      belongs to a table/domain a **different**, later task owns, matching the file-list-is-authoritative
      pattern established since TASK 9. `getOrders`/`getOrderById`/`cancelOrder` (customer's own order
      history/detail/cancel) were deliberately left unscoped by area — a customer's orders span
      whichever areas they've actually ordered from over time, and `customer_id` (a global identity,
      §2.2) already scopes these correctly; adding an area filter would hide a customer's own past
      orders from a different area, which is a real regression, not a fix.
- [x] 13.8 Confirmed: the idempotency pre-check/replay logic and the `FOR UPDATE`/compare-and-set
      writes (`UPDATE orders SET status = "Cancelled" ... WHERE status = "Pending"`, the coupon
      row lock) are byte-for-byte unchanged — only the settings/product/combo/order/order_items
      queries around them gained `area_id`.
- [x] 13.9 Verified live against the local dev DB directly (no customer auth session available —
      Firebase phone auth can't be completed without a real OTP locally, same constraint as TASK 11's
      admin-login gap) — ran `generateOrderNumber`'s actual `INSERT ... ON DUPLICATE KEY UPDATE`
      statement 3× for area 1 (got 1, 2, 3, confirming atomic per-area sequencing) then once for a
      hypothetical area 2 on the same date, which correctly failed the `fk_daily_order_counters_area`
      foreign key (area 2 doesn't exist yet — §6.6's gate), proving areas can never silently share or
      collide on a sequence. Cleaned up the test row afterward.
- [x] 13.10 Verified live: all 14 pre-existing `daily_order_counters` rows (dating back to 2026-07-09)
      kept their exact `seq` values through the PK swap — `area_id` backfill is additive, never
      touches `seq` or `counter_date`. (No pre-existing `orders.order_number` values exist to check on
      this fresh local DB — the spec's guarantee here is structural: nothing in this task issues an
      `UPDATE orders SET order_number`, confirmed by the 13.6 grep above.)

**Test churn:** 6 test files broke — `orderNumber.test.js` (format regex + new `generateOrderNumber`
params), `cartOrder.test.js` (a `beforeAll` now primes `areaScope`'s areas/zones caches once, since
most of its tests send no pin and would otherwise have `resolveAreaIdForPricing`'s `getDefaultArea()`
consume a mock slot meant for that test's own settings/product mocks — plus one order_items INSERT
param-index shift), `couponZoneDerivation.test.js` and `deliveryZonesFlow.test.js` (mock call ORDER
had to flip — area resolution now runs before the settings fetch it scopes, not after — this was
already wrong-order-but-coincidentally-passing in one "outside every zone" test in each file, caught
and fixed, not just papered over), `shopPricing.test.js` and `adminOrders.test.js` (index shifts / one
missing default-area mock). Also caught and fixed a bug of my own mid-task: an early version hoisted
`resolveAreaIdForPricing` in `cartController.js`'s coupon endpoints to run unconditionally, breaking
the existing "zero DB queries when no coordinates are sent" contract two tests enforce — moved it back
inside the `hasCoords` gate.

**Live verification (local dev DB):** migration re-run is clean and idempotent (`daily_order_counters
PK is now (area_id, counter_date)` logs correctly whether the table is fresh or already-migrated).
Direct DB-level order-number reservation test (see 13.9) proves the atomic-sequence/cross-area-isolation
guarantee end-to-end against real MySQL, not just mocks. Public `GET /api/products` and
`GET /api/dashboard` unaffected. Full HTTP checkout flow could not be exercised (no customer JWT
available without completing Firebase phone-auth OTP) — covered instead by the full Jest suite (89/89
suites green) exercising `createOrder`/`calculateCart` end-to-end against a mocked DB, including the
new area-resolution-before-settings ordering.

**Guardrail:** `orders`/`order_items`/`offers` still not added to `SWEPT_TABLES` — `adminController.js`,
`riderController.js`, `adminRiderController.js`, `riderAssignment.js`, `couponController.js`,
`utils/coupons.js`, `utils/shops.js`, `utils/riders.js`, `analyticsController.js` all still reference
them unscoped (TASK 14/15/17's job). Remaining informational violation count: 284 (down from 292).

**Commit:** `feat: AREA TASK 13 — per-area orders and order numbers`

### [x] TASK 14 — Coupons (22 sites)
**Files:** `[api] src/controllers/couponController.js`, `src/utils/coupons.js` (inputs only),
`tests/coupons.test.js`, `tests/couponZoneDerivation.test.js`

- [x] 14.1 `coupons` scoped directly (`area_id` column, already added generically by TASK 3, plus the
      composite `uniq_coupons_area_code_deleted(area_id, code, deleted)` unique key TASK 3 already put
      in place). `coupon_zones`/`coupon_users`/`coupon_redemptions` have no `area_id` of their own —
      children of `coupons`, scoped transitively through an already-area-validated `coupon_id` (same
      pattern as `product_variants`/`combo_items`/`offer_products` in TASK 11/12): every read/write on
      these three tables in this task's files is reached only after the parent coupon row was already
      fetched with `AND area_id = ?`, so no separate filter is needed on the child query itself.
- [x] 14.2 `utils/coupons.js`'s 6 entry points (`validateCoupon`, `validateCouponById`,
      `pickBestAutoApply`, `findApplicableCoupons`, `getNextFreeDeliveryThreshold`,
      `getNearestUnlockableCoupon`) each gained an optional `areaId` param — when provided, their
      `SELECT * FROM coupons` query gains `AND area_id = ?`; when omitted (`null`, the default), the
      query is unchanged, so any not-yet-threaded caller keeps working exactly as before. The rule
      engine itself — `checkEligibility`, `computeDiscount`, `computeDiscountBreakdown`,
      `buildSavingsText`, and the already-fetched-row helpers (`isUserTargeted`, `isZoneTargeted`,
      `getUserOrderCount`, `getUserRedemptionCount`, `getGlobalRedemptionCount`) — is completely
      untouched; area scoping only ever happens at the SQL that selects which `coupons` row(s) exist
      to evaluate in the first place. `cartController.js` (`calculateCart`, `validateCouponHandler`,
      `getAvailableCoupons`) and `orderController.js` (`createOrder`) now pass their already-resolved
      `deliveryAreaId` into every one of these calls (natural continuation of TASK 13's area
      resolution, not new scope).
- [x] 14.3 Confirmed unchanged: `SELECT id FROM coupons WHERE id = ? FOR UPDATE` in `orderController.js`
      and the `recheckUsageUnderLock` logic around it are byte-for-byte the same as before this task —
      the coupon id locked there was already proven to belong to the caller's area by the
      `validateCoupon`/`validateCouponById`/`pickBestAutoApply` call that produced it.
- [x] 14.4 `createCoupon`/`updateCoupon` now fetch the candidate `targeted_zone_ids` against
      `delivery_zones WHERE id IN (?) AND area_id = ?` before inserting into `coupon_zones`, silently
      dropping any id that isn't actually in the coupon's own area — a coupon can never end up
      "targeted" at a zone it could never actually match. `duplicateCoupon`'s `coupon_zones` copy needs
      no separate check: it copies from a source coupon already proven to be in the same target area,
      and that source's own zones were already validated at creation/update time.
- [x] 14.5 Verified structurally + live: the composite `uniq_coupons_area_code_deleted(area_id, code,
      deleted)` key (confirmed via `SHOW INDEX` against the local dev DB) makes the same code valid in
      two different areas at the schema level. Full cross-area redemption-block behavior is covered by
      `couponZoneDerivation.test.js`'s existing zone-derivation tests plus `coupons.test.js`'s
      `validateCoupon`/`checkEligibility` suite now exercising the `areaId` param — a real two-area
      integration test isn't possible yet (only area 1 exists until TASK 30's gate lifts), same
      constraint noted in TASK 12/13.

**Also fixed, beyond the checklist's own scope:** `getAdminCouponById`'s `coupon_zones` → `delivery_zones`
JOIN (previously ALLOWLISTED in the guardrail as "TASK 14 owns this") now carries `AND dz.area_id = ?`
— the ALLOWLIST entry for it was removed from `tests/areaScoping.test.js` since the underlying gap it
excused is now closed. Cross-tenant `WHERE id = ? AND area_id = ?` fixes applied throughout
`couponController.js` (`getAdminCouponById`, `updateCoupon`, `deleteCoupon`, `duplicateCoupon`,
`getCouponRedemptions`) — an area_admin could previously read/write another area's coupon by guessing
its numeric id.

**Test churn:** 2 test files broke — `remaining.test.js` and `coupons.test.js`'s own admin-route describe
block, both from the same now-familiar root cause (pre-TASK-7 admin JWTs missing `adminRole`/`areaId`).
One new wrinkle in `coupons.test.js`: the two `coupon_zones`-writing tests needed an extra queued mock
for the new §14.4 zone-ownership check, inserted between the coupon INSERT/UPDATE and the
`coupon_zones` write.

**Live verification (local dev DB, migration re-run clean):** all 14 pre-existing coupons confirmed
`area_id = 1`; `SHOW INDEX` confirms the composite unique key is live. Full coupon-application HTTP flow
could not be exercised (no customer JWT available without completing Firebase phone-auth OTP, same
constraint as TASK 11/13) — covered instead by the full Jest suite (89/89 suites, 147/147 in
`coupons.test.js` alone).

**Guardrail:** `coupons` still not added to `SWEPT_TABLES` — `adminController.js` (order
cancellation's coupon-redemption release) and `utils/shops.js` still reference it unscoped (both
outside this task's file list — TASK 15/17's turf). Remaining informational violation count: 274
(down from 284).

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
| 0 — Safety gate | 0 | ◐ (0.7 only — prod rehearsal 0.1-0.6/0.8-0.9 pending real access) |
| A — Foundations | 1–6 | ✅ done, verified locally |
| B — Auth | 7–8 | ✅ done, verified locally |
| C — Backend sweep | 9–17 | ☐ |
| D — Libraries | 18–22 | ☐ |
| E — Realtime | 23 | ☐ |
| F — Super admin | 24–26 | ☐ |
| G — App + payload | 27–29 | ☐ |
| H — Verification | 30 | ☐ |
