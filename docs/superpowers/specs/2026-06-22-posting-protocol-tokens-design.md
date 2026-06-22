# Make the two-phase posting protocol type-deep

**Date:** 2026-06-22
**Status:** Approved (design) — ready for implementation plan
**Origin:** Architecture review candidate #4 ("Make the two-phase posting protocol type-deep").
The last code candidate (#6 is a deliberate skip). Most safety-critical module — sequenced last.

## Vocabulary

Architecture terms are used exactly (per `improve-codebase-architecture`):
**module, interface, implementation, depth, deep/shallow, seam, adapter, leverage, locality.**
Domain terms per `docs/runbooks/domain-glossary.md`.

---

## 1. Problem

`PostingService` exposes a two-phase posting protocol — phase one (`preparePosting` / `prepareReversal`,
pre-transaction reads) resolves the open period + fiscal year; phase two (`createPostedEntryInTx` /
`reverseInTx`, in-transaction writes) assigns the gapless number and writes the POSTED entry. Four
external callers (document-lifecycle, year-end-close ×2, payments) plus two internal convenience methods
(`post`, `reverse`) must replay this protocol by hand.

**What is already enforced (do not re-do):** the in-tx TOCTOU guard `assertPostablePeriodInTx` (shared
advisory lock on the fiscal year + re-check `year_end_closings`; `FOR SHARE` on the period + re-check
`OPEN`) is already the **mandatory first statement** of `createPostedEntryInTx` (`posting.service.ts:101`),
`reverseInTx` (`:283`), and `postDraft` (`:387`). The review's "fold the guard inside so it can't be
skipped" is **done** (the Deepening-C/TOCTOU work). All four external callers are correct today.

**What remains (latent, not active):** the *other* protocol invariants are enforced only by convention:

| Invariant | Enforced today by | Gap closed by this work |
| --- | --- | --- |
| Guard runs first, in-tx | the code itself ✅ | (already done — untouched) |
| prepare() before the tx | convention | branded token the write requires |
| thread the resolved `{periodId, fiscalYear}` | convention — write takes loose `string`/`number` | token carries them; can't be fabricated/mis-threaded |
| `allowClosedYear` only on reopen | passed **separately** to `prepareReversal` *and* `reverseInTx` (`year-end-close.service.ts:188` & `:203`) | captured once in the reversal token |

A future fifth caller could call a write without preparing, fabricate `periodId`/`fiscalYear`, or set
`allowClosedYear` inconsistently across the two calls (which silently breaks reopen). This work hardens
the type contract against that. It is purely latent — no current bug.

## 2. Goal

Make the protocol **type-deep**: phase one mints a branded token that phase two **requires**, so the
ordering and id-threading invariants are enforced by the compiler instead of a JSDoc comment, and
`allowClosedYear` is specified exactly once.

**Locality:** the protocol contract lives in the types, not a comment. **Leverage:** every posting path
— present and future — gets the contract for free and cannot mis-sequence it.

## 3. Scope

**In scope**
- Two branded token classes `PreparedPosting` / `PreparedReversal`, minted only by `PostingService` via a
  module-private symbol.
- New signatures: `preparePosting → PreparedPosting`; `createPostedEntryInTx(tx, prepared)`;
  `prepareReversal(entryId, reversedBy, date?, opts?) → PreparedReversal`; `reverseInTx(tx, prepared)`.
- Migrate the 4 external call-pairs + the 2 internal convenience methods.
- A unit test for the runtime mint-guard.

**Out of scope (explicitly)**
- `postDraft` — a self-contained atomic method (no external prepare/write split); already guarded. Untouched.
- `assertPostablePeriodInTx` internals, `nextNumber`, the advisory-lock SQL, the gapless-number logic,
  metrics — all unchanged. Behavior is byte-identical.
- No schema, DTO, controller, or route changes.

## 4. The branded tokens

A module-private symbol in `posting.service.ts` gates construction — external code can neither import the
symbol (so it can't satisfy the `mint` parameter at compile time) nor `new` the class:

```ts
const PROTOCOL_MINT = Symbol('posting.protocol.mint'); // NOT exported

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

export class PreparedPosting {
  /** @internal — minted only by PostingService.preparePosting */
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

export class PreparedReversal {
  /** @internal — minted only by PostingService.prepareReversal */
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

The token fields are **readable** (`readonly`) — the brand prevents *construction*, not reading.
This matters: `payments` reads `prepared.fiscalYear` for its own payment-number sequence (see §5).

## 5. New method shapes

```ts
async preparePosting(input: PostEntryInput, postedBy: string): Promise<PreparedPosting> {
  // …unchanged balance/SoD/open-period/postable-account/closed-year checks…
  return new PreparedPosting(PROTOCOL_MINT, input, postedBy, period.id, fiscalYear);
}

async createPostedEntryInTx(tx: LedgerTx, prepared: PreparedPosting): Promise<JournalEntry> {
  await this.assertPostablePeriodInTx(tx, prepared.periodId, prepared.fiscalYear);
  // …nextNumber / buildEntryRef / journalEntry.create using prepared.input/postedBy/periodId/fiscalYear…
}

async prepareReversal(
  entryId: string, reversedBy: string, date?: Date, opts: { allowClosedYear?: boolean } = {},
): Promise<PreparedReversal> {
  // …unchanged load/POSTED-check/period/closed-year (skipped when opts.allowClosedYear)…
  return new PreparedReversal(
    PROTOCOL_MINT, original, reversedBy, period.id, fiscalYear, reversalDate, opts.allowClosedYear ?? false,
  );
}

async reverseInTx(tx: LedgerTx, prepared: PreparedReversal): Promise<JournalEntry> {
  await this.assertPostablePeriodInTx(tx, prepared.periodId, prepared.fiscalYear, {
    allowClosedYear: prepared.allowClosedYear,
  });
  // …nextNumber / reversal create (debit/credit swap) / mark original REVERSED, using prepared.*…
}
```

`PreparedPosting` carries no `allowClosedYear` (a normal post never allows a closed year; the guard runs
with the default `false`). Only the reversal token carries it.

## 6. Caller migration (behavior-preserving)

- **`PostingService.post`:** `const p = await this.preparePosting(input, postedBy); return this.prisma.client.$transaction((tx) => this.createPostedEntryInTx(tx, p));`
- **`PostingService.reverse`:** `const p = await this.prepareReversal(entryId, reversedBy, date); … $transaction((tx) => this.reverseInTx(tx, p));` (the P2002 try/catch is unchanged).
- **`document-lifecycle.reverseWithGuard`:** `const prepared = await this.posting.prepareReversal(opts.journalEntryId, opts.reversedBy, opts.reversalDate);` … `await this.posting.reverseInTx(ltx, prepared);` (no `allowClosedYear` → defaults `false`, as today).
- **`year-end-close.close`:** `const prepared = await this.posting.preparePosting(closingInput, closedBy);` … `await this.posting.createPostedEntryInTx(tx, prepared);`. The outer `fiscalYear` (the close target — advisory lock + status re-check) is untouched.
- **`year-end-close.reopen`:** `const prepared = await this.posting.prepareReversal(rec.closingEntryId, reopenedBy, undefined, { allowClosedYear: true });` … `await this.posting.reverseInTx(tx, prepared);` — `allowClosedYear: true` now lives in the token (was passed to both calls).
- **`payments.service`:** `const prepared = await this.posting.preparePosting(journalInput, postedBy);` … inside the tx, use `prepared.fiscalYear` for `docNumber.next`/`buildRef`, and `await this.posting.createPostedEntryInTx(tx, prepared);`.

## 7. Data flow

Unchanged. The same period/fiscal-year is resolved pre-tx, the same guard runs first in-tx with the same
inputs, the same gapless number is assigned, the same entry is written, the same `allowClosedYear` value
applies. Only the *shape* by which the resolved facts travel from phase one to phase two changes (a typed
token instead of loose positional args).

## 8. Error handling

No new domain errors. `assertPostablePeriodInTx` throws the same `ClosedYearError` / `ValidationFailedError`
as today. The mint-guard's `throw new Error('… is internal')` is unreachable in normal flow (only a forged
construction hits it) — it is a defensive backstop behind the compile-time barrier.

## 9. Testing

- **Compile-time contract is the headline test:** `npm run typecheck` passes only when every caller threads
  a token correctly. A future write-without-prepare or fabricated id is a compile error.
- **New unit test** (`posting-protocol.spec.ts` or in an existing posting spec): constructing
  `PreparedPosting` / `PreparedReversal` with a non-mint first argument throws — proving the brand is not
  trivially forgeable at runtime.
- **Existing e2e are the integration net** (behavior identical): `posting`, `posting-toctou`, `close`,
  `close-reversal-guard`, `close-out-of-order`, `payments`, `journal`, and the document-void paths in
  `sales-invoices` / `purchase-bills`. All must stay green.

## 10. Verification & migration

- Branch `feat/posting-protocol-tokens` off `main`. Two commits: (1) token classes + signature changes +
  internal `post`/`reverse` + the mint-guard unit test; (2) external caller migration (document-lifecycle,
  year-end-close ×2, payments).
- Gate: `npm run verify` — `typecheck` (exit 0), `lint:ci` (clean), `test` (unit incl. mint-guard),
  `test:e2e:cov` (all e2e pass **and** global coverage ≥ 84/62/84/84).
- Sanity diff vs `main`: `posting.service.ts`, `document-lifecycle.service.ts`, `year-end-close.service.ts`,
  `payments.service.ts` (+ the new spec), plus this design doc. No schema/DTO/controller/route.

## 11. Risks

- **Highest-risk candidate of the six.** It touches gapless numbering, advisory locks, and the TOCTOU
  guard. Mitigation: the change is strictly behavior-preserving — only the *shape* of how resolved facts
  reach the write changes; the guard, locks, numbering, and `allowClosedYear` values are identical. The
  comprehensive posting/close/payments/reversal/TOCTOU e2e net catches any regression, and `typecheck`
  forces every caller to migrate consistently.
- **Branding strength:** the module-private-symbol-gated constructor is enforced at compile time (the
  `mint` parameter type is an un-importable symbol) and at runtime (the `!== PROTOCOL_MINT` throw). A
  caller cannot construct a token without going through `prepare*`.
- **`allowClosedYear` consolidation** is the one genuinely footgun-removing change: it can no longer be set
  inconsistently between phase one and phase two, because it exists in exactly one place (the token).
- **Smallest-possible diff:** token classes + four method signatures + six call-site migrations; no logic
  inside the writes changes.
