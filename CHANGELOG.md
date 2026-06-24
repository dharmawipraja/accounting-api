# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) from this release onward.

## [Unreleased]

### Added

- **API versioning** — all business routes are served under `/v1`
  (`enableVersioning`, URI strategy). Operational probes (`/health`, `/ready`,
  `/metrics`) remain version-neutral.
- **Generalized idempotency** — a reusable `@Idempotent()` interceptor stores a
  JSON response snapshot keyed by `Idempotency-Key`. Required on invoice/bill/
  payment creates, the money-moving transitions (`:id/post`, `:id/void`, year-end
  close), and the journal/opening-balances endpoints. Replays return the original
  response; key reuse with a different body/endpoint → 422; in-flight → 409.
  (Reference-data creates are not covered — their unique `code` already prevents
  duplicates.)
- **List pagination** — partners, sales invoices, purchase bills, and payments
  now return `{ data, total, limit, offset }` (`?limit` max 200, default 50;
  `?offset`). Accounts and tax codes remain full lists (bounded reference data).
- **Typed OpenAPI response schemas** — every endpoint's 2xx response body is now
  fully described in `docs/api/openapi.json` (entity shapes as `*ResponseDto`,
  computed/report shapes as `*Dto`), so a generated client yields response types,
  not just request types. A contract guard test keeps coverage complete. The
  frontend guide and agent brief document the conventions (money-as-string,
  omitted soft-delete fields, the journal-list envelope, computed
  `outstanding`/`paymentStatus`, detail-only nested `lines`/`allocations`).
  Document-only — no API behavior change (additive `@Api*` annotations + response
  DTO classes); all existing e2e assertions pass unchanged.

### Changed

- **Rate limiting is now Redis-backed** (`@nestjs/throttler` + `ioredis`) in dev and
  production, so limits are shared across instances and survive restarts; tests/CI keep
  the in-memory store. Keying (per-user, per-IP for anonymous) and limits are unchanged.
  Fail-closed: a real limit hit returns 429; if Redis is unreachable, requests get 503
  (the limiter never silently turns off). `/ready` now also checks Redis. Requires
  `REDIS_URL` outside the test environment.
- **Breaking:** business route paths are now `/v1/...`; the four transactional
  lists above return an envelope instead of a bare array. The journal/
  opening-balances endpoints now require an `Idempotency-Key`. See
  `docs/api/openapi.json`.

### Fixed

- `npm run openapi:export` referenced `dist/scripts/export-openapi.js`, but
  `nest build` emits to `dist/src/scripts/`; the path is corrected so the export
  actually runs.

## [1.0.0] - 2026-06-12

First stable release of the single-company Indonesian accounting API (NestJS 11 +
Prisma 7 + PostgreSQL), conforming to SAK. Feature-complete and production-hardened
(38 unit + 152 e2e tests green).

### Added

- **Foundation & Auth** — JWT authentication with refresh tokens and RBAC
  (ADMIN / ACCOUNTANT / APPROVER / VIEWER); global soft-delete with tombstoned
  unique codes; `Money` value object (decimal.js, 4-decimal, round-half-up);
  typed error envelope (`{ code, message, details?, traceId? }`); hardened HTTP
  middleware (helmet, validation pipe, body limit); `/health` + `/ready` probes.
- **Ledger** — SAK chart of accounts (seeded), monthly accounting periods,
  gapless double-entry posting (draft → post → reverse) with balanced-entry,
  period-lock, and segregation-of-duties guards; opening balances; trial balance.
- **Tax** — PPN (VAT) and PPh (withholding) engine with configurable tax codes
  and a balanced-journal preview (`POST /tax/calculate`).
- **Invoicing & AR/AP** — business partners, sales invoices, purchase bills
  (draft → post → void), and payments (RECEIPT / DISBURSEMENT) with per-partner
  subledgers reconciled to the AR/AP control accounts.
- **Reporting** — Neraca (balance sheet), Laba Rugi (income statement),
  Buku Besar (general ledger), AR/AP aging, Arus Kas (cash flow), and the
  paginated journal register (`GET /ledger/journal-entries`).
- **Close & Audit** — reversible year-end close (zeroes cumulative P&L into
  Laba Ditahan, with a year-lock blocking further posting) and an append-only
  audit log of all mutating requests.
- **Production hardening** — CI quality gate (`npm run verify`: typecheck,
  zero-warning lint, unit + coverage-gated e2e) with GitHub Actions and
  Dependabot; input/data-integrity hardening (typed Prisma-error mapping,
  hardened soft-delete, validated query/param DTOs); single-VM deploy infra
  (Caddy auto-HTTPS, migrate-on-deploy gate, `pg_dump` backup sidecar);
  observability (request `traceId` correlation, Prometheus `/metrics`,
  DSN-gated Sentry, optional Prometheus/Grafana stack, k6 baseline).
- **Documentation** — committed OpenAPI contract (`docs/api/openapi.json`) plus
  a frontend integration guide and agent brief (`docs/api/frontend-guide.md`,
  `docs/api/frontend-agent-brief.md`).

[1.0.0]: https://semver.org/
