# Pull the document draft-lock inside the posting seam — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `DocumentPostingService.post()` own its FOR-UPDATE draft lock internally, removing the `lockDraft` closure parameter so the lock-before-number invariant can't be mis-ordered or omitted by any caller.

**Architecture:** `post()`'s signature narrows from `post(params, lockDraft, finalize)` to `post(params, finalize)`. The draft lock + `DRAFT` re-check SQL moves verbatim from `TaxedDocumentService.lockDraft` into a private `DocumentPostingService.lockDraftInTx`, fed by two new required fields on `PostTaxedDocParams` (`table`, `notDraftMessage`). Behavior is preserved exactly — only the SQL's owning module changes. The sole caller, `TaxedDocumentService.post`, is updated in the same change and its now-dead `lockDraft` is deleted.

**Tech Stack:** NestJS 11, Prisma 7 (`PrismaService.client`, `tx.$queryRaw` with `Prisma.sql`/`Prisma.raw`), Jest (unit + e2e against testcontainers — Docker must be running for e2e).

**Spec:** `docs/superpowers/specs/2026-06-19-posting-lock-internal-design.md`

## Global Constraints

- **No `any` / no erased Prisma typing.** Every closure and parameter stays typed.
- **No behavior change.** The lock SQL, its position (first statement in the tx, before numbering), and the thrown error message are preserved exactly. The `noLongerDraft` message stays **type-specific** (`"Invoice is no longer a draft"` / `"Bill is no longer a draft"`), passed in from `documentMessages(spec)` — #1's byte-for-byte parity unit tests must still pass unchanged.
- **`table` is a constant union literal** (`'sales_invoices' | 'purchase_bills'`) supplied by the adapter, never user input → `Prisma.raw(table)` stays injection-safe; `id` is always a bound parameter.
- **Out of scope — do not touch:** the void path (`DocumentLifecycleService.reverseWithGuard`, `TaxedDocumentService.lockForVoid`), `payments.*`, controllers, DTOs, routes, role guards, pagination/idempotency.
- **Lint gate:** `npm run lint:ci` runs eslint with `--max-warnings 0`. Zero warnings.
- **Coverage gate (CI-enforced):** `npm run test:e2e:cov` enforces global **84/62/84/84** (statements/branches/functions/lines). The post path is exercised by the existing `sales-invoices` + `purchase-bills` e2e specs; relocating the lock between two files does not add behavior, so no new tests are written (per spec §9).
- **Branch:** `feat/posting-lock-internal` (already created off `main` at `e2d382d`).

---

## File Structure

**Modify (only these two source files):**
- `src/invoicing/document-posting.service.ts` — add 2 imports; extend `PostTaxedDocParams`; narrow `post()` to `(params, finalize)`; add private `lockDraftInTx`; update the in-tx lock call + the `post()` JSDoc.
- `src/invoicing/taxed-document.service.ts` — update the `docPosting.post(...)` call (add `table` + `notDraftMessage`, drop the lock closure arg); delete the private `lockDraft` method.

**Unchanged (do not touch):** both controllers, all DTOs, `document-helpers.ts`, `document-lifecycle.service.ts`, `posting.service.ts`, `payments.*`, all e2e/unit specs.

This is one atomic change: the `post()` signature and its only caller must change together to typecheck. It is therefore a single task.

---

## Task 1: Fold the draft lock into `DocumentPostingService.post()`

**Files:**
- Modify: `src/invoicing/document-posting.service.ts`
- Modify: `src/invoicing/taxed-document.service.ts:219-234` (the `post` call) and `:268-281` (delete `lockDraft`)
- Regression net (unmodified): `test/sales-invoices.e2e-spec.ts`, `test/purchase-bills.e2e-spec.ts`

**Interfaces:**
- Consumes: `PostTaxedDocParams`, `PostedDocContext`, `LedgerTx` (already in `document-posting.service.ts`); `ValidationFailedError` (from `../common/errors/domain-errors`); `Prisma` (from `@prisma/client`); `documentMessages(spec).noLongerDraft` and `spec.table` (already available in `TaxedDocumentService.post`, where `m = documentMessages(spec)` is in scope).
- Produces: `DocumentPostingService.post(params: PostTaxedDocParams, finalize: (ctx: PostedDocContext) => Promise<void>): Promise<void>` (closure-free lock) and `PostTaxedDocParams` gains required `table: 'sales_invoices' | 'purchase_bills'` and `notDraftMessage: string`.

- [ ] **Step 1: Establish the regression baseline (existing e2e must be green BEFORE changing code)**

