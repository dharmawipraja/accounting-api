# Financial correctness & concurrency cleanup — design

**Date:** 2026-06-17
**Branch:** `fix/financial-correctness-cleanup`
**Source:** §1 of `docs/production-readiness-audit-2026-06-17.md` (the remaining items after P0-1/P0-2 were fixed and merged).

## Goal

Close out the remaining §1 findings. **None are active money bugs** — they are hardening, UX, consistency, and efficiency improvements. All fixes are app-level: **no schema or migration changes.** Each finding is independent and lands as its own test-first commit.

## Scope

Seven items: FIN-M1, FIN-M2, FIN-M3, FIN-M4, FIN-L1, FIN-L2, NEW-1. (FIN-M2/M3/L1 are defense-in-depth on conditions that cannot occur through normal app flow today; they are included to make the invariants explicit and self-enforcing.)

Out of scope: SEC-2 (idempotency-key table growth / no purge) — related to FIN-L2 but a separate §2 item; the `balanced`/`reconciles` tautology note (NEW-2) — not a bug.

## Findings & approach

### FIN-M1 — Cumulative draft payment validation
**File:** `src/invoicing/payments.service.ts` (`createDraft`, ~133–163)
**Current:** the allocation loop reads each target's outstanding fresh from the DB and checks `outstanding - amt`, but does not accumulate amounts across allocations to the *same* document. Two allocations to one invoice each ≤ outstanding both pass draft validation; the inflated sum is stored as `payment.amount`, and the real over-allocation is only caught later at post time with a 409.
**Change:** maintain a running `Map<documentId, Money>` of amounts already allocated within this payment. For each allocation, compute `effectiveOutstanding = outstanding - alreadyAllocated(docId)` and reject (existing `ValidationFailedError` → 422) if `amt > effectiveOutstanding`; then add `amt` to the map.
**Acceptance:** a single payment with two allocations to the same posted invoice that together exceed outstanding is rejected at `createDraft` with 422 (not a late 409 at post).

### FIN-M2 — Re-verify partner ownership at post time
**File:** `src/invoicing/payments.service.ts` (`post`, ~336–388)
**Current:** the per-allocation `SELECT … FOR UPDATE` re-checks `status` and `outstanding` under lock but not `partner_id`. `createDraft` validated it, and posted documents are immutable, so this cannot be violated through normal flow — a defense-in-depth gap and an inconsistency with the other re-checks.
**Change:** add `partner_id` to the locked `SELECT`; throw `ValidationFailedError` if it ≠ `payment.partnerId`.
**Acceptance:** if a target document's `partner_id` no longer matches the payment's partner at post time, post is rejected.

### FIN-M3 — Floor on void decrement
**File:** `src/invoicing/payments.service.ts` (`void`, ~455–466)
**Current:** `void` decrements each target's `amountPaid` unconditionally. Invoice/bill voids guard (`amount_paid !== 0`); payment void does not. Safe today (one-void-per-payment), but the asymmetry invites a future regression.
**Change:** lock each target document `FOR UPDATE`, read `amount_paid`; if `amount_paid < allocation.amount` throw `ConflictDomainError` (would underflow), else decrement. Mirrors `post()`'s locking pattern.
**Acceptance:** voiding cannot drive `amount_paid` negative; an underflow attempt is rejected with a conflict error.

### FIN-M4 — Principled tax-rate validation
**File:** `src/tax/tax-codes.service.ts` (`validateRate`, ~41–49)
**Current:** `Number(rate)` float parse, checks `> 0 && < 1`. No money impact (real tax math uses `Money`/`Decimal`), but it is float-based and silently accepts rates with more precision than the `Decimal(9,6)` column.
**Change:** validate via `Decimal`; reject rate ∉ (0,1) and reject `decimalPlaces() > 6`, with `ValidationFailedError` (422).
**Acceptance:** rates `0`, `1`, `-0.1`, `1.5`, and `0.1234567` (7dp) are rejected; `0.11` is accepted.

### FIN-L1 — Explicit soft-delete filter in balances
**File:** `src/ledger/balances/balances.service.ts` (`groupedBalances` ~68–82, `accountBalance` ~163–169)
**Current:** the raw SQL filters `je.posted_at IS NOT NULL AND a.deleted_at IS NULL` but not `je.deleted_at IS NULL`. Safe today (only DRAFTs are soft-deletable and they have `posted_at = NULL`, so they are already excluded), but inconsistent with `aging.service.ts`, which does filter.
**Change:** add `AND je.deleted_at IS NULL` to both queries.
**Acceptance:** a soft-deleted POSTED journal entry (which cannot occur via the app, only manufactured in a test) is excluded from `balancesAsOf`/`accountBalance`.

