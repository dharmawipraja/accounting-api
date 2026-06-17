# Security & Hardening Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close out the §2 Security & hardening audit findings that are app-level and schema-free (SEC-2, app-side SEC-3, SEC-4, SEC-5, SEC-6, SEC-8); SEC-1 and the pure-infra items are deferred.

**Architecture:** Six independent, test-first fixes across the idempotency, throttling, company, metrics, auth, and packaging surfaces. One new runtime dependency (`@nestjs/schedule`, for the SEC-2 purge cron) and one new optional env var. No schema or migration changes.

**Tech Stack:** NestJS 11, Prisma 7 (`@prisma/adapter-pg`) + Postgres, `@nestjs/throttler` (Redis-backed outside test), argon2, `class-validator` env validation, Jest unit specs (`*.spec.ts` under `src/`), Jest e2e specs (`test/*.e2e-spec.ts`) against real Postgres via testcontainers.

## Global Constraints

- Node `>=22 <23`. The only new runtime dependency permitted is `@nestjs/schedule` (Task 1); no others.
- All monetary math goes through `Money` (`src/common/money/money.ts`) — never JS floats. (No money code here, but the rule stands.)
- API base path is `/v1`; e2e HTTP calls use `/v1/...`. Money-movers send an `Idempotency-Key` header.
- Domain errors map to HTTP via `AllExceptionsFilter`: `ValidationFailedError` → 422, `ConflictDomainError` → 409, `UnauthorizedDomainError` → 401. RBAC failures (`RolesGuard`) → 403. `UnauthorizedException` → 401.
- `Role` enum (`@prisma/client`): `ADMIN | ACCOUNTANT | APPROVER | VIEWER`.
- Unit tests: `npm test -- <pattern>`. E2E: `npm run test:e2e -- <pattern>`.
- Every e2e bootstrap calls `app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })`.
- Commit messages are conventional and end with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Branch: `fix/security-hardening` (already created, spec committed at `a869442`).
- After each task: `npm run typecheck` and `npx eslint <changed files> --max-warnings 0` must pass.

## File Structure

- `src/common/idempotency/idempotency.interceptor.ts` — Task 1 (SEC-2 key validation)
- `src/common/idempotency/idempotency.service.ts` — Task 1 (SEC-2 `purgeCompleted`)
- `src/common/idempotency/idempotency-purge.service.ts` — Task 1 (new; `@Cron` purge)
- `src/common/idempotency/idempotency.module.ts` — Task 1 (wire purge service)
- `src/app.module.ts` — Task 1 (`ScheduleModule.forRoot()`)
- `src/config/env.validation.ts` — Task 1 (`IDEMPOTENCY_COMPLETED_TTL_MS`)
- `package.json` — Task 1 (`@nestjs/schedule`), Task 6 (audit scripts)
- `test/idempotency.e2e-spec.ts` — Task 1 (bad-key 422 + purge predicate)
- `src/common/guards/user-throttler.guard.ts` — Task 2 (SEC-3 email keying)
- `test/throttle.e2e-spec.ts` — Task 2
- `src/company/company.controller.ts` — Task 3 (SEC-4 role gate)
- `test/company.e2e-spec.ts` — Task 3
- `src/metrics/metrics-token.guard.ts` — Task 4 (SEC-5 fail-closed)
- `src/metrics/metrics-token.guard.spec.ts` — Task 4 (new unit spec)
- `src/users/users.service.ts` — Task 5 (SEC-6 `verifyPasswordOrDecoy`)
- `src/auth/auth.service.ts` — Task 5 (SEC-6 constant-time login)
- `src/auth/auth.service.spec.ts` — Task 5 (new unit spec)
- `docs/production-readiness-audit-2026-06-17.md` — Task 7 (mark fixed)

---

### Task 1: SEC-2 — Idempotency-Key validation + scheduled purge of completed keys

**Files:**
- Modify: `src/common/idempotency/idempotency.interceptor.ts` (validate the key)
- Modify: `src/common/idempotency/idempotency.service.ts` (add `purgeCompleted`)
- Create: `src/common/idempotency/idempotency-purge.service.ts`
- Modify: `src/common/idempotency/idempotency.module.ts` (register purge service)
- Modify: `src/app.module.ts` (`ScheduleModule.forRoot()`)
- Modify: `src/config/env.validation.ts` (`IDEMPOTENCY_COMPLETED_TTL_MS`)
- Modify: `package.json` (add `@nestjs/schedule`)
- Test: `test/idempotency.e2e-spec.ts` (bad-key 422; purge deletes only old completed)