Run: `npx jest --config ./test/jest-e2e.json sales-invoices purchase-bills`
Expected: PASS — all `sales-invoices.e2e-spec.ts` and `purchase-bills.e2e-spec.ts` tests green (create/post/void/list/search + 403/422 paths). This is the net that proves the refactor preserves behavior. (Docker must be up for testcontainers.)

- [ ] **Step 2: Add the two imports in `document-posting.service.ts`**

Change line 2 from:

```ts
import { JournalEntry } from '@prisma/client';
```

to:

```ts
import { JournalEntry, Prisma } from '@prisma/client';
```

And add this import immediately after the existing `import { DocumentNumberService } from './document-number.service';` line:

```ts
import { ValidationFailedError } from '../common/errors/domain-errors';
```

- [ ] **Step 3: Extend `PostTaxedDocParams` with the two lock fields**

In `src/invoicing/document-posting.service.ts`, the `PostTaxedDocParams` interface currently ends:

```ts
  documentType: string; // 'INV' | 'BILL'
  lines: TaxableLineInput[];
}
```

Replace that closing with:

```ts
  documentType: string; // 'INV' | 'BILL'
  lines: TaxableLineInput[];
  /** Table the source document lives in — a constant literal, never user input. */
  table: 'sales_invoices' | 'purchase_bills';
  /** Type-specific "no longer a draft" message (from documentMessages(spec)). */
  notDraftMessage: string;
}
```

- [ ] **Step 4: Narrow `post()` and add the internal lock**

In `src/invoicing/document-posting.service.ts`, replace the entire `post(...)` method (the JSDoc block + method, from `/** Post a taxed document atomically.` through its closing `}`) with:

```ts
  /** Post a taxed document atomically. The source row is locked (FOR UPDATE) and
   *  re-checked still-DRAFT internally, before a number is consumed; `finalize`
   *  updates the document row to POSTED with the assigned number/ref + journal
   *  entry id. */
  async post(
    params: PostTaxedDocParams,
    finalize: (ctx: PostedDocContext) => Promise<void>,
  ): Promise<void> {
    const calc = await this.tax.calculate({
      nature: params.nature,
      settlementAccountId: params.settlementAccountId,
      lines: params.lines,
    });
    const journalInput = {
      date: params.date,
      description: params.description,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      createdBy: params.createdBy,
      lines: calc.journalLines,
    };
    const { periodId, fiscalYear } = await this.posting.preparePosting(
      journalInput,
      params.postedBy,
    );
    await this.prisma.client.$transaction(async (tx) => {
      await this.lockDraftInTx(
        tx,
        params.table,
        params.sourceId,
        params.notDraftMessage,
      );
      const number = await this.docNumber.next(
        tx,
        params.documentType,
        fiscalYear,
      );
      const ref = this.docNumber.buildRef(
        params.documentType,
        fiscalYear,
        number,
      );
      const entry = await this.posting.createPostedEntryInTx(
        tx,
        journalInput,
        params.postedBy,
        periodId,
        fiscalYear,
      );
      await finalize({
        tx,
        number,
        ref,
        entry,
        fiscalYear,
        totals: this.summarize(calc),
      });
    });
  }

  /** FOR UPDATE the source row and re-check it is still DRAFT, before a number is
   *  consumed. `table` is a constant union literal supplied by the adapter (never
   *  user input), so Prisma.raw(table) is injection-safe; `id` is a bound param. */
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

- [ ] **Step 5: Update the caller in `taxed-document.service.ts` and delete its `lockDraft`**

In `src/invoicing/taxed-document.service.ts`, the `post` method currently calls (around lines 219-234):

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
      },
      (tx) => this.lockDraft(tx, spec, id),
      (ctx) => spec.finalizePosted(ctx.tx, id, ctx, postedBy),
    );
```

Replace it with (add the two fields, drop the lock closure argument):

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
        table: spec.table,
        notDraftMessage: m.noLongerDraft,
      },
      (ctx) => spec.finalizePosted(ctx.tx, id, ctx, postedBy),
    );
```

Then **delete** the entire private `lockDraft` method (the JSDoc `/** FOR UPDATE draft lock built from the descriptor's constant table identifier. */` through its closing `}`, around lines 268-281):

```ts
  /** FOR UPDATE draft lock built from the descriptor's constant table identifier. */
  private async lockDraft<
    R extends DocumentRow,
    C extends CreateDocumentInput,
    U extends UpdateDocumentInput,
  >(tx: LedgerTx, spec: Spec<R, C, U>, id: string): Promise<void> {
    const rows = await tx.$queryRaw<{ status: string }[]>(
      Prisma.sql`SELECT status FROM ${Prisma.raw(spec.table)} WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`,
    );
    if (rows.length === 0 || rows[0].status !== 'DRAFT')
      throw new ValidationFailedError(documentMessages(spec).noLongerDraft, {
        id,
      });
  }
