# Posting Period/Year TOCTOU Guard Implementation Plan (Deepening C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the posting-vs-close TOCTOU by re-checking period/year status under locks inside each write transaction, so a concurrent period/year close can't orphan a POSTED entry.

**Architecture:** A private `assertPostablePeriodInTx(tx, periodId, fiscalYear, {allowClosedYear?})` on `PostingService` takes `pg_advisory_xact_lock_shared(fiscalYear)` + re-checks `year_end_closings` status (mirrors close's exclusive advisory lock) and `SELECT … FOR SHARE` on the period row + re-checks OPEN. It's called first inside `createPostedEntryInTx`, `postDraft`'s tx, and `reverseInTx`. Pre-tx checks stay as fast-fail. `periods.close` gains `FOR UPDATE` + re-check.

**Tech Stack:** NestJS 11, Prisma 7 (adapter pattern), TypeScript 5.9, Jest + Testcontainers `postgres:16`. Postgres advisory locks (`pg_advisory_xact_lock` / `_shared`) and row locks (`FOR SHARE`/`FOR UPDATE`).

## Global Constraints

- **No single-threaded behavior change.** The in-tx re-check passes whenever the pre-tx check did, absent a concurrent close. The full existing suite (posting/close/reversal/invoicing/payments) MUST stay green.
- **Full gate per task:** `npm run db:generate && npm run typecheck` (0), `npm run lint:ci` (0), and the relevant `npm run test:e2e -- <name>`. Docker up (Testcontainers `postgres:16`).
- **Reuse existing errors + exact messages:** `ClosedYearError('Fiscal year is closed; reopen it before posting', { fiscalYear })` and `ValidationFailedError('No open accounting period contains this date', { periodId })` (both from `../../common/errors/domain-errors`).
- **No schema change.** The shared advisory lock needs no row (chosen over a per-year row).
- **`allowClosedYear` semantics:** only `YearEndCloseService.reopen` reverses a closing entry while the year is CLOSED — it must keep working. `reverseInTx` gains an `allowClosedYear` opt that `reopen` sets.
- **`LedgerTx`** (`src/ledger/posting/posting.service.ts`) exposes `$queryRaw`/`$executeRaw` (only `$connect/$disconnect/$on/$transaction/$extends/$use` are omitted) — the guard's raw SQL is type-safe on it.
- **Fixed lock-acquisition order** in the guard: advisory-shared(year) → period `FOR SHARE`. Posting then takes `journal_sequences FOR UPDATE` (existing). Close takes advisory-exclusive(year); period-close takes the period row lock — disjoint, no cycle.
- Tables: periods = `accounting_periods` (model `accountingPeriod`); year close = `year_end_closings` (model `yearEndClosing`).

---

## Task 1: The in-tx guard + apply to `createPostedEntryInTx` and `postDraft`

**Files:**
- Modify: `src/ledger/posting/posting.service.ts` (add `assertPostablePeriodInTx`; call it in `createPostedEntryInTx` and inside `postDraft`'s tx)
- Test: `test/posting-toctou.e2e-spec.ts` (new)

**Interfaces:**
- Produces: `private assertPostablePeriodInTx(tx: LedgerTx, periodId: string, fiscalYear: number, opts?: { allowClosedYear?: boolean }): Promise<void>` — throws `ClosedYearError` (year CLOSED, unless `allowClosedYear`) or `ValidationFailedError` (period not OPEN).

- [ ] **Step 1: Add the guard method**

In `posting.service.ts`, add this private method (e.g. just after `createPostedEntryInTx`):
```ts
  /** Authoritative in-transaction TOCTOU guard. Serializes against a concurrent
   *  period/year close: shared advisory lock on the fiscal year (close holds the
   *  exclusive one) + re-check year_end_closings; FOR SHARE on the period row
   *  (periods.close takes the conflicting exclusive lock) + re-check OPEN. Must be
   *  the FIRST statement in every posted-entry write path. */
  private async assertPostablePeriodInTx(
    tx: LedgerTx,
    periodId: string,
    fiscalYear: number,
    opts: { allowClosedYear?: boolean } = {},
  ): Promise<void> {
    if (!opts.allowClosedYear) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${fiscalYear})`;
      const yr = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM year_end_closings WHERE fiscal_year = ${fiscalYear}`;
      if (yr.length > 0 && yr[0].status === 'CLOSED') {
        throw new ClosedYearError(
          'Fiscal year is closed; reopen it before posting',
          { fiscalYear },
        );
      }
    }
    const p = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM accounting_periods WHERE id = ${periodId} FOR SHARE`;
    if (p.length === 0 || p[0].status !== 'OPEN') {
      throw new ValidationFailedError(
        'No open accounting period contains this date',
        { periodId },
      );
    }
  }
```

- [ ] **Step 2: Call it at the top of `createPostedEntryInTx`**

In `createPostedEntryInTx`, before `const entryNumber = await this.nextNumber(tx, fiscalYear);`:
```ts
    await this.assertPostablePeriodInTx(tx, periodId, fiscalYear);
    const entryNumber = await this.nextNumber(tx, fiscalYear);
```
(This covers `post()`, `DocumentPostingService`, `payments`, and the year-close's own closing-entry post — at close time the year is still OPEN, so the guard passes; the re-entrant shared advisory lock under close's held exclusive lock is granted.)

- [ ] **Step 3: Call it inside `postDraft`'s transaction**

In `postDraft`'s `$transaction(async (tx) => { … })` body, after the existing draft `FOR UPDATE` + status re-check block and before `const entryNumber = await this.nextNumber(tx, fiscalYear);`:
```ts
      await this.assertPostablePeriodInTx(tx, period.id, fiscalYear);
      const entryNumber = await this.nextNumber(tx, fiscalYear);
```

- [ ] **Step 4: Write the deterministic guard tests (new spec)**

Create `test/posting-toctou.e2e-spec.ts`. Bootstrap mirrors `test/posting.e2e-spec.ts:24-42` (startTestDb → makePrismaOverride → overrideProvider(PrismaService) → `app.enableVersioning({type:VersioningType.URI, defaultVersion:'1'})` → `app.init()` → `CompanyService.seedIfEmpty()` + `update({segregationOfDutiesEnabled:false})` → `AccountsService.seedIfEmpty()` → `PeriodsService.generatePeriods(2026)` AND `generatePeriods(2027)` → `posting = app.get(PostingService)` → build `kasId`(`1-1000`)/`modalId`(`3-1000`) from `(await app.get(AccountsService).list()).data`). Import `ClosedYearError`, `ValidationFailedError` from `../src/common/errors/domain-errors`, `PeriodsService`, `YearEndCloseService`.

Helper + tests:
```ts
  const balanced = (date: Date) => ({
    date, description: 'toctou', sourceType: 'MANUAL' as const,
    lines: [
      { accountId: kasId, debit: '100.0000' },
      { accountId: modalId, credit: '100.0000' },
    ],
    createdBy: 'creator',
  });

  it('in-tx guard rejects a post into a CLOSED period (ValidationFailedError)', async () => {
    const periods = await app.get(PeriodsService).list(2026);
    const may = periods.find((p) => p.name === '2026-05')!;
    await app.get(PeriodsService).close(may.id, 'admin');
    await expect(
      prisma.client.$transaction((tx) =>
        posting.createPostedEntryInTx(tx, balanced(new Date('2026-05-15')), 'p', may.id, 2026),
      ),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('in-tx guard rejects a post into a CLOSED year (ClosedYearError)', async () => {
    // Close an empty 2027 (no activity → status CLOSED, no closing entry).
    await app.get(YearEndCloseService).close(2027, 'admin');
    const p2027 = (await app.get(PeriodsService).list(2027)).find((p) => p.name === '2027-01')!;
    await expect(
      prisma.client.$transaction((tx) =>
        posting.createPostedEntryInTx(tx, balanced(new Date('2027-01-15')), 'p', p2027.id, 2027),
      ),
    ).rejects.toBeInstanceOf(ClosedYearError);
  });
```
> Note: these call `createPostedEntryInTx` DIRECTLY (bypassing the pre-tx check in `preparePosting`/`post`) so they exercise the in-tx guard specifically. The guard runs the year check first (2026 is OPEN in the period test, so it falls through to the period check).

- [ ] **Step 5: Verify + commit**

Run: `npm run db:generate && npm run typecheck` → 0. `npm run lint:ci` → 0.
Run: `npm run test:e2e -- "posting-toctou|posting|close|reporting"` → green (the 2 new guard tests pass; existing posting/close behavior unchanged — pre-tx checks still fast-fail the common case).
```bash
git add src/ledger/posting/posting.service.ts test/posting-toctou.e2e-spec.ts
git commit -m "feat(posting): in-tx period/year TOCTOU guard on post + postDraft"
```

---

## Task 2: Apply the guard to `reverseInTx` + thread `allowClosedYear`

**Files:**
- Modify: `src/ledger/posting/posting.service.ts` (`reverseInTx` signature + guard call)
- Modify: `src/close/year-end-close.service.ts` (`reopen` passes `allowClosedYear` to `reverseInTx`)
- Test: `test/posting-toctou.e2e-spec.ts` (append)

**Interfaces:**
- Consumes: `assertPostablePeriodInTx` (Task 1).
- Produces: `reverseInTx(tx, original, reversedBy, periodId, fiscalYear, reversalDate, opts?: { allowClosedYear?: boolean })`.

- [ ] **Step 1: Add `opts` to `reverseInTx` + call the guard**

Change `reverseInTx`'s signature to add a trailing `opts: { allowClosedYear?: boolean } = {}` parameter, and make the FIRST statement of its body:
```ts
    await this.assertPostablePeriodInTx(tx, periodId, fiscalYear, opts);
    const entryNumber = await this.nextNumber(tx, fiscalYear);
```
`reverse()` calls `reverseInTx(tx, original, reversedBy, periodId, fiscalYear, reversalDate)` with no opts (year-locked) — leave that call as-is.

- [ ] **Step 2: `reopen` must pass `allowClosedYear: true`**

In `src/close/year-end-close.service.ts` `reopen`, the existing `this.posting.reverseInTx(tx, original, reopenedBy, periodId, fy, reversalDate)` call becomes:
```ts
        await this.posting.reverseInTx(
          tx, original, reopenedBy, periodId, fy, reversalDate,
          { allowClosedYear: true },
        );
```
(reopen legitimately reverses the closing entry while the year is CLOSED. `prepareReversal` already cleared its own pre-tx check with `allowClosedYear: true`; the in-tx guard must skip the year re-check too — but the PERIOD check still applies and passes, since the closing entry's period is OPEN.)

- [ ] **Step 3: Deterministic reverse-into-closed-year test (real entry, no fakes)**

Append to `test/posting-toctou.e2e-spec.ts` (use a DISTINCT fiscal year — 2028 — added via `generatePeriods(2028)` in beforeAll — to avoid coupling with other tests in this spec):
```ts
  it('in-tx guard rejects reverseInTx into a CLOSED year (allowClosedYear=false)', async () => {
    // Post a real balance-sheet entry in 2028, then close 2028 (no P&L → CLOSED, no closing entry).
    const entry = await posting.post(balanced(new Date('2028-03-15')), 'p');
    await app.get(YearEndCloseService).close(2028, 'admin');
    // prepareReversal with allowClosedYear bypasses ONLY the pre-tx check and returns the real original.
    const prepared = await posting.prepareReversal(entry.id, undefined, { allowClosedYear: true });
    // Calling reverseInTx WITHOUT allowClosedYear must be rejected by the in-tx guard.
    await expect(
      prisma.client.$transaction((tx) =>
        posting.reverseInTx(tx, prepared.original, 'p', prepared.periodId, prepared.fiscalYear, prepared.reversalDate),
      ),
    ).rejects.toBeInstanceOf(ClosedYearError);
  });
```
> This uses real domain objects (no casts). It also implicitly confirms the `allowClosedYear: true` path through `prepareReversal` still resolves the original even when the year is CLOSED — the same path `reopen` relies on. The end-to-end reopen behavior is verified by the existing `close` e2e in Step 4.

- [ ] **Step 4: Verify + commit**

Run: `npm run db:generate && npm run typecheck` → 0. `npm run lint:ci` → 0.
Run: `npm run test:e2e -- "posting-toctou|close|posting"` → green. **The `close` e2e's reopen test MUST still pass** (it reverses the closing entry while the year is CLOSED, now through the `allowClosedYear: true` guard path) — this is the critical regression check for Step 2.
```bash
git add src/ledger/posting/posting.service.ts src/close/year-end-close.service.ts test/posting-toctou.e2e-spec.ts
git commit -m "feat(posting): in-tx guard on reverseInTx; thread allowClosedYear for reopen"
```

---

## Task 3: Harden `periods.close` with `FOR UPDATE` + re-check

**Files:**
- Modify: `src/ledger/periods/periods.service.ts` (`close`)
- Test: `test/periods.e2e-spec.ts` (existing already-closed test must stay green; add a guard note)

**Interfaces:**
- Produces: `periods.close` takes the conflicting exclusive period-row lock (serializes against the posting guard's `FOR SHARE`).

- [ ] **Step 1: Rewrite `close` to lock-and-recheck in a transaction**

Replace the body of `close(id, closedBy)` in `periods.service.ts`:
```ts
  async close(id: string, closedBy: string): Promise<AccountingPeriod> {
    return this.prisma.client.$transaction(async (tx) => {
      // FOR UPDATE the period row so a concurrent posting (which takes FOR SHARE
      // + re-checks OPEN) serializes; re-check status under the lock.
      const rows = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM accounting_periods WHERE id = ${id} FOR UPDATE`;
      if (rows.length === 0)
        throw new NotFoundDomainError('Period not found', { id });
      if (rows[0].status === 'CLOSED')
        throw new ConflictDomainError('Period already closed', { id });
      return tx.accountingPeriod.update({
        where: { id },
        data: { status: 'CLOSED', closedAt: new Date(), closedBy },
      });
    });
  }
```
(`NotFoundDomainError` / `ConflictDomainError` are already imported in this file; messages unchanged.)

- [ ] **Step 2: Verify + commit**

Run: `npm run db:generate && npm run typecheck` → 0. `npm run lint:ci` → 0.
Run: `npm run test:e2e -- "periods|posting"` → green (the existing period close/reopen + not-found + already-closed tests pass unchanged — behavior is identical single-threaded; only the locking is added).
```bash
git add src/ledger/periods/periods.service.ts
git commit -m "feat(periods): lock-and-recheck period close (FOR UPDATE) for posting serialization"
```

---

## Task 4: Concurrent race tests (posting vs close)

**Files:**
- Test: `test/posting-toctou.e2e-spec.ts` (append)

These are integration sanity tests demonstrating serialization without timing-flakiness (the strong per-mechanism proof is Task 1's deterministic guard tests). Mirror the service-level `Promise.all(...).catch(() => null)` style of `test/posting.e2e-spec.ts:98-118`.

- [ ] **Step 1: Posting vs year-close race**

Append (use a fresh year, e.g. 2029, generated in beforeAll, to isolate from earlier tests):
```ts
  it('posting vs year-close serialize: post either commits-before or is rejected; never orphans', async () => {
    const p2029 = (await app.get(PeriodsService).list(2029)).find((p) => p.name === '2029-06')!;
    const close = app.get(YearEndCloseService);
    const [postRes, closeRes] = await Promise.all([
      posting.post(balanced(new Date('2029-06-15')), 'p').then((e) => ({ ok: true as const, e })).catch((err) => ({ ok: false as const, err })),
      close.close(2029, 'admin').then(() => ({ ok: true as const })).catch((err) => ({ ok: false as const, err })),
    ]);
    // Close always wins or runs after; year ends CLOSED.
    expect((await close.getStatus(2029))?.status).toBe('CLOSED');
    // The post either committed (before close) or was rejected with ClosedYearError — never a 500/other error.
    if (!postRes.ok) expect(postRes.err).toBeInstanceOf(ClosedYearError);
    // No NON-closing POSTED entry exists in 2029 that the racing post slipped in AFTER close:
    // if the post was rejected, there are zero manual entries; if it committed first, exactly one.
    const manual = await prisma.client.journalEntry.count({
      where: { fiscalYear: 2029, status: 'POSTED', sourceType: 'MANUAL' },
    });
    expect(manual).toBe(postRes.ok ? 1 : 0);
    // And a fresh post into the now-closed year is firmly rejected.
    await expect(posting.post(balanced(new Date('2029-06-16')), 'p')).rejects.toBeInstanceOf(ClosedYearError);
  });
```

- [ ] **Step 2: Posting vs period-close race**

Append (fresh period, e.g. 2026-09, not used elsewhere):
```ts
  it('posting vs period-close serialize: post commits-before or is rejected', async () => {
    const sep = (await app.get(PeriodsService).list(2026)).find((p) => p.name === '2026-09')!;
    const [postRes] = await Promise.all([
      posting.post(balanced(new Date('2026-09-15')), 'p').then((e) => ({ ok: true as const })).catch((err) => ({ ok: false as const, err })),
      app.get(PeriodsService).close(sep.id, 'admin').catch(() => null),
    ]);
    expect((await app.get(PeriodsService).list(2026)).find((p) => p.name === '2026-09')!.status).toBe('CLOSED');
    if (!postRes.ok) expect((postRes as { err: unknown }).err).toBeInstanceOf(ValidationFailedError);
    // A fresh post into the now-closed period is rejected (by the pre-tx check).
    await expect(posting.post(balanced(new Date('2026-09-16')), 'p')).rejects.toBeInstanceOf(ClosedPeriodError);
  });
```
> Import `ClosedPeriodError` from `../src/common/errors/domain-errors` too. (The pre-tx `findOpenPeriodForDate` returns null for a closed period → `ClosedPeriodError`; the in-tx guard's period rejection is `ValidationFailedError` — both are correct, they're different code paths.) Add `generatePeriods(2029)` to the beforeAll.

- [ ] **Step 3: Verify + commit**

Run: `npm run db:generate && npm run typecheck` → 0. `npm run lint:ci` → 0.
Run: `npm run test:e2e -- posting-toctou` → green (all guard + race tests).
```bash
git add test/posting-toctou.e2e-spec.ts
git commit -m "test(posting): concurrent posting-vs-close serialization tests"
```

---

## Task 5: Final verification

- [ ] **Step 1: Full gate**

Run: `npm run db:generate && npm run verify` → typecheck 0, lint:ci 0, unit all green, e2e all suites green (incl. the new `posting-toctou` suite), coverage thresholds met.

- [ ] **Step 2: Confirm no single-threaded behavior drift**

Run: `npm run test:e2e -- "posting|close|reporting|periods|journal|sales-invoices|purchase-bills|payments"` → all green (the guard is a no-op when nothing closes concurrently; all existing assertions hold).

- [ ] **Step 3: Commit any residue (expected: nothing)**

If `git status` is clean, done.

---

## Self-Review notes

- **Spec coverage:** guard helper (Task 1); applied to all three write paths — `createPostedEntryInTx` (Task 1), `postDraft` (Task 1), `reverseInTx` (Task 2); `allowClosedYear` threaded so reopen works (Task 2); `periods.close` FOR UPDATE (Task 3); deterministic guard tests (Tasks 1–2) + concurrent race tests (Task 4); full verify (Task 5). Both races (period + year) covered.
- **Behavior-preservation:** the in-tx guard re-checks the same conditions the pre-tx checks already enforce, with the same error classes/messages; single-threaded runs are unchanged (the existing suite is the guard against drift).
- **Watch-points:** (1) `reverseInTx` MUST receive `allowClosedYear: true` from `reopen` or the reopen e2e breaks — Task 2 Step 4 is the regression check. (2) The year-close's own closing-entry post passes the guard because the year is still OPEN at that point (status flips after) and the re-entrant shared advisory lock under its held exclusive is granted — verified against the close flow; no special-casing. (3) Use a distinct fiscal year/period per test to avoid intra-spec coupling (each spec has its own testcontainer DB, but tests within a spec share it). (4) Lock order is fixed (advisory-shared → period FOR SHARE → sequence FOR UPDATE); close/period-close take disjoint locks — no deadlock cycle.