### FIN-L2 — Lazy expiry of stale in-flight idempotency keys
**Files:** `src/common/idempotency/idempotency.service.ts`, `src/config/env.validation.ts`
**Current:** `complete()` runs as a separate `UPDATE` after the handler's transaction commits. A crash between the commit and `complete()` leaves the key `response=null` ("in-flight") forever; retries get `409 in progress` indefinitely even though the underlying write succeeded.
**Change:** in `resolveExisting`, when the existing row is in-flight (`response === null` / `httpStatus === null`), check its `createdAt` age. If older than `IDEMPOTENCY_INFLIGHT_TTL_MS`, atomically `deleteMany({ where: { key, response: null, completedAt: null, createdAt: { lt: threshold } } })`; if it removed the row, re-run `reserve()` once (single recursion guard) so the retry re-attempts cleanly. Otherwise behavior is unchanged (replay completed, 409 genuinely-in-flight, 422 mismatch). Add optional `IDEMPOTENCY_INFLIGHT_TTL_MS` to `env.validation.ts`, default **120000** — chosen well above the maximum handler duration (payment tx timeout 20s, server `requestTimeout` 30s) so a genuinely-running slow request is never wrongly expired.
**Acceptance:** a request whose key has a stale in-flight row (old `createdAt`) proceeds normally; a fresh in-flight row still returns 409.

### NEW-1 — Single tax computation per document post
**Files:** `src/invoicing/document-posting.service.ts`, `src/invoicing/sales-invoices.service.ts`, `src/invoicing/purchase-bills.service.ts`
**Current:** `DocumentPostingService.post` computes `tax.calculate` once to build the journal lines (`:78`); the `finalize` callback then calls `computeTotals` — a *second* `tax.calculate` (`:50`) — to store the document totals (`sales-invoices.service.ts:317`, `purchase-bills.service.ts:321`). Every invoice/bill post runs the tax engine twice from two separate reads; a tax-rate edit between the two reads could make the posted journal and the stored totals disagree.
**Change:** extract a pure `summarize(calc): { subtotal, taxTotal, withholdingTotal, total }` (the split currently inside `computeTotals`). `computeTotals` becomes `summarize(await this.tax.calculate(...))` (unchanged behaviour — still used by the draft-preview paths). In `post()`, compute `const totals = this.summarize(calc)` from the `calc` it already holds and add `totals` to `PostedDocContext`. The `finalize` callbacks read `ctx.totals` instead of calling `computeTotals` again.
**Acceptance:** posting an invoice/bill produces the same stored totals and journal as today (existing e2e stay green), with `tax.calculate` invoked once.

## Testing strategy (TDD — RED first for every item)

- **Behavioral** — FIN-M1 (e2e: double-allocate one invoice → 422 at draft), FIN-M4 (unit on `validateRate` bounds + precision), FIN-L2 (e2e: stale in-flight row proceeds, fresh one 409): write the failing test first, watch it fail for the right reason, then minimal code.
- **Defensive** — FIN-M2, FIN-M3, FIN-L1: "manufactured-state" tests. Use raw SQL to create the otherwise-impossible condition (reassign a posted doc's `partner_id`; lower a doc's `amount_paid` below an allocation; insert a soft-deleted POSTED journal entry), then assert the new guard fires / the row is excluded. Each fails RED against current code (no guard) and passes after.
- **NEW-1** — pure refactor: rely on the existing invoice/bill posting e2e (which already assert stored totals == journal). No call-count assertions (testing implementation detail is an anti-pattern); the refactor must keep those tests green.

## Delivery

- One small commit per finding (clean history, easy revert), each with its test.
- After each commit: `tsc --noEmit`, eslint `--max-warnings 0`, and the relevant e2e; full unit + e2e suite before merge.
- Branch `fix/financial-correctness-cleanup` → fast-forward merge to `main` (no remote configured).
- Update `docs/production-readiness-audit-2026-06-17.md` to mark each item fixed.

## Risks

- FIN-L2 recursion: bounded to a single re-`reserve()` to avoid loops; the atomic `deleteMany` predicate ensures only one of several concurrent retries removes the stale row.
- FIN-M3/FIN-M2 add locking/selects to the void/post paths — kept minimal and consistent with the existing `FOR UPDATE` pattern; covered by the full e2e run.
- NEW-1 touches the shared `DocumentPostingService` interface (`PostedDocContext` gains `totals`); both invoice and bill finalize callbacks update together.
