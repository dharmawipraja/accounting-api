# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) from this release onward.

## [Unreleased]

### Changed (breaking)

- **Business dates must be `YYYY-MM-DD`** — a timestamp sent for a journal,
  document, due, payment, void/reverse date or a report `asOf`/`from`/`to` is now
  `400` (previously its first 10 characters were used, so `toISOString()` from a
  WIB client after midnight posted to the previous day). Audit-log `from`/`to`
  filters still accept timestamps.

### Changed

- **Access tokens are revoked with their session** — access tokens now carry a
  `sid` (refresh-family id) checked on every request, so logout, logout-all,
  self-service password change, and admin reset / role change / deactivation /
  delete reject outstanding access tokens immediately (previously they lived up
  to `JWT_ACCESS_TTL`). A password change now also signs out the calling tab.
  Access tokens issued before this release (no `sid`) are rejected with `401`:
  users log in again once.
- **Audit log stores less for anonymous requests** — a login row (success or
  failure) keeps only `{ email }`; refresh/logout rows store `{}` (previously
  the redacted body). Anonymous interceptor rows now also count against the
  per-IP audit budget.
- Internal simplifications (no API change): one soft-delete `$allOperations`
  hook + shared `tombstoneData()` (now also covering `updateManyAndReturn`),
  one ordered `classifyException()` shared by the exception filter and audit
  status, and a single-key-space audit rejection limiter.

- **CD reloads monitoring config** — when the monitoring overlay runs, a deploy
  recreates Prometheus / Alertmanager whose mounted config differs from the
  checked-out files (alert-rule changes no longer wait for a manual restart).
