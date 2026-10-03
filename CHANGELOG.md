# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) from this release onward.

## [Unreleased]

### Added

- **Refunds of unapplied credit** — `POST /v1/payments/:id/refunds`,
  `/v1/sales-credit-notes/:id/refunds`, `/v1/purchase-debit-notes/:id/refunds`
  `{ date, amount, cashAccountId, description? }` pay a payment advance or a note's
  excess back in cash (customer: Dr Uang Muka Pelanggan / Cr cash; vendor: Dr cash /
  Cr Uang Muka Pembelian), reversible via `…/refunds/:refundId/reverse`. Same roles,
  SoD, partner rule and holder lock as apply; refund ≤ unapplied, date ≥ holder date and
  ≤ today (WIB). Stored as `payment_applications` rows with the new `cash_account_id`
  target (migration `20261012000000_credit_refunds`); responses list them as `refunds`.
  Live refunds block voiding the holder like applications.
- **Opening credit** — `POST /v1/payments` with `opening: true` (no `cashAccountId`, no
  allocations) enters a go-live customer deposit / vendor prepayment per partner against
  Saldo Awal (Dr Saldo Awal / Cr Uang Muka Pelanggan, or Dr Uang Muka Pembelian / Cr Saldo
  Awal), creating unapplied credit that can be applied or refunded. Excluded from the
  cash-flow report like the opening entry.

### Fixed

- **Customer/vendor credit could never be refunded** — unapplied advances and note
  excess could only be applied to documents (manual journals are barred from the advance
  accounts). See refunds above.
- **Opening-balance advances were stuck** — an OPENING entry may no longer touch
  `CUSTOMER_ADVANCE` / `VENDOR_ADVANCE` (`422 { accountId, role, reason:
  'ADVANCE_IN_OPENING' }`): a lump sum there belonged to no partner and could never be
  applied. Use opening credits instead.

- **Refresh grace window minted unlimited sessions** — every replay of a consumed
  refresh token inside `REFRESH_REUSE_GRACE_MS` issued a new sibling, so anyone who
  saw the token could renew their own session without tripping reuse detection. Now
  at most ONE grace sibling per consumed token (new `refresh_tokens.grace_child_id`,
  migration `20261011100000_refresh_grace_sibling`); a further replay revokes the
  family. Two concurrent refreshes still both succeed.
- **Known-IP bypass of the per-account failure ceiling** — a known IP skipped the
  ceiling entirely (a colleague behind the same office IP could guess unbounded).
  New absolute ceiling `LOGIN_FAILURE_HARD_LIMIT` (default 100 per 15 min) refuses
  every IP, known or not.
- **Login-failure counter could lose its TTL** — `INCR` and `PEXPIRE` are now one
  `MULTI` (`PEXPIRE … NX`), so a crash between them can no longer leave a permanent
  counter that locks new IPs out forever. Redis errors still fail closed (`503`).

### Changed

- `REFRESH_REUSE_GRACE_MS` default `10000` → `5000`, max `60000` → `30000`.
- **Credit/debit-note rounding drift** — partial notes recomputed per-code rupiah tax
  on their own base, so returning a whole invoice in pieces could credit Rp1 more (a
  phantom advance on Uang Muka Pelanggan/Pembelian) or Rp1 less (left outstanding with
  nothing left to return) than the original; fixed discounts drifted ±0.0001 per note.
  Now, under the original's lock, the note that brings a line to its full quantity takes
  the line's remaining amount/discount, and per tax code a note takes the original's
  remaining amount when it completes the code, else its own amount capped at the
  remainder — so notes never exceed the original per code and whole returns reproduce
  it exactly (see the domain glossary).
- **Inactive references blocked returns** — a note can now be issued against an
  original whose tax code (e.g. retired by a rate change), line account or partner has
  since been deactivated (not deleted); invoices and bills stay strict.
- **Zero-quantity original line** — returning from it answered `500` (division by
  zero); now `422 VALIDATION_FAILED`.
- **Coretax faktur status transitions are enforced** — `PATCH
  /v1/sales-invoices/:id/tax-invoice` returns `422` on a status move outside
  `NONE`→`EXPORTED`|`APPROVED`, `EXPORTED`→`NONE`|`APPROVED`, `APPROVED`→`CANCELLED`
  (`CANCELLED` is final; same-status writes allowed). Before, an `APPROVED` faktur
  could be set back to `NONE` and land in the default export again (duplicate
  upload to DJP).
