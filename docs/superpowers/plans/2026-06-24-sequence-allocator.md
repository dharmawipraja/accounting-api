# One Gapless-Sequence Allocator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the duplicated gapless lock-and-increment (`PostingService.nextNumber` + `DocumentNumberService.next`) into one pure `nextSequenceNumber(tx, table, key)` in `common/db`; both callers become thin keyed delegations.

**Architecture:** `src/common/db/sequence.ts` holds a `SqlTx` type and a pure `nextSequenceNumber` that runs the INSERT-ON-CONFLICT → SELECT-FOR-UPDATE → UPDATE+1 cycle via `Prisma.sql`, with the table and key column names supplied as constant identifiers (`Prisma.raw`) and the key values bound. The two callers delegate; the now-orphaned `RawTx`/`raw-tx.ts` is deleted. Strictly behavior-preserving — same three statements, same bound params, same gapless guarantee.

**Tech Stack:** NestJS 11, Prisma 7 (`Prisma.sql`/`Prisma.raw`/`Prisma.join`), Jest (unit + e2e against testcontainers — Docker required for e2e).

**Spec:** `docs/superpowers/specs/2026-06-24-sequence-allocator-design.md`

## Global Constraints

- **Behavior-preserving.** The same three statements, the same bound key values, the `FOR UPDATE`, the `ON CONFLICT DO NOTHING`, and the gapless guarantee are unchanged — only assembled via `Prisma.sql` (so the table/key can be parameterized) instead of tagged templates.
- **Injection safety.** `Prisma.raw` is confined to the constant `table` union (`'journal_sequences' | 'document_sequences'`) and the callers' literal key column names — never user input. Key VALUES are bound parameters. Same convention as `trigram-search`'s `ownColumns`.
- **Tables stay distinct** (`journal_sequences` keyed `(fiscal_year)`; `document_sequences` keyed `(document_type, fiscal_year)`). No schema change. `buildDocRef`/`buildRef`/`buildEntryRef` unchanged. `DocumentNumberService` survives as a thin facade.
- **`Object.keys` order** drives both the INSERT column list and the bound `values`, so they align (single source `cols`).
- **No `any`.** Lint `--max-warnings 0`. Coverage gate `test:e2e:cov` global 84/62/84/84.
- **Branch:** `feat/sequence-allocator` (already created off `main` at `8cc62e6`).

---

## File Structure

**Create**
- `src/common/db/sequence.ts` — `SqlTx`, `nextSequenceNumber`.
- `src/common/db/sequence.spec.ts` — unit tests (mocked `SqlTx`).

**Modify**
- `src/ledger/posting/posting.service.ts` — `nextNumber` delegates; swap `RawTx`→`SqlTx` import.
- `src/invoicing/document-number.service.ts` — `next` delegates; swap `RawTx`→`SqlTx` import.

**Delete**
- `src/common/db/raw-tx.ts` — `RawTx` is used only by the two methods above (grep-confirmed), both now using `SqlTx`.

**Unchanged:** `doc-ref.ts`, the schema, all callers' tx flow, controllers/DTOs.

---

## Task 1: The `nextSequenceNumber` module + unit tests

**Files:**
- Create: `src/common/db/sequence.ts`
- Test: `src/common/db/sequence.spec.ts`

**Interfaces (produced, consumed by Task 2):**
- `type SqlTx = { $executeRaw(q: Prisma.Sql): Promise<number>; $queryRaw<T>(q: Prisma.Sql): Promise<T> }`
- `nextSequenceNumber(tx: SqlTx, table: 'journal_sequences' | 'document_sequences', key: Record<string, string | number>): Promise<number>`

- [ ] **Step 1: Write the failing unit tests**

Create `src/common/db/sequence.spec.ts`:

