# Accounting API — Phase 3: Tax Engine — Design Spec

- **Date:** 2026-06-11
- **Status:** Approved (pending written-spec review)
- **Owner:** budi@maul.is
- **Builds on:** Phase 1 (foundation) + Phase 2 (ledger core), both merged. Reuses `PostingService` (consumed in Phase 4, not here), the SAK chart (tax accounts already seeded), `Money`, soft-delete, domain errors, JWT/RBAC, testcontainers harness.
- **Master spec:** `docs/superpowers/specs/2026-06-10-indonesian-accounting-api-design.md` (§5.3 tax_codes, §7 tax postings).

## 1. Overview

The Indonesian tax engine: a `tax_codes` reference table and a pure `TaxService` that, given a tax-exclusive taxable transaction (base lines + tax codes + a settlement account), computes PPN (VAT) and PPh (withholding) and returns the **full balanced set of journal lines** (base + tax + settlement plug). Phase 4 invoicing consumes `TaxService` to assemble and post real documents via `PostingService`; Phase 3 itself does **no ledger persistence**.

v1 scope (per the original brainstorm): **PPN + PPh withholding recording** to the correct ledger accounts. e-Faktur/Coretax e-invoicing, SPT generation, and NPWP online validation are deferred.

### Goals
- A `tax_codes` model whose `kind` alone determines posting side and mechanism.
- A pure, fully-tested `TaxService.calculate` producing balanced journal lines.
- A seed of the common Indonesian PPN/PPh codes, editable via CRUD.
- A `POST /tax/calculate` preview endpoint.

### Non-goals (later)
- e-Faktur / Coretax e-invoicing, SPT, NPWP online validation (deferred).
- Posting to the ledger (Phase 4 invoicing does this using `TaxService` output).
- Tax-inclusive line amounts (v1 is tax-exclusive only).
- NPWP-driven rate logic in the engine (handled by selecting an explicit-rate code).

## 2. Module layout

A new **`TaxModule`** (`src/tax/`), a peer of `CompanyModule`/`LedgerModule`. Pure computation + reference data — **no posting**.

| Unit | Responsibility |
|---|---|
| `TaxCodesService` | Tax-code CRUD + idempotent seed; validates `taxAccountId` (postable + correct normal balance for the kind) |
| `TaxService` | `calculate(taxableTransaction)` → tax breakdown + full balanced journal-line set; pure (reads tax codes, no writes) |
| `TaxCodesController` | `/tax/codes` CRUD |
| `TaxController` | `POST /tax/calculate` preview |

**Dependencies:** `TaxModule` → `LedgerModule` (for `AccountsService`, used to validate `taxAccountId` at code-creation and to resolve account codes in the seed), `CommonModule` (`Money`), `PrismaModule`. It does **not** depend on `PostingService`. Acyclic; Phase 4 `InvoicingModule` will import both `TaxModule` and `LedgerModule`.

**Soft delete:** add `TaxCode` to `SOFT_DELETE_MODELS` (tombstone `code` on delete).

## 3. Data model

`TaxKind` is a Prisma enum; `kind` alone determines posting side + mechanism.

**`tax_codes`** — *soft-deletable (tombstone on `code`)*
- `id`, `code` (e.g. `PPN-OUT-11`), `name` (e.g. `PPN Keluaran 11%`)
- `kind` (`PPN_OUTPUT` / `PPN_INPUT` / `PPH_PAYABLE` / `PPH_PREPAID`)
- `rate` `NUMERIC(9,6)` — a fraction (0.110000 = 11%)
- `taxAccountId` — plain string reference to a postable account (no DB FK, same convention as `journal_lines.accountId`; validated in the service)
- `isActive` (default true), `createdAt`/`updatedAt`, `deletedAt?`/`deletedBy?`
- `@@unique([code])`, `@@index([deletedAt])`, `@@map("tax_codes")`

**Behavior derived from `kind`:**

