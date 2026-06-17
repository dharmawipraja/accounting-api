# accounting-api

A single-company Indonesian accounting API built on NestJS, conforming to SAK. **Version 1.0.0** — feature-complete and production-hardened (see [`CHANGELOG.md`](CHANGELOG.md)).

It provides JWT authentication with RBAC (four roles: ADMIN, ACCOUNTANT, APPROVER, VIEWER) on a double-entry ledger, and covers the full accounting cycle:

- **Ledger** — SAK chart of accounts, monthly periods, gapless double-entry posting (draft → post → reverse) with segregation-of-duties guards, opening balances, trial balance.
- **Tax** — PPN/PPh engine with configurable tax codes and a balanced-journal preview.
- **Invoicing & AR/AP** — sales invoices, purchase bills, and payments with per-partner subledgers reconciled to the AR/AP control accounts.
- **Reporting** — Neraca, Laba Rugi, Buku Besar, AR/AP aging, Arus Kas, and the paginated journal register.
- **Close & Audit** — reversible year-end close (with a year-lock) and an append-only audit log.

It runs on Prisma 7 + PostgreSQL with a soft-delete extension, a `Money` value object for currency-safe arithmetic, hardened HTTP middleware (helmet, validation pipe, global exception filter), readiness/health probes, Prometheus `/metrics`, and request `traceId` correlation.

## Tech stack

- TypeScript, NestJS
- Prisma 7 + PostgreSQL (via `@prisma/adapter-pg`)
- JWT authentication (access + refresh tokens)
- Docker / Docker Compose

## Prerequisites

- Node.js 22+
- Docker (for the database and production container)

## Setup

1. Copy the example env file and fill in values:

   ```bash
   cp .env.example .env
   ```

   Key variables to set:
   - `DATABASE_URL` — PostgreSQL connection string
   - `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` — must each be at least 32 characters
   - `POSTGRES_PASSWORD` — used by Docker Compose
   - `REDIS_URL` — Redis connection string (e.g. `redis://localhost:6379`). Required in dev and prod; tests and CI use an in-memory store and do not need it.

## Local development

```bash
# Start the database
docker compose up -d db

# Apply migrations to the dev database (accounting_dev)
npm run db:migrate

# Start the API in watch mode (NODE_ENV=development -> .env.development)
npm run start:dev
```

The environment follows the script: `start:dev` loads `.env.development` (its own
`accounting_dev` database) so local work never touches production data. `npm run
db:migrate` / `db:reset` / `db:studio` target the same dev database via
`.env.development`. Copy `.env.example` to `.env` (shared secrets) and create
`.env.development` with a dev `DATABASE_URL` before first run.

**Rate limiting** is Redis-backed in dev and prod (`@nestjs/throttler` +
`ioredis`). Add `REDIS_URL=redis://localhost:6379` to `.env.development` before
running `start:dev` (`docker compose up -d redis` exposes Redis on
`127.0.0.1:6379`). Tests and CI use an in-memory store — no Redis required.
Behaviour: a real limit hit returns **429**; if Redis is unreachable the
limiter fails-closed and returns **503** (the limiter never silently turns off).
`/ready` also pings Redis when it is configured.

## Running with Docker

```bash
docker compose up --build
```

`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and `POSTGRES_PASSWORD` must be set in the environment or your `.env` file before starting.

## Testing

```bash
# Unit tests
npm test

# Integration tests (requires Docker — spins up testcontainers automatically)
npm run test:e2e
```

## API documentation

OpenAPI (Swagger UI) is served at `/docs`. It is disabled in production by default; set `ENABLE_SWAGGER=true` in the environment to enable it.

A committed, machine-readable contract lives at [`docs/api/openapi.json`](docs/api/openapi.json) — both request **and response** bodies are fully typed (every 2xx response resolves to a named `components.schemas` entry), so a generated client yields response types too. Regenerate it with `npm run openapi:export`. For integration semantics (auth, conventions, the role matrix, domain lifecycles, and a glossary), see [`docs/api/frontend-guide.md`](docs/api/frontend-guide.md); [`docs/api/frontend-agent-brief.md`](docs/api/frontend-agent-brief.md) is a copy-to-your-repo briefing for building a client.

Key conventions for client builders:

- **`/v1` versioning** — all business routes are served under `/v1` (e.g. `GET /v1/ledger/accounts`). The operational probes (`/health`, `/ready`, `/metrics`) are version-neutral and remain unprefixed.
- **Idempotency** — write endpoints that create or transition financial documents (invoice/bill/payment create, post, and void; journal create, post, and reverse; opening-balances; year-end close) require an `Idempotency-Key` request header. Pass a unique UUID per logical write; retries with the same key replay the original response without re-executing the write. Missing key → `422`; key reuse with different body/endpoint → `422`; in-flight duplicate → `409`.
- **Enveloped pagination** — five list endpoints return `{ data, total, limit, offset }` (`?limit` max 200, default 50; `?offset`): `GET /v1/partners`, `GET /v1/sales-invoices`, `GET /v1/purchase-bills`, `GET /v1/payments`, and `GET /v1/ledger/journal-entries`. Accounts and tax codes return full bare arrays (bounded reference data).

## Production deployment

Deploy a tagged release on a single Docker host (Caddy auto-HTTPS, migrate-on-deploy gate, and a `pg_dump` backup sidecar):

```bash
git checkout v1.0.0
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

See [`docs/runbooks/deploy.md`](docs/runbooks/deploy.md) and [`docs/runbooks/backup-and-restore.md`](docs/runbooks/backup-and-restore.md) for the full procedure.

## Database backups

This API holds financial records. For production deployments, schedule regular `pg_dump` backups of the Postgres volume. Example:

```bash
docker compose exec db pg_dump -U accounting accounting > backup.sql
```

Store backups off-host and test restores periodically.

## Development & CI

This repo standardizes on **Node 22 LTS** (`.nvmrc`). Match it locally:

```bash
nvm install 22 && nvm use   # reads .nvmrc
npm ci
```

Before pushing, run the full gate locally:

```bash
npm run verify   # typecheck + lint:ci (no-fix, zero warnings) + unit + e2e (with coverage floor)
```

`npm run verify` is the gate. Note the coverage floor is enforced by the e2e
run **only via `npm run verify` / `npm run test:e2e:cov`** — a plain
`npm run test:e2e` skips the threshold (fast path). CI (GitHub Actions,
`.github/workflows/ci.yml`) runs the same gate plus `npm audit` (high+) and a
production `docker build` on every push/PR to `main`.

Dependency updates arrive via Dependabot. **Minor/patch** PRs are auto-grouped
and safe to merge once green; **major** bumps (Prisma, NestJS) are reviewed
manually because they are breaking. See `SECURITY.md` for the audit policy.
