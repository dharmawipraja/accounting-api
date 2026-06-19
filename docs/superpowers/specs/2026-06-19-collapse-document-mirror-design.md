# Collapse the Sales/Purchase document mirror

**Date:** 2026-06-19
**Status:** Approved (design) — ready for implementation plan
**Origin:** Architecture review candidate #1 ("Collapse the Sales/Purchase document mirror")

## Vocabulary

Architecture terms are used exactly (per the `improve-codebase-architecture` skill):
**module, interface, implementation, depth, deep/shallow, seam, adapter, leverage, locality.**
Domain terms per `docs/runbooks/domain-glossary.md`. The new concept introduced here is
**"taxed trade document"** — a document that runs through the tax engine and posts to an
AR/AP control account (sales invoice + purchase bill), *excluding* payments. Recorded in
`CONTEXT.md` as part of this work.

---

## 1. Problem

`SalesInvoicesService` (~369 lines) and `PurchaseBillsService` (~373 lines) are ~95%
mirror-image implementations. They are two shallow modules: each method's interface is
nearly as complex as its body, and the body is duplicated in the sibling. Every rule —
draft/post/void state machine, line Money-math, the `lockDraft` raw SQL, `present()` —
exists twice, so every change is two edits and the two can silently diverge.

The two differ only by a small, enumerable set:

| Difference | Sales invoice | Purchase bill |
| --- | --- | --- |
| Prisma model / line delegate | `salesInvoice` / `salesInvoiceLine` | `purchaseBill` / `purchaseBillLine` |
| Partner flag | `isCustomer` | `isVendor` |
| Control-account role | `AR_CONTROL` | `AP_CONTROL` |
| Tax nature | `SALE` | `PURCHASE` |
| `sourceType` | `SALES_INVOICE` | `PURCHASE_BILL` |
| Document-number prefix | `INV` | `BILL` |
| Number / ref fields | `invoiceNumber` / `invoiceRef` | `billNumber` / `billRef` |
| Trigram table / columns | `sales_invoices` (`invoice_ref`, `description`) | `purchase_bills` (`bill_ref`, `vendor_invoice_no`, `description`) |
| **Extra field (structural)** | — | `vendorInvoiceNo` |
| Labels / nouns in messages | "invoice" / "Sales invoice" | "bill" / "Purchase bill" |

The shared seams these services build on are already deep and stay unchanged:
`DocumentPostingService`, `DocumentLifecycleService`, `findControlAccountId`,
`taxableLines`, `listPaginated`, `trigramSearch`, `serializeMoney`.

## 2. Goal

Deepen the two shallow mirrors into **one deep module** (`TaxedDocumentService`) that owns
the duplicated body once, with `SALE` and `PURCHASE` as two **adapters** (a typed
`DocumentDescriptor` each). Two adapters justify the seam — it is real, not hypothetical.

**Leverage:** a future taxed trade document type = one descriptor.
**Locality:** the state machine, line-math, lock, and presenter live in one place; fix once.

## 3. Scope

**In scope**
- One shared `TaxedDocumentService` + a `DocumentDescriptor` interface.
- `SalesInvoicesService` / `PurchaseBillsService` reduced to thin typed adapters.
- Unit tests for the now-shared pure logic.
- `CONTEXT.md` with the "taxed trade document" term.

**Out of scope (unchanged)**
- HTTP contracts: `/v1/sales-invoices`, `/v1/purchase-bills` routes, request/response DTOs,
  role guards, idempotency, pagination envelopes. Frontend contract does not move.
- `DocumentPostingService`, `DocumentLifecycleService`, `document-helpers.ts`.
- **Payments** — structurally different (allocations, direction, no tax path).
- **Candidate #2** (pull the draft lock fully inside `DocumentPostingService`) — a separate
  follow-on. This work *pre-stages* it by single-sourcing the lock from `spec.table`.

**Non-goals**
- No behavior change. Error messages preserved byte-for-byte (see §7).
- No `any` / erased Prisma typing — full type-safety is a hard requirement.

