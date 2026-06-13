# v1 Versioning, Generalized Idempotency & List Pagination — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the best-practice polish — URI versioning (`/v1` hard cutover, version-neutral probes), a generic `Idempotency-Key` interceptor (required key + body-hash guard) across all create + money-moving endpoints, and offset pagination on the six unbounded lists — plus regenerated `openapi.json` and updated guides.

**Architecture:** Versioning via NestJS `enableVersioning({ type: URI, defaultVersion: '1' })` with `@Version(VERSION_NEUTRAL)` on health/metrics. Idempotency via a global `IdempotencyInterceptor` + injectable `IdempotencyService` (reserve-first, JSON response snapshot) toggled by an `@Idempotent()` decorator; the journal-specific mechanism is deleted and journals move onto it. Pagination via a shared `PaginationQueryDto` and per-resource `*ListResponseDto` envelopes `{ data, total, limit, offset }`, exposed through a new `listPage()` service method (the existing unbounded `list()` is retained only where internal callers need a full fetch).

**Tech Stack:** NestJS 11, Prisma 7 (`@prisma/adapter-pg`), PostgreSQL, Jest 30 + ts-jest, supertest, `@testcontainers/postgresql`, `@nestjs/swagger` 11.

**Branch:** `feat/v1-versioning-idempotency-pagination` (already created; spec committed at `fa04ff6`).

**Spec of record:** `docs/superpowers/specs/2026-06-13-v1-versioning-idempotency-pagination-design.md`

---

## File Structure

**New files**
- `src/common/dto/pagination-query.dto.ts` — shared `limit`/`offset` query DTO.
- `src/common/idempotency/idempotent.decorator.ts` — `@Idempotent()` metadata marker.
- `src/common/idempotency/idempotency.service.ts` — reserve/complete/release + replay validation.
- `src/common/idempotency/idempotency.service.spec.ts` — unit tests for the service.
- `src/common/idempotency/idempotency.interceptor.ts` — global interceptor wiring the service.
- `src/common/idempotency/idempotency.module.ts` — registers the interceptor as `APP_INTERCEPTOR`.
- `prisma/migrations/20260613000000_generalize_idempotency_keys/migration.sql` — schema change.
- `test/idempotency.e2e-spec.ts` — end-to-end idempotency behaviour.
- `test/pagination.e2e-spec.ts` — end-to-end pagination envelope behaviour.

**Modified files**
- `src/main.ts` — enable URI versioning.
- `src/health/health.controller.ts`, `src/metrics/metrics.controller.ts` — `@Version(VERSION_NEUTRAL)`.
- `prisma/schema.prisma` — generalize `IdempotencyKey`.
- `src/app.module.ts` — import `IdempotencyModule`.
- `src/ledger/journal/journal.service.ts` — delete `runIdempotent`/`reserveIdempotent`, drop `idempotencyKey` params.
- `src/ledger/journal/journal.controller.ts`, `src/ledger/journal/opening-balances.controller.ts` — `@Idempotent()`, drop `@Headers`.
- `src/ledger/accounts/accounts.controller.ts` + `accounts.service.ts` (+ `dto/account-response.dto.ts`).
- `src/tax/tax-codes.controller.ts` + `tax-codes.service.ts` (+ `dto/tax-code-response.dto.ts`).
- `src/invoicing/business-partners.controller.ts` + `business-partners.service.ts` (+ `dto/business-partner-response.dto.ts`).
- `src/invoicing/sales-invoices.controller.ts` + `sales-invoices.service.ts` (+ `dto/sales-invoice-response.dto.ts`, `dto/list-sales-invoices.dto.ts`).
- `src/invoicing/purchase-bills.controller.ts` + `purchase-bills.service.ts` (+ `dto/purchase-bill-response.dto.ts`, `dto/list-purchase-bills.dto.ts`).
- `src/invoicing/payments.controller.ts` + `payments.service.ts` (+ `dto/payment-response.dto.ts`, `dto/list-payments.dto.ts`).
- `src/ledger/periods/periods.controller.ts` — `@Idempotent()` on `generate`.
- `src/close/closing.controller.ts` — `@Idempotent()` on year-end `run`.
- `src/ledger/journal/dto/list-journal-entries.dto.ts` — extend `PaginationQueryDto`.
- `docs/api/openapi.json`, `docs/api/frontend-guide.md`, `docs/api/frontend-agent-brief.md`, `README.md`, `CHANGELOG.md`.
- All `test/*.e2e-spec.ts` — `/v1` paths, required keys, envelope assertions.

---

## PART A — API VERSIONING

### Task 1: Enable URI versioning with version-neutral probes

**Files:**
- Modify: `src/main.ts`
- Modify: `src/health/health.controller.ts`
- Modify: `src/metrics/metrics.controller.ts`
- Create (temp): `scripts/codemod-v1-paths.cjs`
- Test: `test/versioning.e2e-spec.ts` (new)

- [ ] **Step 1: Write the failing versioning e2e test**

Create `test/versioning.e2e-spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('API versioning (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  const server = () => app.getHttpServer() as App;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = makePrismaOverride(db.url);
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  it('serves business routes under /v1 and 404s the unprefixed path', async () => {
    await request(server()).get('/v1/ledger/accounts').expect(401); // auth required, but route exists
    await request(server()).get('/ledger/accounts').expect(404);
  });

  it('keeps health and metrics version-neutral', async () => {
    await request(server()).get('/health').expect(200);
    await request(server()).get('/ready').expect(200);
    await request(server()).get('/v1/health').expect(404);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test:e2e -- versioning`
Expected: FAIL — without versioning enabled in `AppModule`/`main`, `/ledger/accounts` returns 401 (not 404) and `/v1/...` 404s. (The test enables versioning on its own app instance, so the **probe** assertions should pass but the design requires the real bootstrap to match; the failing signal here is primarily that the rest of the suite still uses unprefixed paths — see Step 6.)

- [ ] **Step 3: Enable versioning in `src/main.ts`**

In `src/main.ts`, update the imports and add the call right after `app.enableShutdownHooks();` (line ~38). Change the import on line 2:

```typescript
import { ValidationPipe, VersioningType } from '@nestjs/common';
```

Add after `app.enableShutdownHooks();`:

```typescript
  // URI versioning — every business route is served under /v1 (hard cutover).
  // Operational probes (/health, /ready, /metrics) opt out via @Version(VERSION_NEUTRAL).
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
```

- [ ] **Step 4: Make health + metrics version-neutral**

In `src/health/health.controller.ts`, add `Version, VERSION_NEUTRAL` to the `@nestjs/common` import and annotate the class. The decorator goes directly above `export class HealthController`:

```typescript
import { Controller, Get, Version, VERSION_NEUTRAL } from '@nestjs/common';
// ...existing imports...

@ApiTags('Health')
@Version(VERSION_NEUTRAL)
@Controller()
export class HealthController {
```

(Keep the existing `@ApiTags`/other decorators; only add `@Version(VERSION_NEUTRAL)`. If `@nestjs/common` is already imported with other names, just add `Version, VERSION_NEUTRAL` to that import list.)

In `src/metrics/metrics.controller.ts`, do the same:

```typescript
import { Controller, Get, Version, VERSION_NEUTRAL } from '@nestjs/common';
// ...existing imports...

@Version(VERSION_NEUTRAL)
@Controller('metrics')
export class MetricsController {
```

