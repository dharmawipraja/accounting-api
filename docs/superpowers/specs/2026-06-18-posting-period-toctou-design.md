# Posting Period/Year TOCTOU Guard — Design (Deepening C)

- **Date:** 2026-06-18
- **Status:** Approved (design); pending implementation plan
- **Source:** §3 "Architecture & dead code" → Deepening **C** of `docs/production-readiness-audit-2026-06-17.md` (the last deferred §3 item).
- **Type:** Concurrency-correctness. No behavior change in the single-threaded case (the existing suite must stay green); closes a TOCTOU race under concurrent posting + close.

## 1. Motivation

`PostingService.preparePosting()` validates (OUTSIDE the write transaction) that the target `AccountingPeriod` is OPEN and the fiscal year's `YearEndClosing` is not CLOSED, then a separate `$transaction` performs the write. Between the check and the write, a concurrent close can flip the state — orphaning a POSTED entry into a closed period/year. The code explicitly documents this accepted TOCTOU ("single-company, low-concurrency phase… move the re-check inside the `$transaction` if concurrency grows"). This change moves the authoritative gate inside the transaction.

There are **two independent races**, with two different close mechanisms and thus two locks:

| Race | Close side | Posting check | Lock |
|------|-----------|---------------|------|
| **Period** — `periods.close(id)` sets `AccountingPeriod.status=CLOSED` | `UPDATE accounting_periods` (exclusive row lock) | `findOpenPeriodForDate` (status OPEN) | `SELECT … FROM accounting_periods … FOR SHARE` + re-check |
| **Year** — `yearEndClose.close(fy)` sets `YearEndClosing.status=CLOSED` | `pg_advisory_xact_lock(fy)` (exclusive) + `yearEndClosing` upsert | `yearEndClosing.findFirst({fy, CLOSED})` | `pg_advisory_xact_lock_shared(fy)` + re-check |

The year-close locks on the fiscal-year key (the `year_end_closings` row may not exist before the first close), so a **shared advisory lock** is the correct serializer — not a row lock.

## 2. Goals / Non-goals