```ts
import { Prisma } from '@prisma/client';
import { nextSequenceNumber, SqlTx } from './sequence';

function mockTx() {
  const executed: Prisma.Sql[] = [];
  const queried: Prisma.Sql[] = [];
  const tx: SqlTx = {
    $executeRaw: (q: Prisma.Sql) => {
      executed.push(q);
      return Promise.resolve(1);
    },
    $queryRaw: ((q: Prisma.Sql) => {
      queried.push(q);
      return Promise.resolve([{ next_number: 7 }]);
    }) as SqlTx['$queryRaw'],
  };
  return { tx, executed, queried };
}

describe('nextSequenceNumber', () => {
  it('single-key (journal_sequences): gapless lock-and-increment, returns current', async () => {
    const { tx, executed, queried } = mockTx();
    const n = await nextSequenceNumber(tx, 'journal_sequences', {
      fiscal_year: 2026,
    });
    expect(n).toBe(7);
    // INSERT … ON CONFLICT, keyed on fiscal_year, value bound
    expect(executed[0].sql).toContain('journal_sequences');
    expect(executed[0].sql).toContain('fiscal_year');
    expect(executed[0].sql).toContain('ON CONFLICT');
    expect(executed[0].values).toEqual([2026]);
    // SELECT … FOR UPDATE
    expect(queried[0].sql).toContain('FOR UPDATE');
    expect(queried[0].sql).toContain('journal_sequences');
    expect(queried[0].values).toEqual([2026]);
    // UPDATE next_number = current + 1 (8), predicate value follows
    expect(executed[1].sql).toContain('UPDATE');
    expect(executed[1].values).toEqual([8, 2026]);
  });

  it('two-key (document_sequences): keyed on document_type + fiscal_year', async () => {
    const { tx, executed, queried } = mockTx();
    const n = await nextSequenceNumber(tx, 'document_sequences', {
      document_type: 'INV',
      fiscal_year: 2026,
    });
    expect(n).toBe(7);
    expect(executed[0].sql).toContain('document_sequences');
    expect(executed[0].sql).toContain('document_type');
    expect(executed[0].values).toEqual(['INV', 2026]);
    expect(queried[0].sql).toContain('document_type');
    expect(queried[0].values).toEqual(['INV', 2026]);
    expect(executed[1].values).toEqual([8, 'INV', 2026]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/common/db/sequence.spec.ts`
Expected: FAIL — `Cannot find module './sequence'`.

- [ ] **Step 3: Implement the module**

Create `src/common/db/sequence.ts`:

```ts
import { Prisma } from '@prisma/client';

/** A tx handle that accepts a parameterized Prisma.Sql — the form a dynamic table name
 *  requires (a tagged-template $executeRaw cannot vary the table). Satisfied structurally by
 *  the interactive-transaction client passed into a $transaction callback. */
export type SqlTx = {
  $executeRaw(query: Prisma.Sql): Promise<number>;
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
};

/** Lock-and-increment a per-key counter inside the caller's transaction. Gapless because the
 *  increment shares the tx with the document write.
 *
 *  INJECTION SAFETY: `table` and the `key` COLUMN NAMES are constant identifiers supplied by the
 *  caller (never user input) → safe for Prisma.raw (same convention as trigram-search's
 *  ownColumns). The key VALUES are bound parameters. */
export async function nextSequenceNumber(
  tx: SqlTx,
  table: 'journal_sequences' | 'document_sequences',
  key: Record<string, string | number>,
): Promise<number> {
  const cols = Object.keys(key);
  const colList = Prisma.raw(cols.join(', '));
  const values = Prisma.join(cols.map((c) => Prisma.sql`${key[c]}`));
  const predicate = Prisma.join(
    cols.map((c) => Prisma.sql`${Prisma.raw(c)} = ${key[c]}`),
    ' AND ',
  );
  await tx.$executeRaw(
    Prisma.sql`INSERT INTO ${Prisma.raw(table)} (${colList}, next_number, updated_at)
               VALUES (${values}, 1, now()) ON CONFLICT (${colList}) DO NOTHING`,
  );
  const rows = await tx.$queryRaw<{ next_number: number }[]>(
    Prisma.sql`SELECT next_number FROM ${Prisma.raw(table)} WHERE ${predicate} FOR UPDATE`,
  );
  const current = rows[0].next_number;
  await tx.$executeRaw(
    Prisma.sql`UPDATE ${Prisma.raw(table)} SET next_number = ${current + 1}, updated_at = now() WHERE ${predicate}`,
  );
  return current;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/common/db/sequence.spec.ts`
Expected: PASS — 2 passed.

> If `.sql`/`.values` assertions fail on a Prisma version mismatch, inspect the actual `Prisma.Sql` shape (`console.log(executed[0])`) — the getter is `.sql` (with `?` placeholders) and `.values` (bound params) in Prisma 7; do not change the implementation, adjust the test's accessor only.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck`
Expected: PASS (exit 0). The module is self-contained; nothing imports it yet.