- [ ] **Step 5: Write the path codemod script**

Create `scripts/codemod-v1-paths.cjs`:

```javascript
// One-shot codemod: prefix supertest request paths with /v1, EXCEPT the
// version-neutral probes (/health, /ready, /metrics) and already-prefixed /v1.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'test');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.e2e-spec.ts'));
// Matches `.get('/`, `.post("/`, `.delete(\`/` etc. and consumes the leading slash.
const re =
  /(\.(?:get|post|put|patch|delete)\()(['"`])\/(?!v1\/|health\b|ready\b|metrics\b)/g;

for (const f of files) {
  const p = path.join(dir, f);
  const src = fs.readFileSync(p, 'utf8');
  const out = src.replace(re, (_m, call, q) => `${call}${q}/v1/`);
  if (out !== src) {
    fs.writeFileSync(p, out);
    console.log('updated', f);
  }
}
```

- [ ] **Step 6: Run the codemod**

Run: `node scripts/codemod-v1-paths.cjs`
Expected: prints `updated <file>` for each e2e spec that contains business-route requests.

- [ ] **Step 7: Run the full e2e suite and fix stragglers**

Run: `npm run test:e2e`
Expected: PASS. If any spec still 404s, it built a path some other way (e.g. string concatenation) — find it and add the `/v1` prefix manually. Re-run until green.

- [ ] **Step 8: Remove the codemod script**

Run: `rm scripts/codemod-v1-paths.cjs`

- [ ] **Step 9: Typecheck + lint**

Run: `npm run typecheck && npm run lint:ci`
Expected: both exit 0.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(api): URI versioning with /v1 hard cutover, neutral probes"
```

---

## PART B — IDEMPOTENCY

### Task 2: Generalize the `idempotency_keys` schema

**Files:**
- Modify: `prisma/schema.prisma:215-222`
- Create: `prisma/migrations/20260613000000_generalize_idempotency_keys/migration.sql`

- [ ] **Step 1: Update the Prisma model**

Replace the `IdempotencyKey` model in `prisma/schema.prisma` (lines 215-222) with:

```prisma
model IdempotencyKey {
  key         String    @id
  method      String
  path        String
  requestHash String    @map("request_hash")
  response    Json?
  httpStatus  Int?      @map("http_status")
  createdAt   DateTime  @default(now()) @map("created_at")
  completedAt DateTime? @map("completed_at")

  @@map("idempotency_keys")
}
```

- [ ] **Step 2: Hand-author the migration**

Create `prisma/migrations/20260613000000_generalize_idempotency_keys/migration.sql`:

```sql
-- Generalize idempotency_keys from the journal-specific shape (endpoint,
-- result_entry_id) to an entity-agnostic response snapshot. Idempotency rows are
-- transient; clearing them on migrate is safe and lets us add NOT NULL columns.
DELETE FROM "idempotency_keys";

ALTER TABLE "idempotency_keys" DROP COLUMN "endpoint";
ALTER TABLE "idempotency_keys" DROP COLUMN "result_entry_id";

ALTER TABLE "idempotency_keys" ADD COLUMN "method" TEXT NOT NULL;
ALTER TABLE "idempotency_keys" ADD COLUMN "path" TEXT NOT NULL;
ALTER TABLE "idempotency_keys" ADD COLUMN "request_hash" TEXT NOT NULL;
ALTER TABLE "idempotency_keys" ADD COLUMN "response" JSONB;
ALTER TABLE "idempotency_keys" ADD COLUMN "http_status" INTEGER;
ALTER TABLE "idempotency_keys" ADD COLUMN "completed_at" TIMESTAMP(3);
```

(Confirm `20260613000000` sorts after the latest existing migration `20260611070000_add_close_and_audit`. It does. If a later migration has appeared, bump the timestamp.)

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npm run db:generate`
Expected: `Generated Prisma Client` with no errors; the `IdempotencyKey` type now has `method`/`path`/`requestHash`/`response`/`httpStatus`.

- [ ] **Step 4: Typecheck — expect the OLD journal code to break**

Run: `npm run typecheck`
Expected: FAIL in `src/ledger/journal/journal.service.ts` — `resultEntryId`/`endpoint` no longer exist. This is expected; Task 5 removes that code. Proceed.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260613000000_generalize_idempotency_keys
git commit -m "feat(idempotency): generalize idempotency_keys schema + migration"
```

### Task 3: The `@Idempotent()` decorator

**Files:**
- Create: `src/common/idempotency/idempotent.decorator.ts`

- [ ] **Step 1: Write the decorator**

Create `src/common/idempotency/idempotent.decorator.ts`:

```typescript
import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'idempotent';

/**
 * Marks a write handler as requiring an `Idempotency-Key` header. The global
 * IdempotencyInterceptor reserves the key, runs the handler once, and replays the
 * stored response on retries. See common/idempotency/idempotency.interceptor.ts.
 */
export const Idempotent = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IDEMPOTENT_KEY, true);
```

- [ ] **Step 2: Commit**

```bash
git add src/common/idempotency/idempotent.decorator.ts
git commit -m "feat(idempotency): add @Idempotent decorator"
```

### Task 4: `IdempotencyService` (reserve/complete/release) with unit tests

**Files:**
- Create: `src/common/idempotency/idempotency.service.ts`
- Test: `src/common/idempotency/idempotency.service.spec.ts`

- [ ] **Step 1: Write the failing unit test**

Create `src/common/idempotency/idempotency.service.spec.ts`:

```typescript
import { Prisma } from '@prisma/client';
import { IdempotencyService } from './idempotency.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ConflictDomainError,
  ValidationFailedError,
} from '../errors/domain-errors';

const P2002 = new Prisma.PrismaClientKnownRequestError('dup', {
  code: 'P2002',
  clientVersion: 'test',
});

function makeService() {
  const idempotencyKey = {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const prisma = { client: { idempotencyKey } } as unknown as PrismaService;
  return { service: new IdempotencyService(prisma), idempotencyKey };
}

describe('IdempotencyService', () => {
  it('reserves a fresh key (replay:false)', async () => {
    const { service, idempotencyKey } = makeService();
    idempotencyKey.create.mockResolvedValue({});
    await expect(
      service.reserve('k', 'POST', '/v1/partners', 'h'),
    ).resolves.toEqual({ replay: false });
  });

  it('replays a completed key with its stored response + status', async () => {
    const { service, idempotencyKey } = makeService();
    idempotencyKey.create.mockRejectedValue(P2002);
    idempotencyKey.findUnique.mockResolvedValue({
      key: 'k',
      method: 'POST',
      path: '/v1/partners',
      requestHash: 'h',
      response: { id: 'abc' },
      httpStatus: 201,
    });
    await expect(
      service.reserve('k', 'POST', '/v1/partners', 'h'),
    ).resolves.toEqual({ replay: true, response: { id: 'abc' }, httpStatus: 201 });
  });

  it('rejects the same key on a different endpoint (422)', async () => {
    const { service, idempotencyKey } = makeService();
    idempotencyKey.create.mockRejectedValue(P2002);
    idempotencyKey.findUnique.mockResolvedValue({
      method: 'POST',
      path: '/v1/tax/codes',
      requestHash: 'h',
      response: { id: 'x' },
      httpStatus: 201,
    });
    await expect(
      service.reserve('k', 'POST', '/v1/partners', 'h'),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('rejects the same key with a different body hash (422)', async () => {
    const { service, idempotencyKey } = makeService();
    idempotencyKey.create.mockRejectedValue(P2002);
    idempotencyKey.findUnique.mockResolvedValue({
      method: 'POST',
      path: '/v1/partners',
      requestHash: 'OTHER',
      response: { id: 'x' },
      httpStatus: 201,
    });
    await expect(
      service.reserve('k', 'POST', '/v1/partners', 'h'),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('reports an in-progress key (no response yet) as 409', async () => {
    const { service, idempotencyKey } = makeService();
    idempotencyKey.create.mockRejectedValue(P2002);
    idempotencyKey.findUnique.mockResolvedValue({
      method: 'POST',
      path: '/v1/partners',
      requestHash: 'h',
      response: null,
      httpStatus: null,
    });
    await expect(
      service.reserve('k', 'POST', '/v1/partners', 'h'),
    ).rejects.toBeInstanceOf(ConflictDomainError);
  });

  it('treats a vanished reservation row as 409', async () => {
    const { service, idempotencyKey } = makeService();
    idempotencyKey.create.mockRejectedValue(P2002);
    idempotencyKey.findUnique.mockResolvedValue(null);
    await expect(
      service.reserve('k', 'POST', '/v1/partners', 'h'),
    ).rejects.toBeInstanceOf(ConflictDomainError);
  });

  it('complete() stores a JSON snapshot + status', async () => {
    const { service, idempotencyKey } = makeService();
    idempotencyKey.update.mockResolvedValue({});
    await service.complete('k', { id: 'abc', when: new Date('2026-01-01') }, 201);
    expect(idempotencyKey.update).toHaveBeenCalledWith({
      where: { key: 'k' },
      data: expect.objectContaining({
        response: { id: 'abc', when: '2026-01-01T00:00:00.000Z' },
        httpStatus: 201,
      }),
    });
  });

  it('release() deletes and swallows errors', async () => {
    const { service, idempotencyKey } = makeService();
    idempotencyKey.delete.mockRejectedValue(new Error('gone'));
    await expect(service.release('k')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- idempotency.service`
Expected: FAIL — `Cannot find module './idempotency.service'`.

- [ ] **Step 3: Implement the service**

Create `src/common/idempotency/idempotency.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ConflictDomainError,
  ValidationFailedError,
} from '../errors/domain-errors';

export type ReserveResult =
  | { replay: false }
  | { replay: true; response: unknown; httpStatus: number };

/**
 * Reserve-first idempotency: a fresh key inserts a reservation row (response
 * null = in flight); a repeated key replays the stored response, 422s on
 * endpoint/body mismatch, or 409s while still in flight. complete() stores a
 * JSON snapshot of the response; release() drops a reservation after a failure
 * so a retry can re-attempt (failures are never cached).
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async reserve(
    key: string,
    method: string,
    path: string,
    requestHash: string,
  ): Promise<ReserveResult> {
    try {
      await this.prisma.client.idempotencyKey.create({
        data: { key, method, path, requestHash },
      });
      return { replay: false };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return this.resolveExisting(key, method, path, requestHash);
      }
      throw err;
    }
  }

  private async resolveExisting(
    key: string,
    method: string,
    path: string,
    requestHash: string,
  ): Promise<ReserveResult> {
    const record = await this.prisma.client.idempotencyKey.findUnique({
      where: { key },
    });
    if (!record) {
      // The owner errored and released the row between our create and read.
      throw new ConflictDomainError(
        'A request with this idempotency key is in progress',
        { key },
      );
    }
    if (record.method !== method || record.path !== path) {
      throw new ValidationFailedError(
        'Idempotency-Key already used for a different endpoint',
        { key },
      );
    }
    if (record.requestHash !== requestHash) {
      throw new ValidationFailedError(
        'Idempotency-Key already used with a different request body',
        { key },
      );
    }
    if (record.response === null || record.httpStatus === null) {
      throw new ConflictDomainError(
        'A request with this idempotency key is in progress',
        { key },
      );
    }
    return {
      replay: true,
      response: record.response,
      httpStatus: record.httpStatus,
    };
  }

  async complete(
    key: string,
    response: unknown,
    httpStatus: number,
  ): Promise<void> {
    await this.prisma.client.idempotencyKey.update({
      where: { key },
      data: {
        // Round-trip to a pure JSON value so Dates serialize exactly as the HTTP
        // response would, and Prisma accepts it as Json.
        response: JSON.parse(
          JSON.stringify(response ?? null),
        ) as Prisma.InputJsonValue,
        httpStatus,
        completedAt: new Date(),
      },
    });
  }

  async release(key: string): Promise<void> {
    await this.prisma.client.idempotencyKey
      .delete({ where: { key } })
      .catch(() => undefined);
  }
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `npm test -- idempotency.service`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/common/idempotency/idempotency.service.ts src/common/idempotency/idempotency.service.spec.ts
git commit -m "feat(idempotency): IdempotencyService with reserve/complete/release"
```

### Task 5: Interceptor + module, and refactor journals onto it

**Files:**
- Create: `src/common/idempotency/idempotency.interceptor.ts`
- Create: `src/common/idempotency/idempotency.module.ts`
- Modify: `src/app.module.ts`
- Modify: `src/ledger/journal/journal.service.ts`
- Modify: `src/ledger/journal/journal.controller.ts`
- Modify: `src/ledger/journal/opening-balances.controller.ts`

- [ ] **Step 1: Write the interceptor**

Create `src/common/idempotency/idempotency.interceptor.ts`:

```typescript
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Observable, from, of } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { createHash } from 'crypto';
import { IDEMPOTENT_KEY } from './idempotent.decorator';
import { IdempotencyService } from './idempotency.service';
import { ValidationFailedError } from '../errors/domain-errors';

interface IdempotentRequest {
  method: string;
  originalUrl?: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly idempotency: IdempotencyService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const enabled = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!enabled) return next.handle();

    const req = ctx.switchToHttp().getRequest<IdempotentRequest>();
    const res = ctx.switchToHttp().getResponse<{ statusCode: number }>();
    const header = req.headers['idempotency-key'];
    const key = Array.isArray(header) ? header[0] : header;
    if (!key) {
      throw new ValidationFailedError('Idempotency-Key header is required');
    }
    const method = req.method;
    const path = req.originalUrl ?? req.url;
    const requestHash = createHash('sha256')
      .update(JSON.stringify(req.body ?? null))
      .digest('hex');
    // Resolve the status the handler would emit so a replay reproduces it.
    const declared = this.reflector.get<number | undefined>(
      HTTP_CODE_METADATA,
      ctx.getHandler(),
    );
    const httpStatus = declared ?? (method === 'POST' ? 201 : 200);

    return from(this.idempotency.reserve(key, method, path, requestHash)).pipe(
      switchMap((reserved) => {
        if (reserved.replay) {
          res.statusCode = reserved.httpStatus;
          return of(reserved.response);
        }
        return next.handle().pipe(
          switchMap((data) =>
            from(this.idempotency.complete(key, data, httpStatus)).pipe(
              switchMap(() => of(data)),
            ),
          ),
          catchError((err: unknown) =>
            from(this.idempotency.release(key)).pipe(
              switchMap(() => {
                throw err;
              }),
            ),
          ),
        );
      }),
    );
  }
}
```

- [ ] **Step 2: Write the module**

Create `src/common/idempotency/idempotency.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyService } from './idempotency.service';
import { IdempotencyInterceptor } from './idempotency.interceptor';

// PrismaModule is @Global, so IdempotencyService resolves PrismaService here.
@Module({
  providers: [
    IdempotencyService,
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class IdempotencyModule {}
```

- [ ] **Step 3: Register the module in AppModule**

In `src/app.module.ts`, add the import near the other module imports:

```typescript
import { IdempotencyModule } from './common/idempotency/idempotency.module';
```

Add `IdempotencyModule` to the **end** of the `imports:` array (after `MetricsModule`):

```typescript
    AuditModule,
    MetricsModule,
    IdempotencyModule,
  ],
```

Position matters: global `APP_INTERCEPTOR`s execute outermost-first in module-import order. Importing `IdempotencyModule` last makes it the **innermost** interceptor, so `AuditInterceptor` and `MetricsInterceptor` (registered by earlier modules) still wrap it — every attempt, including a replay or a missing-key `422`, is audited and metered. The idempotency interceptor's `next.handle()` is then the route handler itself, which a replay correctly short-circuits.

- [ ] **Step 4: Strip the bespoke idempotency from `JournalService`**

In `src/ledger/journal/journal.service.ts`:

1. Delete the entire `runIdempotent` and `reserveIdempotent` block (lines ~259-324, the section under `// ---- idempotency ... ----`).
2. Remove the now-unused imports `ConflictDomainError` and `Prisma` **only if** they are not referenced elsewhere in the file (search first; `Prisma` is often used for types — keep it if so).
3. Change the four public methods to drop the `idempotencyKey` parameter and the `runIdempotent` wrapper. Replace each as follows:

```typescript
  async postDraft(id: string, postedBy: string): Promise<JournalEntry> {
    return this.posting.postDraft(id, postedBy);
  }

  async reverse(id: string, reversedBy: string): Promise<JournalEntry> {
    return this.posting.reverse(id, reversedBy);
  }

  async createAndPost(
    input: DraftInput,
    postedBy: string,
  ): Promise<JournalEntry> {
    return this.posting.post(
      {
        date: input.date,
        description: input.description,
        sourceType: 'MANUAL',
        createdBy: input.createdBy,
        lines: input.lines,
      },
      postedBy,
    );
  }
```

For `postOpeningBalances`, drop the `idempotencyKey` param and unwrap the `runIdempotent(... , 'openingBalances', async () => { <BODY> })` so the method body runs directly. Keep `<BODY>` exactly as-is; only remove the wrapper and the param:

```typescript
  async postOpeningBalances(
    date: Date,
    balances: PostLineInput[],
    postedBy: string,
  ): Promise<JournalEntry> {
    // <the existing async-callback body, verbatim, with its final `return`>
  }
```

- [ ] **Step 5: Add `@Idempotent()` to the journal controller; drop the header plumbing**

In `src/ledger/journal/journal.controller.ts`:

1. Remove `Headers` from the `@nestjs/common` import.
2. Add the import: `import { Idempotent } from '../../common/idempotency/idempotent.decorator';`
3. For the three POST handlers, add `@Idempotent()` and remove the `@Headers('idempotency-key') idempotencyKey?: string` parameter and the argument passed to the service. Resulting handlers:

```typescript
  @ApiCreatedResponse({ type: JournalEntryResponseDto })
  @Roles(Role.ACCOUNTANT, Role.APPROVER, Role.ADMIN)
  @Idempotent()
  @Post()
  async createOrPost(
    @Body() dto: CreateJournalEntryDto,
    @Query() q: JournalPostQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<JournalEntry> {
    const input = {
      date: new Date(dto.date),
      description: dto.description,
      lines: dto.lines,
      createdBy: user.id,
    };
    if (q.post === 'true') {
      if (user.role === Role.ACCOUNTANT) {
        throw new ForbiddenDomainError('Posting requires an Approver or Admin', {
          role: user.role,
        });
      }
      return this.journal.createAndPost(input, user.id);
    }
    return this.journal.createDraft(input);
  }

  @ApiOkResponse({ type: JournalEntryResponseDto })
  @Roles(Role.APPROVER, Role.ADMIN)
  @Idempotent()
  @Post(':id/post')
  @HttpCode(200)
  post(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<JournalEntry> {
    return this.journal.postDraft(id, user.id);
  }

  @ApiOkResponse({ type: JournalEntryResponseDto })
  @Roles(Role.APPROVER, Role.ADMIN)
  @Idempotent()
  @Post(':id/reverse')
  @HttpCode(200)
  reverse(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<JournalEntry> {
    return this.journal.reverse(id, user.id);
  }
```

(Leave the `@Get` handlers and `@Delete` handler untouched.)

- [ ] **Step 6: Same for opening-balances**

In `src/ledger/journal/opening-balances.controller.ts`: remove `Headers` from the import, add `import { Idempotent } from '../../common/idempotency/idempotent.decorator';`, and update the handler:

```typescript
  @ApiOkResponse({ type: JournalEntryResponseDto })
  @Roles(Role.ADMIN)
  @Idempotent()
  @Post()
  @HttpCode(200)
  post(
    @Body() dto: OpeningBalancesDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<JournalEntry> {
    return this.journal.postOpeningBalances(
      new Date(dto.date),
      dto.balances,
      user.id,
    );
  }
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: exit 0 (the schema/journal mismatch from Task 2 Step 4 is now resolved).

- [ ] **Step 8: Add the `Idempotency-Key` header to journal e2e calls**

The journal e2e specs now hit `@Idempotent()` endpoints, which require the header. Add `import { randomUUID } from 'crypto';` to `test/journal.e2e-spec.ts` and `test/journal-list.e2e-spec.ts` (and any other spec that POSTs to `/v1/ledger/journal-entries`, `/v1/ledger/journal-entries/:id/post|reverse`, or `/v1/ledger/opening-balances`). For each such request add `.set('Idempotency-Key', randomUUID())`. Example:

```typescript
await request(server())
  .post('/v1/ledger/journal-entries')
  .set('Authorization', `Bearer ${appr}`)
  .set('Idempotency-Key', randomUUID())
  .send({ /* ... */ })
  .expect(201);
```

- [ ] **Step 9: Run journal + posting e2e and fix any remaining 422s**

Run: `npm run test:e2e -- journal posting`
Expected: PASS. Any `422 Idempotency-Key header is required` points at a journal/opening-balances POST still missing the header — add it. Re-run until green.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(idempotency): global interceptor + module; journals refactored onto it"
```

### Task 6: Apply `@Idempotent()` to the remaining included endpoints

**Files:**
- Modify: `src/ledger/accounts/accounts.controller.ts`
- Modify: `src/tax/tax-codes.controller.ts`
- Modify: `src/invoicing/business-partners.controller.ts`
- Modify: `src/invoicing/sales-invoices.controller.ts`
- Modify: `src/invoicing/purchase-bills.controller.ts`
- Modify: `src/invoicing/payments.controller.ts`
- Modify: `src/ledger/periods/periods.controller.ts`
- Modify: `src/close/closing.controller.ts`

For each controller below, add the import (path depth varies — `accounts` is two levels under `src/ledger/`, so `../../common/...`; the others under `src/<area>/` use `../common/...`) and put `@Idempotent()` directly above the listed `@Post` decorators. **Do not** add it to `@Patch`, `@Delete`, `@Post(':id/deactivate')`, period `close`/`reopen`, year-end `reopen`, `auth/*`, or `tax/calculate`.

- [ ] **Step 1: accounts** — import `import { Idempotent } from '../../common/idempotency/idempotent.decorator';`; add `@Idempotent()` to the `create` handler only (`@Post()` at line ~64).

- [ ] **Step 2: tax-codes** — import `import { Idempotent } from '../common/idempotency/idempotent.decorator';`; add `@Idempotent()` to `create` only (`@Post()` at line ~49).

- [ ] **Step 3: business-partners** — import `import { Idempotent } from '../common/idempotency/idempotent.decorator';`; add `@Idempotent()` to `create` only (`@Post()` at line ~48).

- [ ] **Step 4: sales-invoices** — import `import { Idempotent } from '../common/idempotency/idempotent.decorator';`; add `@Idempotent()` to `create` (`@Post()`), `post` (`@Post(':id/post')`), and `void` (`@Post(':id/void')`).

- [ ] **Step 5: purchase-bills** — same import; add `@Idempotent()` to `create`, `post`, `void`.

- [ ] **Step 6: payments** — same import; add `@Idempotent()` to `create`, `post`, `void`.

- [ ] **Step 7: periods** — `import { Idempotent } from '../../common/idempotency/idempotent.decorator';`; add `@Idempotent()` to `generate` (`@Post('generate')`) only — not `close`/`reopen`.

- [ ] **Step 8: closing** — `import { Idempotent } from '../common/idempotency/idempotent.decorator';`; add `@Idempotent()` to `run` (`@Post()`) only — not `reopen`.

- [ ] **Step 9: Document the header in OpenAPI**

So the regenerated `openapi.json` advertises the header, add `@ApiHeader` to each idempotent handler (alongside `@Idempotent()`). Add to the swagger import in each controller: `ApiHeader`. Then above each idempotent handler add:

```typescript
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Unique key to make this write safely retryable.',
  })
```

- [ ] **Step 10: Typecheck + lint**

Run: `npm run typecheck && npm run lint:ci`
Expected: exit 0.

- [ ] **Step 11: Make the rest of the e2e suite green again (run-and-fix)**

Required keys now break every other e2e HTTP call to an included endpoint (creates/post/void for invoices, bills, payments, accounts, tax-codes, partners, periods generate, year-end). Run the suite and add `.set('Idempotency-Key', randomUUID())` (importing `randomUUID` from `crypto` per file) to each failing call:

Run: `npm run test:e2e`
For each failure reporting `422 / Idempotency-Key header is required`, locate the offending `.post(...)` and add the header. Known specs needing edits include: `test/sales-invoices.e2e-spec.ts`, `test/purchase-bills.e2e-spec.ts`, `test/payments.e2e-spec.ts`, `test/accounts.e2e-spec.ts`, `test/tax-codes.e2e-spec.ts`, `test/business-partners.e2e-spec.ts`, `test/close.e2e-spec.ts`, `test/periods.e2e-spec.ts`, and the reporting specs that build data via HTTP (`reporting-*.e2e-spec.ts`), plus shared helpers like `makePostedInvoice`. Re-run until green.

> Note: requests created via service calls (`app.get(XService).create(...)`) bypass the interceptor and need no key — only HTTP `.post()` calls to included routes do.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat(idempotency): require Idempotency-Key on all create + money-moving endpoints"
```

### Task 7: End-to-end idempotency behaviour

**Files:**
- Create: `test/idempotency.e2e-spec.ts`

- [ ] **Step 1: Write the e2e spec**

Create `test/idempotency.e2e-spec.ts` (uses `partners` — minimal body, ACCOUNTANT role):

```typescript
import { Test } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Idempotency (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let acct: string;
  const server = () => app.getHttpServer() as App;

  const partnerBody = (code: string) => ({
    code,
    name: 'PT Idem',
    isCustomer: true,
  });

  beforeAll(async () => {
    db = await startTestDb();
    prisma = makePrismaOverride(db.url);
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    const users = app.get(UsersService);
    await users.create({
      email: 'acct@idem.test',
      password: 'secret123',
      name: 'Acct',
      role: 'ACCOUNTANT',
    });
    acct = (await app.get(AuthService).login('acct@idem.test', 'secret123'))
      .accessToken;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  it('replays the same key+body and creates exactly one row', async () => {
    const key = randomUUID();
    const body = partnerBody('IDEM-1');
    const first = await request(server())
      .post('/v1/partners')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const second = await request(server())
      .post('/v1/partners')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect((second.body as { id: string }).id).toBe(
      (first.body as { id: string }).id,
    );
    const count = await prisma.client.businessPartner.count({
      where: { code: 'IDEM-1' },
    });
    expect(count).toBe(1);
  });

  it('rejects the same key with a different body (422)', async () => {
    const key = randomUUID();
    await request(server())
      .post('/v1/partners')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', key)
      .send(partnerBody('IDEM-2'))
      .expect(201);
    await request(server())
      .post('/v1/partners')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', key)
      .send(partnerBody('IDEM-2-CHANGED'))
      .expect(422);
  });

  it('requires the header (422 when missing)', async () => {
    await request(server())
      .post('/v1/partners')
      .set('Authorization', `Bearer ${acct}`)
      .send(partnerBody('IDEM-3'))
      .expect(422);
  });

  it('two concurrent identical requests create exactly one row', async () => {
    const key = randomUUID();
    const body = partnerBody('IDEM-RACE');
    const send = () =>
      request(server())
        .post('/v1/partners')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', key)
        .send(body);
    const results = await Promise.allSettled([send(), send()]);
    const statuses = results.map((r) =>
      r.status === 'fulfilled' ? r.value.status : 0,
    );
    // One succeeds (201). The other replays (201) or is rejected in-flight (409).
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
    const count = await prisma.client.businessPartner.count({
      where: { code: 'IDEM-RACE' },
    });
    expect(count).toBe(1);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm run test:e2e -- idempotency`
Expected: PASS (4 tests).

- [ ] **Step 3: Commit**

```bash
git add test/idempotency.e2e-spec.ts
git commit -m "test(idempotency): e2e replay, body-mismatch, missing-key, concurrency"
```

---

## PART C — PAGINATION

### Task 8: Shared `PaginationQueryDto`; refactor journal list DTO

**Files:**
- Create: `src/common/dto/pagination-query.dto.ts`
- Modify: `src/ledger/journal/dto/list-journal-entries.dto.ts`

- [ ] **Step 1: Create the shared DTO**

Create `src/common/dto/pagination-query.dto.ts`:

```typescript
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** Shared offset-pagination query: ?limit (1-200, default applied in service) & ?offset. */
export class PaginationQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
```

- [ ] **Step 2: Refactor the journal list DTO to extend it (DRY)**

Replace `src/ledger/journal/dto/list-journal-entries.dto.ts` with:

```typescript
import { IsDateString, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { JournalStatus, JournalSourceType } from '@prisma/client';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export class JournalListQueryDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(JournalStatus) status?: JournalStatus;
  @IsOptional() @IsEnum(JournalSourceType) sourceType?: JournalSourceType;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  fiscalYear?: number;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}
```

- [ ] **Step 3: Typecheck + run journal-list e2e**

Run: `npm run typecheck && npm run test:e2e -- journal-list`
Expected: exit 0 and PASS (journal list already uses `q.limit`/`q.offset`, now inherited).

- [ ] **Step 4: Commit**

```bash
git add src/common/dto/pagination-query.dto.ts src/ledger/journal/dto/list-journal-entries.dto.ts
git commit -m "feat(pagination): shared PaginationQueryDto; journal list DTO extends it"
```

### Task 9: Envelope response DTOs + extend invoicing list query DTOs

**Files:**
- Modify: `src/ledger/accounts/dto/account-response.dto.ts`
- Modify: `src/tax/dto/tax-code-response.dto.ts`
- Modify: `src/invoicing/dto/business-partner-response.dto.ts`
- Modify: `src/invoicing/dto/sales-invoice-response.dto.ts`
- Modify: `src/invoicing/dto/payment-response.dto.ts`
- Modify: `src/invoicing/dto/purchase-bill-response.dto.ts`
- Modify: `src/invoicing/dto/list-sales-invoices.dto.ts`
- Modify: `src/invoicing/dto/list-purchase-bills.dto.ts`
- Modify: `src/invoicing/dto/list-payments.dto.ts`

- [ ] **Step 1: Add envelope DTOs**

Append to each response DTO file an envelope class (mirrors `JournalEntryListResponseDto`). Ensure `ApiProperty` is imported (it already is in each file).

`account-response.dto.ts` (append):

```typescript
export class AccountListResponseDto {
  @ApiProperty({ type: [AccountResponseDto] }) data!: AccountResponseDto[];
  @ApiProperty({ example: 137 }) total!: number;
  @ApiProperty({ example: 50 }) limit!: number;
  @ApiProperty({ example: 0 }) offset!: number;
}
```

`tax-code-response.dto.ts` (append):

```typescript
export class TaxCodeListResponseDto {
  @ApiProperty({ type: [TaxCodeResponseDto] }) data!: TaxCodeResponseDto[];
  @ApiProperty({ example: 12 }) total!: number;
  @ApiProperty({ example: 50 }) limit!: number;
  @ApiProperty({ example: 0 }) offset!: number;
}
```

`business-partner-response.dto.ts` (append):

```typescript
export class BusinessPartnerListResponseDto {
  @ApiProperty({ type: [BusinessPartnerResponseDto] })
  data!: BusinessPartnerResponseDto[];
  @ApiProperty({ example: 87 }) total!: number;
  @ApiProperty({ example: 50 }) limit!: number;
  @ApiProperty({ example: 0 }) offset!: number;
}
```

`sales-invoice-response.dto.ts` (append):

```typescript
export class SalesInvoiceListResponseDto {
  @ApiProperty({ type: [SalesInvoiceResponseDto] })
  data!: SalesInvoiceResponseDto[];
  @ApiProperty({ example: 240 }) total!: number;
  @ApiProperty({ example: 50 }) limit!: number;
  @ApiProperty({ example: 0 }) offset!: number;
}
```

`purchase-bill-response.dto.ts` (append — class is `PurchaseBillResponseDto`):

```typescript
export class PurchaseBillListResponseDto {
  @ApiProperty({ type: [PurchaseBillResponseDto] })
  data!: PurchaseBillResponseDto[];
  @ApiProperty({ example: 240 }) total!: number;
  @ApiProperty({ example: 50 }) limit!: number;
  @ApiProperty({ example: 0 }) offset!: number;
}
```

`payment-response.dto.ts` (append):

```typescript
export class PaymentListResponseDto {
  @ApiProperty({ type: [PaymentResponseDto] }) data!: PaymentResponseDto[];
  @ApiProperty({ example: 310 }) total!: number;
  @ApiProperty({ example: 50 }) limit!: number;
  @ApiProperty({ example: 0 }) offset!: number;
}
```

- [ ] **Step 2: Extend the three invoicing list query DTOs**

`list-sales-invoices.dto.ts`:

```typescript
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { DocumentStatus } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class SalesInvoiceListQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() partnerId?: string;
  @IsOptional() @IsEnum(DocumentStatus) status?: DocumentStatus;
}
```

`list-purchase-bills.dto.ts`:

```typescript
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { DocumentStatus } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class PurchaseBillListQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() partnerId?: string;
  @IsOptional() @IsEnum(DocumentStatus) status?: DocumentStatus;
}
```

`list-payments.dto.ts`:

```typescript
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { DocumentStatus, PaymentDirection } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class PaymentListQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() partnerId?: string;
  @IsOptional() @IsEnum(PaymentDirection) direction?: PaymentDirection;
  @IsOptional() @IsEnum(DocumentStatus) status?: DocumentStatus;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(pagination): per-resource list envelope DTOs; list query DTOs paginated"
```

### Task 10: Paginated `listPage()` services + controllers

**Files:**
- Modify: `src/ledger/accounts/accounts.service.ts` + `accounts.controller.ts`
- Modify: `src/tax/tax-codes.service.ts` + `tax-codes.controller.ts`
- Modify: `src/invoicing/business-partners.service.ts` + `business-partners.controller.ts`
- Modify: `src/invoicing/sales-invoices.service.ts` + `sales-invoices.controller.ts`
- Modify: `src/invoicing/purchase-bills.service.ts` + `purchase-bills.controller.ts`
- Modify: `src/invoicing/payments.service.ts` + `payments.controller.ts`

> Rule: **keep** `list()` on accounts & tax-codes (≈22 internal e2e callers rely on the full array — do not touch them). **Add** `listPage()` everywhere. **Delete** the old `list()` on partners/sales-invoices/purchase-bills/payments (no internal callers; the controller switches to `listPage()`).

- [ ] **Step 1: accounts service** — add after the existing `list()` method:

```typescript
  async listPage(q: { limit?: number; offset?: number }): Promise<{
    data: Account[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    const [data, total] = await Promise.all([
      this.prisma.client.account.findMany({
        orderBy: { code: 'asc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.client.account.count(),
    ]);
    return { data, total, limit, offset };
  }
```

- [ ] **Step 2: accounts controller** — add imports `import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';` and `AccountListResponseDto` (from `./dto/account-response.dto`). Replace the `list()` handler:

```typescript
  @Get()
  @ApiOkResponse({ type: AccountListResponseDto })
  list(@Query() q: PaginationQueryDto) {
    return this.accounts.listPage(q);
  }
```

- [ ] **Step 3: tax-codes service** — add after the existing `list()`:

```typescript
  async listPage(q: { limit?: number; offset?: number }): Promise<{
    data: TaxCode[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    const where = { deletedAt: null };
    const [data, total] = await Promise.all([
      this.prisma.client.taxCode.findMany({
        where,
        orderBy: { code: 'asc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.client.taxCode.count({ where }),
    ]);
    return { data, total, limit, offset };
  }
```

- [ ] **Step 4: tax-codes controller** — add imports `PaginationQueryDto` (`../common/dto/pagination-query.dto`), `TaxCodeListResponseDto`, and `Query` (add `Query` to the `@nestjs/common` import). Replace the `list()` handler:

```typescript
  @ApiOkResponse({ type: TaxCodeListResponseDto })
  @Get()
  list(@Query() q: PaginationQueryDto) {
    return this.taxCodes.listPage(q);
  }
```

- [ ] **Step 5: business-partners service** — replace the existing `list()` with `listPage()`:

```typescript
  async listPage(q: { limit?: number; offset?: number }): Promise<{
    data: BusinessPartner[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    const [data, total] = await Promise.all([
      this.prisma.client.businessPartner.findMany({
        orderBy: { code: 'asc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.client.businessPartner.count(),
    ]);
    return { data, total, limit, offset };
  }
```

- [ ] **Step 6: business-partners controller** — add imports `PaginationQueryDto` (`../common/dto/pagination-query.dto`), `BusinessPartnerListResponseDto`, and `Query` (to `@nestjs/common`). Replace the `list()` handler:

```typescript
  @ApiOkResponse({ type: BusinessPartnerListResponseDto })
  @Get()
  list(@Query() q: PaginationQueryDto) {
    return this.partners.listPage(q);
  }
```

- [ ] **Step 7: sales-invoices service** — replace the existing `list(filter)` with `listPage()` (maps `present` over the page):

```typescript
  async listPage(q: {
    partnerId?: string;
    status?: DocumentStatus;
    limit?: number;
    offset?: number;
  }): Promise<{
    data: ReturnType<SalesInvoicesService['present']>[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    const where = { partnerId: q.partnerId, status: q.status };
    const [rows, total] = await Promise.all([
      this.prisma.client.salesInvoice.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.client.salesInvoice.count({ where }),
    ]);
    return { data: rows.map((r) => this.present(r)), total, limit, offset };
  }
```

- [ ] **Step 8: sales-invoices controller** — add `SalesInvoiceListResponseDto` to the response-dto import. Replace the `list()` handler:

```typescript
  @ApiOkResponse({ type: SalesInvoiceListResponseDto })
  @Get()
  list(@Query() q: SalesInvoiceListQueryDto) {
    return this.invoices.listPage(q);
  }
```

- [ ] **Step 9: purchase-bills service** — replace `list(filter)` with `listPage()`:

```typescript
  async listPage(q: {
    partnerId?: string;
    status?: DocumentStatus;
    limit?: number;
    offset?: number;
  }): Promise<{
    data: ReturnType<PurchaseBillsService['present']>[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    const where = { partnerId: q.partnerId, status: q.status };
    const [rows, total] = await Promise.all([
      this.prisma.client.purchaseBill.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.client.purchaseBill.count({ where }),
    ]);
    return { data: rows.map((r) => this.present(r)), total, limit, offset };
  }
```

- [ ] **Step 10: purchase-bills controller** — add `PurchaseBillListResponseDto` to the import. Replace `list()`:

```typescript
  @ApiOkResponse({ type: PurchaseBillListResponseDto })
  @Get()
  list(@Query() q: PurchaseBillListQueryDto) {
    return this.bills.listPage(q);
  }
```

- [ ] **Step 11: payments service** — replace `list(filter)` with `listPage()`:

```typescript
  async listPage(q: {
    partnerId?: string;
    direction?: PaymentDirection;
    status?: DocumentStatus;
    limit?: number;
    offset?: number;
  }): Promise<{
    data: ReturnType<PaymentsService['present']>[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    const where = {
      partnerId: q.partnerId,
      direction: q.direction,
      status: q.status,
    };
    const [rows, total] = await Promise.all([
      this.prisma.client.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.client.payment.count({ where }),
    ]);
    return { data: rows.map((r) => this.present(r)), total, limit, offset };
  }
```

- [ ] **Step 12: payments controller** — add `PaymentListResponseDto` to the import. Replace `list()`:

```typescript
  @ApiOkResponse({ type: PaymentListResponseDto })
  @Get()
  list(@Query() q: PaymentListQueryDto) {
    return this.payments.listPage(q);
  }
```

- [ ] **Step 13: Typecheck + lint**

Run: `npm run typecheck && npm run lint:ci`
Expected: exit 0. (If lint flags an unused import where an old `list()` returned a type no longer referenced, remove it.)

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "feat(pagination): listPage() envelopes for the six unbounded lists"
```

### Task 11: Update list e2e assertions + add pagination e2e

**Files:**
- Modify: `test/accounts.e2e-spec.ts`, `test/tax-codes.e2e-spec.ts`, `test/business-partners.e2e-spec.ts`, `test/sales-invoices.e2e-spec.ts`, `test/purchase-bills.e2e-spec.ts`, `test/payments.e2e-spec.ts`, `test/list-filter-validation.e2e-spec.ts` (and any reporting spec that reads a list endpoint's HTTP body as an array)
- Create: `test/pagination.e2e-spec.ts`

- [ ] **Step 1: Fix existing list-body assertions (run-and-fix)**

Run: `npm run test:e2e -- accounts tax-codes business-partners sales-invoices purchase-bills payments list-filter-validation`
For each failure where a GET-list response body was treated as an array, change it to read the envelope. Patterns:
- `const body = res.body as XResponseDto[]` → `const { data: body } = res.body as { data: XResponseDto[] }`
- `expect(res.body).toHaveLength(n)` → `expect(res.body.data).toHaveLength(n)`
- `res.body.find(...)` / `res.body.map(...)` → `res.body.data.find(...)` / `.map(...)`
- `expect(Array.isArray(res.body)).toBe(true)` → `expect(Array.isArray(res.body.data)).toBe(true)`

Re-run until green. (The GET-by-id and mutating assertions are unchanged — only GET-list bodies move under `.data`.)

- [ ] **Step 2: Write the pagination e2e spec**

Create `test/pagination.e2e-spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Pagination (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let acct: string;
  const server = () => app.getHttpServer() as App;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = makePrismaOverride(db.url);
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.get(AccountsService).seedIfEmpty();
    const users = app.get(UsersService);
    await users.create({
      email: 'acct@page.test',
      password: 'secret123',
      name: 'Acct',
      role: 'ACCOUNTANT',
    });
    acct = (await app.get(AuthService).login('acct@page.test', 'secret123'))
      .accessToken;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  it('returns the { data, total, limit, offset } envelope and honors limit', async () => {
    const res = await request(server())
      .get('/v1/ledger/accounts?limit=3&offset=0')
      .set('Authorization', `Bearer ${acct}`)
      .expect(200);
    const body = res.body as {
      data: unknown[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.limit).toBe(3);
    expect(body.offset).toBe(0);
    expect(body.data.length).toBeLessThanOrEqual(3);
    expect(body.total).toBeGreaterThanOrEqual(body.data.length);
  });

  it('offset advances the page without overlap', async () => {
    const page1 = (
      await request(server())
        .get('/v1/ledger/accounts?limit=2&offset=0')
        .set('Authorization', `Bearer ${acct}`)
        .expect(200)
    ).body as { data: { id: string }[]; total: number };
    const page2 = (
      await request(server())
        .get('/v1/ledger/accounts?limit=2&offset=2')
        .set('Authorization', `Bearer ${acct}`)
        .expect(200)
    ).body as { data: { id: string }[] };
    const ids = new Set(page1.data.map((a) => a.id));
    for (const a of page2.data) expect(ids.has(a.id)).toBe(false);
  });

  it('paginates partners with a correct total', async () => {
    for (const code of ['PG-1', 'PG-2', 'PG-3']) {
      await request(server())
        .post('/v1/partners')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', randomUUID())
        .send({ code, name: 'PT Page', isCustomer: true })
        .expect(201);
    }
    const res = await request(server())
      .get('/v1/partners?limit=2&offset=0')
      .set('Authorization', `Bearer ${acct}`)
      .expect(200);
    const body = res.body as { data: unknown[]; total: number; limit: number };
    expect(body.limit).toBe(2);
    expect(body.data.length).toBe(2);
    expect(body.total).toBeGreaterThanOrEqual(3);
  });

  it('rejects an over-max limit (422)', async () => {
    await request(server())
      .get('/v1/ledger/accounts?limit=500')
      .set('Authorization', `Bearer ${acct}`)
      .expect(422);
  });
});
```

- [ ] **Step 3: Run pagination e2e**

Run: `npm run test:e2e -- pagination`
Expected: PASS (4 tests).

- [ ] **Step 4: Full e2e sweep**

Run: `npm run test:e2e`
Expected: PASS across all suites.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(pagination): envelope assertions + pagination e2e"
```

---

## PART D — DOCS & FINAL VERIFICATION

### Task 12: Regenerate `openapi.json` and run the contract guard

**Files:**
- Modify (generated): `docs/api/openapi.json`

- [ ] **Step 1: Regenerate the spec**

Run: `npm run openapi:export`
Expected: prints `Wrote docs/api/openapi.json`. Paths are now under `/v1` (except `/health`, `/ready`, `/metrics`); included write endpoints show the `Idempotency-Key` header; the six lists reference their `*ListResponseDto` envelopes.

- [ ] **Step 2: Run the contract guard + the api-money/openapi unit specs**

Run: `npm test -- openapi`
Expected: PASS — `every 2xx response declares a non-empty body schema`. If an offender is reported, it names a `METHOD /path (code)` whose response DTO is missing; wire the correct `@ApiOkResponse({ type: ... })` and re-export.

- [ ] **Step 3: Sanity-check the spec content**

Run: `node -e "const d=require('./docs/api/openapi.json'); console.log('has /v1/ledger/accounts:', !!d.paths['/v1/ledger/accounts']); console.log('health neutral:', !!d.paths['/health']);"`
Expected: both `true`.

- [ ] **Step 4: Commit**

```bash
git add docs/api/openapi.json
git commit -m "docs(openapi): regenerate with /v1 paths, Idempotency-Key, list envelopes"
```

### Task 13: Update the guides, README, and changelog

**Files:**
- Modify: `docs/api/frontend-guide.md`
- Modify: `docs/api/frontend-agent-brief.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: frontend-guide.md**

- In **§2 Conventions → Pagination**: state that all list endpoints return the envelope `{ data, total, limit, offset }` with `?limit` (max 200, default 50) and `?offset`; remove/replace any "journal-list is the only enveloped list" wording in **§2 → Response shapes** and the **§6 Response schema quick-map**.
- In **§1 Overview**: note the base path is now `/v1` (operational probes `/health`, `/ready`, `/metrics` stay unprefixed).
- In **§2 Conventions**: add an **Idempotency** subsection — included write endpoints (all creates + `:id/post`/`:id/void` + year-end + journals/opening-balances) require an `Idempotency-Key` header; replays return the original response; reusing a key with a different body or endpoint is `422`; an in-flight key is `409`.
- In **§6 endpoint catalog / quick-map**: add the six new `*ListResponseDto` schema names.

- [ ] **Step 2: frontend-agent-brief.md**

Under **Non-negotiable rules** / **Do / Don't**: add that every business call is under `/v1`, list responses are enveloped (read `.data`), and included writes must send a unique `Idempotency-Key`.

- [ ] **Step 3: README.md**

In **API documentation**: mention `/v1` versioning, the required `Idempotency-Key` on writes, and enveloped list pagination.

- [ ] **Step 4: CHANGELOG.md**

Under `## [Unreleased]` add an `### Added` / `### Changed` block:

```markdown
### Added

- **API versioning** — all business routes are served under `/v1`
  (`enableVersioning`, URI strategy). Operational probes (`/health`, `/ready`,
  `/metrics`) remain version-neutral.
- **Generalized idempotency** — a reusable `@Idempotent()` interceptor stores a
  JSON response snapshot keyed by `Idempotency-Key`. Required on all creates and
  money-moving transitions (`:id/post`, `:id/void`, year-end close) plus the
  journal/opening-balances endpoints. Replays return the original response;
  key reuse with a different body/endpoint → 422; in-flight → 409.
- **List pagination** — accounts, tax codes, partners, sales invoices, purchase
  bills, and payments now return `{ data, total, limit, offset }` (`?limit` max
  200, default 50; `?offset`).

### Changed

- **Breaking:** business route paths are now `/v1/...`; the six lists above
  return an envelope instead of a bare array. The journal/opening-balances
  endpoints now require an `Idempotency-Key`. See `docs/api/openapi.json`.
```

- [ ] **Step 5: Commit**

```bash
git add docs/api/frontend-guide.md docs/api/frontend-agent-brief.md README.md CHANGELOG.md
git commit -m "docs: /v1, idempotency, and pagination conventions in guides + changelog"
```

### Task 14: Full verification gate

- [ ] **Step 1: Run the whole verify pipeline**

Run: `npm run verify`
Expected: `typecheck` (0), `lint:ci` (0), `test` (unit — all pass, includes the 8 new `IdempotencyService` tests), `test:e2e:cov` (all e2e pass and coverage thresholds — statements/functions/lines 84%, branches 62% — still met).

- [ ] **Step 2: If coverage dipped below threshold**

The new interceptor adds branches. If `test:e2e:cov` fails only on coverage, add a focused e2e asserting the **409 in-flight** path is exercised, or a unit test for the interceptor's reflector short-circuit (handler without `@Idempotent()` calls `next.handle()` directly). Re-run `npm run verify` until green.

- [ ] **Step 3: Final commit (if Step 2 added tests)**

```bash
git add -A
git commit -m "test: cover idempotency interceptor branches to hold coverage gate"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** D1 versioning → Task 1; D2 neutral probes → Task 1 Steps 4 + the versioning e2e; D3 idempotency scope → Task 6 (matrix) + Task 5 (journals); D4 mechanism → Tasks 3–5; D5 required key → interceptor missing-key 422 + Task 6 Step 11; D6 body-hash → `IdempotencyService.reserve` + unit/e2e; D7 pagination scope → Task 10 (six lists); D8 shape → Tasks 8–10. Docs/openapi → Tasks 12–13. Tests → Tasks 7, 11, 14.
- **Order rationale:** versioning first (all later tests use `/v1`); idempotency before pagination per the spec build sequence; docs/openapi after behaviour is final.
- **Naming consistency:** the paginated method is `listPage(q)` in all six services; `list()` is retained ONLY on accounts & tax-codes for internal full-fetch callers; envelope DTOs are `<Resource>ListResponseDto` everywhere (matching `JournalEntryListResponseDto`).
- **Known broad edits** (run-and-fix loops, bounded by the test run, not guesswork): `/v1` path prefixing (Task 1), required-key header additions (Task 5 Step 8, Task 6 Step 11), and list-body `.data` assertions (Task 11 Step 1).
