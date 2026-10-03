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
lines (header accounts are for grouping). A child's `parentCode` must name a live,
active header (read `FOR SHARE` in the create tx); a header with live children cannot
be deleted, nor deactivated while any child is active (`422` `details.reason
'HAS_CHILDREN'`, `AccountsService.lockForRetire`). The mirror rule: a child cannot be
reactivated (`PATCH { isActive: true }`) under an inactive header (`422` `details.reason
'PARENT_INACTIVE'`, `{ id, parentId }`; child `FOR UPDATE` then header `FOR SHARE`,
`AccountsService.lockForReactivate`).
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
`AP_CONTROL`, `RETAINED_EARNINGS`, `OPENING_BALANCE_EQUITY`, `TAX_EXPENSE`,
`CUSTOMER_ADVANCE` (2-1300 Uang Muka Pelanggan), `VENDOR_ADVANCE` (1-1600 Uang Muka
Pembelian). `CASH` may be a set (multiple bank/cash accounts); the others are singletons. New code should
identify system accounts via `account.role`, never by code string.
- Singleton roles are create-only. `CASH` may also be assigned later with
  `PATCH /ledger/accounts/:id {role: 'CASH'}` — only to a postable, debit-normal `ASSET`
  with no role (e.g. a bank account created before roles existed). Create with
  `role: 'CASH'` applies the same shape rule; both go through the single pure check
  `assertCashAssignable` (`src/ledger/accounts/cash-role.ts`). A role cannot be cleared
  (`{role: null}` → `400`).
- `Account.role` (nullable) in `prisma/schema.prisma`. Examples: year-end close looks up
  `role: 'RETAINED_EARNINGS'`; cash flow sums `role === 'CASH'`; the income statement pulls
  the `role === 'TAX_EXPENSE'` line out separately.

---

## Journal entries and posting

### Journal entry (jurnal / bukti jurnal)
A single balanced transaction: a header (`date`, `description`, `sourceType`) plus its
lines. `sourceType` (`JournalSourceType`) records what produced it: `MANUAL`, `OPENING`,
`REVERSAL`, `SALES_INVOICE`, `PURCHASE_BILL`, `PAYMENT`, `CLOSING`, `SALES_CREDIT_NOTE`,
`PURCHASE_DEBIT_NOTE`.
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
  (in-transaction write); in-tx TOCTOU guard `assertPostablePeriodInTx`, then the line
  accounts are re-validated `FOR SHARE` (sorted by id) before the sequence. Account
  deactivate/delete take the account row `FOR UPDATE`, so they serialize with posting;
  accounts with a singleton `role` can never be deactivated or deleted. A `CASH` account
  can, but only when its posted balance is zero (read under that row lock) and at least
  one OTHER active, postable `CASH` account remains (checked under advisory lock
  `71_003_001`); otherwise `422` with `details.balance` / `details.otherActiveCashAccounts`.
- **Inactive accounts.** Every post requires active accounts (`422 INVALID_ACCOUNT`)
  **except** a `CLOSING` entry (`CLOSING_POLICY.allowInactive` in
  `src/ledger/posting/account-policy.ts`): a P&L account deactivated mid-year still has
  movement the year-end close must zero. Reversals (incl. document voids) skip the account
  re-check entirely — they only undo an already-posted movement — so a void may post to a
  deactivated `CASH` account and leave it with a non-zero balance. That is accepted and
  recoverable: reactivate it and move the balance with a manual entry.
- **Opening balances are balance-sheet only.** `OPENING_POLICY.forbiddenTypes`
  (`src/ledger/posting/account-policy.ts`) makes every `sourceType: 'OPENING'` post —
  not just `JournalService.postOpeningBalances` — reject `REVENUE`/`EXPENSE` accounts
  (`422 { accountId, reason: 'PNL_IN_OPENING' }`); mid-year YTD P&L is entered as a
  `MANUAL` journal.
- **One live opening entry.** A new `OPENING` post while another `OPENING` entry is
  `POSTED` (not reversed) → `409 CONFLICT { existingEntryId, entryRef }`. To correct the
  opening balances, reverse the existing entry (`POST /ledger/journal-entries/:id/reverse`)
  and post the corrected set. Checked in the post tx by
  `PostingService.assertOpeningAllowedInTx` under advisory lock `71_004_001`
  (`OPENING_LOCK_KEY`), so two concurrent opening posts can't both pass.
