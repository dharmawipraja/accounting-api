# Accounting API — Phase 4: Invoicing & AR/AP — Design Spec

- **Date:** 2026-06-11
- **Status:** Approved (pending written-spec review)
- **Owner:** budi@maul.is
- **Builds on:** Phases 1 (foundation), 2 (ledger core — `PostingService`, SAK chart incl. Piutang Usaha 1-1200 / Utang Usaha 2-1000 / Kas 1-1000 / Bank 1-1100, accounting periods), 3 (tax engine — `TaxService.calculate(SALE|PURCHASE)` → balanced `journalLines`). All merged to `main`.
- **Master spec:** `docs/superpowers/specs/2026-06-10-indonesian-accounting-api-design.md`.

## 1. Overview

The AR/AP subsystem: business partners (customers/vendors), sales invoices, purchase bills, and payments with explicit allocation. A document is drafted, then **posted** — which builds a `TaxableTransaction` from its lines, calls `TaxService.calculate`, and writes the resulting balanced journal entry through `PostingService` (hitting the AR/AP control account). Payments settle documents via allocation lines that drive each document's `amountPaid` → `outstanding`. Per-partner outstanding is the subledger; it reconciles to the AR/AP control accounts in the GL.

### Goals
- `BusinessPartner` master data (one entity, customer/vendor flags, NPWP).
- Sales invoices & purchase bills with a DRAFT → POSTED → VOID lifecycle, posting via `TaxService` → `PostingService`.
- Payments (receipts/disbursements) with explicit full allocation to documents.
- Gapless per-type document numbering, assigned on post.

### Non-goals (deferred)
- Advances / down-payments (uang muka) / overpayments / credit balances — full allocation is required in v1.
- Credit notes / sales returns (retur) — corrections are done by VOID + re-issue.
- Multi-currency — IDR only.
- e-Faktur / Coretax NSFP numbering, SPT — deferred (NPWP is stored, not behavioral).
- Idempotency keys on document posting — the draft→post lock already prevents double-posting; not added in v1.
- Per-partner control sub-accounts — single global AR (1-1200) / AP (2-1000) control.

## 2. Module layout

A new **`InvoicingModule`** (`src/invoicing/`), peer of `LedgerModule`/`TaxModule`. Imports `LedgerModule` (`PostingService`, `AccountsService`, `CompanyService`) and `TaxModule` (`TaxService`). Acyclic — ledger/tax do not depend on invoicing.

| Unit | Responsibility |
|---|---|
| `BusinessPartnersService` + controller | Partner master data CRUD |
| `SalesInvoicesService` + controller | AR invoices: draft→post→void + posting |
| `PurchaseBillsService` + controller | AP bills: draft→post→void + posting |
| `PaymentsService` + controller | Receipts/disbursements + allocation + posting |
| `DocumentNumberService` | Gapless per-(type, fiscal-year) numbering |

`SalesInvoice` and `PurchaseBill` are **separate** models/services (they differ on AR vs AP control, SALE vs PURCHASE tax nature, customer vs vendor, cash-flow direction). The common "build `TaxableTransaction` → `calculate` → post journal" path is a shared private helper so posting logic isn't duplicated.

## 3. Data model

New enums: `DocumentStatus { DRAFT, POSTED, VOID }`, `PaymentDirection { RECEIPT, DISBURSEMENT }`. Extend `JournalSourceType` with `SALES_INVOICE`, `PURCHASE_BILL`, `PAYMENT`.

**`business_partners`** — *soft-deletable (tombstone `code`)*
- `id`, `code` (unique), `name`, `npwp?`, `email?`, `phone?`, `address?`
- `isCustomer Boolean`, `isVendor Boolean`, `isActive @default(true)`, timestamps, `deletedAt?`/`deletedBy?`
- `@@unique([code])`, `@@index([deletedAt])`

**`sales_invoices`** — *soft-deletable*
- `id`, `invoiceNumber Int?`, `invoiceRef String?`, `fiscalYear Int?` (assigned on Post; null in DRAFT)
- `partnerId` (validated `isCustomer`; plain reference per the no-FK convention), `date`, `dueDate?`, `description?`
- `status DocumentStatus @default(DRAFT)`
- `subtotal`, `taxTotal`, `withholdingTotal`, `total`, `amountPaid @default(0)` — `Decimal(20,4)`
- `journalEntryId?`, `createdBy`, `postedBy?`, `postedAt?`, timestamps, `deletedAt?`/`deletedBy?`
- `lines SalesInvoiceLine[]`; `@@unique([fiscalYear, invoiceNumber])`, `@@index([deletedAt])`, `@@index([partnerId])`

**`sales_invoice_lines`**
- `id`, `salesInvoiceId`, `lineNo`, `description`, `accountId` (revenue), `quantity Decimal`, `unitPrice Decimal`, `amount Decimal(20,4)` (= round(qty×unitPrice), the DPP), `taxCodeIds String[]`
- `@@unique([salesInvoiceId, lineNo])`

