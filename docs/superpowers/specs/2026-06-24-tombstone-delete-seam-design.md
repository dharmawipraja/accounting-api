# A tombstone-delete seam for reference masters

**Date:** 2026-06-24
**Status:** Approved (design) — ready for implementation plan
**Origin:** Architecture review round-2 candidate #3 ("A tombstone-delete seam for reference masters").

## Vocabulary

Architecture terms per the `improve-codebase-architecture` skill: **module, interface, implementation,
depth, deep/shallow, seam, adapter, leverage, locality.** Domain terms per `docs/runbooks/domain-glossary.md`.

---

## 1. Problem

Four reference-master services soft-delete by **tombstoning** a unique field — suffixing it with
`#deleted-${id}` so the value can be reused — and setting `deletedAt`/`deletedBy`. The mechanic is
hand-rolled identically in each, differing only by model and which unique column is freed:

| Service | Model | Unique field |
| --- | --- | --- |
| `users.service.softDelete` | `User` | `email` |
| `accounts.service.softDelete` | `Account` | `code` |
| `tax-codes.service.softDelete` | `TaxCode` | `code` |
| `business-partners.service.softDelete` | `BusinessPartner` | `code` |

Each runs:
```ts
update({ where: { id }, data: { [field]: `${value}#deleted-${id}`, deletedAt: new Date(), deletedBy } });
```
(All four fields are `@@unique`, so the suffix is what frees the value for reuse.)

The soft-delete extension (`src/common/prisma/soft-delete.extension.ts`) **already** exposes a `softDelete`
model method (in its `soft-delete-methods` `$extends`) — but it only sets `deletedAt`/`deletedBy`, so these
four bypass it and hand-roll the tombstone `update`. The tombstone format + the soft-delete write live in
four places that must stay in lockstep.

## 2. Goal

Add a `tombstoneDelete` model method beside `softDelete` (the established seam) so the tombstone format and
the soft-delete write live **once**; the four services collapse onto it. **Locality:** the `#deleted-${id}`
format has one home. **Leverage:** a future tombstoning reference master is one call.

## 3. Scope

**In scope**
- New pure `src/common/prisma/tombstone.ts`: `tombstoneValue(value, id)` → `` `${value}#deleted-${id}` ``.
- New `tombstoneDelete` model method in `soft-delete.extension.ts`'s `soft-delete-methods` `$extends`
  (write-only, uses `tombstoneValue`).
- Route the four `softDelete` methods onto it.
- Unit test for `tombstoneValue`.

**Out of scope (explicitly)**
- The four services keep their existence checks (`findFirst`/`findById`) and accounts' POSTED/REVERSED-line
  guard — per-entity domain logic, NOT moved.
- The existing `softDelete` method, the query-filter `$extends` (the `deletedAt: null` injection + hard-
  delete/upsert guards), and every other model are untouched.
- No schema change (`deletedAt`/`deletedBy` and the unique fields already exist).

## 4. The pure helper

`src/common/prisma/tombstone.ts`:

```ts
/** Suffix a unique value so it is freed for reuse while the row is soft-deleted. */
export function tombstoneValue(value: string, id: string): string {
  return `${value}#deleted-${id}`;
}
```

## 5. The seam — `tombstoneDelete`

Added beside `softDelete` in the `soft-delete-methods` `$extends` (`soft-delete.extension.ts`):

```ts
async tombstoneDelete<T>(
  this: T,
  id: string,
  field: string,          // the unique column to free: 'code' | 'email' (constant, never user input)
  currentValue: string,   // the live value the caller already fetched
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
}
```

Mirrors `softDelete` exactly — same `isSoftDelete(ctx.$name)` guard, same `typedCtx` cast, same `update`
shape — adding only the `[field]` computed key and the `tombstoneValue` suffix. It takes `id` (not a general
`where`) because the suffix inherently needs the id and all four callers key by `{ id }`. **Write-only**
(the caller passes the live value it already fetched), matching `softDelete`'s contract — no extra read. The
query-filter `update` injects `deletedAt: null`, so a write to an already-tombstoned row matches 0 rows →
P2025 → 404, exactly as today.

## 6. Caller collapse

Each keeps its fetch + per-entity guards; only the tombstone write changes:

```ts
// users.service.softDelete — after the findFirst + NotFoundDomainError:
await this.prisma.client.user.tombstoneDelete(id, 'email', user.email, deletedBy);

// accounts.service.softDelete — after findById + the POSTED/REVERSED-line guard:
await this.prisma.client.account.tombstoneDelete(id, 'code', account.code, deletedBy);

// tax-codes.service.softDelete — after findById:
await this.prisma.client.taxCode.tombstoneDelete(id, 'code', taxCode.code, deletedBy);

// business-partners.service.softDelete — after findById:
await this.prisma.client.businessPartner.tombstoneDelete(id, 'code', p.code, deletedBy);
```

## 7. Data flow

Unchanged. The same suffixed value, `deletedAt`, `deletedBy`, and `{ id }` where reach the same `update`;
only the *owner* of the tombstone format + the soft-delete write moves from four services into one seam.

## 8. Error handling

None introduced. `tombstoneDelete` throws the same programmer-error `Error` `softDelete` throws if called on
a non-soft-delete model. A write to an already-deleted row is a P2025 → 404 (the existing filter), unchanged.
The services' own existence checks/guards (NotFound, posted-line 422) are untouched.

## 9. Testing

- **New `src/common/prisma/tombstone.spec.ts`** (pure, DB-free): `tombstoneValue('AR-1000', 'abc')` →
  `'AR-1000#deleted-abc'`; idempotent format for representative code/email values.
- **Existing e2e are the integration net** (behavior identical — `tombstoneDelete` wiring is e2e-covered, as
  `softDelete` is): `accounts`, `business-partners`, `tax-codes`, `users` (each: delete → re-fetch 404 →
  **code/email reuse** succeeds), plus `soft-delete` and `soft-delete-hardening`. A wrong field/where/suffix
  fails these.

## 10. Verification & migration

- Branch `feat/tombstone-delete-seam` off `main`. Two commits: (1) `tombstone.ts` + `tombstone.spec.ts`;
  (2) `tombstoneDelete` + route the four callers.
- Gate: `npm run verify` — typecheck (exit 0), `lint:ci` (clean), `test` (unit incl. the new spec),
  `test:e2e:cov` (all e2e pass **and** global coverage ≥ 84/62/84/84).
- Sanity diff vs `main`: `tombstone.ts` + `tombstone.spec.ts` (new); `soft-delete.extension.ts` (+1 method);
  the four services (net reduction), plus this spec. No schema/DTO/controller change; `softDelete` + the
  query-filter extension untouched.

## 11. Risks

- **Low** — the tombstone write is behavior-identical (same suffixed value, `deletedAt`/`deletedBy`, `{ id }`
  where), only relocated behind a method that mirrors the existing `softDelete`.
- **Injection safety / typing.** `field` is a constant identifier (`'code'`/`'email'`) from the caller, never
  user input; the computed `[field]` key matches the extension's existing loose `$allModels` typing (same as
  `softDelete`'s `where: Record<string, unknown>`). Per-model field-name type-checking is not statically
  enforced (unchanged from today) — the e2e net + the literal call sites cover it.
- **Smallest-possible diff:** one pure helper + one method mirroring `softDelete` + four one-line call-site
  collapses.