**Interfaces:**
- Consumes: `IdempotencyService` (existing), `PrismaService.client.idempotencyKey`, `ConfigService`.
- Produces: `IdempotencyService.purgeCompleted(olderThanMs?: number): Promise<number>` (returns deleted count); the interceptor rejects malformed keys with `ValidationFailedError` (→422).

- [ ] **Step 1: Install the scheduler dependency**

```bash
npm install @nestjs/schedule
```
Expected: `@nestjs/schedule` added to `dependencies` in `package.json`.

- [ ] **Step 2: Write the failing e2e tests** — add to `test/idempotency.e2e-spec.ts`.

First, the malformed-key test. Add it alongside the existing HTTP idempotency tests, reusing that file's existing auth token, idempotent endpoint, and request body (read the file; the existing "replays the same key+body" test shows the endpoint + token + body to copy). Only the `Idempotency-Key` header changes — send a 129-character key:

```typescript
  it('SEC-2: rejects an over-long Idempotency-Key with 422', async () => {
    // Reuse the same idempotent endpoint, auth token, and body the existing
    // HTTP idempotency test in this file uses. Only the key is malformed.
    const tooLong = 'a'.repeat(129);
    await request(app.getHttpServer() as App)
      .post(/* same idempotent endpoint as the existing test */)
      .set('Authorization', /* same auth header as the existing test */)
      .set('Idempotency-Key', tooLong)
      .send(/* same valid body as the existing test */)
      .expect(422);
  });
```

Then the purge predicate test (self-contained — uses `IdempotencyService` + `prisma.client` directly; get the service via `app.get(IdempotencyService)` — import it from `../src/common/idempotency/idempotency.service`):

```typescript
  it('SEC-2: purgeCompleted deletes only completed keys older than the retention', async () => {
    const idem = app.get(IdempotencyService);
    const old = new Date('2000-01-01');
    // Old completed key — must be purged.
    await prisma.client.idempotencyKey.create({
      data: {
        key: 'purge-old',
        method: 'POST',
        path: '/v1/x',
        requestHash: 'h',
        response: { ok: true },
        httpStatus: 201,
        createdAt: old,
        completedAt: old,
      },
    });
    // Fresh completed key — must survive.
    await prisma.client.idempotencyKey.create({
      data: {
        key: 'purge-fresh',
        method: 'POST',
        path: '/v1/y',
        requestHash: 'h',
        response: { ok: true },
        httpStatus: 201,
        completedAt: new Date(),
      },
    });
    // In-flight key (completedAt null) — must survive (the FIN-L2 lazy-expiry owns these).
    await prisma.client.idempotencyKey.create({
      data: { key: 'purge-inflight', method: 'POST', path: '/v1/z', requestHash: 'h' },
    });

    const deleted = await idem.purgeCompleted(86_400_000); // 24h retention
    expect(deleted).toBe(1);
    expect(await prisma.client.idempotencyKey.findUnique({ where: { key: 'purge-old' } })).toBeNull();
    expect(await prisma.client.idempotencyKey.findUnique({ where: { key: 'purge-fresh' } })).not.toBeNull();
    expect(await prisma.client.idempotencyKey.findUnique({ where: { key: 'purge-inflight' } })).not.toBeNull();
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test:e2e -- idempotency`
Expected: FAIL — the 129-char key currently passes (the PK has no length cap) so the request does not 422; and `idem.purgeCompleted` does not exist (TypeError / compile error). Both are the expected RED.

- [ ] **Step 4: Validate the key in the interceptor** — in `src/common/idempotency/idempotency.interceptor.ts`, add a module-level regex (after the imports) and a check immediately after the existing presence check (`:42–44`):

```typescript
// Bounds the stored PK (`IdempotencyKey.key String @id`) and rejects garbage.
// UUIDs (the frontend default) and other compact tokens pass.
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;
```

