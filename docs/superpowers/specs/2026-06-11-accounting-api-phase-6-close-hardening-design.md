# Accounting API — Phase 6: Year-End Close & Hardening — Design Spec

- **Date:** 2026-06-11
- **Status:** Approved (pending written-spec review)
- **Owner:** budi@maul.is
- **Builds on:** Phases 1–5 (all merged). Reuses `PostingService` (tx-composable `preparePosting`/`createPostedEntryInTx`/`prepareReversal`/`reverseInTx`, gapless numbering), `BalancesService` (`balancesAsOf`), `AccountsService`, `PeriodsService`, `CompanyService` (`fiscalYearStartMonth`), the chart (Laba Ditahan 3-2000, REVENUE/EXPENSE nominal accounts), JWT/RBAC, soft-delete extension, testcontainers harness.
- **Master spec:** `docs/superpowers/specs/2026-06-10-indonesian-accounting-api-design.md`.

## 1. Overview

The production-hardening finale: **year-end close** (zero the P&L into retained earnings, with a reversible lock), the **year-lock posting guard**, and an **append-only audit log**. Three cohesive "close & governance" pieces, no new business documents.

### Goals
- Year-end close: one reversible CLOSING journal entry zeroing all REVENUE/EXPENSE accounts into Laba Ditahan (3-2000), tracked by a `year_end_closings` record.
- A year-level lock that blocks new posting into a closed fiscal year.
- An append-only `audit_log` of every mutating request, captured by a global interceptor.

### Non-goals (deferred)
- Income-summary clearing account (direct close to Laba Ditahan instead).
- Blocking reversals in a closed year (the lock blocks new posting; reversals stay allowed).
- Failed-auth / security-event logging (the interceptor runs after guards, so it audits authenticated mutations only).
- DB-level append-only enforcement (triggers/REVOKE) — the app simply never mutates `audit_log`.
- Audit-log retention/archival/export.

## 2. Module layout

Two new modules:
- **`CloseModule`** (`src/close/`) — `YearEndCloseService` + `ClosingController`. Imports `LedgerModule` (PostingService, BalancesService, AccountsService, PeriodsService) + `CompanyModule`.
- **`AuditModule`** (`src/audit/`) — `AuditService` (writes the log), `AuditInterceptor` (registered globally via `APP_INTERCEPTOR`), `AuditController` (read endpoint).

Both registered in `AppModule`.

**Dependency direction:** the year-lock guard lives in `PostingService.preparePosting` and reads `prisma.client.yearEndClosing` **directly** (a plain `findFirst`), so `LedgerModule` does NOT depend on `CloseModule`. `CloseModule` depends on the ledger, one-way (acyclic).

## 3. Data model

New `enum CloseStatus { OPEN, CLOSED }`; extend `JournalSourceType` with `CLOSING`.

**`year_end_closings`** (not soft-deletable)
- `fiscalYear Int @id`, `status CloseStatus`, `closingEntryId String?`, `netIncome Decimal(20,4) @default(0)`, `closedAt`, `closedBy`, `reopenedAt DateTime?`, `reopenedBy String?`, `updatedAt`
- One row per fiscal year; `status=CLOSED` is the lock. Reopen flips to `OPEN`; re-close updates the same row (new `closingEntryId`). `@@map("year_end_closings")`

**`audit_log`** (append-only — NOT soft-deletable, never updated/deleted by the app)
- `id`, `timestamp DateTime @default(now())`, `userId String?`, `userRole String?`, `method String`, `path String`, `params Json?`, `body Json?` (sanitized), `statusCode Int`, `durationMs Int`, `ip String?`
- `@@index([timestamp])`, `@@index([userId])`, `@@map("audit_log")`

**Laba Ditahan cash-flow fix:** the migration runs `UPDATE accounts SET cash_flow_category = 'FINANCING' WHERE code = '3-2000'`, and the chart seed (`chart-of-accounts.seed.ts`) is updated to seed 3-2000 with `cashFlowCategory: 'FINANCING'` (fresh DBs and existing DBs agree). Closing entries then surface in the cash-flow statement's FINANCING section, not Operating.

Hand-authored migration (Prisma 7 `migrate dev` needs a TTY): create the two tables, add the `CLOSING` enum value, run the Laba Ditahan UPDATE. Then `migrate deploy` + `generate`.

## 4. Year-end close & reopen (`YearEndCloseService`)

**`close(fiscalYear, closedBy)`** (ADMIN):
1. Guard: reject if `year_end_closings.status` is already `CLOSED` (409 ConflictDomainError).
2. Compute `yearEnd` = last day of the fiscal year from the company `fiscalYearStartMonth` (start month 1 → Dec 31 of `fiscalYear`; start month 7 → Jun 30 of `fiscalYear+1`).
3. `balancesAsOf(yearEnd)` → `REVENUE`/`EXPENSE` rows with non-zero raw position (`debit − credit`).
4. Build the CLOSING entry — to zero each account, post the **opposite** of its raw position (`position>0 → credit:position`; `position<0 → debit:−position`), so any balance (incl. abnormal/contra) zeroes; the balancing plug is Laba Ditahan 3-2000: `netIncome = Σ(credit − debit)` over P&L → `credit: netIncome` if profit, `debit: −netIncome` if loss. `sourceType=CLOSING`, dated `yearEnd`, description "Year-end close FY<fiscalYear>".
5. One transaction: `preparePosting(closingInput, closedBy)` (the year-end month must be OPEN; year not yet closed so the guard passes) → `createPostedEntryInTx` → upsert `year_end_closings {status:CLOSED, closingEntryId, netIncome, closedAt, closedBy}`.
6. **Empty-year edge:** if there are no non-zero P&L accounts, mark the year `CLOSED` with `closingEntryId=null`, `netIncome=0` (skip the entry — avoids an invalid <2-line posting).

