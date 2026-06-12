# Production Readiness WS2 — Code Integrity & Input-Validation Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No untrusted input yields a 500, and a soft-deleted row can't be mutated/resurrected even via a raw Prisma path — with no application feature changes.

**Architecture:** Four independent tasks, filter-first: (1) map Prisma errors to typed 4xx in the global exception filter; (2) harden the soft-delete extension; (3) add validated Query DTOs (drop `as never`); (4) `ParseUUIDPipe` on `:id` params. Each is TDD'd and gated by the WS1 `verify` script; the full Phase 1–6 e2e suite is the regression net.

**Tech Stack:** NestJS 11, Prisma 7 (`@prisma/adapter-pg`), class-validator, Jest + testcontainers.

**Spec:** `docs/superpowers/specs/2026-06-12-production-readiness-ws2-code-integrity-design.md`

**Ground rules:** NOT on `main` — create branch `ws2-code-integrity` first. Docker running for e2e. `verify` = `typecheck && lint:ci && test && test:e2e:cov`. DTO/param validation failures are **400** (`ValidationPipe` → `BadRequestException` → typed envelope), distinct from the existing **422** domain-guard layer. Never run `prisma format`.

## File structure
- `src/common/filters/all-exceptions.filter.ts` — add Prisma-error branches (Task 1).
- `src/common/filters/all-exceptions.filter.spec.ts` — add Prisma unit cases (Task 1).
- `src/common/prisma/soft-delete.extension.ts` — add update/updateMany/aggregate/groupBy/upsert handlers (Task 2).
- `test/soft-delete-hardening.e2e-spec.ts` — extension integration tests (Task 2, new).
- `src/invoicing/dto/list-sales-invoices.dto.ts`, `list-purchase-bills.dto.ts`, `list-payments.dto.ts` — new (Task 3).
- `src/common/dto/as-of-query.dto.ts`, `src/ledger/journal/dto/journal-post-query.dto.ts` — new (Task 3).
- `src/invoicing/{sales-invoices,purchase-bills,payments}.{controller,service}.ts`, `src/ledger/balances/balances.controller.ts`, `src/ledger/accounts/accounts.controller.ts`, `src/ledger/journal/journal.controller.ts` — wire DTOs / drop `as never` (Task 3).
- `test/list-filter-validation.e2e-spec.ts` — new (Task 3).
- 8 controllers — `ParseUUIDPipe` on `:id` (Task 4).
- `test/uuid-param-validation.e2e-spec.ts` — new (Task 4).

---

## Task 1: Prisma-error mapping in the exception filter

**Files:** `src/common/filters/all-exceptions.filter.ts`, `src/common/filters/all-exceptions.filter.spec.ts`

- [ ] **Step 1: Create the branch**

```bash
git checkout -b ws2-code-integrity
```

- [ ] **Step 2: Write failing unit tests** — append to `src/common/filters/all-exceptions.filter.spec.ts` (it already has a `mockHost()` helper and `const filter = new AllExceptionsFilter()`). Add `import { Prisma } from '@prisma/client';` at the top, then add inside the `describe`:

```ts
  it('maps Prisma P2025 (not found) to 404 NOT_FOUND without leaking meta', () => {
    const m = mockHost();
    const err = new Prisma.PrismaClientKnownRequestError('Record to update not found.', {
      code: 'P2025',
      clientVersion: Prisma.prismaVersion.client,
      meta: { modelName: 'SalesInvoice', target: ['code'] },
    });
    filter.catch(err, m.host);
    expect(m.code()).toBe(404);
    const body = m.payload() as { code: string; message: string };
    expect(body.code).toBe('NOT_FOUND');
    expect(JSON.stringify(body)).not.toContain('SalesInvoice'); // no schema leak
    expect(JSON.stringify(body)).not.toContain('target');
  });

  it('maps Prisma P2002 (unique) to 409 CONFLICT', () => {
    const m = mockHost();
    const err = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002', clientVersion: Prisma.prismaVersion.client, meta: { target: ['code'] },
    });
    filter.catch(err, m.host);
    expect(m.code()).toBe(409);
    expect((m.payload() as { code: string }).code).toBe('CONFLICT');
  });

  it('maps Prisma P2023 (malformed UUID) to 400 INVALID_INPUT', () => {
    const m = mockHost();
    const err = new Prisma.PrismaClientKnownRequestError('Inconsistent column data', {
      code: 'P2023', clientVersion: Prisma.prismaVersion.client,
    });
    filter.catch(err, m.host);
    expect(m.code()).toBe(400);
    expect((m.payload() as { code: string }).code).toBe('INVALID_INPUT');
  });

  it('maps a PrismaClientValidationError to 400 INVALID_INPUT', () => {
    const m = mockHost();
    const err = new Prisma.PrismaClientValidationError('Invalid `prisma.x` invocation', {
      clientVersion: Prisma.prismaVersion.client,
    });
    filter.catch(err, m.host);
    expect(m.code()).toBe(400);
    expect((m.payload() as { code: string }).code).toBe('INVALID_INPUT');
  });

  it('leaves an unmapped Prisma code as 500 INTERNAL_ERROR', () => {
    const m = mockHost();
    const err = new Prisma.PrismaClientKnownRequestError('boom', {
      code: 'P2037', clientVersion: Prisma.prismaVersion.client,
    });
    filter.catch(err, m.host);
    expect(m.code()).toBe(500);
    expect((m.payload() as { code: string }).code).toBe('INTERNAL_ERROR');
  });
```

