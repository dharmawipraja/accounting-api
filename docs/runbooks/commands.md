# Commands Runbook (every tool in the project)

The comprehensive reference for **every command in the project**. The canonical
source is `package.json` → `scripts`; every script there is documented below
verbatim, grouped by purpose. Run all `npm run …` commands from the repo root.

Related runbooks:
[`./local-development.md`](./local-development.md) ·
[`./testing.md`](./testing.md) ·
[`./database-and-migrations.md`](./database-and-migrations.md) ·
[`./deploy.md`](./deploy.md) ·
[`./troubleshooting.md`](./troubleshooting.md)

## TL;DR

| Goal | Command |
| --- | --- |
| Run dev server (watch) | `npm run start:dev` |
| Pre-merge gate (the one to run before pushing) | `npm run verify` |
| Apply a migration locally | `npm run db:migrate` |
| Unit tests | `npm test` |
| e2e tests (needs Docker) | `npm run test:e2e` |
| Create the first/only user | `npm run create-admin -- <email> <pass> "<name>"` |
| Build for prod | `npm run build` |
| Production deploy | `docker compose …` (see [`./deploy.md`](./deploy.md)) |

> **Engines** (`package.json`): Node `>=22 <23`, npm `>=10`. Use Node 22 or
> scripts may behave unexpectedly.

---

## Develop & run

| Script | Command | What it does |
| --- | --- | --- |
| `start` | `cross-env NODE_ENV=development nest start` | One-shot dev start (no watch). |
| `start:dev` | `cross-env NODE_ENV=development nest start --watch` | Dev server with hot reload. **Use this for day-to-day development.** |
| `start:debug` | `cross-env NODE_ENV=development nest start --debug --watch` | Same as `start:dev` plus the Node `--inspect` debugger (attach on `localhost:9229`). |
| `start:prod` | `cross-env NODE_ENV=production node dist/src/main` | Runs the **compiled** app from `dist/src/main(.js)`. |

**Prerequisites (all `start*` variants):**
- **Postgres** reachable at `DATABASE_URL` (dev: `accounting_dev` DB — see
  `.env.development`).
- **Redis** reachable at `REDIS_URL` in dev/prod. The rate limiter is
  **fail-closed**: without Redis, throttled routes return `503` even though the
  process is "up". (In `test`, throttling is in-memory and Redis is not needed.)
- `start`/`start:dev`/`start:debug` set `NODE_ENV=development`, which makes
  `ConfigModule` load `.env.development`. `start:prod` sets `NODE_ENV=production`
  and does **not** read a dotenv file — env must come from the real environment
  (the Docker stack supplies it).

**Gotchas:**
- `start:prod` runs `dist/src/main`, **not** `dist/main`. The build emits to
  `dist/src/` (TS `rootDir` = repo root, `sourceRoot` = `src`), so the entrypoint
  is `dist/src/main.js`. Run `npm run build` first or the file won't exist.
- `start:prod` is for local prod-smoke only; real deploys run the container
  (see [`./deploy.md`](./deploy.md)).
- See [`./local-development.md`](./local-development.md) for first-run setup
  (spin up Postgres+Redis, migrate, create-admin).

```bash
npm run start:dev          # everyday loop
npm run start:debug        # then attach a debugger to :9229
npm run build && npm run start:prod   # local production smoke
```

---

## Build & OpenAPI

| Script | Command | What it does |
| --- | --- | --- |
| `build` | `nest build` | Compiles TS → `dist/` (entry `dist/src/main.js`). `nest-cli.json` has `deleteOutDir: true`, so `dist/` is wiped each build. Also runs the `@nestjs/swagger` CLI plugin (decorator introspection) — DTO/response schemas are only fully populated under `nest build`. |
| `format` | `prettier --write "src/**/*.ts" "test/**/*.ts"` | Auto-formats all source and test TS in place. |
| `openapi:export` | `nest build && node dist/src/scripts/export-openapi.js` | Builds, then runs `export-openapi.ts` to regenerate `docs/api/openapi.json`. |

**`openapi:export` notes:**
- The export bootstraps Swagger in **preview mode** — it does **not** connect to
  a DB, so no Postgres/Redis needed.
- It must run *after* `nest build` (chained in the script) because the script
  lives at `dist/src/scripts/export-openapi.js` and the swagger plugin only
  populates schemas during `nest build`.
