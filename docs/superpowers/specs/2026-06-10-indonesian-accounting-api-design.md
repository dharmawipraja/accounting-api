# Indonesian Accounting API — Design Spec

- **Date:** 2026-06-10
- **Status:** Approved (pending written-spec review)
- **Owner:** budi@maul.is

## 1. Overview

A production-grade REST API for double-entry accounting for a single Indonesian
company. It provides a correct, auditable general ledger, AR/AP with invoicing,
basic Indonesian tax recording (PPN and PPh withholding), and the core financial
statements (Neraca, Laba Rugi, Arus Kas) in formats aligned with Indonesian
accounting practice (SAK).

The system is a **single-tenant** internal application: one company entity, one
set of fiscal/tax settings, multiple users with roles.

### Goals

- Correct, atomic double-entry bookkeeping with an immutable, auditable journal.
- AR/AP and invoicing that post to the ledger automatically and correctly.
- Accurate recording of PPN (VAT) and PPh (withholding) on documents.
- Core financial statements that always reconcile.
- Production-ready: secure, observable, tested, containerized, portable.

### Non-goals (deferred to later phases)

- Full tax-compliance machinery: e-Faktur / Coretax e-invoicing, SPT generation,
  NPWP online validation, tax reports/exports.
- Bank reconciliation.
- Fixed assets & depreciation, inventory valuation, payroll (PPh 21).
- Full multi-currency FX revaluation at period end (fields exist; revaluation deferred).
- Multi-tenancy / SaaS concerns.

## 2. Scope (v1 modules)

1. **General-ledger core** — chart of accounts, journal entries, posting, periods,
   trial balance, reversals.
2. **AR/AP & invoicing** — customers/vendors, sales invoices, purchase bills,
   payments & allocations.
3. **Tax recording** — PPN (VAT) and PPh (withholding) on documents, posting to the
   correct ledger accounts. (No filing/e-Faktur integration.)
4. **Financial reporting** — Trial Balance, Neraca, Laba Rugi, Arus Kas (indirect),
   Buku Besar, AR/AP aging; monthly period close and annual year-end close.
5. **Auth & RBAC** — users, JWT auth, roles, permission guards.

## 3. Architecture

A **NestJS modular monolith**, one Docker image, one PostgreSQL database, chosen
for its accounting-correct simplicity (vs. event sourcing) and clean module
boundaries.

Internal layering per module is strict:

> **Controller** (HTTP + DTO validation) → **Service** (domain logic, owns DB
> transactions) → **Repository** (Prisma data access).

Domain invariants live in services; controllers stay thin.

### Modules

| Module | Responsibility |
|---|---|
| `CompanyModule` | Company profile: legal name, NPWP, address, fiscal-year config, base currency (IDR), PPN/PKP status |
| `AuthModule` | Users, login, JWT access + refresh, password hashing (argon2), RBAC guard, roles & permissions |
| `LedgerModule` | Chart of Accounts, Journal Entries/Lines, Accounting Periods, the transactional `PostingService`, reversals |
| `TaxModule` | Tax codes (PPN, PPh), tax calculation, mapping to tax accounts; pure logic consumed by invoicing |
| `InvoicingModule` | Customers/vendors, sales invoices, purchase bills, payments & allocations; generates journal entries via `LedgerModule` |
| `ReportingModule` | Trial balance, Neraca, Laba Rugi, Arus Kas, Buku Besar, AR/AP aging, period close |
| `CommonModule` | `Money`/Decimal value object, global exception filter, validation pipe, audit interceptor, soft-delete Prisma extension, structured logging |

### Dependency rule

`InvoicingModule` and `ReportingModule` depend on `LedgerModule`, **never the
reverse**. The ledger knows nothing about invoices — only balanced journal
entries. This keeps the core stable and lets future modules (tax engine, bank rec,
payroll) be added as new modules that *feed* the ledger.

### Example data flow — posting a sales invoice

1. Controller validates the DTO.
2. `InvoicingService.postInvoice()` opens a DB transaction.
3. Calls `TaxService` to compute PPN/PPh per line.
4. Builds a balanced journal entry and calls `PostingService.post()` (validates
   Σdebits = Σcredits, checks the period is open, assigns a gapless entry number
   under a row lock).
5. Marks the invoice `POSTED`, links `journal_entry_id`, commits — all atomic.

## 4. Tech stack & libraries

