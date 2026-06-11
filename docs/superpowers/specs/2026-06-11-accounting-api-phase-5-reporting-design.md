# Accounting API — Phase 5: Financial Reporting — Design Spec

- **Date:** 2026-06-11
- **Status:** Approved (pending written-spec review)
- **Owner:** budi@maul.is
- **Builds on:** Phases 1–4 (all merged). Reuses `BalancesService` (canonical `posted_at IS NOT NULL` SQL sums, `normalBalance` signing, `asOf` UTC-midnight truncation), the SAK chart metadata (`type`/`subtype`/`normalBalance`/`cashFlowCategory`/`parentId`/`code`), accounting periods, and the AR/AP subledger (`sales_invoices`/`purchase_bills` with `total`/`amountPaid`/`date`/`dueDate`, `payments` + `payment_allocations`).
- **Master spec:** `docs/superpowers/specs/2026-06-10-indonesian-accounting-api-design.md`.

## 1. Overview

Read-only financial reporting: Neraca (balance sheet), Laba Rugi (income statement), Buku Besar (general ledger detail), AR/AP aging, and Arus Kas (cash flow, indirect). Each is a JSON endpoint returning nested sections + subtotals + totals, as-of a date or over a from/to range. No new tables, no mutations.

### Goals
- Five structured-JSON reports composing the existing ledger + subledger.
- Built-in integrity checks (Neraca balances; aging ties to AR/AP control; cash flow reconciles to Δcash).
- Reuse `BalancesService` as the single source of balance rules.

### Non-goals (deferred)
- PDF/Excel/CSV export, scheduled/emailed reports, saved report definitions.
- Comparative columns (prior period / prior year).
- Date-versioned void handling in aging (a payment voided strictly after `asOf` is treated by its current status).
- All-accounts general-ledger dump (Buku Besar is per-account).

## 2. Module layout

A new read-only **`ReportingModule`** (`src/reporting/`), peer of `LedgerModule`/`TaxModule`/`InvoicingModule`. Imports `LedgerModule` (`BalancesService`, `AccountsService`, `PeriodsService`, `CompanyService`); uses `PrismaService` directly for subledger / GL-detail raw queries.

**`BalancesService` is extended** with two grouped primitives (sharing a private SQL builder with the existing `trialBalance`, so the `posted_at`/`normalBalance`/`asOf` rules stay in one place):
- `balancesAsOf(asOf): Promise<AccountBalanceRow[]>` — every account's cumulative `debit`/`credit`/signed `balance` as of a date, joined with `code`/`name`/`type`/`subtype`/`normalBalance`/`cashFlowCategory`/`parentId`.
- `movementsBetween(from, to): Promise<AccountBalanceRow[]>` — every account's summed `debit`/`credit`/signed net over `[from, to]` (date inclusive, UTC-truncated), same join.

Both filter `posted_at IS NOT NULL` (POSTED + REVERSED net out), exclude soft-deleted accounts, return 4dp decimal strings.

| Unit | Report | Composes |
|---|---|---|
| `BalanceSheetService` | Neraca | `balancesAsOf` |
| `IncomeStatementService` | Laba Rugi | `movementsBetween` |
| `GeneralLedgerService` | Buku Besar | per-account line query + `balancesAsOf` |
| `AgingService` | AR/AP aging | subledger raw SQL |
| `CashFlowService` | Arus Kas | `balancesAsOf` (two points) + `movementsBetween` |
| `ReportsController` | all six endpoints | — |

Reports take `asOf` (Neraca, aging) or `from`/`to` (Laba Rugi, Buku Besar, Arus Kas); the fiscal-year boundary for YTD figures derives from the company `fiscalYearStartMonth` (the existing `fiscalYearFor` logic).

## 3. Neraca (Balance Sheet) — as-of

