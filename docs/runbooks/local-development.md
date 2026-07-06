# Local Development Runbook

The entry-point guide: get the API running on your machine from scratch. Linear and
narrative — for the full command list see [`./commands.md`](./commands.md), for the
migration deep-dive see [`./database-and-migrations.md`](./database-and-migrations.md),
for tests see [`./testing.md`](./testing.md), and when something breaks see
[`./troubleshooting.md`](./troubleshooting.md).

Stack: NestJS 11 + Prisma 7 + PostgreSQL 16 + Redis 7.

## 1. Prerequisites

- **Node `>=22 <23`** (`.nvmrc` pins `22`). With nvm: `nvm use` (or `nvm install`).
- **npm `>=10`** (ships with Node 22).
- **Docker + Docker Compose v2** — the simplest way to run Postgres 16 + Redis 7, and
  **required** for the e2e suite (it spins up ephemeral Postgres via testcontainers).
- **PostgreSQL 16** and **Redis 7** reachable locally. Use Docker (below) or install
  them natively — either works. Redis is required in dev (it backs the rate limiter,
  which is **fail-closed**: no Redis → `503` on throttled routes).

Verify:
```bash
node --version    # v22.x
npm --version     # >=10
docker --version
docker compose version
```

## 2. First-time setup

```bash
git clone <repo-url> accounting-api
cd accounting-api
npm install
```

> `package.json` has an `overrides` block pinning patched transitive deps (`multer`,
> `form-data`, `@hono/node-server`, `js-yaml`). Leave it as-is — it keeps
> `npm audit` clean.
> ⚠️ The `js-yaml` override forces v4 onto `@istanbuljs/load-nyc-config` (which
> declares v3 and uses the removed `safeLoad` API). Harmless while the coverage
> config is `.nycrc.json` — but switching to a `.nycrc.yml` would break
> `npm run test:cov:all` with `yaml.safeLoad is not a function`.

### Environment files

`.env.example` is the annotated template. Create both files dev needs:

```bash
cp .env.example .env
cp .env.example .env.development
```

Edit them and set real values:

| Var | Notes |
| --- | --- |
| `JWT_ACCESS_SECRET` | **≥32 chars**, random. Generate: `openssl rand -base64 48` |
| `JWT_REFRESH_SECRET` | **≥32 chars**, random, **different** from the access secret |
| `DATABASE_URL` | point at a local `accounting_dev` DB, e.g. `postgresql://accounting:accounting@localhost:5432/accounting_dev?schema=public` |
| `REDIS_URL` | `redis://localhost:6379` |
| `POSTGRES_PASSWORD` | used by Docker Compose to provision the `db` container; keep it consistent with `DATABASE_URL` |
| `CORS_ORIGIN` | the frontend origin, e.g. `http://localhost:5173` |