- Run it whenever API request/response shapes change and commit the regenerated
  `docs/api/openapi.json`.

```bash
npm run build
npm run openapi:export
npm run format
```

---

## Database

All `db:*` scripts use `dotenv-cli` to load **`.env.development`** before invoking
the Prisma CLI, so they target the **dev** database (`accounting_dev`).

| Script | Command | What it does |
| --- | --- | --- |
| `db:migrate` | `dotenv -e .env.development -- prisma migrate dev` | Applies pending migrations to the dev DB and regenerates the Prisma client. |
| `db:reset` | `dotenv -e .env.development -- prisma migrate reset` | **Drops & recreates** the dev DB, re-applies all migrations from scratch. Destructive. |
| `db:studio` | `dotenv -e .env.development -- prisma studio` | Opens Prisma Studio (browser data viewer) against the dev DB. |
| `db:generate` | `prisma generate` | Regenerates the Prisma client from `schema.prisma`. (No dotenv — schema-only, no DB connection.) |

**Prerequisites:** `.env.development` present with a valid `DATABASE_URL`, and the
dev Postgres reachable.

**Gotchas:**
- **Migrations are hand-authored** in this project. `db:migrate` will still
  prompt to create/apply migration SQL via `prisma migrate dev`, but the SQL is
  written and reviewed by hand (gapless numbering, append-only audit trigger,
  etc.). **Read [`./database-and-migrations.md`](./database-and-migrations.md)
  before authoring or applying any migration** — do not let Prisma auto-generate
  schema-drift SQL blindly.
- `db:reset` wipes all dev data. Never point it at anything but the dev DB.
- These scripts are **dev-only**. For **production**, migrations run via the
  Prisma CLI `migrate deploy` (apply committed migrations, no prompts, no
  schema diffing) inside the `migrate` container before the API starts:

  ```bash
  npx prisma migrate deploy        # what the prod migrate service runs
  ```

  Never run `migrate dev`/`migrate reset` against prod. See
  [`./deploy.md`](./deploy.md).

```bash
npm run db:migrate     # apply a new migration locally
npm run db:studio      # browse the dev DB
npm run db:generate    # after editing schema.prisma
npm run db:reset       # nuke + rebuild dev DB (destructive)
```

---

## Testing

| Script | Command | What it does |
| --- | --- | --- |
| `test` | `jest` | Unit tests (`src/**/*.spec.ts`). Fast, no DB. |
| `test:watch` | `jest --watch` | Unit tests in watch mode. |
| `test:cov` | `jest --coverage` | Unit tests with a coverage report (`coverage/`). |
| `test:debug` | `node --inspect-brk -r tsconfig-paths/register -r ts-node/register node_modules/.bin/jest --runInBand` | Runs Jest serially under the debugger; breaks on start so you can attach to `:9229`. |
| `test:e2e` | `jest --config ./test/jest-e2e.json` | End-to-end tests against a real Postgres. |
| `test:e2e:cov` | `jest --config ./test/jest-e2e.json --coverage` | e2e tests with coverage. Part of `verify`. |

**Prerequisites:**
- **Unit tests** (`test`, `test:watch`, `test:cov`, `test:debug`): no external
  services. They use `NODE_ENV=test`, where Redis/throttling is in-memory.
- **e2e tests** (`test:e2e`, `test:e2e:cov`): **Docker must be running.** They
  use **Testcontainers** to spin up a throwaway Postgres per run — there is no
  `.env.test`, the DB URL is injected by the test harness. The first run pulls
  the Postgres image (slow); later runs reuse it.

**Gotchas:**
- e2e tests are the slow ones and the most common cause of a failing `verify`;
  if they hang or error with a Docker/connection message, confirm the Docker
  daemon is up.
- See [`./testing.md`](./testing.md) for the suite layout, how to run a single
  spec, and Testcontainers tips.

```bash
npm test                 # unit
npm run test:watch       # unit, watch
npm run test:e2e         # e2e (Docker required)
npm run test:e2e:cov     # e2e + coverage
```

---

## Quality gates

| Script | Command | What it does |
| --- | --- | --- |
| `verify` | `npm run typecheck && npm run lint:ci && npm run test && npm run test:e2e:cov` | **THE pre-merge gate.** Runs typecheck → lint (zero warnings) → unit → e2e+coverage, in order, failing fast. CI runs the same chain. |
| `typecheck` | `tsc --noEmit` | Type-checks the whole project without emitting JS. |
| `lint` | `eslint "{src,apps,libs,test}/**/*.ts" --fix` | Lints **and auto-fixes** TS. Use while developing. |
| `lint:ci` | `eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 0` | Lints with **no auto-fix** and fails on any warning. Used by `verify`/CI. |

