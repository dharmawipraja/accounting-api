# Throttle Policy Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Limit requests per authenticated user (not per shared IP) and add a strict brute-force cap on login/refresh, with no application feature changes.

**Architecture:** A `UserThrottlerGuard` overrides the throttler's tracker to key by verified `user.id` (IP fallback for anon routes); the global guard chain is reordered so auth runs before the throttler; login/refresh get strict per-route `@Throttle` overrides. Limits are env-tunable. The 143 e2e + 35 unit suite is the regression net.

**Tech Stack:** NestJS 11, `@nestjs/throttler@6.5.0`, class-validator, Jest + testcontainers.

**Spec:** `docs/superpowers/specs/2026-06-12-throttle-policy-hardening-design.md`

**Ground rules:** NOT on `main` — create branch `throttle-hardening` first. Docker running. `verify` = `typecheck && lint:ci && test && test:e2e:cov`. `@typescript-eslint/no-explicit-any` is off but `no-unsafe-*` rules apply — type the guard param explicitly (no `any` access). Never run `prisma format`.

## File structure
- `src/common/guards/user-throttler.guard.ts` — the user-keyed throttler guard (Task 1, new).
- `src/common/guards/user-throttler.guard.spec.ts` — unit (Task 1, new).
- `src/app.module.ts` — reorder APP_GUARD + swap in the guard + `THROTTLE_LIMIT` (Task 2).
- `src/auth/auth.controller.ts` — `@Throttle` on login/refresh (Task 2).
- `src/config/env.validation.ts` — 3 optional vars (Task 2).
- `docs/runbooks/deploy.md` — env list (Task 2).
- `test/throttle.e2e-spec.ts` — login-cap e2e (Task 2, new).

---

## Task 1: UserThrottlerGuard + unit

**Files:** `src/common/guards/user-throttler.guard.ts`, `src/common/guards/user-throttler.guard.spec.ts`

- [ ] **Step 1: Branch**

```bash
git checkout -b throttle-hardening
```

- [ ] **Step 2: Write the failing unit test** `src/common/guards/user-throttler.guard.spec.ts`. The guard's constructor needs ThrottlerGuard deps, but `getTracker` is independent of them — instantiate with `Object.create` to call the protected method directly without the DI graph:

```ts
import { UserThrottlerGuard } from './user-throttler.guard';

describe('UserThrottlerGuard.getTracker', () => {
  // getTracker doesn't touch instance state, so a prototype instance is enough.
  const guard = Object.create(
    UserThrottlerGuard.prototype,
  ) as UserThrottlerGuard & {
    getTracker(req: unknown): Promise<string>;
  };

  it('keys by user id when authenticated', async () => {
    await expect(guard.getTracker({ user: { id: 'u1' }, ip: '9.9.9.9' })).resolves.toBe(
      'user:u1',
    );
  });

  it('keys by ip when anonymous', async () => {
    await expect(guard.getTracker({ ip: '1.2.3.4' })).resolves.toBe('ip:1.2.3.4');
  });

  it('falls back to ip:unknown when neither is present', async () => {
    await expect(guard.getTracker({})).resolves.toBe('ip:unknown');
  });
});
```

Run: `npx jest user-throttler.guard.spec` → FAIL (module not found).

- [ ] **Step 3: Implement the guard** `src/common/guards/user-throttler.guard.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Keys the rate limit by the *verified* authenticated user (so concurrent users
 * behind one shared/NAT IP each get their own budget), falling back to the
 * client IP for anonymous routes (login/refresh). Relies on the global guard
 * order JwtAuthGuard -> UserThrottlerGuard, so `req.user` is set when present.
 *
 * The param is typed (not the base's `Record<string, any>`) — a valid bivariant
 * method override that keeps the body free of unsafe `any` access.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: {
    user?: { id?: string };
    ip?: string;
  }): Promise<string> {
    const userId = req.user?.id;
    return Promise.resolve(
      userId ? `user:${userId}` : `ip:${req.ip ?? 'unknown'}`,
    );
  }
}
```

Run: `npx jest user-throttler.guard.spec` → 3 PASS.

- [ ] **Step 4: typecheck + lint**

Run: `npm run typecheck && npm run lint:ci`
Expected: clean (the typed override compiles as a valid override of `getTracker(req: Record<string, any>)`; no `no-unsafe-*` warnings since `req` is a typed interface). If TS rejects the override signature, widen the param to `Record<string, any>` and read via a local typed cast: `const u = req.user as { id?: string } | undefined; const ip = req.ip as string | undefined;` — then the same body. Re-run.

- [ ] **Step 5: Commit**

```bash
git add src/common/guards/user-throttler.guard.ts src/common/guards/user-throttler.guard.spec.ts
git commit -m "feat(throttle): UserThrottlerGuard keys the rate limit by verified user (ip fallback)"
```

---

## Task 2: Wire the guard, reorder, per-route limits, env, e2e

**Files:** `src/app.module.ts`, `src/auth/auth.controller.ts`, `src/config/env.validation.ts`, `docs/runbooks/deploy.md`; Test: `test/throttle.e2e-spec.ts`

- [ ] **Step 1: Write the failing e2e** `test/throttle.e2e-spec.ts` (fresh app ⇒ fresh in-memory throttle store; the login-cap test runs first so the login bucket is pristine). Mirror an existing e2e bootstrap (Test module + ValidationPipe + AllExceptionsFilter + makePrismaOverride + startTestDb):

