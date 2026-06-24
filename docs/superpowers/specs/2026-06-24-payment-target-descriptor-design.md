# Collapse the payment receipt/disbursement mirror

**Date:** 2026-06-24
**Status:** Approved (design) — ready for implementation plan
**Origin:** Architecture review round-2 candidate #1 ("Collapse the payment receipt/disbursement mirror").
A direct replay of round-1 #1 (the sales/purchase `DocumentDescriptor` collapse).

## Vocabulary

Architecture terms per the `improve-codebase-architecture` skill: **module, interface, implementation,
depth, deep/shallow, seam, adapter, leverage, locality.** Domain terms per `CONTEXT.md` +
`docs/runbooks/domain-glossary.md`. New concept introduced here: **payment target** — the document a
payment allocation settles (a sales invoice for a `RECEIPT`, a purchase bill for a `DISBURSEMENT`).
Recorded in `CONTEXT.md` as part of this work.

---

## 1. Problem

`PaymentsService` (516 lines, the largest module) is built around an `isReceipt`/`direction` split that
duplicates a fixed enumeration set at four sites — the same shallow mirror shape round-1 collapsed for
sales/purchase documents. Everything that varies is 1:1 with the direction:

| Varies by direction | RECEIPT | DISBURSEMENT |
| --- | --- | --- |
| target table / delegate / alloc id | `sales_invoices` · `salesInvoice` · `salesInvoiceId` | `purchase_bills` · `purchaseBill` · `purchaseBillId` |
| partner flag | `isCustomer` | `isVendor` |
| control account role | `AR_CONTROL` | `AP_CONTROL` |
| document-number prefix | `PAY-RCV` | `PAY-DSB` |
| cash side | Dr cash / Cr control | Dr control / Cr cash |
| message noun | "sales invoice" | "purchase bill" |

The duplicated sites:
- `loadTarget` (50-94) — two arms (validate which id is present, read the target doc).
- `post` in-tx allocation loop (316-386) — two ~35-line arms (`FOR UPDATE` + POSTED check + partner
  check + over-allocation guard + increment `amountPaid`).
- `void` `applyInTx` unwind loop (451-488) — two blocks (`FOR UPDATE` + negative-floor check +
  decrement).
- `post`'s control-account / journal-line / prefix picks (277-302, 388-397).

The **over-allocation guard** (`outstanding − amount ≥ 0`, recomputed under `FOR UPDATE`) — financially
load-bearing — is re-derived in four places, and reachable only through full e2e. The interface a reader
must hold is "there are two of everything and they must stay in lockstep" — the duplication *is* the
interface.

## 2. Goal

Collapse the mirror behind one **`PaymentTarget`** descriptor keyed by direction, with the duplicated
behavior pulled into shared free-function helpers that own the over-allocation invariant once.

**Locality:** the settle/unwind/over-allocation logic lives in one place; fix once.
**Leverage:** a future settlement target (e.g. a third document type) is one descriptor entry.
**Testability:** the over-allocation guard becomes a pure, unit-testable function.

## 3. Scope

**In scope**
- New `src/invoicing/payment-targets.ts`: `PaymentTarget` interface, `PAYMENT_TARGETS` map (RECEIPT /
  DISBURSEMENT), and free functions `loadTarget` / `settleInTx` / `unwindInTx` / `buildPaymentLines`,
  plus the pure `exceedsOutstanding`. `AllocationInput` moves here.
- `PaymentsService` collapses its four mirror sites onto the descriptor + helpers.
- Unit tests for the pure guard and the journal-line builder.
- `CONTEXT.md` term "payment target".

**Out of scope (explicitly)**
- `post()`'s overall structure — the draft-lock re-check, `preparePosting`/`createPostedEntryInTx`, the
  `$transaction` tuning (`maxWait`/`timeout`), and `payment.update` stay as-is. (It already uses the
  posting seam correctly; a payment journal is a non-taxed 2-line cash/control entry that cannot use
  `DocumentPostingService.post`.)
- `void`'s `reverseWithGuard` wrapper, `createDraft`'s cumulative in-memory draft check, `present`,
  `listPage`, `deleteDraft`.
