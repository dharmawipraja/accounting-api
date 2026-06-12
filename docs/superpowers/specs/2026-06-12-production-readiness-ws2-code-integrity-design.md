# Production Readiness — WS2: Code Integrity & Input-Validation Hardening — Design Spec

- **Date:** 2026-06-12
- **Status:** Approved (pending written-spec review)
- **Owner:** budi@maul.is
- **Builds on:** the feature-complete 6-phase accounting API + WS1 (quality gate, merged). No application features are added or changed.

## 1. Program context

Second of four production-readiness workstreams ([[production-readiness-program]]): **WS1 (done) → WS2 (this) → WS3 → WS4.** WS2 hardens data integrity and input handling so the existing endpoints can't be made to corrupt data or return 500s on bad input. Comprehensive/proactive scope (validate up front AND backstop at the filter), per the brainstorming decision.

## 2. Goals & non-goals

### Goals
- No untrusted input produces a 500: malformed UUIDs, bad enum filters, and uncaught Prisma errors all surface as typed 4xx via the `{code,message,details}` envelope.
- A soft-deleted (tombstoned) row cannot be mutated, resurrected, or counted — even through a raw `prisma.client` path — not only via the service-layer guards.
- No schema internals leak in error responses.

### Non-goals (out of scope)
- WS3/WS4 work; any feature change; new endpoints; auth/rate-limit changes (WS4/separate).
- Reworking the existing 422 domain-guard layer (it stays; DTO/param failures are a separate 400 layer).
- A "restore/undelete" capability (none exists; the soft-delete hardening assumes rows are never legitimately un-deleted).

## 3. Piece 1 — Prisma-error mapping in `AllExceptionsFilter`

`src/common/filters/all-exceptions.filter.ts` today maps only `DomainError` and `HttpException`; everything else (all Prisma errors) → 500. Add two branches **before** the final `else` (the 500/log path), using `import { Prisma } from '@prisma/client'`:

```ts
} else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
  const map: Record<string, { status: number; code: string; message: string }> = {
    P2025: { status: 404, code: 'NOT_FOUND',    message: 'Resource not found' },
    P2002: { status: 409, code: 'CONFLICT',     message: 'Resource already exists' },
    P2003: { status: 409, code: 'CONFLICT',     message: 'Operation violates a reference constraint' },
    P2023: { status: 400, code: 'INVALID_INPUT', message: 'Invalid input' },
    P2000: { status: 400, code: 'INVALID_INPUT', message: 'Invalid input' },
    P2006: { status: 400, code: 'INVALID_INPUT', message: 'Invalid input' },
  };
  const m = map[exception.code];
  if (m) { status = m.status; envelope = { code: m.code, message: m.message }; }
  else   { /* fall through to 500 + log below */ }
} else if (exception instanceof Prisma.PrismaClientValidationError) {
  status = 400; envelope = { code: 'INVALID_INPUT', message: 'Invalid input' };
}
```

Rules:
- **No schema leak:** the response message is a fixed generic string; the Prisma `code`/`meta` (which can name columns/constraints) goes only to the existing server-side `logger.error` (extend the log branch so Prisma errors that map to 4xx are still logged at `warn`/`debug`, and unmapped Prisma codes log at `error` and return 500).
- **Backstop only:** services map their known cases to `DomainError`s first (handled earlier in the filter), so this catches only *uncaught* Prisma errors. No existing behavior is removed (verified by the full regression suite staying green).
- Keep the unmapped/unknown path at 500 with `INTERNAL_ERROR` + full stack log (unchanged).

## 4. Piece 2 — Soft-delete extension hardening

`src/common/prisma/soft-delete.extension.ts`. In the `soft-delete-filter` `$allModels` query block, add handlers for the unguarded operations (for `isSoftDelete(model)` only; pass through otherwise):

- **`update`** and **`updateMany`**: inject `args.where = { ...args.where, deletedAt: null }`. A write targeting a tombstoned row then matches 0 rows → Prisma throws `P2025` → Piece 1 maps it to **404**. (Modern Prisma allows a non-unique field alongside the unique selector in `update.where`; the extension sets it at the args level.)
- **`aggregate`** and **`groupBy`**: inject `args.where = { ...args.where, deletedAt: null }` so soft-deleted rows are never counted/summed. (Low current usage — reporting/balances use raw SQL — but cheap future-proofing.)
- **`upsert`**: **forbid** on soft-delete models (throw a plain `Error`, exactly like the existing `delete`/`deleteMany` guards) — upsert-vs-soft-delete is ambiguous and no code uses it; a loud failure surfaces future misuse.

Compatibility:
- The `softDelete()` model method performs `update({ where, data: { deletedAt, deletedBy } })`. With injection, its `where` becomes `{ ...where, deletedAt: null }`, which correctly matches the still-live row on the first delete (and 0 rows on a double-delete → `P2025` → 404 — acceptable).
- Tombstone updates (services set `deletedAt` + rewrite a unique field in one `update`) target live rows → injection is a no-op for them.
- Every existing service `update` operates on a live row (guarded by a prior `findFirst`), so injection is a no-op for all correct paths. The 122-test e2e suite is the regression net.
- Update the `KNOWN GAP` comment block to reflect that update/updateMany/aggregate/groupBy are now guarded and upsert is forbidden.