- **Language/runtime:** TypeScript on Node.js (current LTS).
- **Framework:** NestJS.
- **Database:** PostgreSQL.
- **ORM:** Prisma (migrations, `Decimal` type backed by `NUMERIC`).
- **Money:** `decimal.js` / `Prisma.Decimal`; never a JS `number` for money.
- **Auth:** `@nestjs/jwt`, `argon2` for password hashing.
- **Validation:** `class-validator` + `class-transformer`.
- **Security:** `helmet`, CORS allow-list, `@nestjs/throttler` (rate limiting).
- **Logging:** `pino` (structured) with request IDs.
- **Docs:** `@nestjs/swagger` (OpenAPI).
- **Config:** `@nestjs/config` (12-factor, env-based).
- **Testing:** Jest; `testcontainers` for integration/e2e against real Postgres.

Other supporting libraries may be added where they are safe, well-maintained, and
production-standard.

## 5. Data model

Money columns are `NUMERIC(20,4)`. All tables carry `created_at` / `updated_at`.
Soft-deletable tables additionally carry `deleted_at` / `deleted_by` (see §9).

### 5.1 Ledger core

**`accounts` (Chart of Accounts / Bagan Akun)** — *soft-deletable*
- `id`, `code` (e.g. `1-1100`), `name`
- `type` (ASSET / LIABILITY / EQUITY / REVENUE / EXPENSE)
- `subtype` (e.g. CURRENT_ASSET, FIXED_ASSET, CURRENT_LIABILITY, …) for statement grouping
- `cash_flow_category` (OPERATING / INVESTING / FINANCING / NONE) for Arus Kas
- `normal_balance` (DEBIT / CREDIT), `parent_id` (hierarchy)
- `is_postable` (header accounts cannot be posted to), `is_active`, `currency`
- Unique: `code` (partial index where `deleted_at IS NULL`)

**`accounting_periods` (Periode)**
- `id`, `fiscal_year`, `name` (e.g. `2026-06`), `start_date`, `end_date`
- `status` (OPEN / CLOSED)

**`journal_entries` (Jurnal)** — *immutable once posted; never deleted*
- `id`, `entry_number` (gapless sequential per fiscal year), `date`, `period_id`, `description`
- `source_type` (MANUAL / SALES_INVOICE / PURCHASE_BILL / PAYMENT / REVERSAL / CLOSING), `source_id`
- `status` (POSTED / REVERSED), `reversal_of_id`, `reversed_by_id`
- `created_by`, `posted_at`, `created_at`
- Unique: `entry_number` per `fiscal_year` (across all rows, permanent)

**`journal_lines` (Baris Jurnal)** — *immutable once posted; never deleted*
- `id`, `journal_entry_id`, `line_no`, `account_id`
- `debit` `NUMERIC(20,4)`, `credit` `NUMERIC(20,4)`, `description`
- DB `CHECK`: both ≥ 0, and exactly one of debit/credit is > 0
- Indexes on `account_id` and `journal_entry_id`

### 5.2 Invoicing / AR/AP

**`business_partners` (Mitra)** — *soft-deletable*
- `id`, `type` (CUSTOMER / VENDOR / BOTH), `name`, `npwp`, `nik`, `address`
- `is_pkp` (VAT-registered — drives PPN applicability), `default_payment_terms`
- `receivable_account_id`, `payable_account_id` (control accounts)

**`sales_invoices` / `purchase_bills`** — *drafts soft-deletable; posted immutable*
- `id`, `number`, `partner_id`, `date`, `due_date`, `currency`, `exchange_rate`
- `status` (DRAFT / POSTED / PARTIALLY_PAID / PAID / VOID)
- `subtotal`, `tax_total`, `wht_total` (withholding), `total`, `amount_paid`
- `journal_entry_id`, `notes`
- Unique: `number` (permanent, across all rows)

**`sales_invoice_lines` / `purchase_bill_lines`**
- `id`, `line_no`, `description`, `qty`, `unit_price`
- `account_id` (revenue, or expense/asset), `tax_code_id`, `line_amount`, `tax_amount`

**`payments`** — *posted immutable; drafts (if any) soft-deletable*
- `id`, `type` (RECEIPT / DISBURSEMENT), `partner_id`, `date`, `amount`
- `cash_bank_account_id`, `journal_entry_id`

**`payment_allocations`**
- `id`, `payment_id`, `document_type` (SALES_INVOICE / PURCHASE_BILL), `document_id`
- `amount_applied` — drives invoice/bill status transitions

### 5.3 Tax

**`tax_codes`** — *soft-deletable*
- `id`, `name` (e.g. "PPN Keluaran 11%", "PPh 23 Jasa 2%")
- `kind` (PPN_OUTPUT / PPN_INPUT / PPH_WITHHOLDING)
- `rate`, `tax_account_id`, `is_withholding`