- `AgingService`'s AR/AP mirror (a read-only report — a separate concern).
- Controllers, DTOs, the Prisma schema. No HTTP/contract change.

## 4. The `PaymentTarget` descriptor + helpers

`src/invoicing/payment-targets.ts` (free functions, mirroring `signing.ts` / `trigram-search`):

```ts
import { AccountRole, PaymentDirection, Prisma } from '@prisma/client';

export interface AllocationInput {
  salesInvoiceId?: string;
  purchaseBillId?: string;
  amount: string;
}

/** Normalized read of a payment's target document. */
export interface TargetRow {
  id: string;
  partnerId: string;
  status: string;
  total: Prisma.Decimal;
  amountPaid: Prisma.Decimal;
}

/** The document a payment allocation settles, per direction. */
export interface PaymentTarget {
  direction: PaymentDirection;
  partnerFlag: 'isCustomer' | 'isVendor';
  controlRole: AccountRole;                       // AR_CONTROL | AP_CONTROL
  numberPrefix: 'PAY-RCV' | 'PAY-DSB';
  table: 'sales_invoices' | 'purchase_bills';     // constant union → Prisma.raw injection-safe
  noun: string;                                   // 'sales invoice' | 'purchase bill'
  cashIsDebit: boolean;                           // RECEIPT true; DISBURSEMENT false
  allocId(a: AllocationInput): string | undefined;  // the id for this direction
  otherId(a: AllocationInput): string | undefined;  // the id that must be ABSENT
  find(client, id: string): Promise<TargetRow | null>;  // typed delegate, e.g. client.salesInvoice.findFirst
  applyPaid(tx: LedgerTx, id: string, amount: Prisma.Decimal, sign: 1 | -1): Promise<void>;
}

export const PAYMENT_TARGETS: Record<PaymentDirection, PaymentTarget> = { RECEIPT: {…}, DISBURSEMENT: {…} };
```

The descriptor's `find`/`applyPaid` are typed closures over the Prisma delegate (`salesInvoice` /
`purchaseBill`); the raw `FOR UPDATE` reads use `Prisma.raw(target.table)` (a constant union literal —
injection-safe, exactly the round-1 `spec.table` pattern). `applyPaid` keeps the existing
`{ amountPaid: { increment | decrement } }` delegate write (behavior-preserving).

**Shared helpers (the duplicated logic, once):**

```ts
/** Pure over-allocation check (no I/O) — the financially load-bearing invariant, unit-testable. */
export function exceedsOutstanding(total: Prisma.Decimal, amountPaid: Prisma.Decimal, amount: string): boolean;
//  ≡ Money.of(total).subtract(Money.of(amountPaid)).subtract(Money.of(amount)).isNegative()

/** Validate the allocation references the right doc type, then read it (create-draft path). */
export async function loadTarget(client, target: PaymentTarget, alloc: AllocationInput): Promise<TargetRow>;

/** Lock the target FOR UPDATE, re-verify POSTED + partner + outstanding, increment amountPaid (post path).
 *  Re-reads per call so two allocations to one document see each other's increment under the lock. */
export async function settleInTx(tx: LedgerTx, target: PaymentTarget, alloc, partnerId: string): Promise<void>;

/** Lock the target FOR UPDATE, floor-check, decrement amountPaid (void path). */
export async function unwindInTx(tx: LedgerTx, target: PaymentTarget, alloc): Promise<void>;

/** The 2-line cash/control journal for a payment, per cashIsDebit. */
export function buildPaymentLines(target: PaymentTarget, cashAccountId: string, controlId: string, amount: string): JournalLine[];
```

Error messages are reproduced via `target.noun` (e.g. `Allocated ${noun} is not posted`,
`Allocated ${noun} belongs to another partner`); the over-allocation throw stays
`ConflictDomainError('Allocation now exceeds outstanding', …)` and the floor throw
`ConflictDomainError('Void would drive amountPaid negative', …)`, byte-for-byte as today.

## 5. Caller collapse (`PaymentsService`)

