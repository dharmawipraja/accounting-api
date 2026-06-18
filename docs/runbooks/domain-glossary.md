# Domain Glossary — Indonesian-GAAP (SAK) Accounting

This is a reference for developers without a finance background. Each entry defines an
accounting concept (with its Indonesian name where useful), then points at where it
lives in **this** codebase. It describes the rules the code actually implements — not
generic accounting theory. For how the modules fit together, see
[`./architecture.md`](./architecture.md).

All amounts are stored as `Decimal(20,4)` and serialized as 4-decimal **strings** —
never JS floats (see [Money](#money)). The reporting currency is the Indonesian rupiah
(IDR / `Rp`).

---

## Core ledger

### Double-entry bookkeeping (pembukuan berpasangan)
Every economic event is recorded as a balanced **journal entry**: the sum of debits
equals the sum of credits. An entry has ≥ 2 lines, and each line carries **exactly one**
of debit or credit as a positive amount (never both, never neither).
- App invariant: `assertBalanced()` in `src/ledger/posting/assert-balanced.ts` (≥ 2 lines,
  one-sided per line, total debit == total credit).
- DB invariant: a `CHECK` constraint on `journal_lines` enforces the one-sided rule at
  the database layer (one of `debit`/`credit` > 0, the other 0; see migrations).

### Normal balance (saldo normal)
The side on which an account type normally carries a positive balance. ASSET and EXPENSE
are **debit-normal**; LIABILITY, EQUITY, and REVENUE are **credit-normal**. Reports sign
each account by this so a balance reads as a positive magnitude.
- `NormalBalance` enum (`DEBIT` / `CREDIT`) and `Account.normalBalance` in
  `prisma/schema.prisma`.
- Signing logic: `BalancesService.toRow()` computes `balance` as `debit−credit` (debit-normal)
  or `credit−debit` (credit-normal) in `src/ledger/balances/balances.service.ts`.

### Debit / credit
Two sides of every line. Their accounting meaning depends on the account's normal
balance: a debit *increases* a debit-normal account and *decreases* a credit-normal one
(and vice-versa). They are bookkeeping directions, not "money in/out".
- Stored as `JournalLine.debit` / `JournalLine.credit`, both `Decimal(20,4)`, default 0.

---

## Chart of accounts

### Chart of accounts (bagan akun / daftar akun)
The master list of all accounts you can post to. Each account has a `code`, `name`,
`type`, `subtype`, `normalBalance`, a cash-flow classification, and an optional system
`role`. Accounts form a tree (`parentId`); only `isPostable` leaf accounts accept journal
lines (header accounts are for grouping).
- `Account` model in `prisma/schema.prisma`; postable/active checks in
  `PostingService.assertPostableAccounts` (`src/ledger/posting/posting.service.ts`).

### Account type
`AccountType` enum: `ASSET`, `LIABILITY`, `EQUITY`, `REVENUE`, `EXPENSE`. Drives both
normal-balance signing and which report an account appears on (ASSET/LIABILITY/EQUITY →
balance sheet; REVENUE/EXPENSE → income statement).

### Account subtype
`AccountSubtype` enum — a finer classification used to group report lines, e.g.
`CURRENT_ASSET`, `FIXED_ASSET`, `ACCUMULATED_DEPRECIATION` (a contra-asset),
`CURRENT_LIABILITY`, `REVENUE`, `COGS`, `OPERATING_EXPENSE`, `OTHER_INCOME`,
`OTHER_EXPENSE`, `TAX_PAYABLE`, `TAX_RECEIVABLE`. The income statement sections are built
from these (`src/reporting/income-statement.service.ts`).

### Cash-flow category
`CashFlowCategory` enum: `OPERATING`, `INVESTING`, `FINANCING`, `NONE`. Tags each
balance-sheet account so the (indirect) cash-flow statement can bucket its movement.
`NONE` falls into OPERATING.
- `Account.cashFlowCategory`; bucketed in `CashFlowService` (`src/reporting/cash-flow.service.ts`).

### Account role (system account)
`AccountRole` enum identifies the handful of accounts the engine must locate
programmatically, instead of hard-coding account codes: `CASH`, `AR_CONTROL`,
`AP_CONTROL`, `RETAINED_EARNINGS`, `OPENING_BALANCE_EQUITY`, `TAX_EXPENSE`. `CASH` may
be a set (multiple bank/cash accounts); the other five are singletons. New code should
identify system accounts via `account.role`, never by code string.
- `Account.role` (nullable) in `prisma/schema.prisma`. Examples: year-end close looks up
  `role: 'RETAINED_EARNINGS'`; cash flow sums `role === 'CASH'`; the income statement pulls
  the `role === 'TAX_EXPENSE'` line out separately.

---

## Journal entries and posting

### Journal entry (jurnal / bukti jurnal)
A single balanced transaction: a header (`date`, `description`, `sourceType`) plus its
lines. `sourceType` (`JournalSourceType`) records what produced it: `MANUAL`, `OPENING`,
`REVERSAL`, `SALES_INVOICE`, `PURCHASE_BILL`, `PAYMENT`, `CLOSING`.
- `JournalEntry` + `JournalLine` models; orchestration in `PostingService`.

### Draft vs posted (status)
`JournalStatus`: a `DRAFT` entry is editable and has **no** effect on balances; a `POSTED`
entry is immutable and counts. `REVERSED` marks an entry that has been undone. Reports
only count rows where `posted_at IS NOT NULL`.
- `JournalEntry.status` / `postedAt`. Posting path: `PostingService.post` /
  `postDraft` / `createPostedEntryInTx`. All balance queries filter `je.posted_at IS NOT NULL`
  in `src/ledger/balances/balances.service.ts`.

### Posting / `posted_at`
The act of committing a draft to the ledger: validates balance, segregation-of-duties,
that an OPEN period contains the date, that the fiscal year is not closed, and that all
accounts are postable; then assigns a number and sets `postedAt`. The "is this counted?"
rule keys off `posted_at`, not `status`.
- `PostingService.preparePosting` (out-of-transaction checks) + `createPostedEntryInTx`
  (in-transaction write); in-tx TOCTOU guard `assertPostablePeriodInTx`.

### Gapless entry number (nomor jurnal)
Posted entries get a per-fiscal-year sequential `entryNumber` and a human ref
`entryRef` like `JE/2026/000123`. Numbering is **gapless** because the counter is
locked-and-incremented (`FOR UPDATE`) inside the same transaction that writes the entry,
so a rolled-back post never burns a number.
- `PostingService.nextNumber` + `buildEntryRef`; `JournalSequence` model; unique
  `[fiscalYear, entryNumber]` on `JournalEntry`.

### Reversal (jurnal balik)
You never edit or delete a posted entry; you **reverse** it — post a new entry whose
debits/credits are swapped, which nets the original to zero. The original is marked
`REVERSED` (`reversedById`) and the new one has `sourceType = REVERSAL` and
`reversalOfId` pointing back. A unique index on `reversalOfId` prevents double-reversal.
- `PostingService.prepareReversal` / `reverseInTx` (lines created with `debit: l.credit,
  credit: l.debit`); `@@unique([reversalOfId])` on `JournalEntry`.

### Segregation of duties (SoD)
Internal control: for `MANUAL` entries, the user who posts must differ from the user who
created the entry (toggleable per company). Document-sourced entries are exempt.
- `CompanySettings.segregationOfDutiesEnabled`; enforced in `preparePosting` / `postDraft`.

---

## Periods and fiscal year

### Accounting period (periode akuntansi)
A monthly bucket with a status of `OPEN` or `CLOSED`. You can only post into the OPEN
period whose date range contains the entry date; closing a month freezes it.
- `AccountingPeriod` model (`fiscalYear`, `sequence`, `startDate`, `endDate`, `status`),
  `PeriodStatus` enum; open-period lookup in `PostingService.preparePosting`.

### Fiscal year (tahun buku / tahun fiskal)
The 12-month reporting year. It need not start in January: `fiscalYearStartMonth`
configures the start. A date's fiscal year is the calendar year if the month is ≥ the
start month, else the prior year.
- `CompanySettings.fiscalYearStartMonth`; `fiscalYearForDate()` in
  `src/common/dates/fiscal-year.ts`.

---

## Year-end close

### Year-end close (tutup buku akhir tahun)
At year end, the cumulative profit or loss — the net of all REVENUE and EXPENSE
movement for the year — is swept into **Laba Ditahan** (retained earnings) via one
`CLOSING` journal entry. This zeroes the P&L accounts so the next year starts fresh.
Net income is computed from **this year's movement** (`movementsBetween`), so closing a
later year before an earlier one does not double-count; close years **in order**.
- `YearEndCloseService.close` in `src/close/year-end-close.service.ts`; `RETAINED_EARNINGS`
  role account; `YearEndClosing` model (`status`, `closingEntryId`, `netIncome`).

### Reopen
Undoes a close by **reversing** the closing entry and flipping the year back to `OPEN`.
Reopening is allowed to write into a year that is still flagged CLOSED (it passes
`allowClosedYear` so the normal closed-year guard does not block its own reversal).
- `YearEndCloseService.reopen` (uses `prepareReversal`/`reverseInTx` with `allowClosedYear`).

### Advisory-lock serialization
Both close and reopen take a Postgres transaction-level advisory lock keyed on the
fiscal year, then re-check status under the lock, so two concurrent closes (or reopens)
can't post duplicate / orphaned closing entries.
- `pg_advisory_xact_lock(fiscalYear)` in `close()` / `reopen()`; posting takes the
  *shared* form `pg_advisory_xact_lock_shared` in `assertPostablePeriodInTx`.

### Closed-year guard
A closed fiscal year rejects new posts, draft-posts, reversals, and document voids until
it is reopened.
- `ClosedYearError` raised in `preparePosting`, `postDraft`, `prepareReversal`, and the
  in-tx `assertPostablePeriodInTx`.

---

## AR / AP and documents

### Subledger vs control account
Customer/vendor balances live in two places that must agree: the **subledger** (the
detail — individual invoices/bills and their `amountPaid`) and a single **control
account** in the general ledger (`AR_CONTROL` for receivables, `AP_CONTROL` for
payables). Posting a document debits/credits the control account; aging reports re-derive
the same total from the subledger and must reconcile to the control balance.
- Settlement account resolved by role: `findControlAccountId(prisma, 'AR_CONTROL')` in
  `src/invoicing/sales-invoices.service.ts`; passed as `settlementAccountId` into the tax
  engine, which puts it on the AR/AP side of the journal.

### Sales invoice / Accounts receivable (faktur penjualan / piutang usaha — AR)
What customers owe you. A `SalesInvoice` has lines, computed `subtotal` / `taxTotal` /
`withholdingTotal` / `total`, and an `amountPaid`. When posted, it debits AR (control)
and credits revenue + output VAT (see tax). Outstanding = `total − amountPaid`.
- `SalesInvoice` / `SalesInvoiceLine` models; posting via `DocumentPostingService.post`
  with `nature: 'SALE'`.

### Purchase bill / Accounts payable (tagihan pembelian / utang usaha — AP)
What you owe vendors — the mirror of a sales invoice. A `PurchaseBill` posts a debit to
expense + input VAT and a credit to AP (control).
- `PurchaseBill` / `PurchaseBillLine` models; posting with `nature: 'PURCHASE'`.

### Payment (pembayaran)
A cash receipt or disbursement that settles one or more documents. `direction` is
`RECEIPT` (money in, settles invoices) or `DISBURSEMENT` (money out, settles bills). A
payment debits/credits a `CASH` account against the AR/AP control account, and its
allocations increment each target document's `amountPaid`.
- `Payment` / `PaymentAllocation` models; `PaymentDirection` enum; logic in
  `src/invoicing/payments.service.ts` (control account chosen by `AR_CONTROL`/`AP_CONTROL`).

### Allocation & over-allocation guard
A `PaymentAllocation` ties part of a payment to a specific invoice/bill. You cannot
allocate more than a document's outstanding amount. At post time, each target row is
locked `FOR UPDATE` and outstanding (`total − amount_paid`) is re-verified, so concurrent
payments can't jointly over-pay.
- Pre-check and in-tx `FOR UPDATE` re-check in `PaymentsService` ("Allocation exceeds /
  now exceeds the document outstanding").

### Document lifecycle: DRAFT → POST → VOID
Documents (invoices, bills, payments) start `DRAFT` (no ledger effect), become `POSTED`
(journal entry written, control/subledger updated), and are undone with `VOID` — which
reverses the journal entry and unwinds `amountPaid` rather than deleting anything. A
draft can be soft-deleted; a posted document cannot.
- `DocumentStatus` enum (`DRAFT`/`POSTED`/`VOID`); shared `DocumentLifecycleService`
  (`softDeleteDraft`, `reverseWithGuard`) in `src/ledger/document-lifecycle.service.ts`.

---

## Indonesian tax

### Tax code & `TaxKind`
A `TaxCode` is a reusable rate + GL account with a `kind` (`TaxKind` enum): `PPN_OUTPUT`,
`PPN_INPUT`, `PPH_PAYABLE`, `PPH_PREPAID`. Sales may only carry `PPN_OUTPUT` / `PPH_PREPAID`;
purchases only `PPN_INPUT` / `PPH_PAYABLE`.
- `TaxCode` model (`kind`, `rate Decimal(9,6)`, `taxAccountId`); `ALLOWED_KINDS` map in
  `src/tax/tax.service.ts`.

### PPN — Pajak Pertambahan Nilai (VAT)
Value-added tax. On a sale you collect **output VAT** (`PPN_OUTPUT`, a credit to a
tax-payable account); on a purchase you pay **input VAT** (`PPN_INPUT`, a debit to a
tax-receivable account). Computed as base × rate, rounded once to whole rupiah per code.
- `TaxService.calculate`: output → credit, input → debit; `base.multiply(rate).roundToRupiah()`.

### PPh — Pajak Penghasilan (withholding income tax)
Tax withheld on income. On a sale your customer withholds from you → `PPH_PREPAID`
(a debit prepayment, an asset). On a purchase you withhold from the vendor → `PPH_PAYABLE`
(a credit you owe the tax office). Withholding *reduces* the cash settled.
- `TaxService.calculate`: prepaid → debit, payable → credit.

### Settlement amount
The net cash the document settles for: **`settlement = subtotal + PPN − PPh`**. This is
the amount posted to the AR/AP control account. A settlement that is zero or negative
(withholding ≥ gross) is rejected with a 422 because the ledger requires a positive
one-sided line.
- `settlement = subtotal.add(ppnTotal).subtract(pphTotal)` with the non-positive guard in
  `src/tax/tax.service.ts`; split into stored `taxTotal` / `withholdingTotal` in
  `DocumentPostingService.summarize`.

### Per-code rupiah rounding
Each tax code's total is rounded **once** to whole rupiah (`ROUND_HALF_UP`), matching
Indonesian Faktur Pajak (tax-invoice) rounding — not per-line, which would accumulate
rounding error.
- `Money.roundToRupiah()` applied to each code's aggregated base in `TaxService.calculate`.

### PKP status (`isPkp`)
A *Pengusaha Kena Pajak* is a VAT-registered business obligated to charge PPN. Modeled as
a company-level flag.
- `CompanySettings.isPkp` in `prisma/schema.prisma`. **Note:** `isPkp` is currently a stored
  setting only — `TaxService.calculate` does not branch on it (PPN is driven by the tax codes
  attached to each line). *Flagged: the "PKP gates PPN" rule is not enforced in code.*

---

## Reports

All reports are read-only and derive from `BalancesService` primitives
(`balancesAsOf`, `movementsBetween`, `trialBalance`, `accountBalance`), which sum posted,
non-deleted journal lines. Several reports emit a boolean self-check.

### Trial balance (neraca saldo)
Every account's total debits and credits as of a date; the grand `totalDebit` must equal
`totalCredit` (the double-entry proof for the whole ledger).
- `BalancesService.trialBalance` in `src/ledger/balances/balances.service.ts`.

### Balance sheet / Neraca
Assets, liabilities, and equity as of a date, grouped by subtype. Equity includes a
synthetic **Laba (Rugi) Berjalan** line = cumulative P&L (`Σ credit−debit` over
REVENUE+EXPENSE), since current-year profit hasn't been closed to retained earnings yet.
The `balanced` flag asserts **Assets = Liabilities + Equity**.
- `BalanceSheetService.generate` (`src/reporting/balance-sheet.service.ts`);
  `balanced: assets.total.equals(liabilities.total.add(totalEquity))`.

### Income statement / Laba rugi
Revenue and expense **movement** over a date range, sectioned into revenue, COGS (→ gross
profit), operating expense (→ operating profit), other income/expense (→ profit before
tax), then the `TAX_EXPENSE`-role line, yielding net income.
- `IncomeStatementService.generate` (`src/reporting/income-statement.service.ts`).

### Cash flow (laporan arus kas) — indirect method
Starts from net income (Σ cash-effect of P&L accounts), adds movements of non-cash
balance-sheet accounts bucketed by `cashFlowCategory` (OPERATING/INVESTING/FINANCING),
and ties to cash. The `reconciles` flag asserts **opening cash + net change = closing
cash** (`kasAwal + netChange == kasAkhir`), where cash = `role === 'CASH'` accounts.
- `CashFlowService.generate` (`src/reporting/cash-flow.service.ts`).

### AR / AP aging (umur piutang / umur utang)
Outstanding posted invoices/bills as of a date, bucketed by days past due
(`Current`, `1-30`, `31-60`, `61-90`, `>90`) and grouped by partner. `paid_as_of` is the
posted allocations on or before the as-of date, so the total reconciles to the AR/AP
control balance at that date.
- `AgingService.aging('AR' | 'AP', asOf)` (`src/reporting/aging.service.ts`).

### General ledger (buku besar)
One account's posted lines over a date range, with an opening balance and a per-line
running balance signed by the account's normal balance.
- `GeneralLedgerService.generate` (`src/reporting/general-ledger.service.ts`).

---

## Money

### Money (rupiah)
A value object wrapping `decimal.js` at **scale 4** with `ROUND_HALF_UP` (matching Faktur
Pajak rounding). It accepts only `string | Decimal` (never a JS `number`), so float
arithmetic can't sneak in; all monetary values persist as 4-decimal strings. `roundToRupiah()`
rounds to whole rupiah for tax. The currency is IDR (`CompanySettings.baseCurrency` /
`Account.currency` default `"IDR"`).
- `src/common/money/money.ts`; columns are `Decimal(20,4)` throughout `prisma/schema.prisma`.

---

## Business partner

### Business partner (mitra bisnis / pelanggan / pemasok)
A customer and/or vendor. Flags `isCustomer` / `isVendor` decide whether a partner can
appear on sales vs purchase documents; `npwp` is the Indonesian tax ID.
- `BusinessPartner` model in `prisma/schema.prisma`.
