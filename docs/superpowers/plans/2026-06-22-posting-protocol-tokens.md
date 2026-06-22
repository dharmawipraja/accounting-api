# Type-Deep Two-Phase Posting Protocol — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `PostingService`'s two-phase protocol type-deep — phase one mints a branded `PreparedPosting`/`PreparedReversal` token that the in-tx write methods require — so prepare-before-write and id-threading are compiler-enforced and `allowClosedYear` is set exactly once.

**Architecture:** A module-private symbol (`PROTOCOL_MINT`) gates two token classes; only `PostingService.preparePosting`/`prepareReversal` can mint them. `createPostedEntryInTx`/`reverseInTx` take a token and destructure it at the top — so the rest of each (safety-critical) write body is byte-identical. All six callers (2 internal + 4 external) migrate to threading tokens. Strictly behavior-preserving: the TOCTOU guard, advisory locks, gapless numbering, and `allowClosedYear` values are unchanged.

**Tech Stack:** NestJS 11, Prisma 7, Jest (unit + e2e against testcontainers — Docker required for e2e).

**Spec:** `docs/superpowers/specs/2026-06-22-posting-protocol-tokens-design.md`

## Global Constraints

- **Behavior-preserving.** Only the *shape* by which `{periodId, fiscalYear, …}` travels from phase one to phase two changes. The guard (`assertPostablePeriodInTx`), advisory-lock SQL, `nextNumber`, entry-creation, metrics, and the P2002 reverse-race mapping are unchanged.
- **`allowClosedYear` is set once** — captured by `prepareReversal` into `PreparedReversal`; `reverseInTx` reads `prepared.allowClosedYear`. `reverseInTx` no longer takes an `opts` argument.
- **Tokens are minted only by `PostingService`** via the module-private `PROTOCOL_MINT` symbol (not exported). Fields are `readonly` and readable (payments reads `prepared.fiscalYear`).
- **Out of scope — do not touch:** `postDraft`, `assertPostablePeriodInTx` internals, `nextNumber`, advisory-lock SQL, the gapless-number logic, metrics; no schema/DTO/controller/route changes.
- **One atomic commit.** The signature change and all six callers must move together to typecheck, so this is one task with one commit (every commit stays buildable). No `any` except the established `x as unknown as T` double-assert in the unit test.
- **Lint gate:** `npm run lint:ci` (`--max-warnings 0`). **Coverage gate:** `npm run test:e2e:cov` global 84/62/84/84.
- **Branch:** `feat/posting-protocol-tokens` (already created off `main` at `b77d54b`).

---

## File Structure

**Modify**
- `src/ledger/posting/posting.service.ts` — add `PROTOCOL_MINT` + `OriginalEntry` + `PreparedPosting`/`PreparedReversal`; change `preparePosting`/`createPostedEntryInTx`/`prepareReversal`/`reverseInTx`; migrate internal `post`/`reverse`.
- `src/ledger/document-lifecycle.service.ts` — migrate `reverseWithGuard`.
- `src/close/year-end-close.service.ts` — migrate `close` + `reopen`.
- `src/invoicing/payments.service.ts` — migrate the settlement post.

**Create**
- `src/ledger/posting/posting-protocol.spec.ts` — mint-guard unit test.

**Unchanged (do not touch):** `postDraft`, `posting.types.ts`, all DTOs/controllers, the schema, all e2e specs.

---

## Task 1: Brand the posting protocol and migrate all callers

**Files:** as listed above.

**Interfaces (produced):**
- `class PreparedPosting { readonly input: PostEntryInput; readonly postedBy: string; readonly periodId: string; readonly fiscalYear: number }` — minted only by `preparePosting`.
- `class PreparedReversal { readonly original: OriginalEntry; readonly reversedBy: string; readonly periodId: string; readonly fiscalYear: number; readonly reversalDate: Date; readonly allowClosedYear: boolean }` — minted only by `prepareReversal`.
- `preparePosting(input: PostEntryInput, postedBy: string): Promise<PreparedPosting>`
- `createPostedEntryInTx(tx: LedgerTx, prepared: PreparedPosting): Promise<JournalEntry>`
- `prepareReversal(entryId: string, reversedBy: string, date?: Date, opts?: { allowClosedYear?: boolean }): Promise<PreparedReversal>`
- `reverseInTx(tx: LedgerTx, prepared: PreparedReversal): Promise<JournalEntry>`

