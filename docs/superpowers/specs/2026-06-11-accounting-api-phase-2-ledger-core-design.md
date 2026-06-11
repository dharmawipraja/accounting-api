# Accounting API — Phase 2: Ledger Core — Design Spec

- **Date:** 2026-06-11
- **Status:** Approved (pending written-spec review)
- **Owner:** budi@maul.is
- **Builds on:** Phase 1 Foundation (merged) — NestJS + Prisma 7 + PostgreSQL, JWT auth + RBAC, soft-delete extension, `Money` value object, domain errors + exception filter.
- **Master spec:** `docs/superpowers/specs/2026-06-10-indonesian-accounting-api-design.md` (§5.1, §6, §8, §9.3 define the ledger; this spec refines Phase-2 decisions).

## 1. Overview

The general-ledger core: the double-entry engine every later phase posts through. It provides a chart of accounts, accounting periods, an immutable journal with a transactional `PostingService`, manual journal entries with a draft → post lifecycle, reversals, opening balances, and a trial balance that proves the books balance.

This is a single-tenant system; a `company_settings` singleton holds fiscal-year config and the segregation-of-duties flag.

### Goals
- Correct, atomic double-entry posting with an immutable, gapless, auditable journal.
- Draft → post workflow with role gating and configurable segregation of duties.
- A SAK-aligned seed chart of accounts that the company can edit.
- Opening balances for companies migrating from another system.
- A trial balance and account-balance queries that always reconcile.

### Non-goals (later phases)
- Year-end closing entries / retained-earnings roll (Phase 6).
- Invoices, bills, payments, tax postings (Phases 3–4) — they will *feed* this ledger.
- Financial statements beyond trial balance — Neraca, Laba Rugi, Arus Kas (Phase 5).
- `account_period_balances` snapshot optimization (deferred until reporting needs it).
- Multi-currency on the ledger (ledger is always IDR; FX is a document concern, later).

## 2. Scope

In: company-settings singleton · chart of accounts + management · accounting periods + monthly close/reopen · `PostingService` (gapless numbering) · manual journal entries (draft → post) · reversals · opening balances (auto-plug) · idempotent posting · SAK seed · trial balance + account-balance queries. Role-gated with configurable segregation of duties.

Out: year-end close, invoicing, tax engine, statements beyond trial balance (deferred as above).

## 3. Module layout

Two new NestJS modules on the Phase 1 foundation.

| Module | Responsibility |
|---|---|
| `CompanyModule` | Company-settings **singleton** (one row): legal name, NPWP, address, `fiscal_year_start_month` (default 1), base currency (IDR), `segregation_of_duties_enabled` (default true), PKP status. Seeded on first migration. |
| `LedgerModule` | Chart of accounts, accounting periods, journal sequences, journal entries/lines, `PostingService`, trial balance & balance queries. |

**Dependencies:** `LedgerModule` → `CompanyModule`, `PrismaModule`, `CommonModule` (`Money`). Consumes Phase 1 auth (`@Roles`, `@CurrentUser`, global guards). Nothing depends back on the ledger yet.

**`LedgerModule` internal services** (focused, independently testable; controllers stay thin):
- `AccountsService` — chart-of-accounts CRUD + hierarchy/validation.
- `PeriodsService` — period generation, open/close/reopen, `findOpenPeriodForDate` guard.
- `PostingService` — the transactional core: validate → number → write a balanced entry; reversals. **The only writer of POSTED entries.**
- `JournalService` — draft lifecycle, manual-entry assembly, `createAndPost`, opening balances; calls `PostingService` to post.
- `BalancesService` — trial balance + single-account balance aggregation (read-only).

All amounts use the `Money` value object and persist as `NUMERIC(20,4)`; `PostingService` checks Σdebit = Σcredit via `Money`.

## 4. Data model

Six tables. Money columns `NUMERIC(20,4)`; all carry `created_at`/`updated_at`.

### 4.1 `company_settings` (singleton — exactly one row, seeded on migration)
- `legal_name`, `npwp?`, `address?`, `fiscal_year_start_month` (1–12, default 1)
- `base_currency` (default `IDR`), `segregation_of_duties_enabled` (default `true`), `is_pkp` (default `true`)
- Singleton enforced (fixed id / unique-on-constant).

