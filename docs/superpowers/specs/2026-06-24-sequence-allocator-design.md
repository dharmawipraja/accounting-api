# One gapless-sequence allocator

**Date:** 2026-06-24
**Status:** Approved (design) — ready for implementation plan
**Origin:** Architecture review round-2 candidate #2 ("One gapless-sequence allocator").

## Vocabulary

Architecture terms per the `improve-codebase-architecture` skill: **module, interface, implementation,
depth, deep/shallow, seam, adapter, leverage, locality.** Domain terms per `docs/runbooks/domain-glossary.md`.

---

## 1. Problem

The "gapless, lock-and-increment a per-key counter inside the caller's transaction" algorithm is
implemented twice, structurally identical, differing only by table name and key columns:

| | Table | Key |
| --- | --- | --- |
| `PostingService.nextNumber(tx, fiscalYear)` | `journal_sequences` | `(fiscal_year)` |
| `DocumentNumberService.next(tx, documentType, fiscalYear)` | `document_sequences` | `(document_type, fiscal_year)` |

Each runs the identical three statements:
1. `INSERT INTO <table> (<key>, next_number, updated_at) VALUES (<keyVals>, 1, now()) ON CONFLICT (<key>) DO NOTHING`
2. `SELECT next_number FROM <table> WHERE <keyPredicate> FOR UPDATE`
3. `UPDATE <table> SET next_number = ${current + 1}, updated_at = now() WHERE <keyPredicate>`

The **gapless guarantee** is load-bearing — a burned number is an audit gap — yet it lives in two places
that must be kept in lockstep by hand. `buildDocRef` is *already* the shared reference-formatting seam
both route through (`PostingService.buildEntryRef` and `DocumentNumberService.buildRef` both call it),
which proves the team's instinct that this family belongs behind one seam; the counter mechanics were the
half left un-extracted.

## 2. Goal

Extract one gapless-sequence module the way `buildDocRef`/`signing.ts` were extracted; both callers
become thin keyed delegations. **Locality:** the gapless invariant lives once and is unit-testable.
**Leverage:** a future sequence (new table/key) is one call.

## 3. Scope

**In scope**
- New `src/common/db/sequence.ts`: a `SqlTx` type + a pure `nextSequenceNumber(tx, table, key)`.
- `PostingService.nextNumber` and `DocumentNumberService.next` become one-line delegations.
- Delete `src/common/db/raw-tx.ts` (`RawTx` is used only by those two methods — confirmed — and both
  switch to `SqlTx`).
- Unit tests for the dynamic-SQL assembly.

**Out of scope (explicitly)**
- The two sequence TABLES stay distinct (`journal_sequences` vs `document_sequences`); only the algorithm
  is shared. No schema change.
- `buildDocRef` / `buildRef` / `buildEntryRef` — unchanged (already shared).
- `DocumentNumberService` survives as a thin facade (`next` + `buildRef`); not absorbed.
- No change to the `FOR UPDATE`, the `ON CONFLICT`, the gapless guarantee, or any caller's tx flow.
- Round-2 #7 (full `RawTx`/`LedgerTx` unification) is not done here — deleting the now-orphaned `RawTx`
  is a side-effect, not the goal.

## 4. The module

`src/common/db/sequence.ts`:

```ts
import { Prisma } from '@prisma/client';

/** A tx handle that accepts a parameterized Prisma.Sql — the form a dynamic table name requires
 *  (tagged-template `$executeRaw` cannot vary the table). Satisfied by the interactive-tx client. */
export type SqlTx = {
  $executeRaw(query: Prisma.Sql): Promise<number>;
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>;
};

/** Lock-and-increment a per-key counter inside the caller's transaction. Gapless because the
 *  increment shares the tx with the document write.
 *
 *  INJECTION SAFETY: `table` and the `key` COLUMN NAMES are constant identifiers supplied by the
 *  caller (never user input) → safe for Prisma.raw, the same constant-identifier pattern as
 *  trigram-search's ownColumns. The key VALUES are bound parameters. */
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

**Equivalence (verified against both originals):** for `journal_sequences` the caller passes
`{ fiscal_year: fy }` → `cols=['fiscal_year']`, reproducing the single-key INSERT / ON CONFLICT / WHERE
exactly; for `document_sequences` the caller passes `{ document_type, fiscal_year }` →
`cols=['document_type','fiscal_year']`, reproducing the two-key form. Same three statements, same bound
values, same `now()`. (`Object.keys` preserves insertion order, so the INSERT column list and `values`
align.)

## 5. Caller collapse

```ts
// posting.service.ts
private nextNumber(tx: SqlTx, fiscalYear: number): Promise<number> {
  return nextSequenceNumber(tx, 'journal_sequences', { fiscal_year: fiscalYear });
}