```typescript
    if (!key) {
      throw new ValidationFailedError('Idempotency-Key header is required');
    }
    if (!IDEMPOTENCY_KEY_RE.test(key)) {
      throw new ValidationFailedError(
        'Idempotency-Key must be 1–128 characters of [A-Za-z0-9._:-]',
      );
    }
```

- [ ] **Step 5: Add `purgeCompleted` to the service** — in `src/common/idempotency/idempotency.service.ts`, add a retention getter next to `inflightTtlMs` and a public purge method (place the method after `release`):

```typescript
  private get completedTtlMs(): number {
    return this.config.get<number>('IDEMPOTENCY_COMPLETED_TTL_MS') ?? 86_400_000;
  }
```

```typescript
  /**
   * Delete completed idempotency keys older than the retention window. In-flight
   * rows (completedAt null) are excluded — the `completedAt: { lt }` predicate
   * never matches NULL — so the FIN-L2 lazy-expiry remains the sole owner of those.
   * Returns the number of rows deleted.
   */
  async purgeCompleted(olderThanMs: number = this.completedTtlMs): Promise<number> {
    const threshold = new Date(Date.now() - olderThanMs);
    const { count } = await this.prisma.client.idempotencyKey.deleteMany({
      where: { completedAt: { lt: threshold } },
    });
    return count;
  }
```

- [ ] **Step 6: Create the purge cron service** — `src/common/idempotency/idempotency-purge.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { IdempotencyService } from './idempotency.service';

/** Hourly cleanup of completed idempotency keys past their retention window. */
@Injectable()
export class IdempotencyPurgeService {
  private readonly logger = new Logger(IdempotencyPurgeService.name);

  constructor(private readonly idempotency: IdempotencyService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async purge(): Promise<void> {
    const count = await this.idempotency.purgeCompleted();
    if (count > 0) {
      this.logger.log(`Purged ${count} completed idempotency keys`);
    }
  }
}
```

- [ ] **Step 7: Wire the purge service** — in `src/common/idempotency/idempotency.module.ts`, register it as a provider:

```typescript
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyService } from './idempotency.service';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyPurgeService } from './idempotency-purge.service';

// PrismaModule is @Global, so IdempotencyService resolves PrismaService here.
@Module({
  providers: [
    IdempotencyService,
    IdempotencyPurgeService,
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class IdempotencyModule {}
```

- [ ] **Step 8: Enable the scheduler app-wide** — in `src/app.module.ts`, import `ScheduleModule` and add `ScheduleModule.forRoot()` to the `imports` array (add it near the other top-level module imports, e.g. right after `ConfigModule.forRoot({...})`):

```typescript
import { ScheduleModule } from '@nestjs/schedule';
```
Add `ScheduleModule.forRoot(),` to `imports`.

- [ ] **Step 9: Add the retention env var** — in `src/config/env.validation.ts`, add directly after the `IDEMPOTENCY_INFLIGHT_TTL_MS` block (`:64–67`):

```typescript
  @IsOptional()
  @IsInt()
  @Min(60000)
  IDEMPOTENCY_COMPLETED_TTL_MS?: number;
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npm run test:e2e -- idempotency`
Expected: PASS — the 129-char key returns 422; `purgeCompleted(86_400_000)` deletes exactly the old completed row (returns 1) and leaves the fresh-completed and in-flight rows. Existing idempotency tests stay green (a valid UUID key still works).

- [ ] **Step 11: Typecheck, lint, commit**

```bash
npm run typecheck
npx eslint src/common/idempotency/idempotency.interceptor.ts src/common/idempotency/idempotency.service.ts src/common/idempotency/idempotency-purge.service.ts src/common/idempotency/idempotency.module.ts src/app.module.ts src/config/env.validation.ts test/idempotency.e2e-spec.ts --max-warnings 0
git add -A
git commit -m "fix(idempotency): validate Idempotency-Key + scheduled purge of completed keys (SEC-2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: SEC-3 (app-side) — Login throttle keyed by submitted email

**Files:**
- Modify: `src/common/guards/user-throttler.guard.ts` (`getTracker`)
- Test: `test/throttle.e2e-spec.ts` (enable trust proxy; rotate XFF; one email still 429)

**Interfaces:**
- Consumes: the Express request (`user`, `ip`, `body.email`).
- Produces: `getTracker` returns `user:<id>` (authed) / `login:<email>` (anonymous login with an email body) / `ip:<ip>` (other anonymous).

- [ ] **Step 1: Write the failing test** — in `test/throttle.e2e-spec.ts`, enable trust proxy in `beforeAll` (so a client-supplied `X-Forwarded-For` becomes `req.ip`, mirroring prod's `trust proxy: 1`). Add right after `await app.init();`:

```typescript
    (app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void }).set(
      'trust proxy',
      1,
    );