- The in-tx period re-check throws the same `ClosedPeriodError` (`409 CLOSED_PERIOD`) as
  the pre-tx check. Direct post / postDraft / reversal transactions run with
  `POSTING_TX_OPTIONS` (`maxWait 5s`, `timeout 20s`); a breach is Prisma `P2028` → `409
  CONFLICT { retryable: true }` (`isTransientConflict`).

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
- A reversal may be dated later than the original (never earlier; enforced in
  `prepareReversal`). The generic `POST /ledger/journal-entries/:id/reverse` only reverses
  `MANUAL`/`OPENING` entries (`JournalService.reverse`); document-owned entries are undone
  by voiding the document, and `CLOSING` entries by reopening the year.

### Segregation of duties (SoD)
Internal control: for manual journal entries, sales invoices, purchase bills, credit/debit notes and payments,
the user who posts must differ from the user who created it (toggleable per company; 403
`SEGREGATION_OF_DUTIES`). Otherwise one user could create and post a vendor bill and then
pay it. `OPENING` (admin-only, created and posted in one call), `CLOSING` and `REVERSAL`
entries are exempt.
- `CompanySettings.segregationOfDutiesEnabled`; `SOD_SOURCES` in `company.service.ts`;
  enforced in `preparePosting` (documents and payments post through it) / `postDraft`.

---

## Periods and fiscal year

### Accounting period (periode akuntansi)
A monthly bucket with a status of `OPEN` or `CLOSED`. You can only post into the OPEN
period whose date range contains the entry date; closing a month freezes it.
- `AccountingPeriod` model (`fiscalYear`, `sequence`, `startDate`, `endDate`, `status`),
  `PeriodStatus` enum; open-period lookup via `PeriodsService.resolveOpenPeriodForDate`
  (auto-generates a missing CURRENT or NEXT fiscal year only; boot pre-generates both;
  generation serialized by advisory lock 71_002_001).

