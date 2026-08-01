# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

VillKro (ProjectServeLoco) — a grocery / food delivery platform monorepo. Each `apps/*` folder is a self-contained, independently deployable project with its own `package.json` and Dockerfile; run npm commands from inside the specific app directory.

- `apps/api` — Node.js + Express REST API with Socket.IO realtime (backend for everything)
- `apps/customer-app` — React Native (Expo) iOS/Android customer app
- `apps/admin` — React + Vite admin panel
- `apps/landing` — static landing page
- `plans/` — design docs, audits, and the active work spec (`plans/bugs.md`)
- `deploy/` — nginx configs and AWS deploy assets; `docker-compose.prod.yml` at root

## Commands

### API (`apps/api`)
```bash
npm run dev            # nodemon, APP_ENV=development, http://localhost:3000
npm test               # jest (uses tests/__mocks__; no live DB needed)
npx jest tests/cartOrder.test.js          # single test file
npx jest -t "order status"                # tests matching a name
npm run lint           # eslint
npm run db:migrate:dev # run migrations against dev env
npm run seed           # seed demo data
```

### Admin (`apps/admin`)
```bash
npm run dev      # vite dev server, :5173
npm run build    # production build
npm run lint
```
Admin also has `npm run dev:prod-api` to run the local UI against the production API.

### Customer app (`apps/customer-app`)
```bash
npm start        # expo start (prestart runs scripts/adbReverse.js for Android)
npm run android  # expo run:android
npm test         # jest
```

## Architecture

- **Dual database**: the API uses **MySQL** (primary relational data — products, orders, users) and **MongoDB** together; `apps/api/src/db/index.js` initializes both and both must be healthy. Schema changes go through `src/db/migrate.js`, which runs automatically on `npm start`.
- **API layering**: `routes/ → middleware/ → controllers/ → repositories/ + services/`, with shared logic in `utils/` and request validation in `validators/`. Realtime order events (auto-accept, status pushes) live in `src/realtime/` on Socket.IO; admin subscribes via `socket.io-client`.
- **Response shape is a contract**: many API responses intentionally duplicate fields in both camelCase and snake_case because different clients read different casings. Never remove one of the duplicates or rename response fields.
- **Order integrity**: order creation uses `FOR UPDATE` row locking for coupon redemption and compare-and-set updates on order status/payment (server returns 409 on conflict). Don't weaken these.
- **Coupon engine**: `apps/api/src/utils/coupons.js` is the single rule engine used by both cart preview and order creation; code-required coupons appearing in the offers list is intended behavior.

## Active workflow: plans/multi-area.md

`plans/multi-area.md` is the contract for the multi-area (super admin) expansion — locked decisions, performance/DRY rules, data-safety rules (Area 1 is live in production), and known hurdles. `plans/multi-area-tasks.md` is the execution checklist (31 tasks, 236 subtasks). Read the spec's §2, §3, §4, §6 and §9 before working the checklist; tasks run in order, one commit each formatted `feat: AREA TASK <n> — <short title>`.

## Older workflow: plans/bugs.md

`plans/bugs.md` is an instruction spec of audited bug/security fixes written for an implementing AI. If working from it: follow its rules section literally (do exactly what the task says, run `npm test` in `apps/api` after each backend task, tick checkboxes with a one-line note, one commit per task formatted `fix: TASK <n> — <short title>`, tasks in order, and respect its DO-NOT-TOUCH sections).

## CI

GitHub Actions per app: `ci.yml` (API tests + lint), `ci-admin.yml`, `ci-customer-app.yml`, plus `deploy.yml` and `playstore.yml`. Deployment steps are documented in `plans/deploymentfinallast.md`.

## Subagent routing (`.claude/agents/`)

Route by task shape, cheapest capable model first:

- Plain lookup ("where is X defined", "find usages of Y", "which file has Z") → `finder` (Haiku). No judgment involved — never route a lookup to a pricier agent.
- Reviewing a diff/feature just written ("review this", "check my changes") → `reviewer` (Sonnet). Scope is the changed code only.
- Hard/ambiguous problems only — intermittent bugs, root-cause unclear, security-sensitive design, "how should I structure X" for a new subsystem → `architect` (Opus, high effort). Reserve for genuinely hard cases; an obvious fix from a stack trace does not need architect.

Force a specific agent by name if the automatic route picks wrong. For planning a large feature before writing code: `/model opusplan` (plans on Opus, auto-switches to Sonnet for implementation).