```

Then add the test:

```typescript
  it('SEC-3: login throttle is per-email, not bypassable by rotating X-Forwarded-For', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(app.getHttpServer() as App)
        .post('/v1/auth/login')
        .set('X-Forwarded-For', `203.0.113.${i}`) // a DIFFERENT client IP each attempt
        .send({ email: 'thr@test.io', password: 'wrong-password' });
      statuses.push(res.status);
    }
    // Keyed by email, the shared bucket trips regardless of the rotating IP.
    expect(statuses[10]).toBe(429);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:e2e -- throttle`
Expected: FAIL — with IP keying, each distinct `X-Forwarded-For` gets its own bucket, so all 11 are 401 (bad creds) and `statuses[10]` is 401, not 429.

- [ ] **Step 3: Key login by email** — replace `getTracker` in `src/common/guards/user-throttler.guard.ts`:

```typescript
  protected getTracker(req: {
    user?: { id?: string };
    ip?: string;
    body?: { email?: unknown };
  }): Promise<string> {
    const userId = req.user?.id;
    if (userId) return Promise.resolve(`user:${userId}`);
    // Anonymous: a login carries an email — key by it so per-account brute force
    // is bounded regardless of a spoofed X-Forwarded-For. Combining with IP would
    // let a rotating spoofed IP restore a fresh budget, defeating the limit.
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : null;
    if (email) return Promise.resolve(`login:${email}`);
    return Promise.resolve(`ip:${req.ip ?? 'unknown'}`);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:e2e -- throttle`
Expected: PASS — `statuses[10]` is 429 despite the rotating IP. The existing "11th is 429" and "authenticated request not throttled" tests stay green (same email → `login:thr@test.io` bucket; authed request → `user:<id>`).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck
npx eslint src/common/guards/user-throttler.guard.ts test/throttle.e2e-spec.ts --max-warnings 0
git add src/common/guards/user-throttler.guard.ts test/throttle.e2e-spec.ts
git commit -m "fix(throttle): key login rate limit by email, not spoofable IP (SEC-3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: SEC-4 — Role-gate company settings GET

**Files:**
- Modify: `src/company/company.controller.ts` (add `@Roles` to `get()`)
- Test: `test/company.e2e-spec.ts` (ADMIN/ACCOUNTANT 200; APPROVER/VIEWER 403)

**Interfaces:**
- Consumes: `@Roles`, `Role` (both already imported in the controller).
- Produces: `GET /v1/company/settings` requires `ADMIN` or `ACCOUNTANT`.

- [ ] **Step 1: Write the failing test** — in `test/company.e2e-spec.ts`, create one user per non-admin role in `beforeAll` (after the existing admin creation) and capture tokens. Add to the `let` declarations: `let accountantToken: string; let approverToken: string; let viewerToken: string;`. In `beforeAll`:

```typescript
    const mkToken = async (email: string, role: 'ACCOUNTANT' | 'APPROVER' | 'VIEWER') => {
      await users.create({ email, password: 'secret123', name: role, role });
      return (await app.get(AuthService).login(email, 'secret123')).accessToken;
    };
    accountantToken = await mkToken('acct@x.com', 'ACCOUNTANT');
    approverToken = await mkToken('appr@x.com', 'APPROVER');
    viewerToken = await mkToken('view@x.com', 'VIEWER');
```

Then the test:

```typescript
  it('SEC-4: company settings GET is limited to ADMIN and ACCOUNTANT', async () => {
    const get = (token: string) =>
      request(app.getHttpServer() as App)
        .get('/v1/company/settings')
        .set('Authorization', `Bearer ${token}`);
    await get(adminToken).expect(200);
    await get(accountantToken).expect(200);
    await get(approverToken).expect(403);
    await get(viewerToken).expect(403);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:e2e -- company`
Expected: FAIL — the unguarded `@Get()` returns 200 for APPROVER and VIEWER (the two `.expect(403)` assertions fail).

- [ ] **Step 3: Add the role gate** — in `src/company/company.controller.ts`, add `@Roles(Role.ADMIN, Role.ACCOUNTANT)` to the `get()` handler:

```typescript
  @Roles(Role.ADMIN, Role.ACCOUNTANT)
  @Get()
  @ApiOkResponse({ type: CompanySettingsDto })
  get(): Promise<CompanySettings> {
    return this.company.get();
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:e2e -- company`
Expected: PASS — ADMIN and ACCOUNTANT get 200; APPROVER and VIEWER get 403. Existing company tests (admin GET/PATCH, seed idempotency) stay green.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck
npx eslint src/company/company.controller.ts test/company.e2e-spec.ts --max-warnings 0
git add src/company/company.controller.ts test/company.e2e-spec.ts
git commit -m "fix(company): gate settings GET to ADMIN+ACCOUNTANT (SEC-4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: SEC-5 — Metrics guard fail-closed + constant-time compare

**Files:**
- Modify: `src/metrics/metrics-token.guard.ts`
- Test: `src/metrics/metrics-token.guard.spec.ts` (new unit spec)

**Interfaces:**
- Consumes: `ConfigService` (`METRICS_TOKEN`, `NODE_ENV`), `crypto.timingSafeEqual`.
- Produces: guard denies in production when no token is configured (fail-closed); constant-time bearer compare.

- [ ] **Step 1: Write the failing unit spec** — create `src/metrics/metrics-token.guard.spec.ts`:

```typescript
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExecutionContext } from '@nestjs/common';
import { MetricsTokenGuard } from './metrics-token.guard';

function makeCtx(authorization?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization } }),
    }),
  } as unknown as ExecutionContext;
}