## 4. Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Collapse approach | **Typed descriptor** | Biggest dedup that keeps full Prisma typing. Descriptor = typed adapter to the per-model delegate; shared module = deep logic. |
| Testing | **Pin shared pure logic** with unit tests + keep e2e as the regression net | Unit-coverage floor (22/18/18/22) measures the new code; pure logic is the natural unit surface. |
| Messages | **Preserve byte-for-byte** | No test pins them, but rewriting is an uncovered behavior change. Keep it a pure refactor; normalize later if wanted. |
| Concrete service classes | **Keep as thin adapters** | Zero controller churn; typed home for each type's spec + input interfaces. |

## 5. Architecture & module shape

```
unchanged:  SalesInvoicesController          PurchaseBillsController
              /v1/sales-invoices               /v1/purchase-bills
                    │ injects                         │ injects
            SalesInvoicesService             PurchaseBillsService      ← thin typed ADAPTERS
              · typed inputs                   · typed inputs            (~90 lines each)
              · builds `spec`                  · builds `spec`           build a DocumentDescriptor,
              · delegates ───────┐             · delegates ──────┐       delegate every method
                                 ▼                               ▼
                    ┌───────────────────────────────────────────────┐
                    │  TaxedDocumentService  (NEW — the deep module) │  ~200 lines, written ONCE
                    │  createDraft · update · getById · listPage     │  owns ordering, messages,
                    │  deleteDraft · post · void · present           │  orchestration, lock, present
                    └───────────────────────┬───────────────────────┘
                                            │ reuses (unchanged)
        DocumentPostingService · DocumentLifecycleService · findControlAccountId
        · taxableLines · listPaginated · trigramSearch · serializeMoney
```

**New files**
- `src/invoicing/taxed-document.service.ts` — `@Injectable()`, **stateless**, generic over
  row/input types. Every method takes `(spec, …)`. The single-sourced body.
- `src/invoicing/document-descriptor.ts` — the `DocumentDescriptor` interface + the
  structural `DocumentRow` type + shared data shapes.
- `src/invoicing/document-presenter.ts` — pure `presentDocument(row)` + `buildLineCreateData(lines)`
  + the message builder (the unit-test surface).

**Changed files**
- `src/invoicing/sales-invoices.service.ts` / `purchase-bills.service.ts` → thin adapters.
  Keep class names + DI tokens (controllers untouched) and the typed `Create…Input` /
  `Update…Input` interfaces. Build a `spec` in the constructor; delegate every method.
- `src/invoicing/invoicing.module.ts` → register `TaxedDocumentService`.

**Unchanged:** both controllers, all DTOs, routes, role guards, idempotency, the reused
seams listed above.

## 6. The `DocumentDescriptor` interface

`TaxedDocumentService` is the **deep module**; the descriptor is the **adapter** to Prisma's
per-model typed delegate. The descriptor owns *only* typed data-access; the shared module
owns every decision, message, and orchestration.