## 5. Piece 3 — Query DTOs for list/filter + as-of inputs

Replace raw per-key `@Query('x')` strings with validated DTOs (`@Query() dto: …`); the global `ValidationPipe` (whitelist/forbidNonWhitelisted/transform) then rejects bad values with **400**. Import `DocumentStatus`, `PaymentDirection` from `@prisma/client`.

New DTOs (in each module's `dto/`):
- **`src/invoicing/dto/list-sales-invoices.dto.ts`** — `SalesInvoiceListQueryDto`: `@IsOptional @IsUUID() partnerId?: string`; `@IsOptional @IsEnum(DocumentStatus) status?: DocumentStatus`.
- **`src/invoicing/dto/list-purchase-bills.dto.ts`** — `PurchaseBillListQueryDto`: same shape.
- **`src/invoicing/dto/list-payments.dto.ts`** — `PaymentListQueryDto`: `partnerId?` UUID; `@IsOptional @IsEnum(PaymentDirection) direction?`; `@IsOptional @IsEnum(DocumentStatus) status?`.

Controller + service changes:
- `sales-invoices`, `purchase-bills`, `payments` controllers: `list(@Query() q: …ListQueryDto)` → pass `q` to the service.
- The three services' `list(filter)` types tighten (`status?: DocumentStatus`, `direction?: PaymentDirection`) and the `where` clauses **drop `as never`** (`status: filter.status` type-checks cleanly).

As-of / flag inputs:
- **`balances` trial-balance** (`@Query('asOf') asOf?`) and **`accounts/:id/balance`** (`@Query('asOf') asOf?`): introduce a small `AsOfQueryDto` (`@IsOptional @IsDateString() asOf?`) — reuse the reporting one or add a shared `src/common/dto/as-of-query.dto.ts`; controllers switch to `@Query() q`. Prevents `new Date(asOf)` receiving garbage.
- **`journal`** `@Query('post') post?` flag → `@IsOptional @IsBooleanString() post?` via a tiny DTO (minor; folded in for completeness).

Status-code note: DTO validation failures are **400** (`ValidationPipe` → `BadRequestException` → envelope `details.errors[]`). The existing **422**s are domain `ValidationFailedError`s from explicit service guards — a different layer, unchanged.

## 6. Piece 4 — `ParseUUIDPipe` on `:id` route params

Add `@Param('id', ParseUUIDPipe)` to every `:id` string param so a malformed id → **400** before reaching Postgres (instead of P2023 → 500). Sites (~31 across 8 controllers): `ledger/journal` (×4), `ledger/periods` (×2), `ledger/accounts` (×4), `tax/tax-codes` (×4), `invoicing/business-partners` (×4), `invoicing/sales-invoices` (×5), `invoicing/purchase-bills` (×5), `invoicing/payments` (×4). Leave `closing`/`periods` `fiscalYear` on `ParseIntPipe` (already validated). A valid-but-missing id still flows to the service's `findFirst` → `NotFoundDomainError` (404).

## 7. Testing strategy

TDD; WS1 `verify` gate per task; full Phase 1–6 regression must stay green.
- **Piece 1 (unit):** construct synthetic `new Prisma.PrismaClientKnownRequestError(msg,{code:'P2025',clientVersion})` (and P2002/P2023) + a `PrismaClientValidationError`, run the filter with a mocked `ArgumentsHost`, assert status 404/409/400 + envelope `code`/generic message + that the response body contains no Prisma `meta`/column names.
- **Piece 2 (integration, extended client):** soft-delete a row (e.g. an Account/BusinessPartner) via `softDelete()`, then: a raw `prisma.client.<model>.update({where:{id}, …})` does NOT mutate it (throws P2025 / 0 effect); `updateMany` skips it; `aggregate`/`groupBy` exclude it; `upsert` throws. Confirm a normal update of a LIVE row still works.
- **Piece 3 (e2e):** `GET /sales-invoices?status=GARBAGE`→400; `?status=POSTED`→200 (filtered); `?partnerId=not-a-uuid`→400; `GET /payments?direction=GARBAGE`→400; `GET /balances/trial-balance?asOf=notadate`→400.
- **Piece 4 (e2e):** `GET /sales-invoices/not-a-uuid`→400; `GET /sales-invoices/<valid-uuid-not-present>`→404; spot-check one param per controller family.

## 8. Build sequence (for the plan)

1. **Filter Prisma mapping** (Piece 1) — the backstop, first, so Pieces 2–4 land on it. Unit tests.
2. **Soft-delete hardening** (Piece 2) — integration tests; relies on Piece 1 for the 404.
3. **Query DTOs** (Piece 3) — invoicing list DTOs + as-of/flag DTOs; drop `as never`. e2e.
4. **UUID params** (Piece 4) — `ParseUUIDPipe` sweep. e2e.

## 9. Notes / future
- The filter's Prisma mapping is deliberately conservative (only well-understood codes); unknown Prisma codes stay 500 + logged so they're visible, not silently masked.
- WS3 (runtime/deploy) and WS4 (observability/perf) remain separate specs.