| kind | seeded account | posting side | mechanism |
|---|---|---|---|
| `PPN_OUTPUT` | PPN Keluaran (2-1100) | credit (liability) | added to settlement |
| `PPN_INPUT` | PPN Masukan (1-1400) | debit (asset) | added to settlement |
| `PPH_PAYABLE` | Utang PPh (2-1200) | credit (liability) | withheld (reduces settlement) |
| `PPH_PREPAID` | Uang Muka PPh (1-1500) | debit (asset) | withheld (reduces settlement) |

## 4. `TaxService.calculate` — interface & semantics

Pure, read-only. All amounts via `Money`.

**Input — `TaxableTransaction`:**
```
{ nature: 'SALE' | 'PURCHASE',
  settlementAccountId: string,        // AR/Piutang (SALE) or AP/Utang (PURCHASE)
  lines: [ { accountId, amount /* DPP, tax-exclusive decimal string */, taxCodeIds: string[] } ] }
```

**Output — `TaxCalculation`:**
```
{ subtotal,
  taxes: [ { taxCodeId, code, kind, base, amount, accountId } ],  // aggregated per code
  settlementAmount,
  journalLines: [ { accountId, debit?, credit?, description? } ] } // full, balanced
```

**Algorithm:**
1. Load referenced tax codes; reject unknown or inactive → `ValidationFailedError` (422).
2. **Kind-vs-nature validation:** `SALE` permits only `PPN_OUTPUT` + `PPH_PREPAID`; `PURCHASE` only `PPN_INPUT` + `PPH_PAYABLE`. Mismatch → 422.
3. `subtotal = Σ line.amount`.
4. **Per-code aggregation + rounding:** for each tax code used, sum the DPP of all lines carrying it, compute `tax = round(base × rate)` to whole rupiah **once** per code.
5. **Assemble journal lines:**
   - Base lines — `SALE` → credit each revenue account (its DPP); `PURCHASE` → debit each expense/asset account.
   - Tax lines — side from the `kind` table.
   - Settlement line — `settlementAmount = subtotal + Σ PPN − Σ PPh`; `SALE` → debit AR; `PURCHASE` → credit AP.
6. Assert Σdebit = Σcredit (guaranteed by construction — the settlement is derived from the same rounded tax figures, so it absorbs rounding).

**Worked example — purchase of services, DPP 1,000,000, PPN Masukan 11% + PPh 23 payable 2%:**
```
Dr Beban Jasa        1,000,000
Dr PPN Masukan         110,000
   Cr Utang Usaha        1,090,000   (= 1,000,000 + 110,000 − 20,000)
   Cr Utang PPh 23          20,000
```
Debits 1,110,000 = Credits 1,110,000.

**Worked example — sale of services, DPP 1,000,000, PPN Keluaran 11% + customer withholds PPh 23 2%:**
```
Dr Piutang Usaha     1,090,000   (= 1,000,000 + 110,000 − 20,000)
Dr Uang Muka PPh        20,000
   Cr Pendapatan          1,000,000
   Cr PPN Keluaran          110,000
```
Debits 1,110,000 = Credits 1,110,000.