**`purchase_bills`** / **`purchase_bill_lines`** — mirror sales, except: `partnerId` validated `isVendor`; `vendorInvoiceNo?` on the header; line `accountId` is an expense/asset account; `BILL/` numbering.

**`payments`** — *soft-deletable*
- `id`, `number Int?`, `ref String?`, `fiscalYear Int?` (on Post; `PAY-RCV/`|`PAY-DSB/`)
- `direction PaymentDirection`, `partnerId`, `date`, `cashAccountId` (postable asset), `amount Decimal(20,4)`, `description?`
- `status DocumentStatus @default(DRAFT)`, `journalEntryId?`, `createdBy`, `postedBy?`, `postedAt?`, timestamps, `deletedAt?`/`deletedBy?`
- `allocations PaymentAllocation[]`; `@@unique([fiscalYear, number])`, `@@index([deletedAt])`, `@@index([partnerId])`

**`payment_allocations`**
- `id`, `paymentId`, `salesInvoiceId?`, `purchaseBillId?` (exactly one set, matching direction — service-guarded), `amount Decimal(20,4)`
- `@@index([salesInvoiceId])`, `@@index([purchaseBillId])`

**`document_sequences`** (gapless counter, mirrors `journal_sequences`)
- `documentType String`, `fiscalYear Int`, `nextNumber Int @default(1)`, `updatedAt`; `@@id([documentType, fiscalYear])`

**Derived (not stored), computed in services / responses:** `outstanding = total − amountPaid`; `paymentStatus = amountPaid==0 ? UNPAID : amountPaid>=total ? PAID : PARTIAL`. `amountPaid` is updated transactionally on payment post (increment) / void (decrement), kept in sync with Σ active allocations.

Note: `partnerId`/`accountId`/`cashAccountId` follow the established no-FK + service-validation convention (`journal_lines.accountId`). FK relations for `lines`/`allocations` to their parent document are real Prisma relations.

## 4. Sales invoices & purchase bills

**Lifecycle:**
- **createDraft** `{partnerId, date, dueDate?, description?, lines[≥1]}` — validate partner exists + customer (sales) / vendor (purchase) + active; persist lines (`amount = round(quantity × unitPrice)`); compute + store totals via a pure `TaxService.calculate` preview (`taxTotal` = Σ PPN, `withholdingTotal` = Σ PPh, `total` = settlement). Status `DRAFT`, no number, no GL.
- **update / deleteDraft** — DRAFT only; recompute totals on line change; delete is soft-delete (DRAFT only).
- **post (DRAFT→POSTED, in place, one transaction):** lock + re-check `DRAFT` (no double-post gap); assign gapless number (`document_sequences` FOR UPDATE); create the journal entry from the `TaxService.calculate` `journalLines` via `PostingService.createPostedEntryInTx` (sourceType `SALES_INVOICE`/`PURCHASE_BILL`, `sourceId` = doc id); update row → `POSTED` + number/ref + `journalEntryId` + finalized totals. Settlement account = AR `1-1200` (sales) / AP `2-1000` (purchase), resolved by well-known code. SoD not applied (source ≠ MANUAL); APPROVER+ role gate is the control.
- **void (POSTED→VOID, one transaction):** only if `amountPaid == 0` (else 409); `reverseInTx` the journal entry; set `VOID`.
- **get / list** — list filterable by `partnerId`/`status`/`paymentStatus`/date range; responses include derived `outstanding`/`paymentStatus`.