### 4.2 `accounts` (Bagan Akun) — *soft-deletable (tombstone on `code`)*
- `id`, `code`, `name`
- `type` (ASSET / LIABILITY / EQUITY / REVENUE / EXPENSE)
- `subtype` (CURRENT_ASSET, NON_CURRENT_ASSET, FIXED_ASSET, ACCUMULATED_DEPRECIATION, CURRENT_LIABILITY, NON_CURRENT_LIABILITY, EQUITY, REVENUE, COGS, OPERATING_EXPENSE, OTHER_INCOME, OTHER_EXPENSE, TAX_PAYABLE, TAX_RECEIVABLE)
- `cash_flow_category` (OPERATING / INVESTING / FINANCING / NONE, default NONE — Phase 5)
- `normal_balance` (DEBIT / CREDIT) — **stored explicitly** so contra accounts (e.g. Akumulasi Penyusutan) work
- `parent_id?`, `is_postable` (header = false), `is_active` (default true), `currency` (default IDR)
- `deleted_at?`, `deleted_by?`
- Unique `code` where `deleted_at IS NULL`. Posting allowed only to `is_postable && is_active`. Parent must be non-postable and type-compatible.

### 4.3 `accounting_periods` (Periode)
- `fiscal_year`, `sequence` (1–12), `name` (e.g. `2026-01`), `start_date`, `end_date`
- `status` (OPEN / CLOSED, default OPEN), `closed_at?`, `closed_by?`
- Unique `(fiscal_year, sequence)` and `name`. A date maps to exactly one period.

### 4.4 `journal_sequences` (gapless counter)
- `fiscal_year` (unique), `next_number` (default 1)
- One row per fiscal year; locked `FOR UPDATE` during posting; created lazily.

### 4.5 `journal_entries` (Jurnal) — *drafts soft-deletable; posted never deleted*
- `id`, `entry_number?` (int; null for drafts; gapless per `fiscal_year` on post), `entry_ref?` (display, `JE/2026/000123`)
- `fiscal_year?`, `date`, `period_id?` (set on post), `description`
- `source_type` (MANUAL / OPENING / REVERSAL), `source_id?`
- `status` (DRAFT / POSTED / REVERSED), `reversal_of_id?`, `reversed_by_id?`
- `created_by`, `posted_by?`, `posted_at?`, `deleted_at?`, `deleted_by?`
- `entry_number` unique per `fiscal_year`. Immutable once POSTED (only reversal link/status may change).

### 4.6 `journal_lines` (Baris Jurnal) — *not soft-deletable; editable while DRAFT, frozen once POSTED*
- `id`, `journal_entry_id`, `line_no`, `account_id`, `debit` (default 0), `credit` (default 0), `description?`
- DB `CHECK`: both ≥ 0 **and** exactly one of debit/credit > 0. Indexes on `account_id`, `journal_entry_id`.

### 4.7 `idempotency_keys`
- `key` (unique), `endpoint`, `result_entry_id?`, `created_at`. Records posting-operation keys for de-duplication (§8).

**Soft-delete registry:** add `Account` and `JournalEntry` to `SOFT_DELETE_MODELS`. `JournalLine` stays hard-managed (draft line edits replace rows; posted lines untouched) — services guard that only DRAFT entries' lines are mutated.

## 5. PostingService & invariants

`PostingService` is the only thing that creates posted entries, transitions drafts to posted, and writes reversals. Everything runs in one `prisma.$transaction`.

**`post(entry, postedBy)`** — atomic steps:
1. **Balanced** — Σdebit = Σcredit via `Money`; ≥ 2 lines; each line exactly one of debit/credit > 0 → else `UnbalancedEntryError` (422).
2. **Period** — find the OPEN period containing `date`; none or CLOSED → `ClosedPeriodError` (409).
3. **Accounts** — every `account_id` exists, `is_postable`, `is_active`, not soft-deleted → else `InvalidAccountError` (422).
4. **Segregation of duties** — if `segregation_of_duties_enabled`, require `postedBy ≠ created_by` → else `SegregationOfDutiesError` (403).
5. **Number** — derive `fiscal_year` from `date` + `fiscal_year_start_month`; `SELECT … FOR UPDATE` the `journal_sequences` row (create if missing), assign `entry_number = next_number`, set `entry_ref`, increment.
6. **Write** — entry (`POSTED`, `posted_by`, `posted_at`, `period_id`, `fiscal_year`, number) + lines; commit.

Any failure → rollback: **no number consumed, no partial write.** All four errors extend `DomainError` → clean envelopes via the Phase 1 filter.

**`reverse(entryId, reversedBy, date?)`:**
- Load entry; must be `POSTED` (not draft, not already reversed) → else error.
- New entry with debit/credit **swapped**, `source_type = REVERSAL`, `reversal_of_id = entryId`, description "Reversal of `<ref>`", `date` = reversal date (default original; must be in an OPEN period).
- Post it (own gapless number), then set original `status = REVERSED`, `reversed_by_id = newId` — same transaction. Net effect zero.

