# Buku backend: partner-code search + journal-entry preview — design

**Date:** 2026-07-05
**Requested by:** Buku frontend (`accounting-client`), `/impeccable` UX backlog
**Scope:** Two frontend-blocking backend changes. Task 1 is a small extension of
an already-shipped feature; Task 2 is a new read-only endpoint.

---

## Task 1 — extend server-side `q` search to match partner `code`

### Current state (already shipped, `6c1b127`)

Server-side `?q=` fuzzy/substring search already exists on all three document
list endpoints via `SearchQueryDto` → `trigramSearch()`:

- `GET /v1/sales-invoices` — own cols `invoice_ref`, `description`; partner join `name`
- `GET /v1/purchase-bills` — own cols `bill_ref`, `vendor_invoice_no`, `description`; partner join `name`
- `GET /v1/payments` — own cols `ref`, `description`; partner join `name`

It is already case-insensitive (`ILIKE '%q%'` + trigram `similarity()`), AND-combines
with the existing `status` / `direction` / `partnerId` filters, returns the
**filtered** `total` in the `{data,total,limit,offset}` envelope (via a separate
parallel count query, so page-offset overshoot is correct), and treats a `q`
shorter than `MIN_QUERY_LENGTH` (2) — including empty/whitespace, which
`SearchQueryDto` trims — as absent (falls back to the plain page query).

### The gap

The frontend spec also requires matching the linked partner's **`code`**. Today
the partner join searches only `name`. A `business_partners_code_trgm` GIN index
already exists (schema line 319), so this is index-backed.

### Change

Add `'code'` to the partner join `columns` at the two call sites:

- `src/invoicing/taxed-document.service.ts` — `listPage()` join → `columns: ['name', 'code']`
  (covers both sales-invoices and purchase-bills, which share `TaxedDocumentService`)
- `src/invoicing/payments.service.ts` — `listPage()` join → `columns: ['name', 'code']`

No DTO, controller, route, or envelope changes. The existing extra `description`
match is a harmless superset of the frontend's requested fields and is retained
(removing it would be an out-of-scope behavior change).

### Deferred (optional, not in this work)

The frontend's lower-priority nice-to-have — `q` on `GET /v1/partners`,
`GET /v1/ledger/accounts`, `GET /v1/tax/codes` — is **deferred**. Those sets are
bounded (single company) and the client filters them fine today; adding search
surface there is not worth it now.

### Acceptance

- `GET /v1/sales-invoices?q=acme&status=POSTED&limit=20&offset=0` returns only
  POSTED invoices whose `invoice_ref` **or** customer `name` **or** customer
  `code` matches "acme" (case-insensitive, partial), with `total` = full match count.
- Same partner-`code` matching verified for `purchase-bills` and `payments`.

---

## Task 2 — `POST /v1/journal-entries/preview` (new, read-only, non-persisting)

A dry-run that returns the exact balanced journal entry a document *would* post,
so the accountant can verify debits/credits **before** committing. It must never
diverge from the real post — so it reuses the real posting derivation, never a
copy.

### Route & module

- **Route:** `POST /v1/journal-entries/preview`, `@HttpCode(200)`, bearer-auth
  (mirrors `POST /v1/tax/calculate`). Document-agnostic top-level path (the
  existing *manual-journal* CRUD lives at `ledger/journal-entries`; preview is not
  that resource, so it is not nested under `ledger/`).
- **Module:** new `JournalPreviewController` + `JournalPreviewService` in the
  **invoicing module**, which already wires `TaxModule` + `LedgerModule` +
  `CompanyModule` and owns the document/payment posting composition.

### Request — discriminated by `nature`

A single flat DTO validated conditionally with `@ValidateIf`.

