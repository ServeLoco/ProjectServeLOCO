# Area Rollout Runbook

Release and rollback runbook for the multi-area migration
(`feat/multi-area-super-admin` → `main`). Every step below was actually run
this session against a real copy of pre-multi-area data — not assumed. Two
separate releases, an explicit go/no-go gate, and a rollback procedure that
has actually been checked to work, including the reason a code-only revert
is unsafe.

---

## 00 — Before Anything

A real single-area database (`main`'s own `seed_demo.js` shape: 1 customer, 6
orders across every status, 6 coupons) was migrated forward this session,
verified byte-for-byte intact afterward, then a second area was added on top
and Area 1 was re-checked untouched. Where this doc says "verified," that
means it was actually done, not planned.

**Confirmed this session — the migration is safe on real pre-existing data.**
Row counts and specific values (customer name/phone, all 6 order totals, the
product price, all 6 coupon codes) were captured before migrating and
compared after — zero loss, zero duplication, every row correctly backfilled
to `area_id = 1`.

**Confirmed this session — code-only rollback is unsafe once the migration
has run.** `main`'s own `productController.js` inserts
`INSERT INTO products (name, price, ...)` — no `area_id`. Post-migration,
that column is `NOT NULL` with no default. Redeploying old code against the
new schema means the first product/order/shop creation crashes with
`ER_NO_DEFAULT_FOR_FIELD`. See §05.

---

## 01 — Release A: Prep

Release A ships the multi-area *infrastructure* only — one area, behaving
identically to today. No second area exists yet. This is the release that
has to be boring.

### 1.1 — Full backup, before touching anything

```bash
mysqldump -h <prod-host> -u <user> -p --single-transaction \
  --routines --triggers serveloco > \
  serveloco_pre_area_$(date +%Y%m%d_%H%M).sql
```

This is the one artifact everything else depends on. The migration adds
`NOT NULL` constraints and rewrites composite keys — a one-way schema door,
confirmed directly this session. There is no scripted down-migration for it
(§05). The backup *is* the rollback mechanism.

### 1.2 — Verify the backup actually restores

A backup nobody has restored is a hope, not a plan.

```bash
mysql -u root -e "CREATE DATABASE serveloco_restore_check;"
mysql -u root serveloco_restore_check < serveloco_pre_area_*.sql
mysql -u root serveloco_restore_check -e "SELECT COUNT(*) FROM orders;"
# compare against production's live count — must match exactly
```

### 1.3 — Rehearse the migration against a copy of the backup, not an empty database

> **Do not skip this.** Testing `migrate.js` against a fresh/empty database
> this session surfaced a real, pre-existing bug on `main` itself:
> `ensureIndex('dashboard_section_items', ...)` runs before that table is
> created, so a truly empty install fails outright. It never fires against a
> database that already has the table — which every real production/staging
> database does — but it means an empty-DB test is not a valid rehearsal.
> **Rehearse against a restored copy of the real backup**, exactly as done
> here.

```bash
cd apps/api
APP_ENV=development NODE_ENV=development MYSQL_DATABASE=serveloco_restore_check \
  node src/db/migrate.js
# watch for the exact tail below — this is the success signature
```

Expected final log lines:

```
[migrate] area_id column present (nullable) on all scoped tables.
[migrate] area_id backfilled to Area 1 on all scoped tables.
[migrate] area_id orphan check passed on all scoped tables.
[migrate] area_id set NOT NULL on all scoped tables.
[migrate] area_id foreign keys added on all scoped tables.
[migrate] area_id composite indexes added.
[migrate] per-area unique keys in place.
[migrate] users.last_area_id backfilled from order history.
Migration and seeding completed successfully!
```

### 1.4 — Capture the same before/after snapshot on the rehearsal copy

Not a formality — this is exactly the check that caught the backfill working
correctly this session. Run before migrating and again after; every value
below must be identical except the new `area_id`/`last_area_id` columns.

```sql
SELECT id, name, phone, address FROM users ORDER BY id LIMIT 20;
SELECT id, order_number, customer_id, subtotal, total, status FROM orders ORDER BY id;
SELECT id, name, price FROM products ORDER BY id LIMIT 20;
SELECT id, code, discount_type, discount_value FROM coupons;
```

### 1.5 — Confirm the production database engine

