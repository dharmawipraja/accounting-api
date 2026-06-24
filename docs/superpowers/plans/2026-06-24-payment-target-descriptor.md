# Collapse the Payment Receipt/Disbursement Mirror — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the receipt/disbursement mirror in `PaymentsService` behind one `PaymentTarget` descriptor keyed by direction, with shared `loadTarget`/`settleInTx`/`unwindInTx` helpers that own the over-allocation guard once.

**Architecture:** A new `src/invoicing/payment-targets.ts` holds a `PaymentTarget` descriptor, a `PAYMENT_TARGETS` map (RECEIPT/DISBURSEMENT), free-function helpers, and a pure `exceedsOutstanding`. `PaymentsService` selects the descriptor by direction and delegates, collapsing four duplicated mirror sites. Strictly behavior-preserving: same raw `FOR UPDATE` SQL, the same per-allocation re-read under the lock, the same increment/decrement delegates, and all error strings preserved verbatim via the descriptor.

**Tech Stack:** NestJS 11, Prisma 7, `Money` (decimal.js), Jest (unit + e2e against testcontainers — Docker required for e2e).

**Spec:** `docs/superpowers/specs/2026-06-24-payment-target-descriptor-design.md`

## Global Constraints

- **Behavior-preserving.** The raw SQL, the per-allocation re-read under `FOR UPDATE`, the `amountPaid` increment/decrement delegates, the 2-line journal, and the posting seam are unchanged. Only the *shape* by which the direction's enumerations reach the logic changes.
- **Messages byte-for-byte.** Payments uses TWO nouns: short (`invoice`/`bill`) in `post` ("Allocated invoice is not posted"), long (`sales invoice`/`purchase bill`) in `loadTarget` ("A receipt allocation must reference a sales invoice"). The descriptor carries both (`noun`, `label`); every existing string is reproduced exactly.
- **Per-allocation re-read.** `settleInTx` re-reads its target inside each loop iteration (one call per allocation), so two allocations to one document see each other's increment under the lock — preserved.
- **`Prisma.raw(target.table)`** uses a constant union literal (`'sales_invoices' | 'purchase_bills'`), never user input — injection-safe (same as round-1's `spec.table`).
- **Out of scope — do not touch:** `post()`'s draft-lock / `preparePosting` / `createPostedEntryInTx` / `$transaction` tuning / `payment.update`; `void`'s `reverseWithGuard` wrapper; `createDraft`'s cumulative `allocatedByDoc` over-allocation math and its generic "document" messages; `present`; `listPage`; `deleteDraft`; `AgingService`; controllers; DTOs; schema.
- **No `any`.** Lint `--max-warnings 0`. Coverage gate `test:e2e:cov` global 84/62/84/84.
- **Branch:** `feat/payment-target-descriptor` (already created off `main` at `06c33ac`).

---

## File Structure

**Create**
- `src/invoicing/payment-targets.ts` — `AllocationInput`, `TargetRow`, `PaymentJournalLine`, `PaymentTarget`, `PAYMENT_TARGETS`, `exceedsOutstanding`, `buildPaymentLines`, `loadTarget`, `settleInTx`, `unwindInTx`.
- `src/invoicing/payment-targets.spec.ts` — unit tests for `exceedsOutstanding` + `buildPaymentLines`.

**Modify**
- `src/invoicing/payments.service.ts` — import `AllocationInput` from `payment-targets` (delete local def); collapse `loadTarget`/`createDraft` partner check/`post`/`void` onto the descriptor.
- `CONTEXT.md` — add the "payment target" term.

**Unchanged:** `payments.controller.ts`, DTOs, `aging.service.ts`, posting, schema, the e2e specs.

---

## Task 1: The `PaymentTarget` descriptor module + pure-logic tests

**Files:**
- Create: `src/invoicing/payment-targets.ts`
- Test: `src/invoicing/payment-targets.spec.ts`

**Interfaces (produced, consumed by Task 2):**
- `AllocationInput { salesInvoiceId?, purchaseBillId?, amount: string }`
- `PaymentTarget` (see Step 3) + `PAYMENT_TARGETS: Record<PaymentDirection, PaymentTarget>`
- `exceedsOutstanding(total: Prisma.Decimal, amountPaid: Prisma.Decimal, amount: string): boolean`
- `buildPaymentLines(target, cashAccountId, controlId, amount): PaymentJournalLine[]`
- `loadTarget(client, target, alloc): Promise<TargetRow>`
- `settleInTx(tx: LedgerTx, target, alloc, partnerId: string): Promise<void>`
- `unwindInTx(tx: LedgerTx, target, alloc): Promise<void>`

- [ ] **Step 1: Write the failing unit tests**

Create `src/invoicing/payment-targets.spec.ts`:

```ts
import { Prisma } from '@prisma/client';
import {
  exceedsOutstanding,
  buildPaymentLines,
  PAYMENT_TARGETS,
} from './payment-targets';

const D = (v: string) => new Prisma.Decimal(v);

describe('exceedsOutstanding', () => {
  it('false at the exact boundary (amount == outstanding)', () => {
    expect(exceedsOutstanding(D('1000'), D('0'), '1000')).toBe(false);
    expect(exceedsOutstanding(D('1000'), D('400'), '600')).toBe(false);
  });
  it('true when amount exceeds outstanding', () => {
    expect(exceedsOutstanding(D('1000'), D('0'), '1000.0001')).toBe(true);
    expect(exceedsOutstanding(D('1000'), D('400'), '700')).toBe(true);
  });
  it('false when well under', () => {
    expect(exceedsOutstanding(D('1000'), D('0'), '1')).toBe(false);
  });
});

describe('buildPaymentLines', () => {
  it('RECEIPT debits cash, credits control', () => {
    expect(
      buildPaymentLines(PAYMENT_TARGETS.RECEIPT, 'cash', 'ar', '500.0000'),
    ).toEqual([
      { accountId: 'cash', debit: '500.0000' },
      { accountId: 'ar', credit: '500.0000' },
    ]);
  });
  it('DISBURSEMENT debits control, credits cash', () => {
    expect(
      buildPaymentLines(PAYMENT_TARGETS.DISBURSEMENT, 'cash', 'ap', '500.0000'),
    ).toEqual([
      { accountId: 'ap', debit: '500.0000' },
      { accountId: 'cash', credit: '500.0000' },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/invoicing/payment-targets.spec.ts`
Expected: FAIL — `Cannot find module './payment-targets'`.

- [ ] **Step 3: Implement the module**

Create `src/invoicing/payment-targets.ts`:

```ts
import {
  AccountRole,
  DocumentStatus,
  PaymentDirection,
  Prisma,
} from '@prisma/client';
import { Money } from '../common/money/money';
import { LedgerTx } from '../ledger/posting/posting.service';
import { ExtendedPrismaClient } from '../common/prisma/soft-delete.extension';
import {
  ConflictDomainError,
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';

export interface AllocationInput {
  salesInvoiceId?: string;
  purchaseBillId?: string;
  amount: string;
}

/** Normalized read of the document a payment allocation settles. */
export interface TargetRow {
  id: string;
  partnerId: string;
  status: DocumentStatus;
  total: Prisma.Decimal;
  amountPaid: Prisma.Decimal;
}

/** One line of a payment's 2-line cash/control journal. */
export interface PaymentJournalLine {
  accountId: string;
  debit?: string;
  credit?: string;
}

/** The document a payment allocation settles, per direction:
 *  RECEIPT → sales invoice (AR); DISBURSEMENT → purchase bill (AP). */
export interface PaymentTarget {
  direction: PaymentDirection;
  partnerFlag: 'isCustomer' | 'isVendor';
  partnerRequiredMessage: string;
  controlRole: AccountRole;
  numberPrefix: 'PAY-RCV' | 'PAY-DSB';
  /** Constant union literal — never user input; safe for Prisma.raw. */
  table: 'sales_invoices' | 'purchase_bills';
  noun: string; // short: 'invoice' | 'bill' (post-path messages)
  label: string; // long: 'sales invoice' | 'purchase bill' (loadTarget messages)
  cashIsDebit: boolean;
  allocId(a: AllocationInput): string | undefined;
  otherId(a: AllocationInput): string | undefined;
  find(client: ExtendedPrismaClient, id: string): Promise<TargetRow | null>;
  applyPaid(
    tx: LedgerTx,
    id: string,
    amount: Prisma.Decimal,
    sign: 1 | -1,
  ): Promise<void>;
}

export const PAYMENT_TARGETS: Record<PaymentDirection, PaymentTarget> = {
  RECEIPT: {
    direction: 'RECEIPT',
    partnerFlag: 'isCustomer',
    partnerRequiredMessage: 'Receipt requires a customer',
    controlRole: 'AR_CONTROL',
    numberPrefix: 'PAY-RCV',
    table: 'sales_invoices',
    noun: 'invoice',
    label: 'sales invoice',
    cashIsDebit: true,
    allocId: (a) => a.salesInvoiceId,
    otherId: (a) => a.purchaseBillId,
    find: async (client, id) => {
      const inv = await client.salesInvoice.findFirst({ where: { id } });
      return inv
        ? {
            id: inv.id,
            partnerId: inv.partnerId,
            status: inv.status,
            total: inv.total,
            amountPaid: inv.amountPaid,
          }
        : null;
    },
    applyPaid: async (tx, id, amount, sign) => {
      await tx.salesInvoice.update({
        where: { id },
        data: {
          amountPaid:
            sign === 1 ? { increment: amount } : { decrement: amount },
        },
      });
    },
  },
  DISBURSEMENT: {
    direction: 'DISBURSEMENT',
    partnerFlag: 'isVendor',
    partnerRequiredMessage: 'Disbursement requires a vendor',
    controlRole: 'AP_CONTROL',
    numberPrefix: 'PAY-DSB',
    table: 'purchase_bills',
    noun: 'bill',
    label: 'purchase bill',
    cashIsDebit: false,
    allocId: (a) => a.purchaseBillId,
    otherId: (a) => a.salesInvoiceId,
    find: async (client, id) => {
      const bill = await client.purchaseBill.findFirst({ where: { id } });
      return bill
        ? {
            id: bill.id,
            partnerId: bill.partnerId,
            status: bill.status,
            total: bill.total,
            amountPaid: bill.amountPaid,
          }
        : null;
    },
    applyPaid: async (tx, id, amount, sign) => {
      await tx.purchaseBill.update({
        where: { id },
        data: {
          amountPaid:
            sign === 1 ? { increment: amount } : { decrement: amount },
        },
      });
    },
  },
};

/** Pure over-allocation check: does settling `amount` drive the document past its
 *  outstanding (total − amountPaid)? No I/O. Exact-boundary is allowed (not exceeding). */
export function exceedsOutstanding(
  total: Prisma.Decimal,
  amountPaid: Prisma.Decimal,
  amount: string,
): boolean {
  return Money.of(total.toString())
    .subtract(Money.of(amountPaid.toString()))
    .subtract(Money.of(amount))
    .isNegative();
}

/** The 2-line cash/control journal for a payment. */
export function buildPaymentLines(
  target: PaymentTarget,
  cashAccountId: string,
  controlId: string,
  amount: string,
): PaymentJournalLine[] {
  return target.cashIsDebit
    ? [
        { accountId: cashAccountId, debit: amount },
        { accountId: controlId, credit: amount },
      ]
    : [
        { accountId: controlId, debit: amount },
        { accountId: cashAccountId, credit: amount },
      ];
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Validate the allocation references the right document type, then read it (create-draft path). */
export async function loadTarget(
  client: ExtendedPrismaClient,
  target: PaymentTarget,
  alloc: AllocationInput,
): Promise<TargetRow> {
  const id = target.allocId(alloc);
  if (!id || target.otherId(alloc))
    throw new ValidationFailedError(
      `A ${target.direction.toLowerCase()} allocation must reference a ${target.label}`,
      {},
    );
  const row = await target.find(client, id);
  if (!row)
    throw new NotFoundDomainError(`${cap(target.label)} not found`, { id });
  return row;
}

/** Lock the target FOR UPDATE, re-verify POSTED + partner + outstanding, increment amountPaid.
 *  Call once per allocation so repeated allocations to one document see each other's
 *  increment under the lock. */
export async function settleInTx(
  tx: LedgerTx,
  target: PaymentTarget,
  alloc: AllocationInput,
  partnerId: string,
): Promise<void> {
  const id = target.allocId(alloc)!;
  const rows = await tx.$queryRaw<
    {
      status: string;
      total: string;
      amount_paid: string;
      partner_id: string;
    }[]
  >(
    Prisma.sql`SELECT status, total, amount_paid, partner_id FROM ${Prisma.raw(target.table)} WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`,
  );
  if (rows.length === 0 || rows[0].status !== 'POSTED')
    throw new ValidationFailedError(`Allocated ${target.noun} is not posted`, {
      id,
    });
  if (rows[0].partner_id !== partnerId)
    throw new ValidationFailedError(
      `Allocated ${target.noun} belongs to another partner`,
      { id },
    );
  if (
    exceedsOutstanding(
      new Prisma.Decimal(rows[0].total),
      new Prisma.Decimal(rows[0].amount_paid),
      alloc.amount,
    )
  )
    throw new ConflictDomainError('Allocation now exceeds outstanding', { id });
  await target.applyPaid(tx, id, new Prisma.Decimal(alloc.amount), 1);
}

/** Lock the target FOR UPDATE, floor-check, decrement amountPaid (void path). */
export async function unwindInTx(
  tx: LedgerTx,
  target: PaymentTarget,
  alloc: AllocationInput,
): Promise<void> {
  const id = target.allocId(alloc)!;
  const rows = await tx.$queryRaw<{ amount_paid: string }[]>(
    Prisma.sql`SELECT amount_paid FROM ${Prisma.raw(target.table)} WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`,
  );
  if (
    rows.length === 0 ||
    Money.of(rows[0].amount_paid).subtract(Money.of(alloc.amount)).isNegative()
  )
    throw new ConflictDomainError('Void would drive amountPaid negative', {
      id,
    });
  await target.applyPaid(tx, id, new Prisma.Decimal(alloc.amount), -1);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/invoicing/payment-targets.spec.ts`
Expected: PASS — 5 passed.

- [ ] **Step 5: Typecheck + lint the new files**

Run: `npm run typecheck`
Expected: PASS (exit 0). The module is self-contained; nothing imports it yet.

Run: `npx eslint src/invoicing/payment-targets.ts src/invoicing/payment-targets.spec.ts --max-warnings 0`
Expected: clean.

> If `tsc` errors on `tx.salesInvoice`/`tx.purchaseBill` (the `applyPaid` delegate), confirm `LedgerTx` (from `../ledger/posting/posting.service`) exposes model delegates — it does (it's the extended client minus `$transaction`/lifecycle methods). If `find`'s `client.salesInvoice` errors, confirm `ExtendedPrismaClient` is imported from `../common/prisma/soft-delete.extension`.

- [ ] **Step 6: Commit**

```bash
git add src/invoicing/payment-targets.ts src/invoicing/payment-targets.spec.ts
git commit -m "feat(invoicing): PaymentTarget descriptor + settlement helpers

The receipt/disbursement settlement seam: a PaymentTarget descriptor
keyed by direction, plus loadTarget/settleInTx/unwindInTx/buildPaymentLines
and a pure, unit-tested exceedsOutstanding guard. Not yet wired to callers.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Collapse `PaymentsService` onto the descriptor

**Files:**
- Modify: `src/invoicing/payments.service.ts`
- Modify: `CONTEXT.md`
- Regression net (unmodified): `test/payments.e2e-spec.ts`

**Interfaces:**
- Consumes from Task 1: `AllocationInput`, `PaymentTarget`, `PAYMENT_TARGETS`, `loadTarget`, `settleInTx`, `unwindInTx`, `buildPaymentLines`.

- [ ] **Step 1: Establish the regression baseline (payments e2e green BEFORE the change)**

Run: `npx jest --config ./test/jest-e2e.json payments`
Expected: PASS — receipt + disbursement create/post/void, over-allocation rejection, partner-mismatch, concurrent post race, negative-floor void guard. (Docker must be up.)

- [ ] **Step 2: Swap imports and delete the local `AllocationInput`**

In `src/invoicing/payments.service.ts`, replace the local `AllocationInput` interface (lines ~24-28) by importing it. Add to the import block:

```ts
import {
  AllocationInput,
  PAYMENT_TARGETS,
  loadTarget,
  settleInTx,
  unwindInTx,
  buildPaymentLines,
} from './payment-targets';
```

and DELETE the local declaration:

```ts
export interface AllocationInput {
  salesInvoiceId?: string;
  purchaseBillId?: string;
  amount: string;
}
```

(`CreatePaymentInput` keeps referencing `AllocationInput` — now the imported one. Re-export it if any other module imports `AllocationInput` from here: `export { AllocationInput } from './payment-targets';`. Confirm via `grep -rn "AllocationInput" src` whether a re-export is needed.)

- [ ] **Step 3: Delete the private `loadTarget`; route create-draft through the shared one**

Delete the entire private `loadTarget` method (lines ~49-94).

In `createDraft`, replace the two-arm partner check:

```ts
    if (input.direction === 'RECEIPT' && !partner.isCustomer)
      throw new ValidationFailedError('Receipt requires a customer', {
        partnerId: input.partnerId,
      });
    if (input.direction === 'DISBURSEMENT' && !partner.isVendor)
      throw new ValidationFailedError('Disbursement requires a vendor', {
        partnerId: input.partnerId,
      });
```

with (selecting the descriptor once):

```ts
    const target = PAYMENT_TARGETS[input.direction];
    if (!partner[target.partnerFlag])
      throw new ValidationFailedError(target.partnerRequiredMessage, {
        partnerId: input.partnerId,
      });
```

and in the allocation loop replace the call:

```ts
      const target = await this.loadTarget(input.direction, alloc);
```

with (reuse the `target` already in scope, call the shared helper):

```ts
      const targetRow = await loadTarget(this.prisma.client, target, alloc);
```

Then rename the loop's subsequent `target.` references (the read result) to `targetRow.` — i.e. `targetRow.partnerId`, `targetRow.id`, `targetRow.status`, `targetRow.total`, `targetRow.amountPaid`. (The descriptor is `target`; the read row is `targetRow`. The generic `createDraft` messages — 'Allocated document belongs to another partner', 'Can only allocate to a POSTED document', 'Allocation exceeds the document outstanding' — and the `allocatedByDoc` cumulative math are UNCHANGED.)

- [ ] **Step 4: Collapse `post()`'s control / journal-lines / allocation-loop / prefix**

In `post`, replace the control-account + journal-line block:

```ts
    const isReceipt = payment.direction === 'RECEIPT';
    const controlId = await findControlAccountId(
      this.prisma,
      isReceipt ? 'AR_CONTROL' : 'AP_CONTROL',
    );
    const amount = Money.of(payment.amount.toString());

    // Build the 2-line journal: RECEIPT Dr cash / Cr AR ; DISBURSEMENT Dr AP / Cr cash.
    const journalInput = {
      date: payment.date,
      description: payment.description ?? `Payment ${id}`,
      sourceType: 'PAYMENT' as const,
      sourceId: id,
      createdBy: payment.createdBy,
      lines: isReceipt
        ? [
            { accountId: payment.cashAccountId, debit: amount.toPersistence() },
            { accountId: controlId, credit: amount.toPersistence() },
          ]
        : [
            { accountId: controlId, debit: amount.toPersistence() },
            {
              accountId: payment.cashAccountId,
              credit: amount.toPersistence(),
            },
          ],
    };
```

with:

```ts
    const target = PAYMENT_TARGETS[payment.direction];
    const controlId = await findControlAccountId(
      this.prisma,
      target.controlRole,
    );
    const amount = Money.of(payment.amount.toString());

    const journalInput = {
      date: payment.date,
      description: payment.description ?? `Payment ${id}`,
      sourceType: 'PAYMENT' as const,
      sourceId: id,
      createdBy: payment.createdBy,
      lines: buildPaymentLines(
        target,
        payment.cashAccountId,
        controlId,
        amount.toPersistence(),
      ),
    };
```

Replace the in-tx allocation loop (the `for (const a of allocations) { const amt = …; if (isReceipt) { … } else { … } }` block, ~316-386) with:

```ts
        for (const a of allocations) {
          await settleInTx(tx, target, a, payment.partnerId);
        }
```

Replace the doc-number prefix picks:

```ts
        const number = await this.docNumber.next(
          tx,
          isReceipt ? 'PAY-RCV' : 'PAY-DSB',
          prepared.fiscalYear,
        );
        const ref = this.docNumber.buildRef(
          isReceipt ? 'PAY-RCV' : 'PAY-DSB',
          prepared.fiscalYear,
          number,
        );
```

with:

```ts
        const number = await this.docNumber.next(
          tx,
          target.numberPrefix,
          prepared.fiscalYear,
        );
        const ref = this.docNumber.buildRef(
          target.numberPrefix,
          prepared.fiscalYear,
          number,
        );
```

(The draft-lock re-check, `preparePosting`/`createPostedEntryInTx`, the `$transaction({maxWait,timeout})` tuning, and `payment.update` are untouched. The `allocations` typed-cast extraction at the top of `post` stays. `isReceipt` is now unused — remove its declaration.)

- [ ] **Step 5: Collapse `void()`'s unwind loop**

In `void`, replace the `applyInTx`'s two-block allocation loop (the `for (const a of allocations) { if (a.salesInvoiceId) { … } if (a.purchaseBillId) { … } }` block, ~451-488) with:

```ts
      applyInTx: async (tx) => {
        const target = PAYMENT_TARGETS[payment.direction];
        for (const a of allocations) {
          await unwindInTx(tx, target, a);
        }
        await tx.payment.update({
          where: { id },
          data: { status: 'VOID' },
        });
      },
```

(The `reverseWithGuard` wrapper, its `lock` closure, and the messages are untouched.)

- [ ] **Step 6: Add the `CONTEXT.md` term**

Append to `CONTEXT.md`:

```markdown

## Payment target

The document a payment allocation settles: a **sales invoice** for a `RECEIPT`,
a **purchase bill** for a `DISBURSEMENT`. The receipt/disbursement behavior that
varies by direction (target table, control role, partner flag, doc-number prefix,
cash side, message nouns) lives in one `PaymentTarget` descriptor
(`src/invoicing/payment-targets.ts`), keyed by `PaymentDirection`; the shared
`settleInTx`/`unwindInTx`/`loadTarget` helpers own the over-allocation guard once.
`PaymentsService` selects the descriptor by direction and delegates.
```

- [ ] **Step 7: Typecheck + lint**

Run: `npm run typecheck`
Expected: PASS (exit 0). Confirms the four sites + import swap are consistent and no dangling `this.loadTarget`/`isReceipt`/local-`AllocationInput` references remain.

Run: `npm run lint:ci`
Expected: clean (catches the now-unused `isReceipt`, `Money`/`findControlAccountId` only if they became unused — `findControlAccountId` and `Money` are still used).

- [ ] **Step 8: Run the payments e2e (behaviour preserved)**

Run: `npx jest --config ./test/jest-e2e.json payments`
Expected: PASS — identical to the Step 1 baseline. All receipt/disbursement post/void, over-allocation, partner-mismatch, concurrency, and floor-guard paths green, with identical error strings.

- [ ] **Step 9: Full verification gate**

Run: `npm run verify`
Expected: PASS — typecheck (exit 0), `lint:ci` (clean), `test` (unit incl. `payment-targets.spec`), `test:e2e:cov` (all e2e pass **and** global coverage ≥ 84/62/84/84).

- [ ] **Step 10: Commit**

```bash
git add src/invoicing/payments.service.ts CONTEXT.md
git commit -m "refactor(invoicing): collapse the payment receipt/disbursement mirror

PaymentsService selects a PaymentTarget descriptor by direction and
delegates loadTarget/settle/unwind to the shared helpers; the four
duplicated mirror arms collapse and the over-allocation guard lives once.
Behavior unchanged; messages preserved byte-for-byte; payments e2e green.
CONTEXT.md records the 'payment target' term.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 11: Final sanity diff**

Run: `git diff --stat main`
Expected: `payment-targets.ts` + `payment-targets.spec.ts` (new), `payments.service.ts` (net **reduction**), `CONTEXT.md`, plus the design spec. No controllers/DTOs/schema; no `aging`/posting changes.

---

## Self-Review

**1. Spec coverage**
- §4 descriptor + helpers + pure `exceedsOutstanding`/`buildPaymentLines` → Task 1 Step 3. ✓
- §5 caller collapse (loadTarget, createDraft partner check, post control/lines/loop/prefix, void loop) → Task 2 Steps 3–5. ✓
- §7 messages byte-for-byte (two nouns: short `noun` for post, long `label` for loadTarget; `partnerRequiredMessage`) → descriptor fields + Step 3/4 edits. ✓
- §8 testing (pure unit tests + existing payments e2e net) → Task 1 Steps 1–4; Task 2 Steps 1, 8, 9. ✓
- §3 out-of-scope (post structure, reverseWithGuard, createDraft cumulative math, aging, controllers/DTOs/schema) → Global Constraints + Step 11 diff. ✓
- §2 CONTEXT.md term → Task 2 Step 6. ✓
- §10 per-allocation re-read preserved (settleInTx called once per allocation) → Step 4 loop. ✓

**2. Placeholder scan:** No "TBD"/"add validation"/"similar to". Complete code in every code step; exact commands + expected output in every run step. ✓

**3. Type consistency:** `PaymentTarget` field names/types are identical between Step 3's definition and every Step 4/5 usage (`target.controlRole`, `target.numberPrefix`, `target.partnerFlag`, `target.partnerRequiredMessage`, `target.direction`). `settleInTx(tx, target, alloc, partnerId)` / `unwindInTx(tx, target, alloc)` / `loadTarget(client, target, alloc)` / `buildPaymentLines(target, cash, control, amount)` signatures match between Task 1 and the Task 2 call sites. `exceedsOutstanding(Decimal, Decimal, string)` matches its test and its `settleInTx` call. `AllocationInput` is defined once (Task 1) and imported (Task 2). The read row is named `targetRow` to avoid colliding with the `target` descriptor (Step 3). ✓

No issues found.