- [ ] **Step 3: Run the tests — expect FAIL**

Run: `npx jest src/common/filters/all-exceptions.filter.spec.ts`
Expected: the new cases FAIL (Prisma errors currently fall through to 500 INTERNAL_ERROR).

- [ ] **Step 4: Implement the filter branches** in `src/common/filters/all-exceptions.filter.ts`. Add `import { Prisma } from '@prisma/client';`. Add this module-level constant above the class:

```ts
const PRISMA_STATUS: Record<string, { status: number; code: string; message: string }> = {
  P2025: { status: 404, code: 'NOT_FOUND', message: 'Resource not found' },
  P2002: { status: 409, code: 'CONFLICT', message: 'Resource already exists' },
  P2003: { status: 409, code: 'CONFLICT', message: 'Operation violates a reference constraint' },
  P2023: { status: 400, code: 'INVALID_INPUT', message: 'Invalid input' },
  P2000: { status: 400, code: 'INVALID_INPUT', message: 'Invalid input' },
  P2006: { status: 400, code: 'INVALID_INPUT', message: 'Invalid input' },
};
```

Hoist the request near the top of `catch` (so the Prisma branches can log a URL):

```ts
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const req = ctx.getRequest<{ url?: string }>();
    const url = req.url ?? 'unknown';
```

Then insert these two branches **between** the `HttpException` branch and the final `else`:

```ts
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = PRISMA_STATUS[exception.code];
      if (mapped) {
        status = mapped.status;
        envelope = { code: mapped.code, message: mapped.message };
        this.logger.warn(
          `Prisma ${exception.code} -> ${status} on ${url}: ${exception.message}`,
        );
      } else {
        // Unknown Prisma code: stay 500 + INTERNAL_ERROR, but log loudly.
        this.logger.error(
          `Unmapped Prisma ${exception.code} on ${url}`,
          exception.stack,
        );
      }
    } else if (exception instanceof Prisma.PrismaClientValidationError) {
      status = 400;
      envelope = { code: 'INVALID_INPUT', message: 'Invalid input' };
      this.logger.warn(`Prisma validation error -> 400 on ${url}`);
    } else {
```

Update the existing final `else` body to use the hoisted `url` (replace the inline `ctx.getRequest()` call):

```ts
    } else {
      this.logger.error(
        `Unhandled exception on ${url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }
```

Key points: response messages are the fixed generic strings from `PRISMA_STATUS` (no `exception.meta`/`message` in the body); the full Prisma error is logged server-side only.

- [ ] **Step 5: Run the tests — expect PASS**

Run: `npx jest src/common/filters/all-exceptions.filter.spec.ts`
Expected: all cases (old + new) PASS.

- [ ] **Step 6: Regression + commit**

```bash
npm run typecheck && npm run lint:ci && npm test
git add src/common/filters/all-exceptions.filter.ts src/common/filters/all-exceptions.filter.spec.ts
git commit -m "fix(errors): map uncaught Prisma errors to typed 4xx (no schema leak)"
```

---

## Task 2: Soft-delete extension hardening

**Files:** `src/common/prisma/soft-delete.extension.ts`; Test: `test/soft-delete-hardening.e2e-spec.ts` (new)

- [ ] **Step 1: Write the failing integration test** `test/soft-delete-hardening.e2e-spec.ts` (uses the testcontainers harness; exercises the EXTENDED client directly — no Nest app needed):

```ts
import { PrismaService } from '../src/common/prisma/prisma.service';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Soft-delete extension hardening (integration)', () => {
  let db: TestDb;
  let prisma: PrismaService;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = makePrismaOverride(db.url);
    await prisma.$connect();
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await db?.stop();
  });

  const newPartner = (code: string) =>
    prisma.client.businessPartner.create({
      data: { code, name: `P-${code}`, isCustomer: true },
    });

  it('a raw update cannot mutate a soft-deleted row (P2025)', async () => {
    const p = await newPartner('SD-UPD');
    await prisma.client.businessPartner.softDelete({ id: p.id }, 'tester');
    await expect(
      prisma.client.businessPartner.update({
        where: { id: p.id },
        data: { name: 'HACKED' },
      }),
    ).rejects.toThrow(); // 0 rows match {id, deletedAt: null} -> P2025
  });

  it('updateMany skips soft-deleted rows (count 0)', async () => {
    const p = await newPartner('SD-UPDM');
    await prisma.client.businessPartner.softDelete({ id: p.id }, 'tester');
    const res = await prisma.client.businessPartner.updateMany({
      where: { id: p.id },
      data: { name: 'HACKED' },
    });
    expect(res.count).toBe(0);
  });

  it('aggregate excludes soft-deleted rows', async () => {
    const before = await prisma.client.businessPartner.aggregate({ _count: { _all: true } });
    const p = await newPartner('SD-AGG');
    const mid = await prisma.client.businessPartner.aggregate({ _count: { _all: true } });
    expect(mid._count._all).toBe(before._count._all + 1);
    await prisma.client.businessPartner.softDelete({ id: p.id }, 'tester');
    const after = await prisma.client.businessPartner.aggregate({ _count: { _all: true } });
    expect(after._count._all).toBe(before._count._all); // deleted one no longer counted
  });

  it('upsert is forbidden on a soft-delete model', async () => {
    await expect(
      prisma.client.businessPartner.upsert({
        where: { id: '00000000-0000-0000-0000-000000000000' },
        create: { code: 'SD-UPS', name: 'x', isCustomer: true },
        update: { name: 'y' },
      }),
    ).rejects.toThrow(/upsert/i);
  });

  it('a live row can still be updated normally', async () => {
    const p = await newPartner('SD-LIVE');
    const updated = await prisma.client.businessPartner.update({
      where: { id: p.id },
      data: { name: 'Renamed' },
    });
    expect(updated.name).toBe('Renamed');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npm run test:e2e -- soft-delete-hardening`
Expected: the update/updateMany/aggregate/upsert cases FAIL (the extension doesn't guard these yet — a raw update currently mutates the tombstoned row).

- [ ] **Step 3: Implement the handlers** in `src/common/prisma/soft-delete.extension.ts`, inside the `soft-delete-filter` extension's `query.$allModels` block (alongside the existing `findMany`/`count`/`delete`):

```ts
          async update({ model, args, query }) {
            if (isSoftDelete(model)) {
              args.where = { ...args.where, deletedAt: null };
            }
            return query(args);
          },
          async updateMany({ model, args, query }) {
            if (isSoftDelete(model)) {
              args.where = { ...args.where, deletedAt: null };
            }
            return query(args);
          },
          async aggregate({ model, args, query }) {
            if (isSoftDelete(model)) {
              args.where = { ...args.where, deletedAt: null };
            }
            return query(args);
          },
          async groupBy({ model, args, query }) {
            if (isSoftDelete(model)) {
              args.where = { ...args.where, deletedAt: null };
            }
            return query(args);
          },
          async upsert({ model, args, query }) {
            if (isSoftDelete(model)) {
              // Programmer-error guard: upsert vs. soft-delete is ambiguous and no
              // route uses it. A plain Error (-> 500) surfaces a stray upsert loudly.
              throw new Error(
                `upsert forbidden on ${model}; soft-deletable models must update/softDelete explicitly`,
              );
            }
            return query(args);
          },
```

Then update the `KNOWN GAP` comment block at the top to reflect the new guards:

```ts
/**
 * Models subject to soft delete. Add new soft-deletable models here as later
 * phases introduce them.
 *
 * Guarded operations: find*/count/aggregate/groupBy inject `deletedAt: null`;
 * update/updateMany inject `deletedAt: null` (a write to a tombstoned row matches
 * 0 rows -> P2025 -> 404 via the exception filter); delete/deleteMany/upsert throw
 * (hard delete and upsert are forbidden on soft-deletable models). The service
 * layer still does its own findFirst existence checks; this is defense-in-depth.
 */
```

- [ ] **Step 4: Run — expect PASS**

Run: `npm run test:e2e -- soft-delete-hardening`
Expected: all 5 cases PASS.

- [ ] **Step 5: Full regression** — the injection must not break any existing path (every service update operates on a live row).

Run: `npm run test:e2e`
Expected: full suite green (now 123 e2e tests incl. the new suite).

- [ ] **Step 6: Commit**

```bash
npm run typecheck && npm run lint:ci
git add src/common/prisma/soft-delete.extension.ts test/soft-delete-hardening.e2e-spec.ts
git commit -m "fix(prisma): guard update/updateMany/aggregate/groupBy and forbid upsert on soft-delete models"
```

---

## Task 3: Validated Query DTOs (drop `as never`)

**Files:** new DTOs + 3 invoicing controllers/services + balances/accounts/journal controllers; Test: `test/list-filter-validation.e2e-spec.ts` (new)

- [ ] **Step 1: Write the failing e2e** `test/list-filter-validation.e2e-spec.ts`. Mirror an existing invoicing e2e's bootstrap (Test module + ValidationPipe whitelist/forbidNonWhitelisted/transform + AllExceptionsFilter + makePrismaOverride; seed company/accounts/tax/periods; a VIEWER token). Assert:

```ts
  it('rejects a bad status filter with 400', () =>
    get('/sales-invoices?status=GARBAGE').expect(400));
  it('accepts a valid status filter', () =>
    get('/sales-invoices?status=POSTED').expect(200));
  it('rejects a non-uuid partnerId with 400', () =>
    get('/sales-invoices?partnerId=not-a-uuid').expect(400));
  it('rejects a bad payment direction with 400', () =>
    get('/payments?direction=GARBAGE').expect(400));
  it('rejects a bad asOf on trial-balance with 400', () =>
    get('/ledger/trial-balance?asOf=notadate').expect(400));
```

Run `npm run test:e2e -- list-filter-validation` → FAIL (bad values currently 500, valid status may 200 already).

- [ ] **Step 2: Create the invoicing list DTOs.**

`src/invoicing/dto/list-sales-invoices.dto.ts`:
```ts
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { DocumentStatus } from '@prisma/client';

export class SalesInvoiceListQueryDto {
  @IsOptional() @IsUUID() partnerId?: string;
  @IsOptional() @IsEnum(DocumentStatus) status?: DocumentStatus;
}
```

`src/invoicing/dto/list-purchase-bills.dto.ts`:
```ts
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { DocumentStatus } from '@prisma/client';

export class PurchaseBillListQueryDto {
  @IsOptional() @IsUUID() partnerId?: string;
  @IsOptional() @IsEnum(DocumentStatus) status?: DocumentStatus;
}
```

`src/invoicing/dto/list-payments.dto.ts`:
```ts
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { DocumentStatus, PaymentDirection } from '@prisma/client';

export class PaymentListQueryDto {
  @IsOptional() @IsUUID() partnerId?: string;
  @IsOptional() @IsEnum(PaymentDirection) direction?: PaymentDirection;
  @IsOptional() @IsEnum(DocumentStatus) status?: DocumentStatus;
}
```

- [ ] **Step 3: Create the shared as-of + journal-post DTOs.**

`src/common/dto/as-of-query.dto.ts`:
```ts
import { IsDateString, IsOptional } from 'class-validator';

export class AsOfQueryDto {
  @IsOptional() @IsDateString() asOf?: string;
}
```

`src/ledger/journal/dto/journal-post-query.dto.ts`:
```ts
import { IsBooleanString, IsOptional } from 'class-validator';

export class JournalPostQueryDto {
  @IsOptional() @IsBooleanString() post?: string;
}
```

- [ ] **Step 4: Wire the invoicing controllers to the DTOs.** In each of `sales-invoices.controller.ts`, `purchase-bills.controller.ts`, `payments.controller.ts`, replace the per-key `@Query('…')` params with a single DTO. Example (sales-invoices):

```ts
import { SalesInvoiceListQueryDto } from './dto/list-sales-invoices.dto';
// ...
  @Get()
  async list(@Query() q: SalesInvoiceListQueryDto) {
    const rows = await this.invoices.list(q);
    return rows.map((r) => this.invoices.present(r));
  }
```

Purchase-bills mirrors this with `PurchaseBillListQueryDto`. Payments:
```ts
import { PaymentListQueryDto } from './dto/list-payments.dto';
// ...
  @Get()
  async list(@Query() q: PaymentListQueryDto) {
    const rows = await this.payments.list(q);
    return rows.map((r) => this.payments.present(r));
  }
```

- [ ] **Step 5: Tighten the services and drop `as never`.**
  - `src/invoicing/sales-invoices.service.ts`: add `import { DocumentStatus } from '@prisma/client';`; change the `list` filter type to `{ partnerId?: string; status?: DocumentStatus }`; change the where to `where: { partnerId: filter.partnerId, status: filter.status }` (remove `as never`).
  - `src/invoicing/purchase-bills.service.ts`: same.
  - `src/invoicing/payments.service.ts`: `PaymentDirection` is already imported; add `DocumentStatus`; change the filter type to `{ partnerId?: string; direction?: PaymentDirection; status?: DocumentStatus }`; where → `direction: filter.direction, status: filter.status` (remove both `as never`).

- [ ] **Step 6: Wire balances / accounts / journal to their DTOs.**
  - `src/ledger/balances/balances.controller.ts`: `import { AsOfQueryDto } from '../../common/dto/as-of-query.dto';`; `trialBalance(@Query() q: AsOfQueryDto)` → `const date = q.asOf ? new Date(q.asOf) : new Date();`.
  - `src/ledger/accounts/accounts.controller.ts`: the `balance` handler → `balance(@Param('id') id: string, @Query() q: AsOfQueryDto)` and use `q.asOf` (keep the `@Param('id')` as-is here — Task 4 adds the pipe).
  - `src/ledger/journal/journal.controller.ts`: the create handler's `@Query('post') post` → `@Query() q: JournalPostQueryDto` and read `q.post` (keep the existing truthiness logic, e.g. `q.post === 'true'`). Confirm the existing logic still behaves (a missing flag stays falsy).

- [ ] **Step 7: Run the e2e — expect PASS**

Run: `npm run test:e2e -- list-filter-validation`
Expected: all 5 cases PASS (bad values → 400, valid status → 200).

- [ ] **Step 8: Typecheck (confirms `as never` removal compiles) + full regression**

Run: `npm run typecheck && npm run lint:ci && npm run test:e2e`
Expected: typecheck clean (the tightened types compile without `as never`); full suite green (invoicing list e2e still pass with the DTO'd controllers).

- [ ] **Step 9: Commit**

```bash
git add src/invoicing/dto src/common/dto src/ledger/journal/dto \
  src/invoicing/sales-invoices.controller.ts src/invoicing/sales-invoices.service.ts \
  src/invoicing/purchase-bills.controller.ts src/invoicing/purchase-bills.service.ts \
  src/invoicing/payments.controller.ts src/invoicing/payments.service.ts \
  src/ledger/balances/balances.controller.ts src/ledger/accounts/accounts.controller.ts \
  src/ledger/journal/journal.controller.ts test/list-filter-validation.e2e-spec.ts
git commit -m "feat(validation): validated query DTOs for list filters + as-of (drop as-never casts)"
```

---

## Task 4: `ParseUUIDPipe` on `:id` route params

**Files:** the 8 controllers listed below; Test: `test/uuid-param-validation.e2e-spec.ts` (new)

- [ ] **Step 1: Write the failing e2e** `test/uuid-param-validation.e2e-spec.ts` (same bootstrap pattern; a VIEWER or ADMIN token sufficient for GETs):

```ts
  it('rejects a malformed :id with 400', () =>
    get('/sales-invoices/not-a-uuid').expect(400));
  it('returns 404 for a well-formed but missing id', () =>
    get('/sales-invoices/00000000-0000-0000-0000-000000000000').expect(404));
  // spot-check one per controller family:
  it('accounts: malformed id -> 400', () =>
    get('/accounts/not-a-uuid').expect(400));
  it('tax-codes: malformed id -> 400', () =>
    get('/tax/codes/not-a-uuid').expect(400));
  it('payments: malformed id -> 400', () =>
    get('/payments/not-a-uuid').expect(400));
```
(Adjust each path to the real route prefix — verify against the controllers.) Run `npm run test:e2e -- uuid-param-validation` → FAIL (malformed id currently → 500 via P2023).

- [ ] **Step 2: Add `ParseUUIDPipe` to every `:id` param.** In each controller below, add `ParseUUIDPipe` to the `@nestjs/common` import and change every `@Param('id') id: string` to `@Param('id', ParseUUIDPipe) id: string`. Controllers + counts:
  - `src/ledger/journal/journal.controller.ts` (×4)
  - `src/ledger/periods/periods.controller.ts` (×2 — the `:id` params; leave the `fiscalYear` `ParseIntPipe`)
  - `src/ledger/accounts/accounts.controller.ts` (×4)
  - `src/tax/tax-codes.controller.ts` (×4)
  - `src/invoicing/business-partners.controller.ts` (×4)
  - `src/invoicing/sales-invoices.controller.ts` (×5)
  - `src/invoicing/purchase-bills.controller.ts` (×5)
  - `src/invoicing/payments.controller.ts` (×4)

  Example (one site): `async get(@Param('id', ParseUUIDPipe) id: string) { … }`. Leave `closing.controller.ts`'s `@Param('fiscalYear', ParseIntPipe)` untouched.

- [ ] **Step 3: Run the e2e — expect PASS**

Run: `npm run test:e2e -- uuid-param-validation`
Expected: malformed `:id` → 400; well-formed-missing → 404.

- [ ] **Step 4: Full regression** (existing e2e use real UUIDs from seeds, so they're unaffected).

Run: `npm run test:e2e`
Expected: full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/ledger/journal/journal.controller.ts src/ledger/periods/periods.controller.ts \
  src/ledger/accounts/accounts.controller.ts src/tax/tax-codes.controller.ts \
  src/invoicing/business-partners.controller.ts src/invoicing/sales-invoices.controller.ts \
  src/invoicing/purchase-bills.controller.ts src/invoicing/payments.controller.ts \
  test/uuid-param-validation.e2e-spec.ts
git commit -m "feat(validation): ParseUUIDPipe on :id route params (malformed id -> 400)"
```

- [ ] **Step 6: Final WS2 gate**

Run: `npm run verify`
Expected: typecheck + lint:ci + unit + e2e:cov all green (the e2e coverage floor still met or exceeded).

---

## Self-review (against the spec)

**Spec coverage:**
- §3 Prisma-error mapping (P2025/P2002/P2003/P2023/P2000/P2006 + ValidationError; generic msg, log-not-leak, unknown→500) → Task 1 ✓
- §4 soft-delete hardening (update/updateMany/aggregate/groupBy inject; upsert forbid; comment update; softDelete compat) → Task 2 ✓
- §5 query DTOs (3 invoicing list DTOs, as-of for balances/accounts, journal post flag; drop `as never`; 400) → Task 3 ✓
- §6 ParseUUIDPipe on ~31 `:id` across 8 controllers; fiscalYear left on ParseIntPipe; missing→404 → Task 4 ✓
- §7 tests (unit filter, integration extension, e2e DTO + param) → Tasks 1–4 each ✓
- §8 build sequence (filter→soft-delete→DTOs→params) → task order ✓

**Placeholder scan:** none — full code/exact paths in every step. The Task 3/4 e2e bootstraps say "mirror an existing invoicing e2e" rather than re-pasting ~40 lines of identical setup; the implementer copies the established harness (Test module + ValidationPipe + AllExceptionsFilter + makePrismaOverride + seed + token) used by every invoicing/reporting e2e — the assertions (the novel part) are spelled out in full.

**Type consistency:** `SalesInvoiceListQueryDto`/`PurchaseBillListQueryDto`/`PaymentListQueryDto`/`AsOfQueryDto`/`JournalPostQueryDto` names are used identically in their create-step and the controller-wiring step; service filter types (`status?: DocumentStatus`, `direction?: PaymentDirection`) match the DTO field types; `DocumentStatus`/`PaymentDirection` imported from `@prisma/client` in both DTOs and services; `PRISMA_STATUS` codes match the unit-test assertions (P2025→404/NOT_FOUND etc.).