**SALE | PURCHASE** — byte-identical to `POST /v1/tax/calculate`:
```jsonc
{
  "nature": "SALE",                 // or "PURCHASE"
  "settlementAccountId": "<uuid>",
  "lines": [
    { "accountId": "<uuid>", "amount": "1000000.0000", "taxCodeIds": ["<uuid>"] }
  ]
}
```
`lines` reuse the existing `TaxableLineDto` (`accountId` uuid, `amount`
`@IsMoneyString`, `taxCodeIds` uuid[]). ≥1 line required.

**PAYMENT** — the payment's own shape (reuses `AllocationDto`):
```jsonc
{
  "nature": "PAYMENT",
  "direction": "RECEIPT",           // or "DISBURSEMENT"
  "cashAccountId": "<uuid>",
  "allocations": [
    { "salesInvoiceId": "<uuid>", "amount": "500000.0000" }
    // DISBURSEMENT uses purchaseBillId instead
  ]
}
```
Each allocation must reference exactly the correct document type for the
direction (RECEIPT → `salesInvoiceId`, DISBURSEMENT → `purchaseBillId`), mirroring
`loadTarget`'s type check. ≥1 allocation required, each `amount` a positive money
string.

### Response — uniform across all three natures

```jsonc
{
  "lines": [
    { "accountId": "<uuid>", "accountCode": "1-1210", "accountName": "Piutang Usaha", "debit": "1110000.0000", "credit": "0.0000" },
    { "accountId": "<uuid>", "accountCode": "4-1000", "accountName": "Pendapatan",     "debit": "0.0000",       "credit": "1000000.0000" },
    { "accountId": "<uuid>", "accountCode": "2-1310", "accountName": "PPN Keluaran",   "debit": "0.0000",       "credit": "110000.0000" }
  ],
  "totalDebit": "1110000.0000",
  "totalCredit": "1110000.0000",
  "balanced": true
}
```
All amounts are 4-dp decimal strings. The non-active side of each line is
`"0.0000"`, never null. Named response DTOs (`JournalPreviewLineDto`,
`JournalPreviewResponseDto`) so the OpenAPI shape-guard test passes.

### Derivation — reuse the exact post-path logic (no reimplementation)

- **SALE / PURCHASE:** call `TaxService.calculate({ nature, settlementAccountId, lines })`
  and take `calc.journalLines`. This is the *same* call `DocumentPostingService.post`
  makes; `journalLines` is exactly what gets written. No copy of the GL derivation.
- **PAYMENT:** `total = Σ allocation.amount`; `controlId = findControlAccountId(prisma, target.controlRole)`
  (`AR_CONTROL` for RECEIPT, `AP_CONTROL` for DISBURSEMENT); JE =
  `buildPaymentLines(target, cashAccountId, controlId, total)` — the same helpers
  `PaymentsService.post` uses. Multiple allocations collapse into the single
  2-line cash↔control entry, exactly as posting does.

### Shared account validation + enrichment

Refactor `PostingService.assertPostableAccounts(lines)` (currently private) into a
public **`resolvePostableAccounts(ids: string[]): Promise<Map<string, Account>>`**
that validates existence + `isPostable` + `isActive` (throwing the same
`InvalidAccountError`s a real post throws) **and returns** the fetched accounts.
`assertPostableAccounts` becomes a thin wrapper over it (post path unchanged).
The preview calls `resolvePostableAccounts` on its line account ids once, using
the returned map for both validation **and** `code`/`name` enrichment — one fetch,
one source of truth.

A pure **`toPreview(journalLines, accountMap)`** function does the final
projection: normalize each `debit`/`credit` to 4-dp (`Money.of(x ?? '0').toPersistence()`,
non-active side `"0.0000"`), look up `accountCode`/`accountName`, and compute
`totalDebit`/`totalCredit`/`balanced`. This function is pure → unit-tested.

### Read-only guarantees

- **No** `$transaction`, no DB writes, no `Idempotency-Key` requirement, no
  period-lock, no closed-year check, no segregation-of-duties check. It is a dry
  run, not a state change.
