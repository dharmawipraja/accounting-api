# Pull the document draft-lock inside the posting seam

**Date:** 2026-06-19
**Status:** Approved (design) — ready for implementation plan
**Origin:** Architecture review candidate #2 ("Pull document locking inside the posting seam").
Follow-on to candidate #1 ([[2026-06-19-collapse-document-mirror-design.md]]), which is merged
to `main` (ff `e2d382d`).

## Vocabulary

Architecture terms are used exactly (per `improve-codebase-architecture`):
**module, interface, implementation, depth, deep/shallow, seam, adapter, leverage, locality.**
Domain terms per `docs/runbooks/domain-glossary.md`; "taxed trade document" per `CONTEXT.md`.

---

## 1. Problem

`DocumentPostingService.post()` (`src/invoicing/document-posting.service.ts`) is a deep module on
the posting axis — tax → prepare → lock → number → entry → finalize. But its interface punches one
**hole** through that depth: it takes a `lockDraft` closure (`post(params, lockDraft, finalize)`),
and the caller must hand-write `SELECT status FROM <table> … FOR UPDATE` + a `DRAFT` re-check, with
the implicit knowledge that this must run **before** a document number is consumed. To write the
closure you must understand posting internals — the seam leaks.

After candidate #1 the duplication is already gone (the SQL exists once, in
`TaxedDocumentService.lockDraft`, and `DocumentPostingService.post()` now has exactly **one** caller).
What remains is purely the **depth** problem: the lock-before-number invariant is enforced only by the
caller passing a correct closure, not by the interface. A future second caller — or a careless edit to
the existing one — could omit the `DRAFT` re-check or run it in the wrong place.

> Note on the review's framing: the review listed "callers: sales-invoices · purchase-bills ·
> payments (3× identical FOR UPDATE)". Post-#1 that is inaccurate. Sales + purchase collapsed into one
> closure, and **payments does not call `DocumentPostingService.post()`** — it has its own separate
> settlement-posting path with its own locks (`payments.service.ts`). Payments is out of scope.

## 2. Goal

Make `DocumentPostingService` **fully deep**: the FOR-UPDATE draft lock and `DRAFT` re-check become
**internal** to `post()`. The `lockDraft` closure parameter disappears; `post()` goes from three
arguments to two (`params`, `finalize`).

**Locality:** the lock-before-number invariant lives entirely inside one module.
**Leverage:** any future caller of `post()` gets the lock for free and cannot mis-order or omit it.

## 3. Scope

**In scope**
- `DocumentPostingService.post()`: remove the `lockDraft` closure; lock internally from data on `params`.
- `TaxedDocumentService.post()`: stop passing the closure; supply the lock data; delete its now-unused
  private `lockDraft`.

**Out of scope (explicitly)**
- The **void** path. `DocumentLifecycleService.reverseWithGuard` takes a symmetric `lock` closure, and
  `TaxedDocumentService.lockForVoid` stays. That lock is coupled to the caller's over-payment re-check
  and is a separate, larger change — left for a possible later candidate.
- `payments.service.ts` / `payments.controller.ts` — separate posting path, untouched.
- Controllers, DTOs, routes, role guards, idempotency, pagination — untouched.
- Candidate #4 (branding `PreparedPosting`) — a different, more safety-critical change; not bundled here.

## 4. Module shape

`DocumentPostingService` keeps its single public method `post()`; only its signature narrows:

```
before: post(params, lockDraft, finalize)
after:  post(params, finalize)              // lock is internal
```

`finalize` **stays** a closure — it is a genuine per-type write (`invoiceNumber`/`invoiceRef` vs
`billNumber`/`billRef`), a real adapter, not a leak. After this change `finalize` is the only injected
behavior, which is correct: it is the one thing that legitimately varies by document type.

## 5. Interface

Extend `PostTaxedDocParams` with two **required** fields (the only caller always has both, so required
keeps `tsc` honest):

```ts
export interface PostTaxedDocParams {
  // ...existing fields (nature, settlementAccountId, date, description,
  //    sourceType, sourceId, createdBy, postedBy, documentType, lines)...
  /** Table the source document lives in — a constant literal, never user input. */
  table: 'sales_invoices' | 'purchase_bills';
  /** Type-specific "no longer a draft" message, from documentMessages(spec). */
  notDraftMessage: string;
}
```

The document id the lock needs is already `params.sourceId`; no separate id field is added.

New private method (the SQL moved verbatim from `TaxedDocumentService.lockDraft`):