Edge cases: a line with no tax codes contributes only to subtotal + settlement; a fully tax-free transaction yields a balanced 2-sided entry (settlement = subtotal). A single PPh code (rate < 1) always leaves a positive settlement, but stacking multiple withholding codes can drive `settlement` to zero or negative — `calculate` rejects a non-positive settlement with a 422 (it would otherwise emit a structurally invalid line that fails the ledger's one-sided CHECK in Phase 4). A repeated tax code within one line is also rejected (422).

## 5. Tax-code seed

Seeded idempotently when empty (resolving account codes → ids via `AccountsService`, race-safe like the SAK chart), editable afterward:

| code | name | kind | rate | account |
|---|---|---|---|---|
| `PPN-OUT-11` | PPN Keluaran 11% | PPN_OUTPUT | 0.11 | 2-1100 |
| `PPN-IN-11` | PPN Masukan 11% | PPN_INPUT | 0.11 | 1-1400 |
| `PPH23-PAY` | PPh 23 Jasa 2% (dipotong) | PPH_PAYABLE | 0.02 | 2-1200 |
| `PPH23-PRE` | PPh 23 Jasa 2% (dipungut) | PPH_PREPAID | 0.02 | 1-1500 |
| `PPH42-PAY` | PPh 4(2) Sewa 10% (dipotong) | PPH_PAYABLE | 0.10 | 2-1200 |
| `PPH42-PRE` | PPh 4(2) Sewa 10% (dipungut) | PPH_PREPAID | 0.10 | 1-1500 |

Non-NPWP variants (e.g. PPh 23 at 4%) and a 12% PPN code are added via CRUD when needed.

## 6. API surface

All under the JWT guard; errors via the `{code,message,details}` envelope; OpenAPI auto-documented.

```
Tax codes:  GET    /tax/codes                (list)                  (all auth)
            GET    /tax/codes/:id                                    (all auth)
            POST   /tax/codes                (create)                (ACCOUNTANT/APPROVER/ADMIN)
            PATCH  /tax/codes/:id            (name/rate/isActive)    (ACCOUNTANT/APPROVER/ADMIN)
            POST   /tax/codes/:id/deactivate                         (ADMIN)
            DELETE /tax/codes/:id            (soft-delete)           (ADMIN)
Calculate:  POST   /tax/calculate            (preview, no persist)   (all auth)
```

**Tax-code create/update validation** (`TaxCodesService`): `taxAccountId` must be an existing **postable** account **whose normal balance matches the kind** — `PPN_OUTPUT`/`PPH_PAYABLE` → CREDIT-normal (liability); `PPN_INPUT`/`PPH_PREPAID` → DEBIT-normal (asset). Mismatch → 422. `rate` must be `> 0` and `< 1`. Soft-delete blocked if needed in later phases (no tax-code usage tracking in v1 — deletion is allowed, tombstoning the code).

## 7. Testing strategy

TDD throughout; testcontainers (Phase 1/2 harness: `makePrismaOverride`, `maxWorkers:1`).

- **Unit (`TaxService`):** PPN-only sale; PPN+PPh purchase (worked example → exact lines); multiple lines sharing a code (per-aggregate rounding); multiple codes per line; tax-free line; kind-vs-nature rejection; **balance property test** (random base lines + valid codes → Σdebit = Σcredit).
- **Unit (`TaxCodesService` validation):** postable-account check; kind↔account-normal-balance match; rate range.
- **Integration (testcontainers):** tax-code CRUD; seed idempotency (re-run → same 6 codes); `POST /tax/calculate` returns the exact balanced lines for the worked sale and purchase; kind-vs-nature mismatch → 422; create with a wrong-side account → 422.

## 8. Build sequence

Each step shippable and tested before the next.
1. `TaxCode` model + `TaxKind` enum + migration; register `TaxCode` in `SOFT_DELETE_MODELS`.
2. `TaxCodesService` (CRUD, validation, idempotent seed) + `TaxCodesController` + endpoints + tax-code e2e.
3. `TaxService.calculate` + DTOs + `TaxController` (`POST /tax/calculate`) + calculation unit tests, worked-example e2e, balance property test.

## 9. Notes for later phases
- Phase 4 invoicing builds the `TaxableTransaction` from an invoice/bill, calls `TaxService.calculate`, and posts the returned `journalLines` via `PostingService` with `source_type` SALES_INVOICE / PURCHASE_BILL (extend the enum). The settlement account is the partner's AR/AP control account.
- e-Faktur/Coretax export + SPT reporting build on `tax_codes` + posted tax accounts.
- NPWP-driven rate selection (no-NPWP surcharge) can be added as additional codes or partner-aware code selection in invoicing.
- Tax-inclusive line support, if ever needed, extends `calculate` with an `amountIncludesTax` flag and DPP extraction.