Reads `balancesAsOf(asOf)`; groups `ASSET`/`LIABILITY`/`EQUITY` accounts by `type` then `subtype`, each line with its signed balance.
- **Aset:** Aset Lancar (`CURRENT_ASSET`), Aset Tetap (`FIXED_ASSET`/`NON_CURRENT_ASSET`) net of Akumulasi Penyusutan (`ACCUMULATED_DEPRECIATION`, credit-normal contra). `totalAssets`.
- **Liabilitas:** Lancar (`CURRENT_LIABILITY` incl. `TAX_PAYABLE`) + Jangka Panjang (`NON_CURRENT_LIABILITY`). `totalLiabilities`.
- **Ekuitas:** equity accounts (`EQUITY`) **plus a synthetic "Laba (Rugi) Berjalan" line** = cumulative-as-of net income = `balancesAsOf` summed over all `REVENUE`/`EXPENSE` accounts (signed: revenue − expense). Using the cumulative figure makes **Assets = Liabilities + Equity hold exactly whether or not year-end close has run**. The response also exposes the current-fiscal-year portion (`movementsBetween(fyStart, asOf)` over P&L) as a labelled sub-figure. `totalEquity`.

Returns the three sections (line accounts + subtotals), `totalAssets`/`totalLiabilities`/`totalEquity`, and `balanced: boolean` (`totalAssets === totalLiabilities + totalEquity`).

## 4. Laba Rugi (Income Statement) — from/to

Reads `movementsBetween(from, to)` over `REVENUE`/`EXPENSE` accounts (signed: revenue = net credit, expense = net debit), in SAK structure:
```
Pendapatan (REVENUE)
(−) Beban Pokok Penjualan (COGS)
= LABA KOTOR
(−) Beban Operasional (OPERATING_EXPENSE)
= LABA USAHA
(+) Pendapatan Lain-lain (OTHER_INCOME)
(−) Beban Lain-lain (OTHER_EXPENSE)
= LABA SEBELUM PAJAK
(−) Beban Pajak                ← income-tax-expense account, well-known code 5-9000
= LABA BERSIH
```
Each section lists accounts (code/name/amount) + subtotal; bold lines are computed subtotals. **Beban Pajak** is recognized by the well-known code `5-9000` and broken out after Laba Sebelum Pajak (excluded from Beban Lain-lain; zero if no movement). `LABA BERSIH` for a current-fiscal-year range equals Neraca's current-FY-earnings sub-figure (cross-report invariant).

## 5. Buku Besar (General Ledger detail) — per-account, from/to

`accountId` required. Returns `{ account, openingBalance, lines[], closingBalance }`:
- **openingBalance** = the account's signed cumulative balance as of `from − 1 day` (`balancesAsOf(from-1)` filtered to the account).
- **lines** = each posted journal line hitting the account with `date ∈ [from, to]`, ordered by `date` then `entryNumber`, each `{ date, entryRef, description, debit, credit, runningBalance }` (running = opening, then ± each line signed by `normalBalance`).
- **closingBalance** = opening + Σ movements (== `balancesAsOf(to)` for the account — self-check).

## 6. AR/AP Aging — as-of-historical

From the subledger. `/reports/ar-aging` (sales invoices + receipts) and `/reports/ap-aging` (purchase bills + disbursements); one `AgingService`.

For each document dated `≤ asOf`, currently POSTED (not VOID):
- **outstanding-as-of** = `total − Σ` allocation amounts from POSTED, non-VOID payments dated `≤ asOf`. Exclude documents with outstanding-as-of `≤ 0`.
- **bucket** by `daysPastDue = asOf − (dueDate ?? date)`: Current (`≤ 0`), 1–30, 31–60, 61–90, >90.

Grouped per partner: rows `{ ref, date, dueDate, total, paidAsOf, outstanding, bucket }` + per-partner bucket subtotals; grand totals per bucket + overall.

**Reconciliation invariant:** Σ AR outstanding-as-of == `accountBalance(1-1200, asOf)`; Σ AP == `accountBalance(2-1000, asOf)`.

## 7. Arus Kas (Cash Flow, indirect) — from/to

Identity: since every entry balances, `Δ(Kas+Bank) = Σ over all other accounts of (credit − debit) movement`. So each non-cash account's **cash effect** = `creditMovement − debitMovement` over the range; grouping by `cashFlowCategory` gives the statement and it reconciles to Δcash by construction.