function makeGuard(values: Record<string, string | undefined>): MetricsTokenGuard {
  const config = { get: (k: string) => values[k] } as unknown as ConfigService;
  return new MetricsTokenGuard(config);
}

describe('MetricsTokenGuard', () => {
  it('denies in production when METRICS_TOKEN is unset (fail-closed)', () => {
    const guard = makeGuard({ NODE_ENV: 'production' });
    expect(() => guard.canActivate(makeCtx())).toThrow(UnauthorizedException);
  });

  it('allows in development when METRICS_TOKEN is unset', () => {
    const guard = makeGuard({ NODE_ENV: 'development' });
    expect(guard.canActivate(makeCtx())).toBe(true);
  });

  it('allows a correct bearer token', () => {
    const guard = makeGuard({ NODE_ENV: 'production', METRICS_TOKEN: 'secret-token' });
    expect(guard.canActivate(makeCtx('Bearer secret-token'))).toBe(true);
  });

  it('denies a wrong bearer token', () => {
    const guard = makeGuard({ NODE_ENV: 'production', METRICS_TOKEN: 'secret-token' });
    expect(() => guard.canActivate(makeCtx('Bearer nope'))).toThrow(UnauthorizedException);
  });
});
```

- [ ] **Step 2: Run the spec to verify it fails**

Run: `npm test -- metrics-token.guard`
Expected: FAIL — the current guard returns `true` when the token is unset (fail-open), so the "denies in production when unset" case does not throw.

- [ ] **Step 3: Implement fail-closed + constant-time** — replace `src/metrics/metrics-token.guard.ts`:

```typescript
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class MetricsTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const token = this.config.get<string>('METRICS_TOKEN');
    if (!token) {
      // Fail-closed in production; allow in dev/test for local convenience.
      if (this.config.get<string>('NODE_ENV') === 'production') {
        throw new UnauthorizedException();
      }
      return true;
    }
    const req = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();
    const provided = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return true;
    }
    throw new UnauthorizedException();
  }
}
```

- [ ] **Step 4: Run the spec to verify it passes**

Run: `npm test -- metrics-token.guard`
Expected: PASS (4/4).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck
npx eslint src/metrics/metrics-token.guard.ts src/metrics/metrics-token.guard.spec.ts --max-warnings 0
git add src/metrics/metrics-token.guard.ts src/metrics/metrics-token.guard.spec.ts
git commit -m "fix(metrics): fail-closed in prod + constant-time token compare (SEC-5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: SEC-6 — Constant-time login (decoy hash)

**Files:**
- Modify: `src/users/users.service.ts` (add `verifyPasswordOrDecoy`)
- Modify: `src/auth/auth.service.ts` (always verify before branching)
- Test: `src/auth/auth.service.spec.ts` (new unit spec)

**Interfaces:**
- Consumes: `argon2`, `crypto.randomBytes`, `UsersService`, `JwtService`, `ConfigService`.
- Produces: `UsersService.verifyPasswordOrDecoy(user: User | null, password: string): Promise<boolean>` — verifies against the real hash if present, else against a cached decoy hash (returns false). `AuthService.login` calls it unconditionally (no early return for absent users).

- [ ] **Step 1: Write the failing unit spec** — create `src/auth/auth.service.spec.ts`:

```typescript
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedDomainError } from '../common/errors/domain-errors';