**Balance-inclusion rule:** a reversed original keeps its lines in the books (auditability). `BalancesService` aggregates lines from entries where **`posted_at IS NOT NULL`** (status `POSTED` *or* `REVERSED`), **not** `status = POSTED`. The reversed original *and* its reversal both count and net to zero. Drafts excluded.

## 6. Journal entry lifecycle, permissions & opening balances

**Draft → post** (`JournalService` owns drafts; `PostingService` owns the transition):
- `createDraft` / `updateDraft` — write a `DRAFT` entry + lines. Drafts **may be saved unbalanced** (WIP); line *shape* validated, Σ balance enforced only at post. Editing replaces lines.
- `deleteDraft` — soft-deletes (only while `DRAFT`).
- `postDraft` — hands the draft to `PostingService.post`; transitions the same row `DRAFT → POSTED`.
- `createAndPost` — create + post in one call (`POST /ledger/journal-entries?post=true`).

**SoD shapes the workflow:** `createAndPost` sets `created_by = posted_by = caller`, so with SoD **on**, one-person direct posting is blocked — an accountant must draft and a different approver post. With SoD **off**, a single approver/admin may `createAndPost`. The flag enforces the two-person control without separate code paths.

**Permissions:**

| Action | Roles |
|---|---|
| Create / edit / delete drafts | ACCOUNTANT, APPROVER, ADMIN |
| Post, reverse | APPROVER, ADMIN (+ SoD: poster ≠ creator) |
| Account create / update | ACCOUNTANT, APPROVER, ADMIN |
| Deactivate account, reopen period, post opening balances, edit company settings | ADMIN |
| Close period, generate periods | APPROVER, ADMIN |
| View entries / trial balance / balances | all authenticated (incl. VIEWER) |

**Opening balances:** a one-time `source_type = OPENING` entry, dated at the opening date (in an open period), ADMIN-only, posted through `PostingService` (all invariants apply). The user enters each account's opening balance; the system computes the balancing **plug to "Saldo Awal / Opening Balance Equity"** (a seeded account) so the entry balances — the standard migration pattern (the equity is later reclassified to capital/retained earnings).

## 7. Chart of accounts, SAK seed & periods

**`AccountsService`** — create (validate code uniqueness among active, coherent type/subtype/normal_balance, compatible non-postable parent); update (rename/reparent/retag; block changing `type` once the account has posted lines); **deactivate** (`is_active = false`, keeps history); soft-delete (only if no posted lines, else deactivate); list/tree.

**SAK-aligned seed** (Indonesian numbering `1-…`→`5-…`; headers `is_postable = false`, postable leaves). Ships accounts later phases depend on:

| Group | Key seeded accounts |
|---|---|
| 1 Aset | Kas, Bank, Piutang Usaha, Persediaan, **PPN Masukan**, Uang Muka PPh, Aset Tetap, Akumulasi Penyusutan *(contra, CREDIT)* |
| 2 Liabilitas | Utang Usaha, **PPN Keluaran / Utang PPN**, Utang PPh, Utang Bank |
| 3 Ekuitas | Modal, **Laba Ditahan**, **Saldo Awal (Opening Balance Equity)** |
| 4 Pendapatan | Pendapatan Penjualan, Pendapatan Lain-lain |
| 5 Beban | HPP, Beban Gaji, Beban Sewa, Beban Operasional, Beban Pajak |

Seeded **idempotently only when the CoA is empty** (re-running bootstrap never duplicates or overwrites edits) and fully editable afterward. The exhaustive list with final codes is pinned in the implementation plan.

**`PeriodsService`** — `generatePeriods(fiscalYear)` creates 12 monthly periods from `fiscal_year_start_month` (default Jan–Dec) with date ranges, all OPEN; the current fiscal year is generated on bootstrap. `findOpenPeriodForDate` (the `PostingService` guard); `close` (APPROVER/ADMIN); `reopen` (ADMIN, audited).

## 8. Trial balance, balance queries & idempotency

`BalancesService` (read-only; all authenticated roles). All sums use the `Money`/`Decimal` path.

**Trial Balance (Neraca Saldo)** — `GET /ledger/trial-balance?asOf=YYYY-MM-DD`
- Aggregates `journal_lines` (entries where `posted_at IS NOT NULL`, `date ≤ asOf`) grouped by account.
- Per postable account: `code`, `name`, total `debit`, total `credit`, `balance` on its normal side — plus **grand totals where Σdebit = Σcredit** (the built-in correctness check; a mismatch signals a data-integrity bug). Defaults to today; optional `fiscalYear` scope; `includeZero=false` by default.

