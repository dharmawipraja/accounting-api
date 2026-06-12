# Multi-Environment Configuration (dev / test / prod) — Design Spec

- **Date:** 2026-06-12
- **Status:** Approved (pending written-spec review)
- **Owner:** budi@maul.is
- **Builds on:** the v1.0.0 accounting API (NestJS 11 + `@nestjs/config` + Prisma 7). Adds script-driven environment selection so each environment uses its own database. No application behavior change beyond config loading.

## 1. Goal & intent

Make the environment (`development` / `test` / `production`) follow the **npm script you run**, with each environment pointing at its **own database** so dev work never touches prod data. The mechanism is explicit and NestJS-idiomatic: scripts set `NODE_ENV`, `ConfigModule` loads the matching `.env.<env>` file, and Prisma CLI commands target the right database via `dotenv-cli`.

## 2. Current state (verified)

- `src/app.module.ts`: `ConfigModule.forRoot({ isGlobal: true, validate })` — **no `envFilePath`**, so it loads the default `.env` and validates against `EnvVars`. The `NodeEnv` enum (`src/config/env.validation.ts`) already has `development | production | test`.
- **dev:** `npm run start:dev` reads `DATABASE_URL` from `.env` (local Docker `db`, database `accounting`).
- **test:** provisioned **in code** — `test/setup-env.ts` sets `NODE_ENV=test` + `PORT` + a placeholder `DATABASE_URL` + JWT secrets directly into `process.env` before modules load; the e2e suite spins up an **ephemeral Postgres per run via testcontainers** and overrides `PrismaService` to point at it. No `.env` file is involved in tests.
- **prod:** the Docker compose files set `NODE_ENV: production` and build `DATABASE_URL` (database `accounting`) directly in each service's `environment:` block, interpolating `${POSTGRES_PASSWORD}`. `@nestjs/config` does not override already-set `process.env`, so **compose env always wins in Docker**.
- **Two consumers of the root `.env`:** (a) the Node app / Prisma CLI, and (b) `docker compose` variable interpolation (`${POSTGRES_PASSWORD}`). The root `.env` must be retained for (b).
- `.env.*` is gitignored except `.env.example`. No Prisma seed file exists (the app seeds chart-of-accounts / tax codes idempotently on boot).

## 3. Decisions (from brainstorming)

- **Test database:** keep testcontainers (disposable, fully isolated). The `test` env means `NODE_ENV=test` selection only; **no `.env.test` file** (test config is provisioned by `setup-env.ts`).
- **Prod runtime:** Docker only. Compose injects `NODE_ENV` + `DATABASE_URL`; **no real `.env.production`** (it would be inert inside containers).
- **Approach:** `NODE_ENV`-driven `envFilePath` + `cross-env` scripts + `dotenv-cli` for Prisma (the explicit option; not `dotenv-flow` and not inline-URL hacks).
- **Dev database name:** `accounting_dev` (distinct from prod `accounting`).
- **New devDependencies:** `cross-env`, `dotenv-cli`.

## 4. Design

### 4.1 Environment selection (script → NODE_ENV → env file)

npm scripts set `NODE_ENV` via `cross-env`; `ConfigModule` resolves the file from it:

- `start`, `start:dev`, `start:debug` → `NODE_ENV=development`
- `start:prod` → `NODE_ENV=production` (Docker also sets it; this keeps a local `node dist/main` run consistent)
- `test`, `test:watch`, `test:cov`, `test:e2e`, `test:e2e:cov` → `NODE_ENV=test` via `test/setup-env.ts`. **These scripts are left unchanged** — `setup-env.ts` remains the single source of `NODE_ENV=test` (no `cross-env` added, to avoid two competing sources).

### 4.2 ConfigModule change (`src/app.module.ts`)

```ts
ConfigModule.forRoot({
  isGlobal: true,
  envFilePath: [`.env.${process.env.NODE_ENV ?? 'development'}`, '.env'],
  validate,
}),
```

- `@nestjs/config` loads the array in order; for a given key the **first file wins**, so `.env.<env>` overrides the shared `.env`.
- Real `process.env` still takes precedence over both files → **Docker/compose env and `setup-env.ts` are unaffected** (no regression to the 152 e2e or the prod deploy).
- The `?? 'development'` default means a bare `nest start` with no `NODE_ENV` still resolves to `.env.development`.