```

**Keep** the `lockForVoid` method immediately below it — it serves the void path and is out of scope. `Prisma`, `LedgerTx`, `ValidationFailedError`, and `documentMessages` all remain in use elsewhere in the file, so no imports are removed.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS (exit 0, no output). This is the cross-file consistency gate: the only caller (`TaxedDocumentService`) must supply the two new required fields and the 2-arg signature, or `tsc` fails.

> If `tsc` errors on `tx.$queryRaw(Prisma.sql\`…\`)` in `lockDraftInTx`, confirm `Prisma` is imported from `@prisma/client` (Step 2) and the call passes a single `Prisma.Sql` argument (it does). If it errors that `table`/`notDraftMessage` are missing on the `post` call, confirm Step 5 added both fields.

- [ ] **Step 7: Lint**

Run: `npm run lint:ci`
Expected: clean (exit 0, no warnings).

- [ ] **Step 8: Run the post-path e2e (behaviour preserved)**

Run: `npx jest --config ./test/jest-e2e.json sales-invoices purchase-bills`
Expected: PASS — identical to the Step 1 baseline. The post happy-path and the draft/void state-machine paths are green; the `noLongerDraft` message is unchanged per type.

- [ ] **Step 9: Full verification gate**

Run: `npm run verify`
Expected: PASS — `typecheck` (exit 0), `lint:ci` (clean), `test` (all unit specs incl. `document-presenter.spec.ts` parity), `test:e2e:cov` (all e2e pass **and** global coverage ≥ 84/62/84/84).

> The `noLongerDraft` race branch is concurrency-dependent and not deterministically hit by the suite; it merely relocates from `taxed-document.service.ts` to `document-posting.service.ts`. Global branch coverage (~70.9% vs 62% gate) has ample headroom, so no threshold regression is expected. If `test:e2e:cov` fails **only** on the branch threshold, inspect the report rather than adding speculative tests, and report the gap.

- [ ] **Step 10: Commit**

```bash
git add src/invoicing/document-posting.service.ts src/invoicing/taxed-document.service.ts
git commit -m "refactor(invoicing): own the draft lock inside DocumentPostingService.post

post() drops its lockDraft closure (now post(params, finalize)); the
FOR UPDATE draft lock + DRAFT re-check move internally, fed by required
table/notDraftMessage params. TaxedDocumentService.lockDraft deleted.
Behavior unchanged; sales/purchase e2e green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 11: Final sanity diff**

Run: `git diff --stat main`
Expected: exactly three files — `src/invoicing/document-posting.service.ts`, `src/invoicing/taxed-document.service.ts` (net **reduction**: the lock SQL moves and a typed private method is deleted), and the spec doc `docs/superpowers/specs/2026-06-19-posting-lock-internal-design.md`. No controllers, DTOs, payments, or void-path files.

---

## Self-Review

**1. Spec coverage**
- §2 goal (post → `(params, finalize)`, lock internal) → Task 1 Steps 3–5. ✓
- §5 interface (`table` + `notDraftMessage` required; `lockDraftInTx`; new imports) → Steps 2–4. ✓
- §6 data flow (lock first in tx, before numbering; rest unchanged) → Step 4 (lock call sits before `docNumber.next`). ✓
- §7 caller change + delete `lockDraft`, keep `lockForVoid` → Step 5. ✓
- §8 error handling (type-specific `notDraftMessage`, ValidationFailedError, pre-flight `notADraft` untouched) → Steps 4–5 (the early `notADraft` check in `TaxedDocumentService.post` is not modified). ✓
- §9 testing (no new files; existing e2e is the net; message parity unit test unchanged) → Steps 1, 8, 9. ✓
- §3 scope guards (void/payments/controllers/DTOs untouched) → Global Constraints + Step 11 diff. ✓
- §10/§11 verification + smallest diff → Steps 6–11. ✓

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to". Every code step shows the complete before/after; every run step states the exact command + expected result. ✓

**3. Type consistency:** `post(params: PostTaxedDocParams, finalize: (ctx: PostedDocContext) => Promise<void>)` is identical between the Produces block, Step 4, and the Step 5 call site (which now supplies `table`/`notDraftMessage` and a single `finalize`). `lockDraftInTx(tx: LedgerTx, table: 'sales_invoices' | 'purchase_bills', id: string, notDraftMessage: string)` is identical between Step 4's definition and its in-`post()` call. `PostTaxedDocParams` field names (`table`, `notDraftMessage`, `sourceId`) match between Step 3, Step 4's reads, and Step 5's writes. `m.noLongerDraft` (Step 5) is the same `documentMessages` key the deleted `lockDraft` used. ✓

No issues found.