describe('AuthService.login (constant-time)', () => {
  it('verifies a hash even when the user does not exist (no early return)', async () => {
    const verifyOrDecoy = jest.fn().mockResolvedValue(false);
    const users = {
      findByEmailWithHash: jest.fn().mockResolvedValue(null),
      verifyPasswordOrDecoy: verifyOrDecoy,
    } as unknown as UsersService;
    const auth = new AuthService(
      users,
      {} as unknown as JwtService,
      {} as unknown as ConfigService,
    );

    await expect(auth.login('ghost@x.com', 'whatever')).rejects.toBeInstanceOf(
      UnauthorizedDomainError,
    );
    expect(verifyOrDecoy).toHaveBeenCalledWith(null, 'whatever');
  });
});
```

- [ ] **Step 2: Run the spec to verify it fails**

Run: `npm test -- auth.service`
Expected: FAIL — current `login()` returns early when the user is null and never calls a verify; `verifyOrDecoy` is not called (and `UsersService.verifyPasswordOrDecoy` does not exist yet → compile error). Both are the expected RED.

- [ ] **Step 3: Add the decoy-aware verify to UsersService** — in `src/users/users.service.ts`, add the `crypto` import at the top:

```typescript
import { randomBytes } from 'crypto';
```

Add these members to the `UsersService` class (e.g. after `verifyPassword`):

```typescript
  private decoyHashPromise?: Promise<string>;

  /** A cached argon2 hash of random bytes — never matches any real password. */
  private decoyHash(): Promise<string> {
    return (this.decoyHashPromise ??= argon2.hash(randomBytes(32).toString('hex')));
  }

  /**
   * Verify a password against the user's hash, or — when the user is absent —
   * against a decoy hash, so login timing does not reveal whether the email
   * exists. Always returns false for the decoy path.
   */
  async verifyPasswordOrDecoy(user: User | null, password: string): Promise<boolean> {
    if (user) return argon2.verify(user.passwordHash, password);
    await argon2.verify(await this.decoyHash(), password).catch(() => false);
    return false;
  }
```

- [ ] **Step 4: Make login verify unconditionally** — in `src/auth/auth.service.ts`, replace the body of `login()` (`:22–36`):

```typescript
  async login(email: string, password: string): Promise<TokenPair> {
    const user = await this.users.findByEmailWithHash(email);
    // Always run a verify (decoy when the user is absent) so timing is constant.
    const valid = await this.users.verifyPasswordOrDecoy(user, password);
    if (!user || !user.isActive || !valid) {
      throw new UnauthorizedDomainError('Invalid credentials');
    }
    return this.issueTokens({
      id: user.id,
      email: user.email,
      role: user.role,
    });
  }