### 4.3 Env files

- **`.env`** — *kept.* Shared base values + the vars `docker compose` interpolates (`POSTGRES_PASSWORD`, and anything else referenced as `${...}` in the compose files). Gitignored.
- **`.env.development`** *(new, gitignored)* — dev runtime: `DATABASE_URL=postgresql://accounting:<pw>@localhost:5432/accounting_dev?schema=public`, plus the other required vars (`NODE_ENV` optional here since the script sets it, `PORT`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`). Overrides `.env`.
- **No `.env.test`** (provisioned in code).
- **No `.env.production`** (Docker injects prod env).
- **`.env.example`** — refreshed to document the convention: what each environment uses (`.env.development` for dev; `setup-env.ts` + testcontainers for test; compose for prod) and the full required-var list.

### 4.4 Dev database

- Dev uses `accounting_dev` in the same local Postgres started by `docker compose up -d db`.
- `npm run db:migrate` (Prisma `migrate dev`) **auto-creates** `accounting_dev` if missing, then applies migrations. No compose change needed to pre-create it.

### 4.5 Prisma per-environment scripts

Prisma CLI has its own `.env` loader (independent of Nest). Add `dotenv-cli` and these scripts to `package.json`:

```jsonc
"db:migrate":  "dotenv -e .env.development -- prisma migrate dev",
"db:reset":    "dotenv -e .env.development -- prisma migrate reset",
"db:studio":   "dotenv -e .env.development -- prisma studio",
"db:generate": "prisma generate"
```

- `prisma generate` is env-agnostic (no DB connection) — no `dotenv` wrapper.
- **Prod migrations unchanged:** the Docker `migrate` service runs `prisma migrate deploy` with compose-injected `DATABASE_URL`.

### 4.6 Script changes (`package.json`)

Wrap the run scripts with `cross-env`:

```jsonc
"start":       "cross-env NODE_ENV=development nest start",
"start:dev":   "cross-env NODE_ENV=development nest start --watch",
"start:debug": "cross-env NODE_ENV=development nest start --debug --watch",
"start:prod":  "cross-env NODE_ENV=production node dist/main"
```

(`openapi:export` and the lint/typecheck/test scripts are unchanged. The test scripts keep relying on `setup-env.ts` for `NODE_ENV=test`.)

## 5. Out of scope / non-changes

- `NodeEnv` enum and `validate()` — already cover all three environments; no change.
- `.gitignore` — `.env.*` already ignored except `.env.example`; `.env.development` is covered.
- Docker compose files — unchanged (they already set `NODE_ENV` + `DATABASE_URL` explicitly).
- The e2e/testcontainers harness — unchanged.
- No `.env.test` / `.env.production` files.
- No secrets committed; per-env files stay gitignored.

## 6. Testing / verification

- `npm run verify` (38 unit + 152 e2e) stays **green** — the test path is unchanged (`setup-env.ts` + testcontainers; `process.env` precedence means the new `envFilePath` array is inert under test).
- `npm run db:migrate` creates + migrates `accounting_dev`; `npm run start:dev` boots and connects to `accounting_dev` (not `accounting`/prod). Confirm via startup logs / a query.
- `docker compose up -d db` + the prod compose still work (root `.env` retained for `${POSTGRES_PASSWORD}` interpolation; compose `environment:` still wins for the app).
- `npm run start` with no prior `NODE_ENV` resolves to `.env.development` (the `?? 'development'` default).

## 7. Risks / notes

- **Don't delete the root `.env`** — `docker compose` needs it for `${POSTGRES_PASSWORD}` interpolation; deleting it breaks `compose up`. It stays as the shared fallback and the compose var source.
- **`cross-env` on Unix is optional** but included for portability and a uniform script style; an inline `NODE_ENV=… ` would also work on macOS/Linux.
- **`dotenv-cli` binary is `dotenv`** — scripts invoke `dotenv -e <file> -- <cmd>`.
- If a future need arises to run the app manually in `test` mode (outside the suite), add a `.env.test` then; today it is intentionally omitted (YAGNI).