Each site selects `const target = PAYMENT_TARGETS[direction]` and delegates:
- **`loadTarget` private method** → deleted; use the shared `loadTarget(this.prisma.client, target, alloc)`.
- **`createDraft`** → partner check becomes `if (!partner[target.partnerFlag]) throw …`; the validation
  loop already routes through `loadTarget`. Its cumulative `allocatedByDoc` in-memory check is unchanged
  (pre-tx, direction-agnostic; reuses the same `exceedsOutstanding`-style comparison, net of
  already-allocated).
- **`post`** → `controlId = findControlAccountId(prisma, target.controlRole)`; `lines =
  buildPaymentLines(target, …)`; the two-arm in-tx loop becomes
  `for (const a of allocations) await settleInTx(tx, target, a, payment.partnerId)`; prefix uses
  `target.numberPrefix`. The draft-lock, `preparePosting`/`createPostedEntryInTx`, tx tuning, and
  `payment.update` are untouched.
- **`void`** → the two-block unwind becomes
  `for (const a of allocations) await unwindInTx(tx, PAYMENT_TARGETS[payment.direction], a)`. The
  `reverseWithGuard` wrapper, lock, and `payment.update` are untouched.

After this, `payments.service.ts` no longer branches on `isReceipt` for the duplicated logic;
`direction` selects a descriptor at each entry point.

## 6. Data flow

Unchanged. The same target documents are read, locked `FOR UPDATE`, and re-verified; the same
over-allocation guard runs with the same inputs; the same `amountPaid` increment/decrement is applied via
the same delegates; the same 2-line journal posts via the unchanged posting seam. Only the *shape* by
which the direction's enumerations reach the logic changes (a descriptor instead of inline `if isReceipt`).

## 7. Error handling

No new error types. Per-direction messages are reproduced via `target.noun`; the over-allocation and
negative-floor `ConflictDomainError`s and the not-posted/partner-mismatch `ValidationFailedError`s are
preserved verbatim. The create-draft validation messages
(`A ${direction} allocation must reference a ${noun}`) match today's strings.

## 8. Testing

- **New `payment-targets.spec.ts`** — pure-logic unit tests:
  - `exceedsOutstanding`: under, exact-boundary (equal → not exceeding), over, zero-amount edge.
  - `buildPaymentLines`: RECEIPT → `[Dr cash, Cr control]`; DISBURSEMENT → `[Dr control, Cr cash]`,
    with 4dp amounts.
- **Existing `payments.e2e-spec.ts`** is the integration net (behavior identical): receipt + disbursement
  post and void, over-allocation rejection, partner-mismatch, the concurrent post-vs-post race, and the
  negative-floor void guard. All must stay green.
- The pure guard becomes testable without standing up the full service — the review's headline win.

## 9. Verification & migration

- Branch `feat/payment-target-descriptor` off `main`. Two commits: (1) `payment-targets.ts` +
  `payment-targets.spec.ts`; (2) collapse the four `PaymentsService` sites + `CONTEXT.md` term.
- Gate: `npm run verify` — typecheck (exit 0), `lint:ci` (clean), `test` (unit incl. the new spec),
  `test:e2e:cov` (all e2e pass **and** global coverage ≥ 84/62/84/84).
- Sanity diff vs `main`: `payment-targets.ts` + `payment-targets.spec.ts` (new), `payments.service.ts`
  (net reduction), `CONTEXT.md`, plus this spec. No controllers/DTOs/schema; no `aging`/posting changes.

## 10. Risks

- **Most intricate money path.** Payments carries the AR/AP subledger allocation locks and prior
  FIN-M1..M4 hardening. Mitigation: strictly behavior-preserving — the raw SQL, the per-allocation
  re-read under `FOR UPDATE`, the increment/decrement delegates, the messages, and the guard are
  identical, only parameterized by the descriptor. The large `payments.e2e-spec.ts` is the net, and
  the descriptor pattern is proven (round-1 #1).
- **Per-allocation re-read semantics.** `settleInTx` must re-read the target inside each loop iteration
  (not cache), so two allocations to one document correctly see the prior increment under the lock —
  preserved by design (one call per allocation).
- **Injection safety.** `Prisma.raw(target.table)` uses a constant union literal, never user input —
  the same guarantee as round-1's `spec.table`.
- **Smallest-possible diff:** one descriptor + four helper functions + four call-site collapses; no logic
  inside the settle/unwind bodies changes.
