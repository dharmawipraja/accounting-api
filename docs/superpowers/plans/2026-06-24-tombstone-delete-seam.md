# A Tombstone-Delete Seam for Reference Masters — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `tombstoneDelete` model method beside the existing `softDelete` (using a pure `tombstoneValue` helper) so the `#deleted-${id}` tombstone format + the soft-delete write live once; the four reference-master `softDelete` services collapse onto it.

**Architecture:** A pure `src/common/prisma/tombstone.ts` holds the suffix format; a new write-only `tombstoneDelete` model method in `soft-delete.extension.ts`'s `soft-delete-methods` `$extends` mirrors `softDelete`, adding the `[field]` key + the suffix. Four services keep their fetch + per-entity guards and call the method. Behavior-identical; no schema change.

**Tech Stack:** NestJS 11, Prisma 7 client extension (`$extends` model methods), Jest (unit + e2e against testcontainers — Docker required for e2e).

**Spec:** `docs/superpowers/specs/2026-06-24-tombstone-delete-seam-design.md`

## Global Constraints

- **Behavior-preserving.** The tombstone write keeps the same suffixed value (`` `${value}#deleted-${id}` ``), the same `deletedAt: new Date()`/`deletedBy`, and the same `{ id }` where — only relocated behind a method mirroring `softDelete`.
- **Write-only contract.** `tombstoneDelete(id, field, currentValue, deletedBy?)` — the caller passes the live value it already fetched; the method does NOT re-read. Matches `softDelete`.
- **`field` is a constant identifier** (`'code'`/`'email'`), never user input. The computed `[field]` key matches the extension's existing loose `$allModels` typing (as `softDelete` uses `where: Record<string, unknown>`).
- **Per-entity logic stays in the services** — the existence checks (`findFirst`/`findById`) and accounts' POSTED/REVERSED-line guard are NOT moved.
- **Out of scope — do not touch:** the existing `softDelete` method, the query-filter `$extends` (the `deletedAt: null` injection + hard-delete/upsert guards), every other model, the schema.
- **No `any`.** Lint `--max-warnings 0`. Coverage gate `test:e2e:cov` global 84/62/84/84.
- **Branch:** `feat/tombstone-delete-seam` (already created off `main` at `3990be4`).

---

## File Structure

**Create**
- `src/common/prisma/tombstone.ts` — pure `tombstoneValue(value, id)`.
- `src/common/prisma/tombstone.spec.ts` — unit tests.

**Modify**
- `src/common/prisma/soft-delete.extension.ts` — import `tombstoneValue`; add `tombstoneDelete` beside `softDelete`.
- `src/users/users.service.ts` — `softDelete` calls `tombstoneDelete`.
- `src/ledger/accounts/accounts.service.ts` — same.
- `src/tax/tax-codes.service.ts` — same.
- `src/invoicing/business-partners.service.ts` — same.

**Unchanged:** the query-filter extension, `softDelete`, all other models, the schema.

---

## Task 1: The pure `tombstoneValue` helper + unit tests

**Files:**
- Create: `src/common/prisma/tombstone.ts`
- Test: `src/common/prisma/tombstone.spec.ts`

**Interfaces (produced, consumed by Task 2):**
- `tombstoneValue(value: string, id: string): string` → `` `${value}#deleted-${id}` ``

- [ ] **Step 1: Write the failing unit tests**

Create `src/common/prisma/tombstone.spec.ts`:

```ts
import { tombstoneValue } from './tombstone';

describe('tombstoneValue', () => {
  it('suffixes a code with #deleted-<id>', () => {
    expect(tombstoneValue('AR-1000', 'abc')).toBe('AR-1000#deleted-abc');
  });
  it('suffixes an email', () => {
    expect(tombstoneValue('user@example.com', 'u-1')).toBe(
      'user@example.com#deleted-u-1',
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/common/prisma/tombstone.spec.ts`
Expected: FAIL — `Cannot find module './tombstone'`.

- [ ] **Step 3: Implement the helper**

Create `src/common/prisma/tombstone.ts`:

```ts
/** Suffix a unique value so it is freed for reuse while the row is soft-deleted. */
export function tombstoneValue(value: string, id: string): string {
  return `${value}#deleted-${id}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/common/prisma/tombstone.spec.ts`