- [ ] **Step 1: Establish the regression baseline (e2e green BEFORE the change)**

Run: `npx jest --config ./test/jest-e2e.json posting posting-toctou close payments journal sales-invoices purchase-bills`
Expected: PASS — direct posts, TOCTOU guard, year-end close/reopen, payment settlement, journal post/reverse/postDraft, and document void paths all green. (Docker must be up.)

- [ ] **Step 2: Add the token classes + mint symbol to `posting.service.ts`**

After the `LedgerTx` type definition (around line 28) and before `@Injectable() export class PostingService`, insert:

```ts
/** Module-private mint key — external code cannot import it, so it cannot
 *  satisfy the token constructors' first parameter. */
const PROTOCOL_MINT = Symbol('posting.protocol.mint');

/** The original posted entry (with lines) a reversal is built from. */
export type OriginalEntry = JournalEntry & {
  lines: {
    lineNo: number;
    accountId: string;
    debit: Prisma.Decimal;
    credit: Prisma.Decimal;
    description: string | null;
  }[];
};

/** Phase-one result for a post. Minted only by PostingService.preparePosting;
 *  required by createPostedEntryInTx so a post cannot skip preparation. */
export class PreparedPosting {
  constructor(
    mint: typeof PROTOCOL_MINT,
    readonly input: PostEntryInput,
    readonly postedBy: string,
    readonly periodId: string,
    readonly fiscalYear: number,
  ) {
    if (mint !== PROTOCOL_MINT) throw new Error('PreparedPosting is internal');
  }
}

/** Phase-one result for a reversal. Carries allowClosedYear so it is specified
 *  exactly once (not duplicated across prepare + write). Minted only by
 *  PostingService.prepareReversal; required by reverseInTx. */
export class PreparedReversal {
  constructor(
    mint: typeof PROTOCOL_MINT,
    readonly original: OriginalEntry,
    readonly reversedBy: string,
    readonly periodId: string,
    readonly fiscalYear: number,
    readonly reversalDate: Date,
    readonly allowClosedYear: boolean,
  ) {
    if (mint !== PROTOCOL_MINT) throw new Error('PreparedReversal is internal');
  }
}
```

- [ ] **Step 3: Change `preparePosting` to mint the token**

Change the return type annotation of `preparePosting` from `Promise<{ periodId: string; fiscalYear: number }>` to `Promise<PreparedPosting>`. The body is unchanged except the final `return` — replace:

```ts
    return { periodId: period.id, fiscalYear };
```

with:

```ts
    return new PreparedPosting(PROTOCOL_MINT, input, postedBy, period.id, fiscalYear);
```

- [ ] **Step 4: Change `createPostedEntryInTx` to take the token**

Replace the signature and the first line (destructure restores the original local names so the entry-creation body stays byte-identical). Change:

```ts
  async createPostedEntryInTx(
    tx: LedgerTx,
    input: PostEntryInput,
    postedBy: string,
    periodId: string,
    fiscalYear: number,
  ): Promise<JournalEntry> {
    await this.assertPostablePeriodInTx(tx, periodId, fiscalYear);
```

to:

```ts
  async createPostedEntryInTx(
    tx: LedgerTx,
    prepared: PreparedPosting,
  ): Promise<JournalEntry> {
    const { input, postedBy, periodId, fiscalYear } = prepared;
    await this.assertPostablePeriodInTx(tx, periodId, fiscalYear);
```

(Everything below that line — `nextNumber`, `buildEntryRef`, `tx.journalEntry.create`, `metrics` — is unchanged; it still references `input`/`postedBy`/`periodId`/`fiscalYear`.)

- [ ] **Step 5: Migrate the internal `post` method**

Replace:

```ts
  async post(input: PostEntryInput, postedBy: string): Promise<JournalEntry> {
    const { periodId, fiscalYear } = await this.preparePosting(input, postedBy);
    return this.prisma.client.$transaction((tx) =>
      this.createPostedEntryInTx(tx, input, postedBy, periodId, fiscalYear),
    );
  }
```