**Posting mechanism (the Phase-2 touch):** `PostingService` gains two **additive, transaction-composable** methods — `createPostedEntryInTx(tx, input, postedBy)` (assigns the gapless JE number + writes the balanced entry within a caller's transaction) and `reverseInTx(tx, entryId, reversedBy)`. The existing `post`/`postDraft`/`reverse` are refactored into thin wrappers over them (behavior unchanged, re-verified by the Phase-2 e2e suite). Document services open the outer transaction and call these so the document number, its journal entry, and its status transition commit atomically.

**Roles:** createDraft/update/delete = ACCOUNTANT/APPROVER/ADMIN; post + void = APPROVER/ADMIN; reads any-auth.

## 5. Payments & allocation

- **createDraft** `{direction, partnerId, date, cashAccountId, description?, allocations:[{salesInvoiceId|purchaseBillId, amount}]}` — validate partner active + role matches direction (RECEIPT→customer, DISBURSEMENT→vendor); `cashAccountId` postable asset; each allocation targets a POSTED, non-VOID document of that partner matching the direction; `amount > 0` and `≤ document.outstanding`; **payment `amount` = Σ allocations** (full-allocation rule, 422 otherwise). Draft does not change `amountPaid`.
- **post (DRAFT→POSTED, one transaction):** lock + re-check `DRAFT`; lock the allocated document rows `FOR UPDATE` and re-verify each allocation ≤ current outstanding (the over-allocation guard under concurrency); assign gapless `PAY-RCV`/`PAY-DSB` number; create the journal entry via `createPostedEntryInTx` — RECEIPT: `Dr cashAccount, Cr 1-1200`; DISBURSEMENT: `Dr 2-1000, Cr cashAccount` (2 lines, no tax, balanced); `increment` each document's `amountPaid`; mark `POSTED` + number + `journalEntryId`.
- **void (POSTED→VOID, one transaction):** `reverseInTx` the journal entry; `decrement` each document's `amountPaid`; set `VOID`. Allocations remain as historical records.
- **get / list** — filter by partner/direction/status/date.

**Roles:** createDraft/update/delete = ACCOUNTANT/APPROVER/ADMIN; post/void = APPROVER/ADMIN; reads any-auth.

## 6. Numbering

`DocumentNumberService.next(tx, documentType, fiscalYear)` — `INSERT … ON CONFLICT DO NOTHING` → `SELECT next_number … FOR UPDATE` → `UPDATE` on `document_sequences`, within the caller's transaction (identical to `journal_sequences`). Returns the number; ref = `<PREFIX>/<fy>/<6-digit zero-padded>` (`INV`, `BILL`, `PAY-RCV`, `PAY-DSB`). Fiscal year derived from the document date via the company `fiscalYearStartMonth` (the ledger's existing `fiscalYearFor` logic).

## 7. API surface

All under the JWT guard; `{code,message,details}` envelope; OpenAPI-documented. Reads any-authenticated.

```
Partners:        GET /partners · GET /partners/:id · POST /partners (ACCT+) ·
                 PATCH /partners/:id (ACCT+) · POST /partners/:id/deactivate (ADMIN) ·
                 DELETE /partners/:id (ADMIN)
Sales invoices:  GET /sales-invoices (filters) · GET /sales-invoices/:id ·
                 POST /sales-invoices (draft, ACCT+) · PATCH /sales-invoices/:id (ACCT+) ·
                 POST /sales-invoices/:id/post (APPROVER+) · POST /sales-invoices/:id/void (APPROVER+) ·
                 DELETE /sales-invoices/:id (ACCT+)
Purchase bills:  GET /purchase-bills … (same shape; post/void APPROVER+)
Payments:        GET /payments (filters) · GET /payments/:id · POST /payments (draft, ACCT+) ·
                 PATCH /payments/:id (ACCT+) · POST /payments/:id/post (APPROVER+) ·
                 POST /payments/:id/void (APPROVER+) · DELETE /payments/:id (ACCT+)
```
"ACCT+" = ACCOUNTANT/APPROVER/ADMIN. Post/void responses include derived `outstanding`/`paymentStatus`.

## 8. Testing strategy

TDD throughout; testcontainers (Phase 1–3 harness: `makePrismaOverride`, `maxWorkers:1`).
- **Partners:** CRUD; customer-or-vendor required (422); tombstone delete.
- **Sales invoice / purchase bill:** draft totals match `TaxService` (PPN+PPh); post creates a balanced GL entry hitting AR/AP control + revenue/expense + tax accounts (assert balance + accounts); void reverses it; void blocked once `amountPaid > 0` (409); double-post leaves no number gap.
- **Payments:** full-allocation enforced (Σ≠amount → 422); partial payment → `PARTIAL` + correct `outstanding`; second payment → `PAID`; over-allocation rejected (incl. a concurrent two-payment race → exactly one posts); void restores `outstanding`; payment against a non-matching partner or a DRAFT/VOID document → 422.
- **Reconciliation invariant:** AR control (1-1200) GL balance == Σ customer outstanding; AP control (2-1000) == Σ vendor outstanding.
- **Regression:** full Phase 1–3 suite stays green (especially the refactored `PostingService` wrappers).

## 9. Build sequence

1. **Foundation** — schema (all models + enums + migration), `InvoicingModule` skeleton, additive `PostingService.createPostedEntryInTx`/`reverseInTx` refactor (existing methods → wrappers; Phase-2 e2e green), `DocumentNumberService`.
2. **Business partners** — service + endpoints + e2e.
3. **Sales invoices** — draft/post/void + endpoints + e2e (balanced-GL + void-blocked).
4. **Purchase bills** — service + endpoints + e2e (shared posting helper).
5. **Payments & allocation** — service + endpoints + e2e + reconciliation invariant test.

## 10. Notes for later phases
- Phase 5 (reporting) reads AR/AP aging from the invoice/payment subledger (outstanding + dueDate buckets) and reconciles to the control accounts; financial statements use `BalancesService`.
- Advances/credit notes/multi-currency/e-Faktur build on these models when scoped.
- The `partnerId` NPWP + invoice header data are the seed for future e-Faktur export.