Expected: PASS — 2 passed.

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck`
Expected: PASS (exit 0). Self-contained; nothing imports it yet.

Run: `npx eslint src/common/prisma/tombstone.ts src/common/prisma/tombstone.spec.ts --max-warnings 0`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/common/prisma/tombstone.ts src/common/prisma/tombstone.spec.ts
git commit -m "feat(prisma): pure tombstoneValue helper

The \${value}#deleted-\${id} tombstone suffix as one pure, unit-tested
function. Not yet wired to callers.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `tombstoneDelete` method + route the four services

**Files:**
- Modify: `src/common/prisma/soft-delete.extension.ts`, `src/users/users.service.ts`, `src/ledger/accounts/accounts.service.ts`, `src/tax/tax-codes.service.ts`, `src/invoicing/business-partners.service.ts`
- Regression net (unmodified): `test/users.e2e-spec.ts`, `test/accounts.e2e-spec.ts`, `test/tax-codes.e2e-spec.ts`, `test/business-partners.e2e-spec.ts`, `test/soft-delete.e2e-spec.ts`, `test/soft-delete-hardening.e2e-spec.ts`

**Interfaces:** Consumes `tombstoneValue` from Task 1. Produces the model method `tombstoneDelete(id: string, field: string, currentValue: string, deletedBy?: string)` on every Prisma model delegate.

- [ ] **Step 1: Establish the regression baseline (green BEFORE the change)**

Run: `npx jest --config ./test/jest-e2e.json users accounts tax-codes business-partners soft-delete`
Expected: PASS — each entity's delete → re-fetch 404 → code/email reuse, plus the soft-delete hardening guards. (Docker must be up.)

- [ ] **Step 2: Add the `tombstoneValue` import to the extension**

In `src/common/prisma/soft-delete.extension.ts`, change the top import line:

```ts
import { Prisma, PrismaClient } from '@prisma/client';
```

to:

```ts
import { Prisma, PrismaClient } from '@prisma/client';
import { tombstoneValue } from './tombstone';
```

- [ ] **Step 3: Add the `tombstoneDelete` method beside `softDelete`**

In the same file, the `soft-delete-methods` `$extends` currently ends its `$allModels` block with the `softDelete` method:

```ts
          async softDelete<T>(
            this: T,
            where: Record<string, unknown>,
            deletedBy?: string,
          ) {
            const ctx = Prisma.getExtensionContext(this);
            if (!isSoftDelete(ctx.$name)) {
              throw new Error(
                `softDelete() is not supported on model ${String(ctx.$name)}`,
              );
            }
            const typedCtx = ctx as unknown as {
              update: (a: unknown) => Promise<unknown>;
            };
            return typedCtx.update({
              where,
              data: { deletedAt: new Date(), deletedBy },
            });
          },
```

Insert the new method immediately after that closing `},` (still inside `$allModels`):

```ts
          async tombstoneDelete<T>(
            this: T,
            id: string,
            field: string,
            currentValue: string,
            deletedBy?: string,
          ) {
            const ctx = Prisma.getExtensionContext(this);
            if (!isSoftDelete(ctx.$name)) {
              throw new Error(
                `tombstoneDelete() is not supported on model ${String(ctx.$name)}`,
              );
            }
            const typedCtx = ctx as unknown as {
              update: (a: unknown) => Promise<unknown>;
            };
            return typedCtx.update({
              where: { id },
              data: {
                [field]: tombstoneValue(currentValue, id),
                deletedAt: new Date(),
                deletedBy,
              },
            });
          },
```

- [ ] **Step 4: Route `users.service.softDelete`**

In `src/users/users.service.ts`, replace the tombstone `update` (keep the `findFirst` + `NotFoundDomainError` above it). Change:

```ts
    // Tombstone the unique email so it can be reused, and mark soft-deleted.
    await this.prisma.client.user.update({
      where: { id },
      data: {
        email: `${user.email}#deleted-${id}`,
        deletedAt: new Date(),
        deletedBy,
      },
    });
```

to:

```ts
    // Tombstone the unique email so it can be reused, and mark soft-deleted.
    await this.prisma.client.user.tombstoneDelete(id, 'email', user.email, deletedBy);
```

- [ ] **Step 5: Route `accounts.service.softDelete`**

In `src/ledger/accounts/accounts.service.ts`, keep the `findById` + the POSTED/REVERSED `postedLineCount` guard. Replace:

```ts
    await this.prisma.client.account.update({
      where: { id },
      data: {
        code: `${account.code}#deleted-${id}`,
        deletedAt: new Date(),
        deletedBy,
      },
    });
```

with:

```ts
    await this.prisma.client.account.tombstoneDelete(id, 'code', account.code, deletedBy);
```

- [ ] **Step 6: Route `tax-codes.service.softDelete`**

In `src/tax/tax-codes.service.ts`, keep the `findById`. Replace:

```ts
    await this.prisma.client.taxCode.update({
      where: { id },
      data: {
        code: `${taxCode.code}#deleted-${id}`,
        deletedAt: new Date(),
        deletedBy,
      },
    });