### Fiscal year (tahun buku / tahun fiskal)
The 12-month reporting year. It need not start in January: `fiscalYearStartMonth`
configures the start. A date's fiscal year is the calendar year if the month is ≥ the
start month, else the prior year.
- `CompanySettings.fiscalYearStartMonth`; `fiscalYearForDate()` in
  `src/common/dates/fiscal-year.ts`. Changeable only while no journal entry, CLOSED
  period or year-end close exists; a change regenerates the OPEN periods (current + next
  fiscal year).

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
- **Requires the fiscal year's LAST period OPEN.** The closing entry is dated on the
  fiscal year-end (and reopen's reversal on the same date), so both go through the normal
  open-period guard → `409 CLOSED_PERIOD` if the last month is closed. Close the year
  before closing its last month (or reopen that month first).
- Deactivated P&L accounts are included (the `CLOSING` policy skips the `isActive`
  check); close → reopen → re-close all work.
- **Only an ended year.** The fiscal year-end must be strictly before today (WIB, via
  `asOfOrToday`) → else `422 { fiscalYear, yearEnd }` (`yearNotEndedViolation` in
  `src/close/close-date-rule.ts`). E2E fixtures therefore close past years (e.g. 2006+),
  never the current/next one.

### Reopen
Undoes a close by **reversing** the closing entry and flipping the year back to `OPEN`.
Reopening is allowed to write into a year that is still flagged CLOSED (it passes
`allowClosedYear` so the normal closed-year guard does not block its own reversal).
- `YearEndCloseService.reopen` (uses `prepareReversal`/`reverseInTx` with `allowClosedYear`).
  The `closingEntryId` to reverse is re-read **under the exclusive year lock** (inside the
  reopen tx), never taken from the unlocked pre-check — a reopen + re-close that committed
  in between replaced it.

### Advisory-lock serialization
Both close and reopen take a Postgres transaction-level advisory lock keyed on the
fiscal year, then re-check status under the lock, so two concurrent closes (or reopens)
can't post duplicate / orphaned closing entries. Close computes the year's net income
(the P&L movement it sweeps to Laba Ditahan) **inside that tx, under the exclusive
lock**: every in-flight post holds the *shared* lock, so close waits them out, sees each
committed entry, and no new post can land in the year until close commits — nothing is
left unclosed. The pre-tx "already CLOSED" read is only a fast path; the locked re-check
is authoritative.
- `pg_advisory_xact_lock(fiscalYear)` in `close()` / `reopen()`; posting takes the
  *shared* form `pg_advisory_xact_lock_shared` in `assertPostablePeriodInTx`.

All advisory keys in use (all transaction-scoped, auto-released at commit/rollback;
keep new keys out of these ranges):

| Key | Mode | Taken by | Serializes |
| --- | --- | --- | --- |
| fiscal year int (e.g. `2026`) | **shared** | `assertPostablePeriodInTx` (every posted write) | posts vs close/reopen |
| fiscal year int | **exclusive** | `YearEndCloseService.close()` / `reopen()` | close/reopen vs each other and vs posts |
| `71_001_001` (`USER_ADMIN_LOCK_KEY`) | exclusive | `UserAdminService` update/remove | admin-pool mutations (last-admin rail) |
| `71_002_001` (`PERIOD_GENERATION_LOCK_KEY`) | exclusive | `generatePeriods`, `CompanyService.update` (start-month change) | period generation vs start-month change |
| `71_003_001` (`CASH_RETIRE_LOCK_KEY`) | exclusive | `AccountsService` deactivate/delete of a `CASH` account | CASH retirements vs each other (last-CASH rail) |
| `71_004_001` (`OPENING_LOCK_KEY`) | exclusive | `PostingService.assertOpeningAllowedInTx` (every `OPENING` post; taken first, before the fiscal-year lock) | opening posts vs each other (one-live-opening + AR/AP-before-documents rails) |

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
  The journal preview resolves it the same way (a client `settlementAccountId` is
  deprecated and ignored). Sales lines may not use a **contra-revenue** account
  (`REVENUE` with a `DEBIT` normal balance) → `422 {accountId, reason: 'CONTRA_REVENUE'}`
  — returns belong to credit notes (backlog). Symmetrically, purchase lines may not use a
  **contra-expense** account (`EXPENSE` with a `CREDIT` normal balance, e.g. Potongan/Retur
  Pembelian) → `422 {accountId, reason: 'CONTRA_EXPENSE'}` — purchase returns/discounts
  belong to debit notes (backlog).
- **Control accounts are document-only.** A `MANUAL` journal entry (direct post, draft
  create, draft post) may not touch an `AR_CONTROL`/`AP_CONTROL` account → `422
  VALIDATION_FAILED` `{ accountId, role }` (`src/ledger/posting/account-policy.ts`, enforced
  in `PostingService`). Invoice/bill **lines** may not use a `CASH`/`AR_CONTROL`/`AP_CONTROL`
  account or a tax account (any `tax_codes.tax_account_id`); sales lines must be `REVENUE`
  (or subtype `OTHER_INCOME`), purchase lines `EXPENSE` or `ASSET`; a payment's
  `cashAccountId` must be a `CASH`-role account
  (`src/invoicing/document-account-rules.ts`). All are checked at create/update and
  re-checked inside the post transaction; the journal preview applies the same rules.
  Reversals, document postings, `CLOSING` and `OPENING` entries are not restricted.
- **Caveat — opening balances on AR/AP.** `OPENING` entries (`POST
  /ledger/opening-balances`) *may* post to the control accounts (the go-live path), but a
  lump opening AR/AP balance has no subledger documents behind it, so aging will **not**
  tie to the control balance by that amount. To keep aging == control, enter open
  customer/vendor balances at go-live as dated (backdated) invoices/bills instead.
  The lump-sum route is only open **before the first document**: once any sales
  invoice, purchase bill or payment exists (any status; a soft-deleted draft doesn't
  count), an `OPENING` line on `AR_CONTROL` / `AP_CONTROL` → `422 { accountId, role,
  reason: 'DOCUMENTS_EXIST' }` — after go-live a control-account move with no document
  behind it would drift the subledger↔control reconciliation.

### Sales invoice / Accounts receivable (faktur penjualan / piutang usaha — AR)
What customers owe you. A `SalesInvoice` has lines, computed `subtotal` / `taxTotal` /
`withholdingTotal` / `total`, and an `amountPaid`. When posted, it debits AR (control)
and credits revenue + output VAT (see tax). Outstanding = `total − amountPaid`.
- `SalesInvoice` / `SalesInvoiceLine` models; posting via `DocumentPostingService.post`
  with `nature: 'SALE'`.

### Line discount (potongan / diskon per baris)
An optional per-line discount on a sales invoice or purchase bill, applied **before
tax**: a percent (`discountPercent`, 0–100) **or** a fixed amount (`discountAmount`).
The line stores what was entered plus the resolved `discountAmount`; its `amount` is the
**net DPP** = `round4(quantity × unitPrice) − discountAmount` (a percent resolves to
`gross × percent / 100`, rounded once to 4 dp half-up — `lineAmounts` in
`src/invoicing/document-helpers.ts`). PPN/PPh are computed on the net amount, and
revenue/expense posts net — v1 has **no separate contra "Potongan Penjualan/Pembelian"
account** (those contra accounts stay rejected on document lines). The document's
`discountTotal` is the sum of line discounts; `subtotal` is net of it. DB CHECKs
`*_lines_valid_discount` keep `0 ≤ discount_amount ≤ round(quantity × unit_price, 4)`,
`amount ≥ 0` and `discount_percent ∈ [0, 100]`.

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

### Advance / unapplied payment (uang muka)
A payment may move more cash than it allocates (optional `amount` ≥ allocation sum,
allocations may be empty). The unallocated rest — `payments.unapplied_amount` — posts to
the `CUSTOMER_ADVANCE` liability (receipt: Dr cash / Cr AR allocated, Cr advance) or the
`VENDOR_ADVANCE` asset (disbursement: Dr AP allocated, Dr advance / Cr cash) instead of
AR/AP (`buildPaymentLines`, `src/invoicing/payment-targets.ts`).
- **Application** (`POST /payments/:id/apply`, `PaymentsService.apply`) later moves
  unapplied amount onto POSTED documents of the same partner: one `PaymentApplication`
  row + one posted `PAYMENT` journal per allocation (Dr advance / Cr AR, or Dr AP / Cr
  advance; `createdBy` = payment creator, `postedBy` = applier, so SoD bars the creator),
  dated on/after the payment and each document. It increments `amountPaid` via the same
  `settleInTx` as a payment post and decrements `unapplied_amount` under the payment
  `FOR UPDATE` lock (over-apply → 422, also for the loser of a concurrent apply). An
  application is live on `[date, reversed_on)`; reversing it
  (`POST /payments/:id/applications/:applicationId/reverse`) reverses its journal and
  gives the amount back to the document and the payment.
- **Void rule:** a payment with a live application is not voidable (`422
  HAS_APPLICATIONS`) — reverse its applications first (each reversal is an ordinary,
  dated, reversible step; a cascading void would have to reverse several journals with
  possibly earlier dates in one go). The void date must be on/after the latest
  application reversal date. Void zeroes `unapplied_amount`.
- **Lock order** for apply / reverse-application / void: payment row `FOR UPDATE` →
  partner `FOR SHARE` → target documents `FOR UPDATE` (id order) → the ledger chain
  (year advisory lock → period → accounts → journal sequence). No new advisory key.
- **Subledgers:** AR/AP aging counts applications like allocations (`settlementsSql`
  — the one definition of a document's as-of settlements, also used by the
  backdated-void rule and the document-void date rule), so aging still ties to AR/AP
  control. Advances are **not** AR/AP and never appear in aging; the advance account
  ties to the sum of POSTED payments' `unapplied_amount`. Both advance accounts are
  document-only (MANUAL journals and invoice/bill lines may not use them; OPENING only
  before the first document). Open credit per partner: `GET
  /payments?partnerId=…&unapplied=true`; a partner with an unapplied advance cannot be
  deleted (`OPEN_ITEMS.unappliedPayments`).
- **Out of scope (v1):** PPN on advances (*faktur pajak uang muka*) — no tax is computed
  on an advance; the invoice it is applied to carries the tax. The journal preview covers
  fully allocated payments only.

### Credit note / debit note (nota retur penjualan / pembelian)
A `SalesCreditNote` returns part of ONE POSTED sales invoice; a `PurchaseDebitNote` part
of ONE POSTED purchase bill (`originalId`; the partner is the original's; dated on/after
it). Same lifecycle as invoices/bills (DRAFT → POSTED → VOID, soft-deleted drafts,
gapless `CN/<FY>/nnnnnn` / `DN/<FY>/nnnnnn` via `nextDocumentNumber`), driven by the
shared `TaxedDocumentService` through one `DocumentDescriptor` per kind plus
`postHooks`; note-specific logic in `src/invoicing/notes.service.ts`, pure math in
`note-lines.ts`.
- **Lines** are `{ originalLineId, quantity }`; description, account, unit price and tax
  codes are copied (`returnedLine`). A percent discount keeps its percent; a fixed
  `discountAmount` is pro-rated by quantity, `discountAmount × qty / originalQty`
  rounded once to 4 dp half-up (capped at the returned gross) — several partial returns
  may differ from the original discount by ≤ 0.0001 each. Tax is recomputed on the
  returned DPP with the original codes (per-code rupiah rounding), so partial notes may
  differ from the original's tax by rounding.
- **Over-return guard** (`lockReturnable`): under the ORIGINAL's `FOR UPDATE` lock, for
  every original line, the quantities of all live (DRAFT/POSTED, not deleted) notes ≤
  the original quantity — on create, edit and post, so concurrent notes queue on the
  original and the loser gets `422`.
- **Journal** = the mirror of the original's for the returned part (`noteJournalLines`):
  credit note Dr revenue, Dr PPN Keluaran / Cr PPh prepaid (or the PPh 4(2) final
  expense), Cr AR; debit note Dr AP, Dr PPh payable / Cr expense, Cr PPN Masukan. Source
  types `SALES_CREDIT_NOTE` / `PURCHASE_DEBIT_NOTE` (role-unrestricted policy like the
  documents; SoD applies).
- **Settlement split** (`splitSettlement`): the note total first settles the original —
  `creditedAmount` on the note, added to the original's `credited_total` (outstanding
  everywhere = `total − amount_paid − credited_total`; DB CHECK `amount_paid +
  credited_total ≤ total`) — and the **excess** (original already paid) posts to the
  advance account instead (Cr Uang Muka Pelanggan / Dr Uang Muka Pembelian) as partner
  credit, `unappliedAmount` on the note. The split is planned pre-lock and must be
  unchanged under the original's lock, else the post restarts (bounded → 409).