- **System account roles require their account shape on create** — every
  `AccountRole` (not only `CASH`) must sit on a postable account of its type and
  normal side (e.g. `AP_CONTROL` a credit-normal LIABILITY); `422` with the
  required shape in `details` otherwise.
- **Credit/debit notes: `voided_on` set iff VOID** is now a database CHECK
  (migration `20261011000000_note_voided_on_check`, like invoices/bills/payments);
  it aborts the deploy listing any violating row (none expected).
- **Journal preview of advance payments** — `nature: PAYMENT` accepts `amount` and
  empty/omitted `allocations`, and previews the customer/vendor advance line exactly
  as the post books it (before, an advance could not be previewed and an `amount`
  above the allocations was not shown).
- **CORS exposes `Content-Disposition` and `X-Coretax-Invoice-Count`** so a browser
  client can read the Coretax export's filename and invoice count.
- `payment-advances` e2e race test now fails instead of silently passing when the
  two applies never queue on the lock.

### Changed

- **AR/AP aging continuation** — `?afterPartnerId=` lists only partners after that
  one; a truncated response carries `nextAfterPartnerId` to fetch the rest. Totals
  still cover every open document on every page.
- **Coretax export is rate-limited per user** — `GET
  /v1/tax/coretax/faktur-keluaran` allows `THROTTLE_CORETAX_EXPORT_LIMIT` (default
  10) calls per minute per user.
- **Monitoring overlay mounts config directories** — config moved to
  `monitoring/{prometheus,alertmanager,loki,alloy,grafana}/` and is mounted as
  directories (a `git checkout` is now visible in running containers); the metrics
  token mounts at `/etc/prometheus-secrets/` (host path `monitoring/secrets/`
  unchanged). CD recreates each overlay service whose config directory changed (all
  five on a re-run, and on this upgrade) and logs a `WARN` instead of silently
  skipping when it cannot inspect the overlay (e.g. `GRAFANA_ADMIN_PASSWORD` unset).
- CI `verify` job has a 45-minute timeout; the unused direct `testcontainers`
  devDependency is removed (it still comes in via `@testcontainers/postgresql`).
- Runbooks: the migration-folder naming rule no longer hard-codes the newest
  folder; new recovery section for the Coretax NPWP migration abort (preview query
  + steps) in database-and-migrations.md, linked from deploy.md.
- Internal: de-duplication refactor, no API change — one note-kind factory, model-based
  `listPaginated`, `lockLiveRow`, `resolveVoidDate`, shared line/application
  presenters, and the credit engine in its own `CreditApplicationService`.

## [1.2.0] - 2026-10-03

### Added

- **Coretax (DJP) faktur keluaran XML export, NSFP and bukti potong records** —
  `GET /v1/tax/coretax/faktur-keluaran?from&to[&status]` returns the Coretax
  `TaxInvoiceBulk` import file (`application/xml` attachment) for POSTED sales invoices
  with PPN Output (one `TaxInvoice` each; DPP Nilai Lain 11/12 → `TrxCode 04`,
  `VATRate 12`, `OtherTaxBase = DPP × 11/12`; discounts in `TotalDiscount`), or `422`
  listing every missing master-data field / unreconciled VAT instead of an invalid
  file. The GET does not mutate; `POST …/mark-exported { invoiceIds }` marks invoices
  EXPORTED. `PATCH /v1/sales-invoices/:id/tax-invoice` records the NSFP (17 digits,
  `409` on a duplicate) / faktur status on POSTED invoices; `PATCH …/withholding-slip`
  on sales invoices (PPH_PREPAID) and purchase bills (PPH_PAYABLE) and
  `PATCH …/retur-reference` on credit/debit notes store bukti potong / retur
  references. New fields: company `nitkuSuffix` + Coretax line defaults; partner
  `buyerDocumentType`, `buyerDocumentNumber`, `nitkuSuffix`, `country`; tax code
  `dppNilaiLain`, `coretaxVatRate` (presentation only; seeded `PPN-OUT-11` set to
  12% × 11/12); invoice `trxCode` and line `coretaxItemType/ItemCode/UnitCode`;
  `?taxInvoiceStatus=` list filter. **NPWP is now validated**: 16 digits, input
  punctuation stripped, legacy 15-digit → `0` + 15. Migration `20261010000000_coretax`
  normalizes existing NPWPs (audit rows `method = MIGRATION`) and **fails the deploy
  listing any live NPWP it cannot normalize**. No ledger or amount change. Format from
  DJP's official sample and converter (<https://www.pajak.go.id/en/node/112031>:
  *Sample Faktur PK Template v.1.4.xml*, *ConverterEfakturCoretax v1.6*); unverified
  points and the skipped BPPU XML export are listed in `docs/api/frontend-guide.md`
  § Coretax.