```

- [ ] **Step 5: Run the spec to verify it passes**

Run: `npm test -- auth.service`
Expected: PASS — `verifyPasswordOrDecoy(null, 'whatever')` is called and `login` throws the constant error.

- [ ] **Step 6: Run the auth e2e to confirm no regression**

Run: `npm run test:e2e -- auth`
Expected: PASS — real login (correct password) succeeds; wrong password and unknown user both 401 with the same message.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npm run typecheck
npx eslint src/users/users.service.ts src/auth/auth.service.ts src/auth/auth.service.spec.ts --max-warnings 0
git add src/users/users.service.ts src/auth/auth.service.ts src/auth/auth.service.spec.ts
git commit -m "fix(auth): constant-time login via decoy hash for absent users (SEC-6)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: SEC-8 — npm audit gate scope

**Files:**
- Modify: `package.json` (`audit:ci`, add `audit:dev`)

**Interfaces:**
- Produces: `npm run audit:ci` enforces moderate+ on prod deps; `npm run audit:dev` reports the full tree without failing.

- [ ] **Step 1: Update the scripts** — in `package.json`, change `audit:ci` and add `audit:dev`:

```json
    "audit:ci": "npm audit --omit=dev --audit-level=moderate",
    "audit:dev": "npm audit --audit-level=moderate || true",
```

- [ ] **Step 2: Verify the scripts run**

Run: `npm run audit:ci; echo "exit=$?"` and `npm run audit:dev; echo "exit=$?"`
Expected: `audit:ci` enforces moderate+ on prod deps (non-zero exit only if a moderate+ prod advisory exists — that is the intended gate). `audit:dev` always exits 0 (non-blocking). No code/tests affected. (Note: CI is not active yet — no git remote — so this gate runs once CI is wired.)

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(security): tighten npm audit gate to moderate + add non-blocking dev scan (SEC-8)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Full-suite verification + audit doc update

**Files:**
- Modify: `docs/production-readiness-audit-2026-06-17.md` (mark §2 items)

- [ ] **Step 1: Run the full unit + e2e suites**

```bash
npm test
npm run test:e2e
```
Expected: all unit suites pass (adds `metrics-token.guard.spec` + `auth.service.spec`); all e2e suites pass (idempotency/throttle/company specs each gain tests). No regressions. Confirm 0 failures.

- [ ] **Step 2: Mark the items fixed** in `docs/production-readiness-audit-2026-06-17.md` — add a one-line "✅ FIXED (branch fix/security-hardening)" note to each of SEC-2, SEC-3 (note: app-side only; Caddy XFF deferred), SEC-4, SEC-5, SEC-6, SEC-8 in §2. Add a one-line "Deferred" note to SEC-1 and SEC-7 (and the SEC-3 Caddy part) pointing to their follow-up status. Match the doc's existing formatting; do not alter the original finding descriptions.

- [ ] **Step 3: Commit**

```bash
git add docs/production-readiness-audit-2026-06-17.md
git commit -m "docs(audit): mark §2 SEC items (SEC-2/3/4/5/6/8) fixed

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** every in-scope spec item maps to a task — SEC-2→T1, SEC-3→T2, SEC-4→T3, SEC-5→T4, SEC-6→T5, SEC-8→T6, plus T7 for the spec's "full suite + audit doc update" delivery step. Deferred items (SEC-1, SEC-3 Caddy, SEC-7) are explicitly out of scope per the spec and noted in T7's doc update. No gaps.

**Placeholder scan:** no TBD/TODO. The one templated spot — T1 Step 2's malformed-key test — intentionally references "the same endpoint/token/body as the existing HTTP idempotency test in this file" rather than guessing fixture names; the implementer copies them from the file being edited. All other steps show complete code.

**Type consistency:** `purgeCompleted(olderThanMs?: number): Promise<number>` is defined in T1 and called with no arg by the cron (T1 Step 6) and with `86_400_000` by the test (T1 Step 2) — both valid against the optional parameter. `verifyPasswordOrDecoy(user: User | null, password: string): Promise<boolean>` is defined in T5 Step 3 and called in `AuthService.login` (T5 Step 4) and the spec (T5 Step 1) with matching signatures. `getTracker`'s return strings (`user:`/`login:`/`ip:`) are internal to T2. `IDEMPOTENCY_COMPLETED_TTL_MS` (env, T1 Step 9) matches the getter in T1 Step 5.

**Decisions honored:** SEC-2 rejects with `ValidationFailedError` → 422 (not 400); SEC-4 gates to `Role.ADMIN, Role.ACCOUNTANT`; SEC-6 implements the decoy-hash path.