```

with:

```ts
    await this.prisma.client.taxCode.tombstoneDelete(id, 'code', taxCode.code, deletedBy);
```

- [ ] **Step 7: Route `business-partners.service.softDelete`**

In `src/invoicing/business-partners.service.ts`, keep the `findById`. Replace:

```ts
    await this.prisma.client.businessPartner.update({
      where: { id },
      data: {
        code: `${p.code}#deleted-${id}`,
        deletedAt: new Date(),
        deletedBy,
      },
    });
```

with:

```ts
    await this.prisma.client.businessPartner.tombstoneDelete(id, 'code', p.code, deletedBy);
```

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: PASS (exit 0). Confirms `tombstoneDelete` is visible on each model delegate (via `ExtendedPrismaClient`) and the four call sites are well-typed.

> If `tsc` reports `tombstoneDelete` does not exist on the model delegate, the method was added to the wrong `$extends` block — it must be inside `soft-delete-methods` → `model` → `$allModels`, beside `softDelete` (not in the `query` block). Re-check placement; do not change the call sites.

- [ ] **Step 9: Lint**

Run: `npm run lint:ci`
Expected: clean (catches any leftover unused import in the four services, e.g. if `new Date` was the only use of something — it is not, but confirm).

- [ ] **Step 10: Run the affected e2e (behaviour preserved)**

Run: `npx jest --config ./test/jest-e2e.json users accounts tax-codes business-partners soft-delete`
Expected: PASS — identical to the Step 1 baseline. Each entity: delete → re-fetch 404 → **code/email reuse still succeeds**; soft-delete hardening guards unchanged.

- [ ] **Step 11: Full verification gate**

Run: `npm run verify`
Expected: PASS — typecheck (exit 0), `lint:ci` (clean), `test` (unit incl. `tombstone.spec`), `test:e2e:cov` (all e2e pass **and** global coverage ≥ 84/62/84/84).

- [ ] **Step 12: Commit**

```bash
git add src/common/prisma/soft-delete.extension.ts src/users/users.service.ts src/ledger/accounts/accounts.service.ts src/tax/tax-codes.service.ts src/invoicing/business-partners.service.ts
git commit -m "refactor: route reference-master soft-deletes through tombstoneDelete

users/accounts/tax-codes/business-partners delegate their tombstone write
to a new tombstoneDelete model method (beside softDelete). Per-entity
existence + posted-line guards stay. Behavior-identical; e2e green.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 13: Final sanity diff**

Run: `git diff --stat main`
Expected: `tombstone.ts` + `tombstone.spec.ts` (new); `soft-delete.extension.ts` (+1 method); the four services (net reduction), plus the design spec. No schema/DTO/controller change; `softDelete` + the query-filter extension untouched.

---

## Self-Review

**1. Spec coverage**
- §4 pure helper (`tombstoneValue`) → Task 1 Step 3. ✓
- §5 `tombstoneDelete` (write-only, mirrors `softDelete`, uses `tombstoneValue`, `id`-keyed) → Task 2 Steps 2–3. ✓
- §6 caller collapse (4 services, guards retained) → Task 2 Steps 4–7. ✓
- §3 scope: existence checks + posted-line guard stay; `softDelete`/query-filter/other models/schema untouched → Global Constraints + Step 13 diff. ✓
- §8 error handling (same programmer-error throw; P2025→404 on already-deleted) → Step 3 mirrors `softDelete`; query-filter untouched. ✓
- §9 testing (pure unit + the code/email-reuse e2e net) → Task 1 Steps 1–4; Task 2 Steps 1, 10, 11. ✓
- §10 verification (two commits, `npm run verify`, sanity diff) → Task 1 Step 6; Task 2 Steps 11–13. ✓

**2. Placeholder scan:** No "TBD"/"add validation"/"similar to". Complete before/after in every code step; exact commands + expected output in every run step. ✓

**3. Type consistency:** `tombstoneValue(value: string, id: string): string` is identical between Task 1's Produces block, Step 3's definition, the Step 1 tests, and the Task 2 extension usage. `tombstoneDelete(id, field, currentValue, deletedBy?)` is identical between Task 2's Produces block, Step 3's definition, and the four call sites (Steps 4–7), which all pass `(id, '<field>', <entity>.<field>, deletedBy)`. The four services' `deletedBy` param is `string` (the methods' signature is `(id, deletedBy: string)`) — passed through unchanged. ✓

No issues found.