Indirect presentation:
- **Arus Kas dari Operasi:** Laba Bersih (= Σ cash-effect of `REVENUE`/`EXPENSE` accounts) + Penyesuaian (non-P&L `OPERATING` accounts' cash effects — ΔPiutang, ΔPersediaan, ΔUtang, ΔUtang PPh, penyusutan add-back).
- **Arus Kas dari Investasi:** `INVESTING` accounts (ΔAset Tetap).
- **Arus Kas dari Pendanaan:** `FINANCING` accounts (ΔUtang Bank, ΔModal).
- **Kenaikan/(Penurunan) Kas** = O + I + F.
- **Kas Awal** (`balancesAsOf(from-1)` over Kas `1-1000` + Bank `1-1100`) **+ change = Kas Akhir** (`balancesAsOf(to)`) → `reconciles: boolean`.

Cash accounts identified by well-known code (`1-1000`, `1-1100`). Any non-cash account with `cashFlowCategory = NONE` defaults into Operating so nothing is dropped and the statement always ties.

## 8. API surface

All reads → any authenticated user (incl. `VIEWER`); global JWT guard, no `@Roles`. `{code,message,details}` envelope; OpenAPI-documented; money as 4dp strings.

```
GET /reports/balance-sheet?asOf=YYYY-MM-DD          (Neraca; asOf default today)
GET /reports/income-statement?from=&to=            (Laba Rugi)
GET /reports/general-ledger?accountId=&from=&to=   (Buku Besar)
GET /reports/ar-aging?asOf=                        (AR aging; asOf default today)
GET /reports/ap-aging?asOf=                        (AP aging; asOf default today)
GET /reports/cash-flow?from=&to=                   (Arus Kas)
```
Query DTOs: `asOf`/`from`/`to` `@IsDateString` (range reports require `from`/`to`); `accountId` `@IsUUID`; `from ≤ to` → 422 otherwise.

## 9. Testing strategy

TDD; testcontainers (Phase 1–4 harness). Each report e2e seeds a realistic posted scenario through the existing services (opening balances + a sales invoice + a receipt + a purchase bill) so numbers are real and tie across reports. Invariants:
- **Neraca:** `balanced` holds; synthetic earnings line present.
- **Cross-report tie:** Laba Rugi `LABA BERSIH` (FY) == Neraca current-FY-earnings sub-figure.
- **Buku Besar:** opening + Σ lines == closing == `accountBalance(to)`; running balance correct.
- **Aging:** Σ outstanding-as-of == `accountBalance(1-1200/2-1000, asOf)`; overdue vs current vs partially-paid land in the right buckets.
- **Cash flow:** `reconciles` (Kas Awal + ΣO+I+F == Kas Akhir).
- Endpoint structure + role access (VIEWER can read); `from > to` → 422.

## 10. Build sequence

1. **Foundation** — `ReportingModule` skeleton + `BalancesService` `balancesAsOf`/`movementsBetween` primitives + tests (the existing posting/balances e2e must stay green).
2. **Neraca + Laba Rugi** — `BalanceSheetService` + `IncomeStatementService` + endpoints + e2e (balanced + cross-report tie).
3. **Buku Besar** — `GeneralLedgerService` + endpoint + e2e (opening/running/closing).
4. **AR/AP aging** — `AgingService` + endpoints + e2e (buckets + control reconciliation).
5. **Arus Kas** — `CashFlowService` + endpoint + e2e (reconciliation to Δcash).

## 11. Notes for later phases
- Phase 6 (year-end close) moves prior-year P&L into Laba Ditahan; the Neraca synthetic earnings line then naturally narrows to the current year.
- PDF/Excel export, comparative periods, and scheduled reports build on these JSON endpoints when scoped.
- A dedicated `CASH` subtype or `isCash` flag (vs the well-known-code approach) and an `INCOME_TAX_EXPENSE` subtype (vs recognizing `5-9000`) would remove the two by-code conventions; deferred to avoid a chart/schema change.