- **Partner credit** is applied exactly like a payment advance
  (`PaymentsService.applyCredit` / `reverseCreditApplication`, `CreditSource`):
  `POST /sales-credit-notes/:id/apply` (or `/purchase-debit-notes/…`) writes a
  `PaymentApplication` row with `sales_credit_note_id` / `purchase_debit_note_id`
  (`payment_id` NULL; CHECK exactly one source, a credit note only onto invoices, a debit
  note only onto bills) and a journal of the note's source type. Refunding note credit in
  cash is not built (v1).
- **Void:** only while no application of its excess is live (`422 HAS_APPLICATIONS`; void
  date on/after the latest application reversal). Reverses the journal and takes
  `creditedAmount` back off the original (kept on the VOID note: its credit was live on
  `[date, voided_on)`); `unapplied_amount` → 0. An invoice/bill with a live note cannot
  be voided (`422 HAS_NOTES`).
- **Subledgers:** a note's `creditedAmount` is a settlement of its original in
  `settlementsSql` (live `[date, voided_on)`), and its applications are rows of the
  application branch — so AR/AP aging (`paidAsOf` = payments + applications + note
  credit) still ties to control, and the backdated-void / document-void date rules see
  notes. Each advance account ties to POSTED payments' + POSTED notes'
  `unapplied_amount`.