The rest (`PORT`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`) have sane template defaults; the
`# --- Optional ---` block in `.env.example` documents every tunable.

### How the multi-env model works

npm scripts set `NODE_ENV` via `cross-env` (e.g. `start:dev` →
`NODE_ENV=development`). `ConfigModule` then loads **`.env.<NODE_ENV>` first, then
`.env`** — the env-specific file wins, and a real `process.env` value wins over both.
So in dev, `.env.development` is the override layer over the shared `.env` base.

> **Env is validated at boot** (`src/config/env.validation.ts`). Anything missing or
> malformed — short JWT secret, non-numeric `PORT`, absent `DATABASE_URL`, missing
> `REDIS_URL` outside test — **fails fast** with `Invalid environment configuration`.
> Fix the reported field and restart.

Notes on the other environments (you don't create files for these):
- **test** — configured in code (`test/setup-env.ts`) + ephemeral testcontainers. No
  `.env.test`. Redis runs in-memory, so `REDIS_URL` is not required there.
- **production** — env is injected by Docker Compose. No `.env.production`.

## 3. Database bring-up

### Start Postgres + Redis

With Docker (recommended) — the committed compose file already defines both:

```bash
docker compose up -d db redis
```

This starts `postgres:16` (bound to `127.0.0.1:5432`) and `redis:7-alpine` (bound to
`127.0.0.1:6379`), each with a healthcheck. `POSTGRES_PASSWORD` must be set in `.env`
(Compose reads it). The default DB created is `accounting`; if your `DATABASE_URL`
points at `accounting_dev`, create that database (e.g.
`docker compose exec db createdb -U accounting accounting_dev`), or point
`DATABASE_URL` at the default `accounting` DB.

> If you run native Postgres/Redis instead, skip the compose step and just ensure
> `DATABASE_URL` / `REDIS_URL` resolve.

### Apply migrations + generate the client

```bash
npm run db:migrate     # prisma migrate dev (loads .env.development)
npm run db:generate    # prisma generate (Prisma client)
```

`db:migrate` applies all migrations in `prisma/migrations/` to your dev DB. For the
full migration workflow (creating, resetting, the FOR-UPDATE numbering and hand-authored
SQL conventions) see [`./database-and-migrations.md`](./database-and-migrations.md).

### Seed data

There is **no separate seed command for reference data** — the chart of accounts, tax
codes, accounting periods, and company settings are seeded **on app boot** via
`onModuleInit` (`seedIfEmpty`, idempotent and race-safe; it only seeds when the table
is empty). So the first `npm run start:dev` populates them.

The one thing you must create by hand is the **admin user** — the API has **no public
registration endpoint**:

```bash
npm run create-admin -- <email> <password> "<name>"
# e.g.
npm run create-admin -- admin@acme.co 's3cret-pw' "Budi Admin"
```

This hashes the password with argon2 and upserts an `ADMIN`; it loads `DATABASE_URL`
from `.env.development`. Run it after the DB is migrated.

> **`create-admin` is bootstrap-only** — use it once to seed the first ADMIN on a
> fresh database. Day-to-day user administration (creating ACCOUNTANT/APPROVER/
> VIEWER accounts, resetting passwords, deactivating/deleting users, changing
> roles) goes through the API itself: `POST/GET /v1/users`, `GET/PATCH
> /v1/users/:id`, `POST /v1/users/:id/reset-password`, `DELETE /v1/users/:id`
> (all ADMIN-only). See [`../api/frontend-guide.md`](../api/frontend-guide.md).

## 4. Run it

```bash
npm run start:dev      # NODE_ENV=development, nest start --watch
```

The app listens on `PORT` (default `3000`). Business routes are served under **`/v1`**
(URI versioning, default version `1`). Health probes are **version-neutral at the
root** (not under `/v1`).

Confirm it's up:

```bash
curl http://localhost:3000/health    # liveness  -> {"status":"ok"}
curl http://localhost:3000/ready     # readiness -> {"status":"ok","db":"up"}
```

- `/health` is pure liveness (always `200` if the process is up).
- `/ready` checks **Postgres** (`SELECT 1`) and **Redis** (`ping`); a down dependency
  returns **`503`** with a message naming it (`Database unavailable` / `Redis
  unavailable`), not `200`.

**OpenAPI / Swagger UI** is served at **`/docs`** in non-production (dev/test). It's
off in production unless `ENABLE_SWAGGER=true`. There's also a committed snapshot at
[`../api/openapi.json`](../api/openapi.json) and a prose companion at
[`../api/frontend-guide.md`](../api/frontend-guide.md).

Smoke-test login (use the admin you created):

```bash
curl -s -X POST http://localhost:3000/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@acme.co","password":"s3cret-pw"}'
```

## 5. The inner loop

Keep this file as the one-time setup story. For day-to-day work:

- **Full command reference** — [`./commands.md`](./commands.md) (start/build/lint/
  typecheck, `db:*` scripts, `create-admin`, `openapi:export`, etc.).
- **Tests** — [`./testing.md`](./testing.md). Quick: `npm run test` (unit, Jest),
  `npm run test:e2e` (e2e against testcontainers — needs Docker running), and
  `npm run verify` for the full gate (typecheck + lint + unit + e2e w/ coverage).
- **Stuck?** — [`./troubleshooting.md`](./troubleshooting.md).

## 6. You're set up when…

- [ ] `node --version` is `v22.x`; `npm install` completed clean.
- [ ] `.env` and `.env.development` exist with ≥32-char JWT secrets, a dev
      `DATABASE_URL`, and `REDIS_URL`.
- [ ] `docker compose up -d db redis` (or native Postgres+Redis) is up.
- [ ] `npm run db:migrate` and `npm run db:generate` ran without error.
- [ ] `npm run create-admin -- ...` printed `✓ ADMIN ready`.
- [ ] `npm run start:dev` boots without an env-validation error.
- [ ] `curl localhost:3000/health` → `200` and `curl localhost:3000/ready` → `200`.
- [ ] You can `POST /v1/auth/login` with the admin and get tokens back.
- [ ] `npm run test` passes (and `npm run test:e2e` if Docker is running).