```ts
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { UsersService } from '../src/users/users.service';
import { AuthService } from '../src/auth/auth.service';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Throttle policy (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let token: string;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = makePrismaOverride(db.url);
    await prisma.$connect();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService).useValue(prisma).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.get(UsersService).create({
      email: 'thr@test.io', password: 'secret123', name: 'Thr', role: 'ADMIN',
    });
    // direct service login (NOT via HTTP) so it doesn't consume the login bucket
    token = (await app.get(AuthService).login('thr@test.io', 'secret123')).accessToken;
  }, 120_000);

  afterAll(async () => { await app.close(); await prisma.$disconnect(); await db?.stop(); });

  it('caps brute-force login at 10/min per IP (11th is 429)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(app.getHttpServer() as App)
        .post('/auth/login')
        .send({ email: 'thr@test.io', password: 'wrong-password' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true); // bad creds, under the cap
    expect(statuses[10]).toBe(429); // 11th blocked by the login throttle
  });

  it('a normal low-volume authenticated request is not throttled', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});
```

Run: `npm run test:e2e -- throttle` → FAIL (login currently caps at 100, not 10 → the 11th is still 401, not 429).

- [ ] **Step 2: Reorder the guard chain + swap in `UserThrottlerGuard` + per-user limit** in `src/app.module.ts`:
  - Change the import from `import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';` to `import { ThrottlerModule } from '@nestjs/throttler';` and add `import { UserThrottlerGuard } from './common/guards/user-throttler.guard';`.
  - Change the `forRoot` line to: `ThrottlerModule.forRoot([{ ttl: 60_000, limit: Number(process.env.THROTTLE_LIMIT) || 300 }]),`.
  - Change the `providers` array order + the throttler class:
```ts
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
```
(`JwtAuthGuard` first so `req.user` is set before `UserThrottlerGuard` keys.)

- [ ] **Step 3: Strict `@Throttle` overrides on login/refresh** in `src/auth/auth.controller.ts`:
  - Add `import { Throttle } from '@nestjs/throttler';`.
  - On `login`, above `@Post('login')`:
```ts
  @Throttle({ default: { ttl: 60_000, limit: Number(process.env.THROTTLE_LOGIN_LIMIT) || 10 } })
```
  - On `refresh`, above `@Post('refresh')`:
```ts
  @Throttle({ default: { ttl: 60_000, limit: Number(process.env.THROTTLE_REFRESH_LIMIT) || 30 } })
```

- [ ] **Step 4: env vars** in `src/config/env.validation.ts` — add to `EnvVars` (the `IsOptional`/`IsInt`/`Min` decorators are already imported from earlier work):
```ts
  @IsOptional() @IsInt() @Min(1) THROTTLE_LIMIT?: number;
  @IsOptional() @IsInt() @Min(1) THROTTLE_LOGIN_LIMIT?: number;
  @IsOptional() @IsInt() @Min(1) THROTTLE_REFRESH_LIMIT?: number;
```

- [ ] **Step 5: deploy runbook** — in `docs/runbooks/deploy.md`, the "Optional:" env line (under Prerequisites) — append `THROTTLE_LIMIT` (per-user, default 300), `THROTTLE_LOGIN_LIMIT` (per-IP login cap, default 10), `THROTTLE_REFRESH_LIMIT` (per-IP, default 30) to the list of optional vars.

- [ ] **Step 6: Run the throttle e2e — expect PASS**

Run: `npm run test:e2e -- throttle` → 2 pass (11th login → 429; authed /auth/me → 200).

- [ ] **Step 7: Full regression**

Run: `npm run typecheck && npm run lint:ci && npm test && npm run test:e2e`
Expected: typecheck/lint clean; unit 36/36 (35 + the 3 guard cases land in 1 new suite → suites +1); **full e2e green** — the reorder + per-user keying + the strict login cap must not break any suite. Most suites get tokens via `AuthService.login()` (direct, un-throttled); if any suite makes >10 HTTP `POST /auth/login` calls in 60s from the loopback IP it would now 429 — investigate (it almost certainly uses the direct service path). Run the full e2e TWICE to confirm stability (the throttle store is per-app, so no cross-suite bleed, but confirm).

- [ ] **Step 8: Commit**

```bash
git add src/app.module.ts src/auth/auth.controller.ts src/config/env.validation.ts docs/runbooks/deploy.md test/throttle.e2e-spec.ts
git commit -m "feat(throttle): per-user keying + reorder, strict login/refresh caps, env-tunable limits"
```

---

## Self-review (against the spec)

**Spec coverage:**
- §3.1 reorder APP_GUARD (JwtAuthGuard → UserThrottlerGuard → RolesGuard) → Task 2 Step 2 ✓
- §3.2 UserThrottlerGuard getTracker (verified user / ip fallback) → Task 1 ✓
- §3.3 global default per-user limit + @Throttle login/refresh overrides → Task 2 Steps 2-3 ✓
- §4 env-tunable limits (300/10/30; THROTTLE_LIMIT/LOGIN/REFRESH) → Task 2 Steps 2-4 ✓
- §5 tests (getTracker unit; login-cap e2e 11th→429; authed request not throttled; full regression) → Tasks 1 & 2 ✓
- §7 deploy.md env list → Task 2 Step 5 ✓

**Placeholder scan:** none — full code/commands in every step. The Task 1 Step 4 fallback (widen param + cast) is an explicit alternative for the unlikely TS override-rejection case, not a TBD.

**Type consistency:** `UserThrottlerGuard` name + the `getTracker` param shape (`{ user?: { id?: string }; ip?: string }`) match across the guard, its spec, and the app.module wiring; the env names `THROTTLE_LIMIT`/`THROTTLE_LOGIN_LIMIT`/`THROTTLE_REFRESH_LIMIT` match across env.validation, app.module forRoot, the auth.controller `@Throttle`, and deploy.md; the `default` named-throttler key in `@Throttle({ default: … })` matches the single unnamed `forRoot` throttler (default name).