- **Per-line discounts on sales invoices and purchase bills, applied before tax** —
  each line accepts an optional `discountPercent` (0–100, up to 4 dp) **or**
  `discountAmount` (both → `400`; an amount above `quantity × unitPrice` → `422`). The
  line `amount` (the DPP) is now net of the discount, so PPN/PPh are computed on the
  discounted amount and revenue/expense posts net (no separate contra "Potongan"
  account in v1). Responses add line `discountPercent` / `discountAmount` and document
  `discountTotal`; `subtotal` remains the sum of (net) line amounts. Migration
  `20261008000000_document_line_discounts` adds the columns (defaults keep existing
  documents unchanged) plus CHECK constraints.
- **Customer & vendor advances (unapplied payments)** — `POST /v1/payments` takes an
  optional `amount`; allocations may sum to less (or be empty), and the rest posts to
  the new seeded advance accounts *Uang Muka Pelanggan* (2-1300, role
  `CUSTOMER_ADVANCE`) / *Uang Muka Pembelian* (1-1600, role `VENDOR_ADVANCE`) instead
  of AR/AP; payments expose `unappliedAmount` and `applications`. New
  `POST /v1/payments/:id/apply` `{ date, allocations }` applies it to invoices/bills
  later (Dr advance / Cr AR, or Dr AP / Cr advance, one entry per allocation) and
  `POST /v1/payments/:id/applications/:applicationId/reverse` undoes one. A payment
  with live applications cannot be voided (`422 HAS_APPLICATIONS`). `GET
  /v1/payments?unapplied=true` lists open credit; aging counts applications and still
  ties to AR/AP control (advances are not in aging). Partner delete / role removal
  counts unapplied payments as open items (`unappliedPayments`). Existing installs get
  the two accounts from migration `20261008100001_payment_advance_accounts` (skipped
  with a NOTICE when the code is taken — create a role-carrying account instead).
  Out of scope: PPN on advances (faktur uang muka). Fully allocated payments are
  unchanged. The advance accounts are document-only (no MANUAL journal or
  invoice/bill line may use them).
- **Sales credit notes (nota retur penjualan) and purchase debit notes (nota retur
  pembelian)** — `/v1/sales-credit-notes` and `/v1/purchase-debit-notes` (list, get,
  create, PATCH, post, void, delete draft, apply, reverse application; same roles and
  `Idempotency-Key` rules as invoices/bills/payments). A note returns part of ONE
  POSTED invoice / bill (`originalId`, same partner, dated on/after it); each line is
  `{ originalLineId, quantity }` and copies the original line's price, account and tax
  codes — a percent discount keeps its percent, a fixed discount is pro-rated by
  quantity (rounded once to 4 dp half-up). The returnable quantity (original − every
  live draft/posted note) is enforced under the original's row lock on create, edit
  and post (`422`). Gapless refs `CN/<FY>/nnnnnn` / `DN/<FY>/nnnnnn`; journal source
  types `SALES_CREDIT_NOTE` / `PURCHASE_DEBIT_NOTE` (SoD applies; journal list
  filter). Posting mirrors the original's journal for the returned part (tax
  recomputed on the returned DPP); its settlement first reduces the original's
  outstanding — new `creditedTotal` on invoices/bills, `outstanding = total −
  amountPaid − creditedTotal` — and any excess (original already paid) posts to Uang
  Muka Pelanggan / Pembelian as partner credit (`unappliedAmount`), applied to other
  documents exactly like a payment advance (`POST …/:id/apply`, application rows in
  `payment_applications`, whose `paymentId` is now nullable with new
  `salesCreditNoteId` / `purchaseDebitNoteId`). A note voids only while none of its
  excess is applied (`422 HAS_APPLICATIONS`); an invoice/bill with live notes cannot
  be voided (`422 HAS_NOTES`). Aging counts a note's credit on its original from the
  note date (still ties to AR/AP control). Migration `20261009000000_credit_debit_notes`.
  Out of scope: refunding note credit in cash, journal preview of a note.

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

[unreleased]: https://github.com/dharmawipraja/accounting-api/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/dharmawipraja/accounting-api/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/dharmawipraja/accounting-api/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/dharmawipraja/accounting-api/releases/tag/v1.0.0