with:

```ts
  async post(input: PostEntryInput, postedBy: string): Promise<JournalEntry> {
    const prepared = await this.preparePosting(input, postedBy);
    return this.prisma.client.$transaction((tx) =>
      this.createPostedEntryInTx(tx, prepared),
    );
  }
```

- [ ] **Step 6: Change `prepareReversal` (add `reversedBy`, mint the token)**

Change the signature from:

```ts
  async prepareReversal(
    entryId: string,
    date?: Date,
    opts: { allowClosedYear?: boolean } = {},
  ): Promise<{
    original: JournalEntry & {
      lines: {
        lineNo: number;
        accountId: string;
        debit: Prisma.Decimal;
        credit: Prisma.Decimal;
        description: string | null;
      }[];
    };
    periodId: string;
    fiscalYear: number;
    reversalDate: Date;
  }> {
```

to:

```ts
  async prepareReversal(
    entryId: string,
    reversedBy: string,
    date?: Date,
    opts: { allowClosedYear?: boolean } = {},
  ): Promise<PreparedReversal> {
```

The body is unchanged except the final `return` — replace:

```ts
    return { original, periodId: period.id, fiscalYear, reversalDate };
```

with:

```ts
    return new PreparedReversal(
      PROTOCOL_MINT,
      original,
      reversedBy,
      period.id,
      fiscalYear,
      reversalDate,
      opts.allowClosedYear ?? false,
    );
```

- [ ] **Step 7: Change `reverseInTx` to take the token**

Replace the signature + first line (destructure restores the original local names; the reversal-create + mark-REVERSED body stays byte-identical). Change:

```ts
  async reverseInTx(
    tx: LedgerTx,
    original: Awaited<
      ReturnType<PostingService['prepareReversal']>
    >['original'],
    reversedBy: string,
    periodId: string,
    fiscalYear: number,
    reversalDate: Date,
    opts: { allowClosedYear?: boolean } = {},
  ): Promise<JournalEntry> {
    await this.assertPostablePeriodInTx(tx, periodId, fiscalYear, opts);
```

to:

```ts
  async reverseInTx(
    tx: LedgerTx,
    prepared: PreparedReversal,
  ): Promise<JournalEntry> {
    const { original, reversedBy, periodId, fiscalYear, reversalDate, allowClosedYear } =
      prepared;
    await this.assertPostablePeriodInTx(tx, periodId, fiscalYear, { allowClosedYear });
```

(Everything below — `nextNumber`, the reversal `journalEntry.create` with the debit/credit swap, and the `journalEntry.update` marking the original REVERSED — is unchanged.)

- [ ] **Step 8: Migrate the internal `reverse` method**

In `reverse`, replace the destructure + transaction body. Change:

```ts
    const { original, periodId, fiscalYear, reversalDate } =
      await this.prepareReversal(entryId, date);
    try {
      return await this.prisma.client.$transaction((tx) =>
        this.reverseInTx(
          tx,
          original,
          reversedBy,
          periodId,
          fiscalYear,
          reversalDate,
        ),
      );
    } catch (err) {
```

to:

```ts
    const prepared = await this.prepareReversal(entryId, reversedBy, date);
    try {
      return await this.prisma.client.$transaction((tx) =>
        this.reverseInTx(tx, prepared),
      );
    } catch (err) {
```