```ts
// src/invoicing/document-descriptor.ts

/** Structural shape every taxed-document row shares — lets present() stay fully generic. */
export interface DocumentRow {
  id: string;
  status: DocumentStatus;
  partnerId: string;
  date: Date;
  dueDate: Date | null;
  description: string | null;
  createdBy: string;
  journalEntryId: string | null;
  subtotal: Prisma.Decimal;
  taxTotal: Prisma.Decimal;
  withholdingTotal: Prisma.Decimal;
  total: Prisma.Decimal;
  amountPaid: Prisma.Decimal;
  lines?: DocumentLineRow[];
}

export interface DocumentDescriptor<TRow extends DocumentRow, TCreate, TUpdate> {
  // ── identity (constants) ─────────────────────────────────────────────
  noun: string;                                 // 'invoice' | 'bill'
  label: string;                                // 'Sales invoice' | 'Purchase bill'
  article: 'a' | 'an';                          // message article: "void an invoice" / "a bill"
  nature: 'SALE' | 'PURCHASE';
  controlRole: AccountRole;                     // AR_CONTROL | AP_CONTROL
  partnerFlag: 'isCustomer' | 'isVendor';
  sourceType: 'SALES_INVOICE' | 'PURCHASE_BILL';
  documentType: string;                         // 'INV' | 'BILL'
  table: 'sales_invoices' | 'purchase_bills';   // constant identifier: lock SQL + trigram
  trigramColumns: string[];                     // own searched columns

  // ── typed reads (uniform shape, type-specific delegate) ──────────────
  findById(id: string): Promise<TRow | null>;
  page(a: { where: object; limit: number; offset: number }): Promise<{ rows: TRow[]; total: number }>;
  hydrate(ids: string[]): Promise<TRow[]>;

  // ── typed writes (the irreducible per-model bits) ────────────────────
  createRow(common: DocumentCreateCommon, input: TCreate): Promise<TRow>;     // .create — bill adds vendorInvoiceNo
  updateRow(tx: LedgerTx, id: string, common: DocumentUpdateCommon, input: TUpdate): Promise<void>;
  finalizePosted(tx: LedgerTx, id: string, ctx: PostedDocContext, postedBy: string): Promise<void>; // sets invoiceNumber|billNumber + refs
  markVoid(tx: LedgerTx, id: string): Promise<void>;                          // .update status:VOID
}
```

The shared module hands each closure the common data it already computed (totals + the
`Money.of(unitPrice).multiply(qty)` line math, written once); the closure merges the
type-specific delta and makes the actual typed Prisma call.