A MariaDB-specific quirk surfaced repeatedly in local testing: a
self-referencing foreign key add on `delivery_zones` reports a spurious
duplicate-key error (InnoDB errno 121) that real MySQL reports differently.
The migration's own error handling already tolerates both shapes — nothing
to do here except confirm production runs real MySQL (per
`docker-compose.prod.yml`, it's Azure Database for MySQL), so this is a
non-issue in production and only ever bit local dev.

---

## 02 — Release A: Deploy

The production stack (`docker-compose.prod.yml`) is a single-container
restart per service, not a rolling deploy — confirmed this session. There is
no window where old server code runs against the already-migrated schema;
the container fully stops, then the new one (which runs the migration
automatically via `npm start`) comes up.

### 2.1 — Announce a short maintenance window

The restart itself is brief (container rebuild + migration run, which
completed in well under a minute against realistic data volumes this
session), but announce it — a live order mid-checkout during the restart is
the one real risk of this step, not the migration itself.

### 2.2 — Deploy

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

### 2.3 — Watch the migration run live

```bash
docker compose -f docker-compose.prod.yml logs -f api
```

Confirm the exact same success-signature lines from §1.3 appear. If the
process exits non-zero instead, **do not proceed to §03** — go straight to
§05.

---

## 03 — Release A: Verify

This is the exact check performed this session against a real migrated
(non-test) dataset — pick one real, known customer and confirm nothing about
their experience changed.

### 3.1 — A real customer's order history still resolves

```bash
curl -H "Authorization: Bearer <real customer token>" \
  https://api.serveloco.app/api/orders?limit=10
```

Check: same order count, same totals, same statuses as pre-deploy — each row
now additionally carries `area_id: 1`.

### 3.2 — Cart calculation with no pin still resolves via the customer's backfilled area

```bash
curl -X POST https://api.serveloco.app/api/cart/calculate \
  -H "Authorization: Bearer <real customer token>" \
  -H "Content-Type: application/json" \
  -d '{"items":[{"product_id": <a real product id>, "quantity": 1}]}'
```

Check: `deliveryWithinRange: true`, correct subtotal/delivery charge — same
numbers a customer would have seen before this deploy.

### 3.3 — Admin login still works, on the real credentials already in use

The env-bootstrap super-admin path (`ADMIN_OWNER_ID`/`ADMIN_PASSWORD`) is
untouched and verified this session to keep working after migration. Confirm
a real admin can still log in and load the dashboard.

### 3.4 — Placing a brand-new order still works end-to-end

Use a real (or disposable staging) account, not the demo fixture. Confirm
the order is created, the order number now carries the area code segment
(`OD-YYYYMMDD-A1-NNNN` instead of the old bare format — confirmed
cosmetic-only, no live app code parses this string), and it appears
correctly in the admin panel.

---

## 04 — Go / No-Go

**Go — proceed to the observation window** when:
- Migration log shows the full success signature from §1.3, no errors
- §3.1–3.4 all pass against real data
- No unexpected 500s in the API logs in the first 10 minutes post-deploy

**No-go — roll back immediately, do not attempt a fix forward** when:
- Migration process exited non-zero, or the success-signature lines are
  missing/incomplete
- Any of §3.1–3.4 fails against real customer data
- The API container is crash-looping

Go straight to §05. Do not try to patch the running system — the
backup-and-restore path is the only rollback verified this session; anything
improvised live is not.

---

## 05 — Rollback

**Why code alone can't be the rollback.** Confirmed directly against
`main`'s source this session: `productController.js`'s `INSERT INTO
products` has no `area_id` column. After this migration, that column is
`NOT NULL` with no default (verified: the identical failure shape —
`ER_NO_DEFAULT_FOR_FIELD` — was hit and fixed in this branch's own seed
script during testing). Redeploying `main`'s code against the migrated
schema means the very next product, order, or shop creation crashes. There
is no scripted down-migration in this branch to undo the schema half of
this.

### 5.1 — Stop the current containers

```bash
docker compose -f docker-compose.prod.yml down
```

### 5.2 — Restore the §01 backup, in full

```bash
mysql -h <prod-host> -u <user> -p serveloco < serveloco_pre_area_<timestamp>.sql
```

This is a full restore, not a partial undo — anything written to the
database between the §02 deploy and this restore is lost. That window is
exactly what §06's observation period exists to keep small.

### 5.3 — Redeploy the pre-migration code, matched to the restored schema

```bash
git checkout main
docker compose -f docker-compose.prod.yml up -d --build
```

### 5.4 — Re-run §3.1–3.4 against the restored system

Same checks, same expectation: everything works exactly as it did before
this release was ever attempted.

> **Considered and deliberately not built:** a hand-written down-migration
> (drop the new `NOT NULL` constraints, drop `areas`/`admins`, restore the
> old indexes) would avoid the data-loss window entirely, but it doesn't
> exist in this branch and would need the same testing rigor as the
> up-migration before it could be trusted. For a single go/no-go release,
> backup-and-restore is simpler and already proven — see §00. Worth building
> only if this rollback path is expected to be exercised more than once.

---

## 06 — Observation Window Before Release B

Release A must sit in production, alone, for a real window before Area 2 is
even considered — a multi-day minimum, not a same-day green light. The
entire point is that if something in the area-scoping infrastructure itself
is subtly wrong, it surfaces against one area's real traffic, before a
second region's worth of real business (shops, riders, customer data)
exists to get tangled in it.

**What to watch:**
- Error rate on `POST /api/orders` and `POST /api/cart/calculate` — no new
  class of failure vs. pre-deploy baseline
- Rider dispatch logs — offers still being created and accepted normally
  (`[rider-assign] offer created` lines, no unexplained `waiting for riders`
  stalls)
- Admin panel — every existing page still loads and edits correctly for the
  one real area
- Nothing new resembling `ER_NO_DEFAULT_FOR_FIELD` or `ER_INVALID_DEFAULT`
  in the API logs — the exact signature of an area-scoped insert that
  forgot the column

---

## 07 — Release B: Adding Area 2

A deliberate, later action — never bundled with Release A, and never done by
re-running a seed script against production. Area 1's row must only ever be
**read** during this step, never written — confirmed this session that a
seed-script convenience (renaming Area 1 and giving it a test bounding box)
is exactly the kind of touch that must *not* happen for real: the real Area
1's name, geography, and settings stay exactly as they are.

### 7.1 — Create the new area via the real admin API, not a script

`POST /api/admin/areas` as `super_admin` — purely additive, a new row only.

### 7.2 — Onboard its admin, shops, catalog, riders

Through the real admin panel flows this session's code review already
verified are correctly area-scoped for writes.

### 7.3 — Re-run the exact independence checks verified this session

| Check | What it caught this session | Status |
|---|---|---|
| New area's own pricing/coupons apply, not Area 1's | Original test data used identical values under different codes — proved isolation, not independence, until values were made deliberately different | VERIFIED |
| Rapid alternating requests between areas never bleed a cached value | This codebase has had cache-namespacing bugs before (settings cache, area cache) — six alternating requests, zero bleed | VERIFIED |
| A pin genuinely outside every area's territory is rejected, not defaulted | A real bug found and fixed this session — a narrower version of the original cross-area contamination bug | VERIFIED (fixed) |
| Area-scoped admin reads 404 (not 403) across areas | No existence leak — confirmed live, including that a forged JWT claim is ignored in favor of the real DB row | VERIFIED |

---

## 08 — Known Issues: Resolve Before Release B, Not Release A

None of these block Release A (single area behaves exactly as today
regardless). All of them matter once a second area's real business
decisions are on the line.

| Issue | Why it matters for Area 2 | Status |
|---|---|---|
| Super-admin scope: full read/write across every area vs. the newer spec's read-only decision | Two documents, two different owner decisions — not a bug, a product call that hasn't been made once | UNRESOLVED |
| Coupon codes: unique per-area (this branch) vs. globally unique (newer spec) | Already migrated one way — reversing it is another index rewrite on a live table | UNRESOLVED |
| `store_modes`: per-area (this branch) vs. global, super-admin-owned (newer spec) | Same shape of conflict, same cost to reverse | UNRESOLVED |
| `dashboard_section_items` index ordering bug on a from-scratch install | Doesn't affect an upgrade of a real database, but blocks ever rebuilding one from nothing | REAL BUG, low priority |

> **Before Release B specifically:** the three unresolved rows above are
> genuine owner decisions, not engineering tasks — get an explicit call on
> each before Area 2's real shops, riders, and coupons start accumulating
> under whichever behavior happens to already be live.