(The `catch` block's P2002 mapping is unchanged.)

- [ ] **Step 9: Migrate `document-lifecycle.reverseWithGuard`**

In `src/ledger/document-lifecycle.service.ts`, change the prepare call from:

```ts
    const prepared = await this.posting.prepareReversal(
      opts.journalEntryId,
      opts.reversalDate,
    );
```

to:

```ts
    const prepared = await this.posting.prepareReversal(
      opts.journalEntryId,
      opts.reversedBy,
      opts.reversalDate,
    );
```

And change the write call from:

```ts
        await this.posting.reverseInTx(
          ltx,
          prepared.original,
          opts.reversedBy,
          prepared.periodId,
          prepared.fiscalYear,
          prepared.reversalDate,
        );
```

to:

```ts
        await this.posting.reverseInTx(ltx, prepared);
```

- [ ] **Step 10: Migrate `year-end-close` (close + reopen)**

In `src/close/year-end-close.service.ts` `close`, change:

```ts
    const { periodId, fiscalYear: fy } = await this.posting.preparePosting(
      closingInput,
      closedBy,
    );
```

to:

```ts
    const prepared = await this.posting.preparePosting(closingInput, closedBy);
```

and the write call from:

```ts
      const entry = await this.posting.createPostedEntryInTx(
        tx,
        closingInput,
        closedBy,
        periodId,
        fy,
      );
```

to:

```ts
      const entry = await this.posting.createPostedEntryInTx(tx, prepared);
```

(The outer `fiscalYear` — used for the `pg_advisory_xact_lock` and the `year_end_closings` status re-check — is a different variable and stays untouched.)

In `reopen`, change:

```ts
      const {
        original,
        periodId,
        fiscalYear: fy,
        reversalDate,
      } = await this.posting.prepareReversal(rec.closingEntryId, undefined, {
        allowClosedYear: true,
      });
```

to:

```ts
      const prepared = await this.posting.prepareReversal(
        rec.closingEntryId,
        reopenedBy,
        undefined,
        { allowClosedYear: true },
      );
```

and the write call from:

```ts
        await this.posting.reverseInTx(
          tx,
          original,
          reopenedBy,
          periodId,
          fy,
          reversalDate,
          { allowClosedYear: true },
        );
```

to:

```ts
        await this.posting.reverseInTx(tx, prepared);
```

- [ ] **Step 11: Migrate `payments.service`**

In `src/invoicing/payments.service.ts`, change:

```ts
    const { periodId, fiscalYear } = await this.posting.preparePosting(
      journalInput,
      postedBy,
    );
```

to:

```ts
    const prepared = await this.posting.preparePosting(journalInput, postedBy);
```

Inside the transaction, the payment-number sequence uses `fiscalYear` — change the two `docNumber` calls to read it off the token:

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

And the write call from:

```ts
        const entry = await this.posting.createPostedEntryInTx(
          tx,
          journalInput,
          postedBy,
          periodId,
          fiscalYear,
        );
```

to:

```ts
        const entry = await this.posting.createPostedEntryInTx(tx, prepared);
```

- [ ] **Step 12: Add the mint-guard unit test**

Create `src/ledger/posting/posting-protocol.spec.ts`:

```ts
import { PreparedPosting, PreparedReversal } from './posting.service';

// The real constructors require the module-private PROTOCOL_MINT symbol as the
// first arg, so they cannot be called normally from outside the module. Cast to
// a loose constructor to exercise the runtime guard.
type AnyCtor = new (...args: unknown[]) => unknown;

describe('posting protocol tokens are mint-guarded', () => {
  it('PreparedPosting throws when constructed without the mint', () => {
    const Forge = PreparedPosting as unknown as AnyCtor;
    expect(() => new Forge('not-the-mint', {}, 'u1', 'p1', 2026)).toThrow(
      'PreparedPosting is internal',
    );
  });

  it('PreparedReversal throws when constructed without the mint', () => {
    const Forge = PreparedReversal as unknown as AnyCtor;
    expect(
      () => new Forge('not-the-mint', {}, 'u1', 'p1', 2026, new Date(), false),
    ).toThrow('PreparedReversal is internal');
  });
});
```

- [ ] **Step 13: Typecheck — the protocol contract gate**

Run: `npm run typecheck`
Expected: PASS (exit 0). This is the headline assertion: every caller threads a token correctly. If any caller still passes loose `periodId`/`fiscalYear`/`input` or calls a write without preparing, `tsc` fails here.

> If `tsc` errors on `reverseInTx`'s old `Awaited<ReturnType<…>>['original']` self-reference still lingering anywhere, it was fully removed in Step 7 (replaced by the `PreparedReversal` param). If a caller errors on `prepareReversal` arity, confirm Steps 8–10 added `reversedBy` as the 2nd arg.

- [ ] **Step 14: Lint**

Run: `npm run lint:ci`
Expected: clean (exit 0). (Catches any now-unused import or leftover local.)

- [ ] **Step 15: Run the safety-net e2e (behaviour preserved)**

Run: `npx jest --config ./test/jest-e2e.json posting posting-toctou close payments journal sales-invoices purchase-bills`
Expected: PASS — identical to the Step 1 baseline. Direct posts, TOCTOU guard, close/reopen (incl. `allowClosedYear` reopen), payment settlement, journal reverse, and document voids all unchanged.

- [ ] **Step 16: Full verification gate**

Run: `npm run verify`
Expected: PASS — `typecheck` (exit 0), `lint:ci` (clean), `test` (unit incl. the mint-guard spec), `test:e2e:cov` (all e2e pass **and** global coverage ≥ 84/62/84/84).

- [ ] **Step 17: Commit**

```bash
git add src/ledger/posting/posting.service.ts src/ledger/posting/posting-protocol.spec.ts src/ledger/document-lifecycle.service.ts src/close/year-end-close.service.ts src/invoicing/payments.service.ts
git commit -m "refactor(ledger): type-deep two-phase posting protocol

preparePosting/prepareReversal mint branded PreparedPosting/PreparedReversal
tokens (module-private symbol) that createPostedEntryInTx/reverseInTx now
require — prepare-before-write and id-threading are compiler-enforced, and
allowClosedYear is carried in the reversal token (set once, not dual-passed).
All six callers migrated. Behavior-preserving; guard/locks/numbering
unchanged; e2e green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 18: Final sanity diff**

Run: `git diff --stat main`
Expected: `posting.service.ts`, `posting-protocol.spec.ts` (new), `document-lifecycle.service.ts`, `year-end-close.service.ts`, `payments.service.ts`, plus the design spec. No `postDraft` logic change, no schema/DTO/controller/route.

---

## Self-Review

**1. Spec coverage**
- §4 tokens (`PROTOCOL_MINT`, `OriginalEntry`, `PreparedPosting`, `PreparedReversal`) → Step 2. ✓
- §5 method shapes (preparePosting→token; createPostedEntryInTx(tx,prepared); prepareReversal(+reversedBy)→token; reverseInTx(tx,prepared) reads allowClosedYear) → Steps 3,4,6,7. ✓
- §6 caller migration (internal post/reverse; document-lifecycle; year-end-close ×2; payments incl. `prepared.fiscalYear`) → Steps 5,8,9,10,11. ✓
- §3 out-of-scope (postDraft, guard internals, nextNumber, locks; no schema/DTO/route) → Global Constraints + Step 18 diff. ✓
- §8 error handling (no new errors; mint-guard throw is a defensive backstop) → Step 2 (the `throw`); Step 12 asserts it. ✓
- §9 testing (typecheck as contract gate; mint-guard unit test; existing e2e net) → Steps 1,12,13,15,16. ✓
- §10/§11 verification + risk (behavior-preserving via destructure-at-top; comprehensive e2e) → Steps 4,7 (byte-identical bodies), 15,16. ✓

**2. Placeholder scan:** No "TBD"/"add validation"/"similar to". Every code step shows complete before/after; every run step gives the exact command + expected result. ✓

**3. Type consistency:** `PreparedPosting`/`PreparedReversal` field names and types are identical between the Step 2 definitions, the Interfaces block, the Step 3/6 mint calls (arg order: `mint, input, postedBy, periodId, fiscalYear` and `mint, original, reversedBy, periodId, fiscalYear, reversalDate, allowClosedYear`), and the Step 4/7 destructures. `preparePosting(input, postedBy): Promise<PreparedPosting>` and `prepareReversal(entryId, reversedBy, date?, opts?): Promise<PreparedReversal>` match every call site (Steps 5,8,9,10,11). `createPostedEntryInTx(tx, prepared)` / `reverseInTx(tx, prepared)` 2-arg form is consistent across all callers. `prepared.fiscalYear` (payments) is a readonly field on `PreparedPosting`. ✓

No issues found. (Single commit, not the spec's "two commits": the signature change does not compile until every caller migrates, so an intermediate commit would not build — one commit keeps the history bisectable.)