- **Does** validate (so the user sees real problems early, with the same domain
  errors → same HTTP status a post would return):
  - tax-code existence/active, nature↔kind allowed, settlement positivity,
    balance — all already enforced inside `TaxService.calculate` (→ 422).
  - account existence/postable/active via `resolvePostableAccounts` (→ 422
    `InvalidAccountError`).
  - PAYMENT: cash + control account postable; allocation shape + positive amount;
    control-account-present (`findControlAccountId` → 422 if missing).
- **Documented non-goal:** the deeper *payment allocation* checks (partner-match,
  target POSTED, outstanding-not-exceeded) stay at draft-create / post time. The
  previewed JE shape does not depend on them, and the preview payload carries no
  `partnerId`. Preview answers "what accounts/amounts?", not "is this allocation
  allowed?".

### Testing

- **Unit** (pure): `toPreview` projection — enrich, 4-dp normalization, non-active
  side `"0.0000"`, totals, `balanced`. (Pure logic only, per the repo's
  unit-test-pure-code discipline.)
- **e2e "preview can't lie"** (the core guarantee):
  - Post a real sales invoice with PPN; diff its stored `journalEntry.lines`
    against `preview` for the identical `{nature, settlementAccountId, lines}` —
    accounts + debit/credit must match exactly. Repeat for a purchase bill.
  - Post a receipt payment against posted invoices; diff its stored JE lines
    against the PAYMENT preview for the same `{direction, cashAccountId, allocations}`.
  - Validation parity: unknown/non-postable account → 422 (same as post); unknown
    tax code → 422; withholding ≥ gross (non-positive settlement) → 422.
  - Read-only: `journalEntry.count()` unchanged after a preview; no
    `Idempotency-Key` header needed (does not 422).

### OpenAPI

Regenerate `docs/api/openapi.json` via `npm run openapi:export` after adding the
named request/response DTOs.

---

## Files touched (summary)

**Task 1**
- `src/invoicing/taxed-document.service.ts` — join `columns: ['name', 'code']`
- `src/invoicing/payments.service.ts` — join `columns: ['name', 'code']`
- e2e: partner-code search assertions on the three list specs

**Task 2**
- `src/ledger/posting/posting.service.ts` — extract public `resolvePostableAccounts`,
  make `assertPostableAccounts` delegate
- `src/invoicing/journal-preview.service.ts` — new
- `src/invoicing/journal-preview.controller.ts` — new
- `src/invoicing/dto/preview-journal-entry.dto.ts` — new request DTO (discriminated)
- `src/invoicing/dto/journal-preview-response.dto.ts` — new response DTOs
- `src/invoicing/journal-preview.projection.ts` (+ `.spec.ts`) — pure `toPreview`
- `src/invoicing/invoicing.module.ts` — register controller + service
- `test/journal-preview.e2e-spec.ts` — new
- `docs/api/openapi.json` — regenerated

## Out of scope / non-goals

- No change to the list envelope shape or the `/tax/calculate` contract (extend only).
- No persistence or audit-log entry for the preview.
- No `q` on partners/accounts/tax-codes (deferred).
- No deeper payment-allocation validation in the preview (enforced at post).

## Final contracts to report back to the frontend

- **Task 1:** no new params — `q` already exists; it now additionally matches
  partner `code` (alongside `name` and the document's own ref fields). Same
  `{data,total,limit,offset}` envelope, same enum/money conventions.
- **Task 2:** `POST /v1/journal-entries/preview`, discriminated by `nature`
  (SALE/PURCHASE use `{settlementAccountId, lines}`; PAYMENT uses
  `{direction, cashAccountId, allocations}`), returning
  `{lines:[{accountId,accountCode,accountName,debit,credit}], totalDebit, totalCredit, balanced}`.
  Errors are the standard domain errors (422 for invalid account / tax code /
  non-positive settlement / missing control account). No `Idempotency-Key` required.