### 5.4 Auth & audit

**`users`** — *soft-deletable*
- `id`, `email` (unique where `deleted_at IS NULL`), `password_hash`, `name`
- `role` (ADMIN / ACCOUNTANT / APPROVER / VIEWER), `is_active`

**`audit_log`** — *append-only, immutable*
- `id`, `user_id`, `action`, `entity_type`, `entity_id`, `metadata` (jsonb), `created_at`

## 6. Posting invariants (`PostingService`)

Every posting runs inside one DB transaction and guarantees:

1. **Balanced** — Σ debits = Σ credits, else `UnbalancedEntryError` (also a deferred
   DB constraint as a backstop).
2. **Open period** — no posting to a CLOSED period → `ClosedPeriodError`.
3. **Valid accounts** — no posting to non-postable or inactive accounts.
4. **Immutability** — posted entries are never updated or deleted. A correction
   creates a **reversal entry** (debits/credits swapped), linked via `reversal_of_id`.
5. **Gapless numbering** — entry numbers are sequential with no gaps, allocated under
   a row lock per fiscal year.

Balances are computed by aggregating `journal_lines` on demand (indexed). An
`account_period_balances` snapshot table is a clearly-marked optional optimization
to add only if reporting performance requires it (YAGNI until then).

## 7. Tax handling (PPN / PPh)

`TaxService` computes amounts from line `tax_code`s; `InvoicingService` assembles
the balanced entry. Rounding follows Indonesian convention (PPN rounded to whole
rupiah). PPN rate is data-driven via `tax_codes.rate` (seeded at **11%**, trivially
changeable to 12%).

**Sales invoice with PPN 11% (output VAT collected):**
```
Dr  Piutang Usaha               (subtotal + PPN)
   Cr  Pendapatan                          (subtotal)
   Cr  PPN Keluaran (Utang PPN)            (PPN)
```

**Purchase bill with PPN 11% (input VAT creditable):**
```
Dr  Beban / Persediaan          (subtotal)
Dr  PPN Masukan                 (PPN)
   Cr  Utang Usaha                         (subtotal + PPN)
```

**PPh withholding — we withhold from a vendor (e.g. PPh 23 on services):**
```
Dr  Beban Jasa                  (gross)
   Cr  Utang Usaha                         (gross − PPh23)
   Cr  Utang PPh 23                        (PPh23)
```

**PPh withholding — a customer withholds from us:**
```
Dr  Piutang Usaha               (total − PPh)
Dr  Uang Muka PPh / Prepaid PPh (PPh withheld by customer)
   Cr  Pendapatan                          (subtotal)
   Cr  PPN Keluaran                        (PPN)
```

**Multi-currency (v1):** documents carry `currency` + `exchange_rate`; converted to
IDR at the document rate when posting (the ledger is always IDR). FX revaluation at
period end is deferred — but the fields exist so no migration is needed later.

## 8. Reporting & period close

All reports are **read-only query services** over the ledger and subledgers,
returning structured JSON (presentation-agnostic).

| Report | Indonesian | Description |
|---|---|---|
| Trial Balance | Neraca Saldo | Per-account debit/credit balances; must net to zero |
| Balance Sheet | Neraca | Assets = Liabilities + Equity, grouped by `subtype` per SAK |
| Income Statement | Laba Rugi | Revenue − HPP − Expenses = net profit, for a period |
| Cash Flow | Arus Kas | Operating/Investing/Financing, **indirect method** (uses `cash_flow_category`) |
| General Ledger | Buku Besar | Per-account transaction detail with running balance |
| AR/AP Aging | Umur Piutang / Utang | Outstanding documents bucketed (current, 1–30, 31–60, 61–90, 90+) |

Arus Kas (indirect method) is the heaviest report and is built last and tested
against a known dataset.

**Period close (monthly):** closing a period sets `status = CLOSED`; `PostingService`
rejects postings dated within it. Reopening is Admin-only and audit-logged.

**Year-end close (annual):** a **closing journal entry** (`source_type = CLOSING`)
zeroes nominal accounts (Revenue, HPP, Expenses) into **Laba Ditahan (Retained
Earnings)**, carrying the net result into equity for the new fiscal year. Fiscal
year is configurable on the company; **default = calendar year (Jan–Dec)**.

**Statement integrity (enforced by tests):** trial balance always nets to zero;
Neraca always balances; net income on Laba Rugi reconciles to the equity movement
on the Neraca.

## 9. Data policies

### 9.1 Immutability