Run: `npx eslint src/common/db/sequence.ts src/common/db/sequence.spec.ts --max-warnings 0`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/common/db/sequence.ts src/common/db/sequence.spec.ts
git commit -m "feat(db): pure gapless-sequence allocator

nextSequenceNumber(tx, table, key): the lock-and-increment counter
algorithm (INSERT-ON-CONFLICT → SELECT-FOR-UPDATE → UPDATE+1) as one
pure helper, parameterized by a constant table + key columns. Unit-tested
for the single-key and two-key shapes. Not yet wired to callers.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Route both callers; delete the orphaned `RawTx`

**Files:**
- Modify: `src/ledger/posting/posting.service.ts`
- Modify: `src/invoicing/document-number.service.ts`
- Delete: `src/common/db/raw-tx.ts`
- Regression net (unmodified): `test/journal.e2e-spec.ts`, `test/posting.e2e-spec.ts`, `test/sales-invoices.e2e-spec.ts`, `test/purchase-bills.e2e-spec.ts`, `test/payments.e2e-spec.ts`, `test/close.e2e-spec.ts`

**Interfaces:** Consumes `nextSequenceNumber` / `SqlTx` from Task 1.

- [ ] **Step 1: Establish the regression baseline (numbering e2e green BEFORE the change)**

Run: `npx jest --config ./test/jest-e2e.json journal posting sales-invoices purchase-bills payments close`
Expected: PASS — JE numbers, INV/BILL numbers, PAY-RCV/PAY-DSB numbers, and the CLOSING JE all gapless and green. (Docker must be up.)

- [ ] **Step 2: Route `PostingService.nextNumber`**

In `src/ledger/posting/posting.service.ts`, replace the import:

```ts
import { RawTx } from '../../common/db/raw-tx';
```

with:

```ts
import { nextSequenceNumber, SqlTx } from '../../common/db/sequence';
```

and replace the entire `nextNumber` method:

```ts
  /** Lock-and-increment the per-fiscal-year counter; gapless because it lives in the tx. */
  private async nextNumber(tx: RawTx, fiscalYear: number): Promise<number> {
    await tx.$executeRaw`INSERT INTO journal_sequences (fiscal_year, next_number, updated_at)
      VALUES (${fiscalYear}, 1, now()) ON CONFLICT (fiscal_year) DO NOTHING`;
    const rows = await tx.$queryRaw<{ next_number: number }[]>`
      SELECT next_number FROM journal_sequences WHERE fiscal_year = ${fiscalYear} FOR UPDATE`;
    const current = rows[0].next_number;
    await tx.$executeRaw`UPDATE journal_sequences SET next_number = ${current + 1}, updated_at = now()
      WHERE fiscal_year = ${fiscalYear}`;
    return current;
  }
```

with:

```ts
  /** Lock-and-increment the per-fiscal-year counter; gapless because it lives in the tx. */
  private nextNumber(tx: SqlTx, fiscalYear: number): Promise<number> {
    return nextSequenceNumber(tx, 'journal_sequences', { fiscal_year: fiscalYear });
  }
```

(The three call sites — `createPostedEntryInTx`, `reverseInTx`, `postDraft` — pass the same `tx` they do today; it is the full `LedgerTx`, which satisfies `SqlTx`. No call-site change.)

- [ ] **Step 3: Route `DocumentNumberService.next`**

In `src/invoicing/document-number.service.ts`, replace the import:

```ts
import { RawTx } from '../common/db/raw-tx';
```

with:

```ts
import { nextSequenceNumber, SqlTx } from '../common/db/sequence';
```

and replace the `next` method:

```ts
  async next(
    tx: RawTx,
    documentType: string,
    fiscalYear: number,
  ): Promise<number> {
    await tx.$executeRaw`INSERT INTO document_sequences (document_type, fiscal_year, next_number, updated_at)
      VALUES (${documentType}, ${fiscalYear}, 1, now()) ON CONFLICT (document_type, fiscal_year) DO NOTHING`;
    const rows = await tx.$queryRaw<{ next_number: number }[]>`
      SELECT next_number FROM document_sequences
      WHERE document_type = ${documentType} AND fiscal_year = ${fiscalYear} FOR UPDATE`;
    const current = rows[0].next_number;
    await tx.$executeRaw`UPDATE document_sequences SET next_number = ${current + 1}, updated_at = now()
      WHERE document_type = ${documentType} AND fiscal_year = ${fiscalYear}`;
    return current;
  }
```