Worked adapter (the sales spec, built in `SalesInvoicesService`'s constructor):

```ts
this.spec = {
  noun: 'invoice', label: 'Sales invoice', article: 'an',
  nature: 'SALE', controlRole: 'AR_CONTROL', partnerFlag: 'isCustomer',
  sourceType: 'SALES_INVOICE', documentType: 'INV', table: 'sales_invoices',
  trigramColumns: ['invoice_ref', 'description'],
  findById: (id) => this.prisma.client.salesInvoice.findFirst({
    where: { id }, include: { lines: { orderBy: { lineNo: 'asc' } } } }),
  // …page, hydrate…
  createRow: (common) => this.prisma.client.salesInvoice.create({
    data: common, include: { lines: { orderBy: { lineNo: 'asc' } } } }),   // no vendorInvoiceNo
  finalizePosted: (tx, id, ctx, postedBy) => tx.salesInvoice.update({ where: { id }, data: {
    status: 'POSTED', invoiceNumber: ctx.number, invoiceRef: ctx.ref,
    fiscalYear: ctx.fiscalYear, journalEntryId: ctx.entry.id, postedBy,
    postedAt: new Date(), ...ctx.totals } }),
  markVoid: (tx, id) => tx.salesInvoice.update({ where: { id }, data: { status: 'VOID' } }),
};
```

The bill spec is identical in shape; its `createRow`/`updateRow` additionally read
`input.vendorInvoiceNo`, and `finalizePosted` sets `billNumber`/`billRef`.

**Where every difference lives — exactly once each**

| Difference | Lives in |
| --- | --- |
| model / line delegate, `.create`/`.update`/finalize/void calls | descriptor typed closures |
| `vendorInvoiceNo` (bill-only) | bill spec's `createRow`/`updateRow` |
| `invoiceNumber/Ref` vs `billNumber/Ref` | each spec's `finalizePosted` |
| `isCustomer`/`isVendor` | `partnerFlag` constant |
| `AR_CONTROL`/`AP_CONTROL` | `controlRole` constant |
| `SALE`/`PURCHASE`, `sourceType`, `INV`/`BILL` | constants |
| nouns / labels / article in messages | `noun` / `label` / `article` constants |
| trigram table + columns | `table` + `trigramColumns` |
| draft lock SQL | shared module, built from constant `spec.table` (injection-safe) |

## 7. Data flow

`createDraft` and `post` in the deep module, single-sourced:

```ts
async createDraft(spec, input): Promise<TRow> {
  const partner = await this.partners.findById(input.partnerId);
  if (!partner[spec.partnerFlag] || !partner.isActive)
    throw new ValidationFailedError(`Partner is not an active ${partnerKind(spec)}`, { partnerId: input.partnerId });
  const settlementId = await findControlAccountId(this.prisma, spec.controlRole);
  const totals = await this.docPosting.computeTotals(spec.nature, settlementId, taxableLines(input.lines));
  const common = {                                   // line Money-math written ONCE
    partnerId: input.partnerId, date: input.date, dueDate: input.dueDate,
    description: input.description, ...totals, createdBy: input.createdBy,
    lines: { create: buildLineCreateData(input.lines) },
  };
  return spec.createRow(common, input);              // only the typed .create (bill adds vendorInvoiceNo)
}

async post(spec, id, postedBy): Promise<TRow> {
  const row = await this.getById(spec, id);
  if (row.status !== 'DRAFT')
    throw new ValidationFailedError(`${cap(spec.noun)} is not a draft`, { id, status: row.status });
  const partner = await this.partners.findById(row.partnerId);
  if (!partner[spec.partnerFlag] || !partner.isActive)
    throw new ValidationFailedError(`Partner is not an active ${partnerKind(spec)}`, { partnerId: row.partnerId });
  const settlementId = await findControlAccountId(this.prisma, spec.controlRole);

  await this.docPosting.post(
    { nature: spec.nature, settlementAccountId: settlementId, date: row.date,
      description: row.description ?? `${spec.label} ${id}`,
      sourceType: spec.sourceType, sourceId: id, createdBy: row.createdBy, postedBy,
      documentType: spec.documentType, lines: taxableLines(row.lines) },
    (tx) => this.lockDraft(tx, spec, id),            // lock OWNED here, built from spec.table
    (ctx) => spec.finalizePosted(ctx.tx, id, ctx, postedBy), // only typed field names differ
  );
  return this.getById(spec, id);
}

private async lockDraft(tx, spec, id): Promise<void> {  // both lock closures collapse to this
  const rows = await tx.$queryRaw<{ status: string }[]>(Prisma.sql`
    SELECT status FROM ${Prisma.raw(spec.table)} WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`);
  if (rows.length === 0 || rows[0].status !== 'DRAFT')
    throw new ValidationFailedError(`${cap(spec.noun)} is no longer a draft`, { id });
}
```

- **`createDraft`** — partner validation, control resolution, `computeTotals`, and per-line
  Money-math run once. Only `spec.createRow` is per-type; it is the single place
  `vendorInvoiceNo` enters.
- **`post`** — orchestration into `DocumentPostingService.post(...)` is single-sourced. The
  `lockDraft` closure that was hand-copied into both services now lives once, built from the
  constant `spec.table` (only a literal, no user input → injection-safe). This deletes both
  duplicated `SELECT … FOR UPDATE` blocks and pre-stages candidate #2. `finalize` is the one
  genuinely per-type step.
- **`void`** — the `amountPaid` guard and `reverseWithGuard` wiring are shared; the spec
  supplies only `markVoid` and the lock table.

> `update` reconstructs absent `input.lines` from the existing row (Decimal→string). That
> reconstruction reads `TRow.lines` (typed) — handled in the shared module via the structural
> `DocumentRow.lines`, no per-type closure needed beyond `updateRow`.

## 8. Error handling & message parity

- **Error types unchanged** — `NotFoundDomainError`, `ValidationFailedError`,
  `ConflictDomainError`, mapped by `AllExceptionsFilter`. Status codes (`422`/`404`/`409`)
  unchanged.
- **Validation ordering preserved** — partner-active → control resolution → totals. Ordering
  decides which error wins; single-sourcing makes both types provably identical.
- **Messages preserved byte-for-byte.** The e2e specs assert only on HTTP status (`403`,
  `422`) and `body.status` — no message string is test-load-bearing — but messages are
  user-facing API text, so we keep them exact. The descriptor's `noun` / `label` / `article`
  fields (+ `partnerKind` from `partnerFlag`) reproduce every current string. The plan
  includes a **parity check**: extract the current strings from both old services first, then
  assert each exact string is still produced before deleting the old code.

Message inventory to preserve (each ×2): partner-inactive, "Only a DRAFT {noun} can be
edited", "{label} not found", "{cap noun} is not a draft", "{cap noun} is no longer a draft",
"Only a POSTED {noun} can be voided", "Cannot void {article} {noun} with payments; void the
payments first", "Cannot void {article} {noun} with payments", "{cap noun} journal entry was
already reversed", "{cap noun} is not posted", default description "{label} {id}".

## 9. Testing

- **e2e is the regression net.** `sales-invoices.e2e-spec` and `purchase-bills.e2e-spec` run
  the full orchestration through the unchanged HTTP contracts; green at every step; not
  modified.
- **New unit tests pin the shared pure logic** (in `document-presenter.spec.ts`):
  - `presentDocument(row)` → `outstanding` + `paymentStatus`: `UNPAID` (paid 0), `PARTIAL`
    (0 < paid < total), `PAID` (paid = total), `PAID` on over-payment (paid > total → negative
    outstanding), 4dp money serialization, nested-line serialization.
  - `buildLineCreateData(lines)` → `amount = Money.of(unitPrice) × quantity` at 4dp.
  - message builder → the parity check: every current string reproduced from each spec.
- **Stays e2e (DB → e2e convention):** all persistence/transaction paths and the descriptor
  closures (testing them = testing Prisma). No Prisma mocking.
- **Coverage floor:** moving duplicated lines into one place reduces total lines; pure parts
  gain unit coverage. Net effect on the unit-coverage % is neutral-to-positive; the raised
  floor (22/18/18/22) is safe.

## 10. Migration sequencing

Each step independently verifiable; both e2e green throughout.

1. Add `document-descriptor.ts`, `document-presenter.ts` (pure helpers), and
   `taxed-document.service.ts`; register in `InvoicingModule`. Dead code — nothing calls it
   yet. `tsc` + lint green. **(Verifies the §11 Prisma-typing risk early.)**
2. Add the unit tests from §9.
3. Convert `SalesInvoicesService` → thin adapter (build `spec`, delegate). Run **sales e2e → green**.
4. Convert `PurchaseBillsService` likewise. Run **purchase e2e → green**.
5. Delete the now-dead duplicated bodies. Full `verify` (typecheck, lint, unit, e2e).
6. Add `CONTEXT.md` with the "taxed trade document" term.

Sales-first-then-bill isolates any regression to one type.

## 11. Known risks

- **Prisma nested-write typing.** The shared `common` object's `lines: { create: [...] }`
  must structurally satisfy *both* line models' nested-create input. If Prisma's generated
  types fight it, the fallback is to have each spec's `createRow`/`updateRow` assemble
  `lines.create` from a plain `DocumentLineCreateData[]` the shared module passes in (one extra
  line per closure, still no `any`). Verified with `tsc` at step 1.
- **Message drift.** Mitigated by the byte-for-byte parity check in §8 before old code is
  deleted.
- **Generic ergonomics.** `DocumentDescriptor<TRow, TCreate, TUpdate>` must thread through the
  shared module without `any`. If the generics get unwieldy, narrow them at the adapter
  boundary (the concrete service supplies fully-resolved types), keeping the shared module's
  internals typed against `DocumentRow`.

## 12. Follow-ons (not this work)

- **Candidate #2** — pull the draft lock fully inside `DocumentPostingService` (pass
  `spec.table` instead of a `lockDraft` closure). Pre-staged here.
- **Normalize messages** — optional, as its own small change once parity is no longer needed.