- **Year-end close waits for the day after year-end** — closing on 31 Dec itself
  is now 422 (that day's documents could still arrive).
- **Fiscal-year bounds unified** to 2000–2100 on every endpoint, including path
  params (`/close/year-end/:fiscalYear`, `?fiscalYear=`), which were unbounded.

### Removed

- Unused dev dependencies `ts-loader`, `@eslint/eslintrc`,
  `source-map-support`, `tsconfig-paths`.
- `GET /v1/auth/admin-only` (Phase-1 RBAC smoke route) and the
  `application/x-www-form-urlencoded` body parser — the API is JSON-only.

### Security

- `js-yaml` (via `@nestjs/swagger`) pinned to `^5.4.1` (GHSA-r3ph-w7gj-g6xm) and
  `@grpc/grpc-js` bumped; `npm audit` is back to 0.

### Fixed

- **Opening balances have guard rails** — `POST /v1/ledger/opening-balances` is now
  `409 CONFLICT { existingEntryId, entryRef }` while another opening entry is posted
  (reverse it to re-enter), and an AR/AP control line is `422 { accountId, role,
  reason: "DOCUMENTS_EXIST" }` once any sales invoice, purchase bill or payment
  exists, so a post-go-live opening can no longer drift the AR/AP subledger from its
  control account. Serialized in the post transaction by advisory lock `71_004_001`.
  Reactivating an account (`PATCH { isActive: true }`) under an inactive parent
  header is now `422 { id, reason: "PARENT_INACTIVE", parentId }` (taken under the
  same row locks as deactivation).
- **Neraca no longer reports earlier unclosed years as current-year profit** —
  the `CURRENT_EARNINGS` "Laba (Rugi) Berjalan" line now carries only the fiscal
  year containing `asOf` (= `currentYearEarnings`, ties to Laba Rugi); P&L of
  earlier fiscal years never closed (or reopened) moves to a new
  `UNCLOSED_PRIOR_EARNINGS` "Laba Ditahan (tahun belum ditutup)" equity group
  (emitted only when non-zero) and a new `unclosedPriorYearsEarnings` field.
  `totalEquity` / `balanced` are unchanged.
- **Buku Besar can page past the 10,000-line cap** — a truncated response now
  carries `nextCursor`; pass it back as `?cursor=` (same `accountId`/`from`/`to`)
  for the next page, whose `openingBalance` is the previous page's last
  `runningBalance` (computed server-side). `nextCursor` is `null` otherwise; a
  malformed or out-of-range cursor is 422.
- **AR/AP aging totals cover every open document** — `totalsByBucket` and
  `totalOutstanding` are SQL aggregates over all open documents even when the
  10,000-document cap truncates, a new `documentCount` gives the full count, and
  the cap now cuts only at partner boundaries (a partner is never split;
  ordering is partner name, then partner id).
- **Two concurrent refreshes no longer log the user out** — a refresh token
  replayed within `REFRESH_REUSE_GRACE_MS` (new, default 10000 ms, 0 disables) of
  its rotation gets a new pair in the same session instead of tripping reuse
  detection; a later replay still revokes the whole session.
- **Tax codes no longer stack** — a document line may carry at most one PPN code
  and one PPh code (e.g. `PPH23-PAY` + `PPH42-PAY` on one line → 422).
- **Final PPh 4(2) is an expense** — the seeded `PPH42-PRE` now posts to the new
  `5-9100 Beban PPh Final`, not `1-1500 Uang Muka PPh`; `PPH_PREPAID` codes may
  target a debit-normal expense account. Existing installs are migrated by
  `20261006000000_pph42_final_expense_account` (creates `5-9100`, repoints a
  `PPH42-PRE` still on `1-1500`; audited as `method=MIGRATION`).
- **Login throttle can no longer lock the owner out** — the per-minute login
  bucket is keyed by (email, client IP) instead of email alone. Guessing one
  account from many IPs is capped by a new per-account failed-login ceiling
  (`LOGIN_FAILURE_LIMIT`, default 20 per 15 min) that only refuses IPs the
  account has never logged in from. New metrics `auth_login_failures_total` /
  `auth_login_lockouts_total` and a `LoginAttack` alert.
- **Offsite backup failures now alert** — `backup.sh` tracks the offsite upload
  separately (`backup_last_offsite_success_timestamp_seconds`,
  `backup_offsite_configured`); new `OffsiteBackupStale` alert, and `BackupStale`
  also fires when the metric is absent.
- **Segregation of duties covers documents** — with
  `segregationOfDutiesEnabled` (default on), the creator of a sales invoice,
  purchase bill or payment can no longer post it (403 `SEGREGATION_OF_DUTIES`),
  closing the create-bill-then-pay-it path. Previously only manual journals.
- **Tax rates freeze once used** — `PATCH /tax/codes/:id` with a different `rate`
  returns 409 when any document line uses the code; create a new code instead.

## [1.1.0] - 2026-06-25

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
- **List pagination** — partners, sales invoices, purchase bills, payments, and
  the accounts and tax-code reference lists now return
  `{ data, total, limit, offset }` (`?limit` max 200, default 50; `?offset`).
- **Fuzzy search** — an optional `?q=` relevance-ranked search (PostgreSQL
  `pg_trgm`) on partners, sales invoices, purchase bills, payments, and the
  journal register. Additive — existing filters are unchanged.
- **Session logout & stateful refresh tokens** — refresh tokens are now stored
  server-side and rotated on every refresh, with reuse-detection that revokes the
  whole token family. `POST /auth/logout` revokes the presented refresh token;
  `POST /auth/logout-all` revokes all of a user's sessions.
- **Typed OpenAPI response schemas** — every endpoint's 2xx response body is now
  fully described in `docs/api/openapi.json` (entity shapes as `*ResponseDto`,
  computed/report shapes as `*Dto`), so a generated client yields response types,
  not just request types. A contract guard test keeps coverage complete. The
  frontend guide and agent brief document the conventions (money-as-string,
  omitted soft-delete fields, the journal-list envelope, computed
  `outstanding`/`paymentStatus`, detail-only nested `lines`/`allocations`).

### Changed

- **Rate limiting is now Redis-backed** (`@nestjs/throttler` + `ioredis`) in dev and
  production, so limits are shared across instances and survive restarts; tests/CI keep
  the in-memory store. Keying (per-user, per-IP for anonymous) and limits are unchanged.
  Fail-closed: a real limit hit returns 429; if Redis is unreachable, requests get 503
  (the limiter never silently turns off). `/ready` now also checks Redis. Requires
  `REDIS_URL` outside the test environment.
- **Breaking:** business route paths are now `/v1/...`; every list endpoint
  (transactional lists plus the accounts and tax-code lists) returns the
  `{ data, total, limit, offset }` envelope instead of a bare array — read
  `.data`. The journal/opening-balances endpoints now require an
  `Idempotency-Key`. See `docs/api/openapi.json`.
- Audit log query: `from > to` now returns `422` instead of an empty result.

### Fixed

- **Financial correctness (P0)** — two posting bugs fixed test-first: a reversal
  could post into a closed fiscal year, and an out-of-order year-end close could
  double-count cumulative P&L.
- **Production image entry point** — the production Docker image started
  `dist/main.js`, but `nest build` emits `dist/src/main.js`; the entry path is
  corrected so the image boots.
- `npm run openapi:export` referenced `dist/scripts/export-openapi.js`, but
  `nest build` emits to `dist/src/scripts/`; the path is corrected so the export
  actually runs.

### Security

- **Refresh-token revocation & rotation** — stateful refresh tokens (rotated per
  use, reuse-detection revokes the family); access tokens are unchanged.
- **Login hardening** — login throttling keyed by email, and constant-time login
  (decoy password hash) to resist user enumeration and brute force.
- `Idempotency-Key` format validation with periodic purge; `/metrics` is
  token-gated and fail-closed.
- **Append-only audit log** — enforced by a database trigger (no `UPDATE`/`DELETE`
  on `audit_log`).
- All `npm audit` advisories resolved to zero via `package.json` `overrides`; the
  production image is hardened (read-only root filesystem, dropped Linux
  capabilities, `npm`/`npx` removed) with a Trivy HIGH/CRITICAL scan gate in CI.

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

[unreleased]: https://github.com/dharmawipraja/accounting-api/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/dharmawipraja/accounting-api/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/dharmawipraja/accounting-api/releases/tag/v1.0.0