with:

```ts
  next(tx: SqlTx, documentType: string, fiscalYear: number): Promise<number> {
    return nextSequenceNumber(tx, 'document_sequences', {
      document_type: documentType,
      fiscal_year: fiscalYear,
    });
  }
```

(The `buildRef` method below it is unchanged. The `next` call sites — `payments.service.ts`, `taxed-document.service.ts` finalize — pass the interactive `tx`, which satisfies `SqlTx`. No call-site change.)

- [ ] **Step 4: Delete the orphaned `raw-tx.ts`**

Run: `grep -rn "raw-tx\|RawTx" src/` — expect NO remaining references (both imports were removed in Steps 2–3).
Then: `git rm src/common/db/raw-tx.ts`.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS (exit 0). Confirms both call-site `tx` values satisfy `SqlTx` and no dangling `RawTx` reference remains.

> If `tsc` errors that a `nextNumber`/`next` call site's `tx` is not assignable to `SqlTx`, the value is the `$transaction` callback param (the full client) and does satisfy `SqlTx` — re-check the import path. Do not widen `SqlTx`.

- [ ] **Step 6: Lint**

Run: `npm run lint:ci`
Expected: clean (exit 0).

- [ ] **Step 7: Run the numbering e2e (behaviour preserved)**

Run: `npx jest --config ./test/jest-e2e.json journal posting sales-invoices purchase-bills payments close`
Expected: PASS — identical to the Step 1 baseline. All sequences still gapless; no duplicate or skipped numbers.

- [ ] **Step 8: Full verification gate**

Run: `npm run verify`
Expected: PASS — typecheck (exit 0), `lint:ci` (clean), `test` (unit incl. `sequence.spec`), `test:e2e:cov` (all e2e pass **and** global coverage ≥ 84/62/84/84).

- [ ] **Step 9: Commit**

```bash
git add src/ledger/posting/posting.service.ts src/invoicing/document-number.service.ts src/common/db/raw-tx.ts
git commit -m "refactor: route number sequences through nextSequenceNumber; drop RawTx

PostingService.nextNumber and DocumentNumberService.next delegate to the
shared gapless allocator; the now-orphaned RawTx type is deleted.
Behavior unchanged; numbering e2e green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 10: Final sanity diff**

Run: `git diff --stat main`
Expected: `sequence.ts` + `sequence.spec.ts` (new), `posting.service.ts` + `document-number.service.ts` (net reduction), `raw-tx.ts` (deleted), plus the design spec. No schema/DTO/controller change.

---

## Self-Review

**1. Spec coverage**
- §4 module (`SqlTx`, `nextSequenceNumber`, dynamic Prisma.sql build, injection stance) → Task 1 Step 3. ✓
- §5 caller collapse (both delegations, no call-site change) → Task 2 Steps 2–3. ✓
- §3 scope: delete `raw-tx.ts`; tables distinct; `buildDocRef`/`DocumentNumberService` facade preserved; no schema → Task 2 Step 4 + Global Constraints. ✓
- §7 error handling (row guaranteed by ON CONFLICT before FOR UPDATE) → implementation comment; no new throws. ✓
- §8 testing (unit for both key shapes + numbering e2e net) → Task 1 Steps 1–4; Task 2 Steps 1, 7, 8. ✓
- §9 verification (two commits, `npm run verify`, sanity diff) → Task 1 Step 6; Task 2 Steps 8–10. ✓
- §10 risk (behavior-preserving; Prisma.raw on constants; SqlTx layering) → Global Constraints. ✓

**2. Placeholder scan:** No "TBD"/"add validation"/"similar to". Complete before/after code in every code step; exact commands + expected output in every run step. ✓

**3. Type consistency:** `nextSequenceNumber(tx: SqlTx, table: 'journal_sequences' | 'document_sequences', key: Record<string, string | number>): Promise<number>` and `SqlTx` are identical between Task 1's Produces block, Step 3's definition, the Step 1 test calls, and the Task 2 delegations. `nextNumber(tx: SqlTx, fiscalYear)` / `next(tx: SqlTx, documentType, fiscalYear)` signatures match their callers (the `tx` is the interactive client satisfying `SqlTx`). Key object shapes (`{ fiscal_year }`, `{ document_type, fiscal_year }`) match the spec's column names. ✓

No issues found.