// document-number.service.ts
next(tx: SqlTx, documentType: string, fiscalYear: number): Promise<number> {
  return nextSequenceNumber(tx, 'document_sequences', {
    document_type: documentType,
    fiscal_year: fiscalYear,
  });
}
```

The `nextNumber` call sites (`createPostedEntryInTx`, `reverseInTx`, `postDraft`) and the
`DocumentNumberService.next` call sites (payments, taxed-document) pass the same interactive-tx value
they do today — it is the full `LedgerTx`, which structurally satisfies `SqlTx`. No call-site changes.
Imports of `RawTx` are removed from both files; `src/common/db/raw-tx.ts` is deleted.

## 6. Data flow

Unchanged. Same lock-and-increment under the caller's `$transaction`, same gapless number, same
`buildDocRef` formatting. Only the *owner* of the counter mechanics moves into one seam, and the SQL is
assembled via `Prisma.sql` (so the table/key can be parameterized) instead of tagged templates.

## 7. Error handling

None introduced. The function assumes (as both originals did) that the SELECT after the INSERT-or-conflict
returns a row — guaranteed because the `ON CONFLICT DO NOTHING` ensures the row exists before the
`FOR UPDATE` read. No new throws.

## 8. Testing

- **New `src/common/db/sequence.spec.ts`** — mock `SqlTx` (`$queryRaw` returns `[{ next_number: 7 }]`,
  `$executeRaw` returns `1`) and assert, for BOTH key shapes:
  - the generated `Prisma.Sql` for INSERT/SELECT/UPDATE carries the right table name and the key
    column(s) in the `ON CONFLICT`/`WHERE`;
  - the bound `.values` are exactly the key values (and `current + 1` on the UPDATE);
  - the function returns `current` (7).
  This makes the dynamic-SQL assembly — the risky bit — testable without a DB.
- **Existing e2e are the integration net** (gapless guarantee, behavior identical): `journal` (JE
  numbers), `posting`/`posting-toctou`, `sales-invoices`/`purchase-bills` (INV/BILL), `payments`
  (PAY-RCV/PAY-DSB), `close` (CLOSING JE). A gap or duplicate would fail these.

## 9. Verification & migration

- Branch `feat/sequence-allocator` off `main`. Two commits: (1) `sequence.ts` + `sequence.spec.ts`;
  (2) route both callers + delete `raw-tx.ts`.
- Gate: `npm run verify` — typecheck (exit 0), `lint:ci` (clean), `test` (unit incl. the new spec),
  `test:e2e:cov` (all e2e pass **and** global coverage ≥ 84/62/84/84).
- Sanity diff vs `main`: `sequence.ts` + `sequence.spec.ts` (new), `posting.service.ts` +
  `document-number.service.ts` (net reduction), `raw-tx.ts` (deleted), plus this spec. No schema/DTO/
  controller change.

## 10. Risks

- **Safety-critical numbering.** A burned/duplicate number is an audit gap. Mitigation: strictly
  behavior-preserving — the same three statements with the same bound parameters, only assembled via
  `Prisma.sql` so the table/key can be parameterized. The broad numbering e2e net (journal/document/
  payment/close) catches any regression.
- **Injection safety.** `Prisma.raw` is confined to the constant `table` union and the two callers'
  literal key column names — never user input. Same convention already used by `trigram-search`.
- **`SqlTx` vs `RawTx`.** Defining `SqlTx` in `common/db` (a leaf) avoids importing `LedgerTx` from the
  ledger layer (a layering inversion). `RawTx`'s deletion is safe (grep-confirmed sole consumers are the
  two changed methods).
- **Smallest-possible diff:** one helper + a type + two one-line delegations + a deleted dead type.