**`reopen(fiscalYear, reopenedBy)`** (ADMIN):
- Guard: must be `CLOSED`.
- One transaction: flip to `OPEN` (`reopenedAt`/`By`); if `closingEntryId` set, `reverseInTx` it (re-opens the P&L). The year then accepts corrections and can be re-closed.

Balance-sheet accounts carry forward automatically (the GL is cumulative); no opening-balance entry for the new year is created.

## 5. The year-lock posting guard

In `PostingService.preparePosting`, after `fiscalYearFor(...)`, add one check: `findFirst` on `year_end_closings` for that fiscal year — if `status=CLOSED`, throw `ClosedYearError` (new domain error, 409). This blocks **all new posting** into a closed year (manual entries, sales invoices, purchase bills, payments — all route through `preparePosting`).

**NOT added to `prepareReversal`** — reversals stay allowed in a closed year so (a) `reopen`'s own closing-entry reversal runs, and (b) a void/correction-via-reversal of a prior document remains possible. The lock enforces finality of *new* recorded transactions; reversals are themselves auditable. Existing Phase-1–5 posting behavior in an open year is unchanged.

## 6. Audit log

**`AuditInterceptor`** (global `APP_INTERCEPTOR`): for every mutating request (POST/PATCH/PUT/DELETE; GET/HEAD/OPTIONS skipped), records via `AuditService` — on both success and error (rxjs `tap`/`catchError`) — `{timestamp, userId, userRole (from req.user; null for public routes), method, path, params, body, statusCode, durationMs, ip}`.
- **Sanitization:** `body` is recursively scrubbed — keys matching `/password|token|secret|authorization/i` → `'[REDACTED]'` (so `POST /auth/login` logs without the password).
- One append-only insert per write.

**`AuditService.record(entry)`** — single insert into `audit_log`.

**`AuditController`** — `GET /audit` (ADMIN): list entries, filterable by `userId`/`method`/`from`/`to`, paginated (`limit` default 50 / `offset`), newest first. No write/delete endpoints.

Note: guards run before interceptors, so guard-rejected requests (failed-auth 401, role 403) are not captured here — the interceptor audits authenticated mutations.

## 7. API surface & roles

```
POST /close/year-end             {fiscalYear}              (ADMIN)
POST /close/year-end/:fy/reopen                            (ADMIN)
GET  /close/year-end/:fy                                   (any auth) → status + netIncome + closingEntryId
GET  /audit  (userId/method/from/to, limit/offset)         (ADMIN)
```
`{code,message,details}` envelope; money 4dp; OpenAPI-documented. DTOs validate `fiscalYear` (`@IsInt`), audit filters (`@IsOptional` `@IsDateString`/`@IsInt`).

## 8. Testing strategy

TDD; testcontainers (Phase 1–5 harness).
- **Close:** seed posted revenue + expense in 2026; `close(2026)` → CLOSING entry dated year-end; `balancesAsOf` over P&L == 0 after close; Laba Ditahan balance == net income; `year_end_closings` `CLOSED`. **Cross-report invariant:** Neraca at year-end shows synthetic "Laba Berjalan" == 0, net income in Laba Ditahan.
- **Lock:** a new entry dated in 2026 → `ClosedYearError` 409; an entry in 2027 → OK; re-close 2026 → 409.
- **Reopen:** `reopen(2026)` → closing entry reversed, P&L restored, year `OPEN`, posting into 2026 allowed; empty-year close → closes with no entry.
- **Cash-flow regression:** after close, Arus Kas still `reconciles` (closing entry non-cash; Laba Ditahan FINANCING).
- **Audit:** a POST writes one `audit_log` row (right userId/method/path/status); a GET writes none; `POST /auth/login` body `password` redacted; `GET /audit` ADMIN-only (non-ADMIN → 403).
- **Regression:** full Phase 1–5 suite green (the `preparePosting` year-guard doesn't break open-year posting; the Laba Ditahan `cashFlowCategory` change doesn't break cash-flow tests).

## 9. Build sequence

1. **Foundation** — schema (`year_end_closings`, `audit_log`, `CLOSING` enum, Laba Ditahan `cashFlowCategory` data-fix) + hand-authored migration + `CloseModule`/`AuditModule` skeletons + chart-seed `cashFlowCategory` update + the `ClosedYearError` domain error.
2. **Year-end close** — `YearEndCloseService` (close/reopen) + the `preparePosting` year-lock guard + `ClosingController` + e2e (zeroes P&L, locks, reopen restores, Neraca/cash-flow invariants; Phase-1–5 regression green).
3. **Audit log** — `AuditService` + global `AuditInterceptor` + `AuditController` + e2e (mutations logged, reads not, sanitization, ADMIN read).

## 10. Notes / future
- Full year immutability (blocking reversals in a closed year) and failed-auth security-event logging are deferrable hardening.
- Audit-log retention/archival, and DB-level append-only enforcement (triggers), are future ops concerns.
- This is the final planned phase; the master-spec deferred list (e-Faktur/Coretax, SPT, bank reconciliation, fixed-asset depreciation, inventory, payroll, multi-currency) remains out of scope.