**Goals**
- Move the period + closed-year checks inside each write transaction as the authoritative gate, under locks that serialize against the close paths.
- Period race: `FOR SHARE` on the period row + in-tx re-check OPEN.
- Year race: `pg_advisory_xact_lock_shared(fiscalYear)` + in-tx re-check `YearEndClosing.status != CLOSED` (mirrors close's exclusive advisory lock; no posting-vs-posting contention).
- Apply to ALL write paths: `createPostedEntryInTx` (post / doc-posting / payments / the closing-entry self-post), `postDraft`, `reverseInTx`.
- Preserve `allowClosedYear` semantics (reopen reverses the closing entry while the year is CLOSED).
- A deterministic guard test + a concurrent race test; all existing posting/close/reversal e2e stay green.

**Non-goals**
- No change to the close/reopen flow (it keeps its exclusive advisory lock + status logic).
- No new schema (the shared advisory lock needs no row; chosen over a pre-created per-year row).
- No throughput change for postings against each other (shared↔shared is compatible).
- Account role flags (Deepening D) and the rest of §3 are done; this is the final §3 item.

## 3. Design

### 3a. The in-tx guard (new private method on `PostingService`)
```ts
private async assertPostablePeriodInTx(
  tx: LedgerTx,
  periodId: string,
  fiscalYear: number,
  opts: { allowClosedYear?: boolean } = {},
): Promise<void> {
  // Year race FIRST (fixed lock order): shared advisory lock — close holds the exclusive one.
  if (!opts.allowClosedYear) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${fiscalYear})`;
    const yr = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM year_end_closings WHERE fiscal_year = ${fiscalYear}`;
    if (yr.length > 0 && yr[0].status === 'CLOSED') {
      throw new ClosedYearError('Fiscal year is closed; reopen it before posting', { fiscalYear });
    }
  }
  // Period race: FOR SHARE the period row (periods.close's UPDATE is the conflicting exclusive lock); re-check OPEN.
  const p = await tx.$queryRaw<{ status: string }[]>`
    SELECT status FROM accounting_periods WHERE id = ${periodId} FOR SHARE`;
  if (p.length === 0 || p[0].status !== 'OPEN') {
    throw new ValidationFailedError('No open accounting period contains this date', { periodId });
  }
}
```
- Reuses the existing `ClosedYearError` / `ValidationFailedError` and the **exact existing message strings**, so error behavior is unchanged.
- `LedgerTx` is the existing tx-composable client type.
- Fixed acquisition order (advisory-shared → period FOR SHARE) for deadlock safety.

### 3b. Application points
Call `assertPostablePeriodInTx(tx, periodId, fiscalYear, opts)` as the FIRST statement inside:
- `createPostedEntryInTx(tx, …)` — covers `post()`, `DocumentPostingService` (sales/purchase), `payments`, and the year-close's own closing-entry post.
- `postDraft(...)`'s `$transaction` body.
- `reverseInTx(tx, …)` — threading the `allowClosedYear` opt that `prepareReversal` already resolves.

The pre-tx checks in `preparePosting` / `postDraft` / `prepareReversal` **remain** as fast-fail UX (cheap rejection of the common case); the in-tx guard is the authoritative serialized gate (belt-and-suspenders, identical to the `void()` caller-precheck + in-tx-recheck pattern).

### 3c. Close / period-close / reopen interactions
- **Year-close** (`yearEndClose.close`) is UNCHANGED: it keeps `pg_advisory_xact_lock(fiscalYear)` (exclusive). Its closing-entry `createPostedEntryInTx` call passes the guard — the year is still OPEN at that point (status flips after), and acquiring the re-entrant shared advisory lock while already holding the exclusive one in the same tx is granted. No special-casing needed.
- **`periods.close(id)`**: make it `SELECT status FROM accounting_periods WHERE id = ? FOR UPDATE` + re-check before the status update (defensive mirror of the posting's FOR SHARE; the `UPDATE` alone already provides the conflicting lock, but the explicit form documents intent and re-checks under lock).
- **Reopen** reverses the closing entry while the year is CLOSED → calls the reversal path with `allowClosedYear: true`; the guard then skips the year check but STILL enforces the period FOR SHARE check (the period remains OPEN; year-close never closes periods).

### 3d. Lock ordering (deadlock-free)
A posting tx acquires, in fixed order: advisory-shared(year) → period FOR SHARE → `journal_sequences` FOR UPDATE. Year-close acquires advisory-exclusive(year) first and never takes period/sequence locks; period-close takes only the period row lock. No cross-path lock cycle exists.

## 4. Testing

1. **Deterministic guard tests** (no race timing): (a) close a fiscal year, then attempt a posting/reversal into it → `ClosedYearError` from the in-tx guard; (b) close a period, then post into a date it covers → `ValidationFailedError`. These prove the guard rejects under lock regardless of timing.
2. **Concurrent race tests** (mirror the existing SEC-1 concurrent-rotation pattern, `Promise.all`): fire a posting and a `close(fy)` of the same year concurrently; assert exactly one of {posting commits + close serializes after, close commits + posting rejects with `ClosedYearError`}, and assert **no POSTED entry exists in a CLOSED year** afterward. Same shape for a posting vs `periods.close`.
3. **Regression**: the full existing posting/close/reversal/invoicing/payments e2e suite stays green (single-threaded behavior is identical — the in-tx re-check passes whenever the pre-tx check did, absent a concurrent close).

## 5. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Closing-entry self-block (close's own post hits the guard) | Year still OPEN during the post; re-entrant shared advisory lock under the held exclusive is granted — verified against the close flow |
| Reopen reversing a closing entry in a CLOSED year is blocked | `allowClosedYear: true` skips the year check (existing semantics); period check still applies |
| Deadlock between posting/close/period-close | Fixed lock-acquisition order; close/period-close take disjoint lock sets — no cycle |
| Concurrency tests are flaky/non-deterministic | Pair the probabilistic race test with deterministic already-closed guard tests that don't depend on timing |
| Advisory-lock key collision across unrelated features | Key is the fiscal-year integer, already used exclusively by close/reopen for this exact purpose — same key space, intended |

## 6. Out of scope
The close/reopen flow internals; any schema change; multi-tenant concerns. This completes the §3 audit backlog (only §4 ops/DR remains, separate from §3).
