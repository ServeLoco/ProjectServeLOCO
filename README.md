# VillKro

A monorepo for the VillKro grocery / food delivery platform — API, customer app, and admin panel.

## Structure

```
villkro/
├── apps/
│   ├── api/            Node.js + Express REST + Socket.IO backend
│   ├── customer-app/   React Native (Expo) iOS + Android app
│   └── admin/          React + Vite admin panel
├── docs/               Project documentation
└── plans/              Design docs, audits, deployment plans
```

Each `apps/*` folder is a self-contained, independently deployable project. The `apps/api/Dockerfile` and `apps/admin/Dockerfile` are independent build contexts.

## Quick start

### One-command development (recommended)

From the repo root (after installing dependencies in each `apps/*` project once):

```bash
npm run dev          # local API + admin + customer app
```

- API: http://localhost:3000
- Admin: http://localhost:5173
- Customer app: Expo starts and prints the QR / metro URL

Requirements for `npm run dev`:
- Local MySQL on `localhost:3306`
- Local MongoDB on `localhost:27017`
- `apps/api/.env.development` already contains local-only values

The script preflights both databases and fails fast with a clear message if either is not reachable.

### Production-DB verification mode

```bash
npm run dev:proddb
```

This runs the **local API code** against the production Azure MySQL + Atlas Mongo databases (-values are read from `apps/api/.env.proddb`), while the Admin and Customer app still run locally. It asks for confirmation before starting; pass `--yes` to skip the prompt.

**Use this only for final pre-push smoke testing.** Never migrate or seed production from this command.

### Manual start

If you prefer to start projects individually:

```bash
# Backend
cd apps/api
npm run dev          # http://localhost:3000

# Admin panel
cd apps/admin
npm run dev          # http://localhost:5173

# Customer app (Expo)
cd apps/customer-app
npx expo start
```

## CI

- `.github/workflows/ci.yml` — API tests + lint
- `.github/workflows/ci-admin.yml` — Admin lint + build

## Deployment

See [`plans/deploymentfinallast.md`](./plans/deploymentfinallast.md) for the full step-by-step deploy plan.