**Run `npm run verify` before every push/merge.** It is the single command that
must pass green. Prerequisite: Docker running (for the e2e leg).

**Gotchas:**
- `lint` mutates files (`--fix`); `lint:ci` does not and is stricter
  (`--max-warnings 0`). If `lint:ci` fails in CI but `lint` "passed" locally, you
  likely had auto-fixed warnings that were never committed — run `lint` and
  commit the result, or fix the warning by hand.
- The TypeScript toolchain is **pinned to TS 5.x on purpose**. TS6/ESLint10
  Dependabot bumps were reverted (the codebase is not TS6-compatible). Do not
  re-merge those major bumps without a migration, or `typecheck`/`lint` will
  break.

```bash
npm run verify       # pre-merge gate — must be green
npm run typecheck
npm run lint         # auto-fix while developing
npm run lint:ci      # what CI enforces
```

---

## Security audit

| Script | Command | What it does |
| --- | --- | --- |
| `audit:ci` | `npm audit --omit=dev --audit-level=moderate` | **Production-dependency** audit gate. Fails on any moderate-or-higher advisory in prod deps. Run by the CI `audit` job. |
| `audit:dev` | `npm audit --audit-level=moderate \|\| true` | Full-tree (incl. dev deps) audit at moderate level, **non-blocking** (`|| true` → always exit 0). Informational. |

**Gotchas:**
- `audit:ci` is the one that gates deploys — it scopes to prod deps
  (`--omit=dev`) so dev-only advisories don't block a release.
- `audit:dev` never fails the shell on purpose; it's a visibility aid for the
  full tree, including dev tooling.
- Vulnerabilities are sometimes pinned away via `package.json` → `overrides`
  (e.g. `multer`, `form-data`). If `audit:ci` flags a transitive dep, an override
  is often the fix rather than a direct bump.

```bash
npm run audit:ci     # prod-dep gate (fails on moderate+)
npm run audit:dev    # full tree, advisory only
```

---

## Admin

| Script | Command | What it does |
| --- | --- | --- |
| `create-admin` | `dotenv -e .env.development -- ts-node scripts/create-admin.ts` | Creates (upserts) an **ADMIN** user directly in the dev DB. |

```bash
npm run create-admin -- <email> <password> "<name>"
# e.g.
npm run create-admin -- admin@acme.co 's3cret!' "Budi Admin"
```

**Why it exists:** the API has **no public registration endpoint**, so
`create-admin` is the **only way to create a user** — the first ADMIN must be
inserted directly. It hashes the password with argon2 (matching `UsersService`)
and upserts by email, so re-running with the same email updates that user.

**Prerequisites:** `.env.development` present (it supplies `DATABASE_URL` via
`dotenv-cli`) and the dev Postgres reachable.

**Gotcha:** mind the `--` separator — args after it go to the script, not to
npm. For **production**, run the equivalent against the prod DB (e.g. exec into
the API container with `DATABASE_URL` set and run the script, or run it as a
one-off with the prod env loaded). See [`./deploy.md`](./deploy.md).

---

## Deploy & infra (deferred)

Production deploy/upgrade is a single Docker Compose command and is **fully
documented in [`./deploy.md`](./deploy.md)** — read it rather than relying on the
snippet below:

```bash
# Build image, run migrations (prisma migrate deploy), then start api/caddy/backup:
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

- Migrations in prod run as a dedicated `migrate` service (`prisma migrate
  deploy`) **before** the app, never in-process.
- Backup/restore: [`./backup-and-restore.md`](./backup-and-restore.md).
- CI/CD activation, rollback, monitoring overlay, X-Forwarded-For trust:
  [`./deploy.md`](./deploy.md).

---

## When something breaks

- A command fails or behaves oddly → [`./troubleshooting.md`](./troubleshooting.md).
- `verify`/e2e fails with a Docker error → start the Docker daemon.
- `start:prod` can't find the entry → it's `dist/src/main`, not `dist/main`;
  run `npm run build` first.
- Throttled routes return `503` in dev → Redis isn't reachable at `REDIS_URL`
  (fail-closed limiter).