Posted journal entries, posted invoices/bills, and posted payments are **immutable**
and are never deleted or soft-deleted. Corrections are made via **reversal**
(ledger) or **void** (documents, which reverse their journal entry).

### 9.2 Soft delete

- Every soft-deletable table carries `deleted_at` (+ `deleted_by`).
- A global **Prisma Client extension** filters out rows where `deleted_at IS NOT
  NULL` on every query by default, so records are never physically removed.
- Hard `DELETE` is forbidden in application code; "delete" endpoints set `deleted_at`
  and are audit-logged.
- **Restore** is an Admin-only, audited action.
- Applies to **master data and unposted drafts** (accounts, partners, tax codes,
  users, draft invoices/bills/journals). Posted financial records are out of scope
  for deletion entirely (see §9.1).
- Unique constraints use **partial unique indexes scoped to `deleted_at IS NULL`**
  for reusable identifiers (e.g. account `code`, partner identifiers, user `email`),
  while permanent accounting identifiers (journal `entry_number`, invoice/bill
  `number`) remain unique across all rows forever.

### 9.3 Gapless numbering

Journal `entry_number` is sequential and gapless per fiscal year, allocated under a
row lock (Indonesian bookkeeping requirement).

## 10. Cross-cutting & production concerns

**Money & precision:** `NUMERIC(20,4)` in Postgres; `Prisma.Decimal` / `decimal.js`
in app code. A `Money` value object centralizes arithmetic and rounding (whole-rupiah
for tax/totals, 4 dp internally).

**Auth & RBAC:** JWT short-lived access token + refresh token; `argon2` hashing.
Roles **Admin / Accountant / Approver / Viewer**, with guards per endpoint (only
Approver/Admin can post or void; Viewer is read-only). Optional segregation-of-duties
check: the user who creates a draft can be blocked from posting it (config flag,
default on).

**Audit trail:** the append-only journal is the audit log for financial data; an
`audit_log` table records sensitive non-ledger actions (posts, voids, period
open/close, soft deletes/restores, user/role changes, logins) — who/what/when,
immutable.

**Validation, errors & idempotency:** `class-validator` DTOs; a global exception
filter returns a consistent envelope `{ code, message, details }`. Domain errors map
to clean 4xx responses. **Idempotency keys** on posting endpoints prevent
double-posting on retries.

**Security hardening:** `helmet`, CORS allow-list, rate limiting, request size
limits, secrets via env only, input whitelisting (no mass-assignment), parameterized
queries via Prisma.

**Observability & ops:** `pino` structured logging + request IDs; `/health`
(liveness) and `/ready` (readiness, checks DB) endpoints; OpenAPI/Swagger served.

**Config & deployment:** 12-factor env config; multi-stage `Dockerfile` +
`docker-compose.yml` (api + postgres); Prisma migrations run on deploy;
`.env.example` documented; DB backup guidance in the README; recommend a
Singapore/Jakarta region for data residency.

## 11. Testing strategy (TDD)

- Unit tests for posting, tax, and report math (pure functions where possible).
- Integration/e2e against a **real Postgres via `testcontainers`** — no mocked DB for
  accounting logic.
- **Accounting invariant tests** as a safety net: every posted entry balances; trial
  balance always nets to zero; reversals net to zero with their originals; Neraca
  always balances; soft-deleted rows are excluded from all default queries.
- Seed fixtures: SAK chart of accounts, default tax codes (PPN 11%, common PPh
  rates), an initial Admin user.

## 12. Build sequence

Each phase is shippable and tested before the next.

1. **Foundation** — project scaffold, config, Docker, Prisma, `Money` value object,
   soft-delete extension, auth + RBAC.
2. **Ledger core** — accounts, periods, `PostingService`, reversals, manual journals,
   SAK chart-of-accounts seed.
3. **Tax engine** — tax codes + `TaxService` calculation.
4. **Invoicing** — partners, sales invoices, purchase bills, payments & allocations,
   posting through the ledger.
5. **Reporting** — trial balance → Neraca → Laba Rugi → Buku Besar → AR/AP aging →
   Arus Kas.
6. **Close & hardening** — monthly period close, year-end close, audit log, final
   security/observability hardening pass.

## 13. Future phases (out of v1 scope)

- Full tax compliance: e-Faktur / Coretax e-invoicing, SPT, NPWP validation, tax reports.
- Bank reconciliation.
- Fixed assets & depreciation, inventory, payroll (PPh 21).
- Multi-currency FX revaluation at period end.
- `account_period_balances` snapshot optimization (if/when reporting needs it).