```ts
/** FOR UPDATE the source row and re-check it is still DRAFT, before a number is consumed.
 *  `table` is a constant union literal supplied by the adapter (never user input), so
 *  Prisma.raw(table) is injection-safe; `id` is a bound parameter. */
private async lockDraftInTx(
  tx: LedgerTx,
  table: 'sales_invoices' | 'purchase_bills',
  id: string,
  notDraftMessage: string,
): Promise<void> {
  const rows = await tx.$queryRaw<{ status: string }[]>(
    Prisma.sql`SELECT status FROM ${Prisma.raw(table)} WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`,
  );
  if (rows.length === 0 || rows[0].status !== 'DRAFT')
    throw new ValidationFailedError(notDraftMessage, { id });
}
```

New imports in `document-posting.service.ts`: `Prisma` from `@prisma/client`, `ValidationFailedError`
from `../common/errors/domain-errors`.

## 6. Data flow (semantically unchanged)

```
post(params, finalize):
  calc = tax.calculate(...)                         // outside tx (unchanged)
  { periodId, fiscalYear } = preparePosting(...)    // outside tx (unchanged)
  $transaction(tx => {
    lockDraftInTx(tx, params.table, params.sourceId, params.notDraftMessage)   // ← was lockDraft(tx)
    number = docNumber.next(tx, documentType, fiscalYear)                      // lock still precedes numbering
    ref    = docNumber.buildRef(...)
    entry  = posting.createPostedEntryInTx(...)
    finalize({ tx, number, ref, entry, fiscalYear, totals })
  })
```

The lock sits in the **same position** (first statement in the tx), so the lock-before-number
invariant is byte-for-byte the same behavior — only its owner changes.

## 7. Caller change (`TaxedDocumentService.post`)

```ts
await this.docPosting.post(
  {
    nature: spec.nature,
    settlementAccountId: settlementId,
    date: row.date,
    description: row.description ?? m.defaultDescription(id),
    sourceType: spec.sourceType,
    sourceId: id,
    createdBy: row.createdBy,
    postedBy,
    documentType: spec.documentType,
    lines: taxableLines(row.lines ?? []),
    table: spec.table,                 // ← added
    notDraftMessage: m.noLongerDraft,  // ← added (m already in scope; no second documentMessages call)
  },
  (ctx) => spec.finalizePosted(ctx.tx, id, ctx, postedBy),  // ← lockDraft arg removed
);
```

Then **delete** the private `lockDraft` method. Keep `lockForVoid` (void path). `Prisma` and `LedgerTx`
imports remain in use (`lockForVoid`, `listPage`, `updateRow`). No `any`.

## 8. Error handling

- Race / concurrent state change: `ValidationFailedError(notDraftMessage, { id })`, where
  `notDraftMessage` is the type-specific string (`"Invoice is no longer a draft"` /
  `"Bill is no longer a draft"`). Identical to today; #1's `documentMessages` parity unit tests still
  pass unchanged.
- The cheap pre-flight `notADraft` check in `TaxedDocumentService.post` (before the tx) is **kept** — it
  is UX, not the lock. The authoritative FOR-UPDATE re-check is the part that moves.
- Throwing inside the `$transaction` rolls back the tx (intended — nothing committed on a lost race).

## 9. Testing

- **No new test files.** The integrated post happy-path is the regression net via the existing
  `sales-invoices` + `purchase-bills` e2e specs; the message strings are already unit-pinned by
  `document-presenter.spec.ts`. A unit test for raw-SQL-in-a-tx needs a DB and is low-value/brittle —
  same testing philosophy as #1 (orchestration → e2e, pure logic → unit).
- The `noLongerDraft` race branch (concurrent) is not deterministically reachable in the suite and is
  likely already an uncovered branch; relocating it between two files does not change global coverage
  (branch 70.91% vs 62% gate — ample headroom).

## 10. Verification & migration

- Single branch `feat/posting-lock-internal` off `main`, one commit.
- Gate: `npm run verify` (typecheck exit 0 → `lint:ci` clean → unit all pass → `test:e2e:cov` all pass
  **and** global coverage ≥ 84/62/84/84).
- Sanity diff vs `main`: only `src/invoicing/document-posting.service.ts` and
  `src/invoicing/taxed-document.service.ts` change (plus this spec). No controllers/DTOs/payments.

## 11. Risks

- **Type safety:** the two new `params` fields are required; the sole caller is updated in the same
  change, so `tsc` enforces consistency. No `any`, no erased Prisma typing.
- **Behavior drift:** none expected — the lock SQL, its position, and the thrown message are preserved
  exactly. The only structural change is which module owns the SQL.
- **Smallest-possible diff:** ~15 lines move plus one method deletion; low blast radius.