- **Lock order:** note `FOR UPDATE` → partner `FOR SHARE` → original `FOR UPDATE` →
  ledger chain (create: partner `FOR SHARE` → original `FOR UPDATE`).

### Allocation & over-allocation guard
A `PaymentAllocation` ties part of a payment to a specific invoice/bill. You cannot
allocate more than a document's outstanding amount. At post time, each target row is
locked `FOR UPDATE` and outstanding (`total − amount_paid − credited_total`) is re-verified, so concurrent
payments can't jointly over-pay.
- Pre-check and in-tx `FOR UPDATE` re-check in `PaymentsService` ("Allocation exceeds /
  now exceeds the document outstanding").
- **Backdated-void rule.** A payment voided later than its own date stays live in as-of
  aging on `[date, voided_on)`. A new payment dated P must keep, for every day D ≥ P, the
  aging's as-of paid sum (+ its own allocation) ≤ the document total, or aging would drop
  the over-paid document while AR/AP control still carried the excess → `422
  { documentId, paymentDate, conflictingVoidedOn }`. Exact check (not "no void after P"):
  the sum only rises on payment dates, so it is evaluated at P and each later payment
  date. `allocationHistoryAfter` / `backdatedAllocationViolation` in
  `src/invoicing/payment-targets.ts`; pre-check at create, re-check in `settleInTx` under
  the document `FOR UPDATE` (which payment void's `unwindInTx` also takes). Mirror of the
  document-void guard `assertNoLaterVoidedPayment`.

### Document lifecycle: DRAFT → POST → VOID
Documents (invoices, bills, payments) start `DRAFT` (no ledger effect), become `POSTED`
(journal entry written, control/subledger updated), and are undone with `VOID` — which
reverses the journal entry and unwinds `amountPaid` rather than deleting anything. A
draft can be soft-deleted; a posted document cannot. A void may be dated later than the
document (optional `{ date }` body, e.g. when its period is closed) but never after today
(WIB, 422 `{ date, today }` — also for a journal reversal date); the date is stored in
`voided_on` (set iff `VOID`, DB CHECK) and as-of aging treats the document/payment as live
before it.
- `DocumentStatus` enum (`DRAFT`/`POSTED`/`VOID`); shared `DocumentLifecycleService`
  (`softDeleteDraft`, `reverseWithGuard`) in `src/ledger/document-lifecycle.service.ts`.

---

## Indonesian tax

### Tax code & `TaxKind`
A `TaxCode` is a reusable rate + GL account with a `kind` (`TaxKind` enum): `PPN_OUTPUT`,
`PPN_INPUT`, `PPH_PAYABLE`, `PPH_PREPAID`. Sales may only carry `PPN_OUTPUT` / `PPH_PREPAID`;
purchases only `PPN_INPUT` / `PPH_PAYABLE`. A line carries at most **one PPN code and
one PPh code** (two of the same bucket would tax the same DPP twice → 422).
A code's **rate is frozen once any document line uses it** (409 `TAX_CODE_IN_USE`):
a rate change (e.g. PPN 11% → 12%) is a new code, and the old one is deactivated, so
every document keeps the rate it was taxed at.
- `TaxCode` model (`kind`, `rate Decimal(9,6)`, `taxAccountId`); `ALLOWED_KINDS` map in
  `src/tax/tax.service.ts`.

### PPN — Pajak Pertambahan Nilai (VAT)
Value-added tax. On a sale you collect **output VAT** (`PPN_OUTPUT`, a credit to a
tax-payable account); on a purchase you pay **input VAT** (`PPN_INPUT`, a debit to a
tax-receivable account). Computed as base × rate, rounded once to whole rupiah per code.
- `TaxService.calculate`: output → credit, input → debit; `base.multiplyToRupiah(rate)`.
- A tax code's account must be postable, carry no system role, and match the kind:
  input/prepaid → DEBIT-normal `TAX_RECEIVABLE` (prepaid may also be a DEBIT-normal
  `OPERATING_EXPENSE`/`OTHER_EXPENSE` — final PPh), output/payable → CREDIT-normal
  `TAX_PAYABLE` (`src/tax/tax-account-rule.ts`; checked on tax-code create and re-checked
  inside the document post transaction).

### PPh — Pajak Penghasilan (withholding income tax)
Tax withheld on income. On a sale your customer withholds from you → `PPH_PREPAID`
(a debit prepayment, an asset — creditable PPh 23 goes to `1-1500 Uang Muka PPh`). **Final**
PPh (4(2), e.g. rent) is not creditable, so it is an expense: the seeded `PPH42-PRE` posts
to `5-9100 Beban PPh Final`. On a purchase you withhold from the vendor → `PPH_PAYABLE`
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
rounding error. The product `base × rate` is kept exact and rounded a single time (no
intermediate 4dp rounding: `100004.5450 × 0.11 = 11000.49995 → 11000`, not `11001`).
- `Money.multiplyToRupiah(rate)` applied to each code's aggregated base in `TaxService.calculate`.

### PKP status (`isPkp`)
A *Pengusaha Kena Pajak* is a VAT-registered business obligated to charge PPN. Modeled as
a company-level flag.
- `CompanySettings.isPkp` in `prisma/schema.prisma`. Enforced in `TaxService.calculate`: a
  non-PKP company may neither charge PPN Output (sales) nor credit PPN Input (purchases) →
  422. PPh withholding is unaffected.

---

## Reports

All reports are read-only and derive from `BalancesService` primitives
(`balancesAsOf`, `movementsBetween`, `trialBalance`, `accountBalance`), which sum posted,
non-deleted journal lines. Several reports emit a boolean self-check.
`balancesAsOf`/`movementsBetween` take `BalanceQueryOpts` (`excludeClosing`,
`excludeClosingFrom`, `excludeOpening`, `tx`); the P&L-view reports use them, while trial
balance, general ledger and account balance deliberately **include** closing entries
(post-closing view). Predicates live in `src/ledger/balances/posted-entry.sql.ts`.

### Trial balance (neraca saldo)
Every account's total debits and credits as of a date; the grand `totalDebit` must equal
`totalCredit` (the double-entry proof for the whole ledger).
- `BalancesService.trialBalance` in `src/ledger/balances/balances.service.ts`.

### Report snapshot consistency
Every multi-query report (Neraca, Arus Kas, Buku Besar) runs its reads through
`BalancesService.snapshot(fn)` — one READ ONLY, REPEATABLE READ transaction
(`REPORT_SNAPSHOT_TX` in `src/common/prisma/prisma.service.ts`: maxWait 5s, timeout
30s) whose client is passed to every query as `opts.tx`. A post committing
mid-request is therefore either wholly in or wholly out of the report. Read-only RR
takes only ACCESS SHARE locks (never blocks posting), can't hit serialization
failures, and never marks an idempotency key. Single-query reports (trial balance,
Laba Rugi, aging) are already consistent on their own.

### Balance sheet / Neraca
Assets, liabilities, and equity as of a date, grouped by subtype. Equity adds the
still-open cumulative P&L (`Σ credit−debit` over REVENUE+EXPENSE) as synthetic
lines, split per SAK presentation: **Laba (Rugi) Berjalan** (`CURRENT_EARNINGS`) =
`currentYearEarnings`, the fiscal year containing the as-of date; the remainder —
P&L of **earlier** fiscal years never closed (or reopened) — is retained earnings,
shown as **Laba Ditahan (tahun belum ditutup)** (`UNCLOSED_PRIOR_EARNINGS`, only when
non-zero; `unclosedPriorYearsEarnings`). The remainder is exact because every counted
closing entry/reopen reversal belongs to an earlier year. Closing that year moves the
amount into the real Laba Ditahan account; totals don't change.
It is a **pre-closing** view: a `CLOSING` entry (or its reopen reversal) dated **on** the
as-of date is excluded (`excludeClosingFrom: asOf`), so Neraca at the fiscal year-end
shows the year's profit as Laba (Rugi) Berjalan; from the next day it sits in Laba
Ditahan. `currentYearEarnings` = FY-to-date P&L movement with closing entries excluded.
The `balanced` flag asserts **Assets = Liabilities + Equity**.
- `BalanceSheetService.generate` (`src/reporting/balance-sheet.service.ts`);
  `balanced: assets.total.equals(liabilities.total.add(totalEquity))`.

### Income statement / Laba rugi
Revenue and expense **movement** over a date range, sectioned into revenue, COGS (→ gross
profit), operating expense (→ operating profit), other income/expense (→ profit before
tax), then the `TAX_EXPENSE`-role line, yielding net income. `CLOSING` entries and
their reopen reversals are excluded (`excludeClosing`), so the figures are identical
before close, after close, after reopen and after re-close.
- `IncomeStatementService.generate` (`src/reporting/income-statement.service.ts`).

### Cash flow (laporan arus kas) — indirect method
Starts from net income (Σ cash-effect of P&L accounts), adds movements of non-cash
balance-sheet accounts bucketed by `cashFlowCategory` (OPERATING/INVESTING/FINANCING),
and ties to cash. The `reconciles` flag asserts **opening cash + net change = closing
cash** (`kasAwal + netChange == kasAkhir`), where cash = `role === 'CASH'` accounts.
Flows exclude `CLOSING` entries (and their reversals) and `OPENING` entries; cash booked
by `OPENING` entries inside the range is added to `kasAwal` (beginning balance, not an
operating/financing flow). This is **intended**: `kasAwal` = cash as of `from − 1` +
in-range OPENING cash, so with in-range Saldo Awal entries it differs from the plain
Kas balance on the day before `from` (the four aggregates are computed as
`movementsBetween` with/without OPENING, so `reconciles` still ties). Accumulated depreciation is `cashFlowCategory: NONE` → it
lands in operating as the non-cash add-back.
- `CashFlowService.generate` (`src/reporting/cash-flow.service.ts`).

### AR / AP aging (umur piutang / umur utang)
Outstanding posted invoices/bills as of a date, bucketed by days past due
(`Current`, `1-30`, `31-60`, `61-90`, `>90`) and grouped by partner. `paid_as_of` is the
posted allocations and payment applications live on the as-of date (`settlementsSql`),
so the total reconciles to the AR/AP control balance at that date. Unapplied advances
are not AR/AP and are not in aging (see *Advance / unapplied payment*). Buckets and totals are computed in one SQL statement:
totals aggregate **all** open documents, while the `AGING_MAX_DOCS` (10,000) cap cuts
only at partner boundaries (`truncated: true`; `documentCount` = all open documents).
- `AgingService.aging('AR' | 'AP', asOf)` (`src/reporting/aging.service.ts`).

### General ledger (buku besar)
One account's posted lines over a date range, with an opening balance and a per-line
running balance signed by the account's normal balance. Lines are keyset-ordered by
`(date, entry_number, entry id, line_no)`; past the `GL_MAX_LINES` (10,000) cap the
response carries `nextCursor` (base64url of the last row's key). A cursor page's
opening balance is the account's posted sum through that key (server-side), so it
equals the previous page's last running balance.
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
- **Deactivating with open items is allowed (by design, no guard).** Posted documents
  stay open in AR/AP and aging, but receipts (disbursements) against them — create and
  post — and new documents return `422` ("Partner is inactive") until it is
  re-activated; voiding an existing payment still works.
- **Removing a role with open items is refused** (`PATCH isCustomer/isVendor: false` →
  `422 OPEN_ITEMS` `{ …, role }` while that role has drafts, outstanding POSTED
  documents or draft payments of its direction), and so is deletion (`OPEN_ITEMS`).
  Caveat (documented, not blocked): after the role is removed, **voiding** a posted
  receipt (disbursement) of that partner still works and reopens the invoice (bill)
  balance it settled, which then cannot receive a new payment of that direction
  ("Receipt requires a customer" / "Disbursement requires a vendor") until the role is
  re-enabled.
  `code` / `name` are stored normalized — see *Identifier code* below.
- `BusinessPartner` model in `prisma/schema.prisma`.

### Identifier code (kode akun / kode pajak / kode mitra)
The human-facing `code` of an account, tax code or business partner (and an account's
`parentCode` reference). Normalized on write: Unicode **NFKC** (full-width `ＤＵＰ` →
`DUP`), then surrounding white space trimmed (linear scan — never an alternation regex);
a blank code, or one holding an invisible character — format (Cf — zero-width
space/joiner, BOM, bidi controls, soft hyphen, tags), control (Cc), line / paragraph
separator (Zl / Zp) or any other Default_Ignorable_Code_Point (`CODE_INVISIBLE`) — is a
`400`. Values over 1024 characters skip normalization (their `@MaxLength` rejects
them). Stored in that form (case kept) and **unique case-insensitively
among live rows** — `dup` / `DUP` / `DUP ` / `ＤＵＰ` are one code (`409`). Names get
the same trim + Cf / Default_Ignorable rejection (the ZWJ of an emoji ZWJ sequence and
the VS16 after an emoji are allowed; control characters are allowed), without NFKC or
uniqueness.
- Pure rules in `src/common/text/identifier.ts`; DTO decorators `@IdentifierCode()` /
  `@DisplayName()` (`src/common/validators/identifier-code.ts`).
- DB: partial expression unique indexes `<table>_code_lower_live_key` on
  `lower(code) WHERE deleted_at IS NULL` (migration `20261005000000`); the exact
  `<table>_code_key` uniques stay (they model `@@unique([code])`). A soft delete
  tombstones the code (`<code>#deleted-<id>`), so it is reusable in any case.