**Single-account balance** — `GET /ledger/accounts/:id/balance?asOf=YYYY-MM-DD`
- Debit total, credit total, signed net balance as of the date (optional per-period movement).

**Idempotency:** posting operations (`/post`, `/reverse`, `/opening-balances`) accept an `Idempotency-Key` header. The key + endpoint are recorded in `idempotency_keys`; a repeated key returns the original result instead of posting again — preventing a retried request from creating a duplicate entry with its own gapless number.

## 9. API surface

All under the Phase 1 JWT guard; roles via `@Roles`; `@CurrentUser` supplies `created_by`/`posted_by`; errors use the Phase 1 envelope; OpenAPI auto-documents.

```
Company:    GET/PATCH  /company/settings                                 (PATCH: ADMIN)
Accounts:   POST       /ledger/accounts                                  (ACCOUNTANT+)
            GET        /ledger/accounts            (list/tree)           (all)
            GET/PATCH  /ledger/accounts/:id                              (PATCH: ACCOUNTANT+)
            POST       /ledger/accounts/:id/deactivate                   (ADMIN)
            DELETE     /ledger/accounts/:id        (if no posted lines)  (ADMIN)
            GET        /ledger/accounts/:id/balance                      (all)
Periods:    POST       /ledger/periods/generate                         (APPROVER/ADMIN)
            GET        /ledger/periods                                   (all)
            POST       /ledger/periods/:id/close                         (APPROVER/ADMIN)
            POST       /ledger/periods/:id/reopen                        (ADMIN)
Journals:   POST       /ledger/journal-entries  (draft; ?post=true)      (ACCOUNTANT+ / post: APPROVER+)
            GET        /ledger/journal-entries  (filter status/period/date) (all)
            GET        /ledger/journal-entries/:id                       (all)
            PATCH      /ledger/journal-entries/:id   (DRAFT only)        (ACCOUNTANT+)
            DELETE     /ledger/journal-entries/:id   (DRAFT only)        (ACCOUNTANT+)
            POST       /ledger/journal-entries/:id/post                  (APPROVER/ADMIN, SoD)
            POST       /ledger/journal-entries/:id/reverse               (APPROVER/ADMIN)
Opening:    POST       /ledger/opening-balances  (auto-plug)             (ADMIN)
Reports:    GET        /ledger/trial-balance?asOf=…                      (all)
```

Posting endpoints (`/post`, `/reverse`, `/opening-balances`) honor the `Idempotency-Key` header.

## 10. Testing strategy

TDD throughout with testcontainers (Phase 1 harness + `makePrismaOverride`). Unit tests for pure logic (balance math, fiscal-year/period derivation, line validation, trial-balance aggregation). Integration tests for `PostingService` end to end.

**Accounting-invariant safety net:**
- Every posted entry balances; **trial balance always nets to zero** (property test over N random balanced entries).
- **Reversal nets to zero** — balances after `reverse` equal balances before the original.
- **Gapless under failure** — force an error mid-post → no number consumed; numbers stay sequential.
- **Concurrency** — N concurrent posts for one fiscal year → `entry_number`s exactly 1..N, no gaps/dupes (proves the `FOR UPDATE` lock).
- Guards: posting to CLOSED period / inactive / non-postable account → correct domain errors.
- **SoD** — poster = creator blocked when on, allowed when off.
- Drafts excluded from balances; reversed originals included.
- **Idempotency** — same key on `/post` returns the original entry, no duplicate.
- Opening-balance auto-plug balances to Saldo Awal; seed is idempotent (run twice → no dupes).

## 11. Build sequence

Each step shippable and tested before the next.
1. `CompanyModule` — settings singleton + seed.
2. `AccountsService` + SAK chart seed + CoA endpoints.
3. `PeriodsService` — generate / close / reopen + open-period guard.
4. **`PostingService`** — numbering, balanced check, account/period/SoD guards, reversal (the heart; heaviest tests incl. concurrency).
5. `JournalService` — drafts, createAndPost, opening balances, endpoints + idempotency.
6. `BalancesService` — trial balance + account balance + endpoints.

## 12. Notes for later phases
- Invoicing/tax (Phases 3–4) post through `PostingService` with new `source_type`s (SALES_INVOICE, PURCHASE_BILL, PAYMENT) — the ledger needs no change to accept them.
- Year-end close (Phase 6) adds a `CLOSING` source that zeroes nominal accounts into Laba Ditahan.
- Statements (Phase 5) build on `BalancesService` aggregation + `cash_flow_category` / `subtype` groupings.
- `account_period_balances` snapshot is the first optimization to consider if trial-balance/statement queries get slow.
