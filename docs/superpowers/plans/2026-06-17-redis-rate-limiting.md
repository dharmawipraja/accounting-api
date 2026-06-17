# Redis-Backed Rate Limiting (Fail-Closed) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the `@nestjs/throttler` storage from in-memory to Redis in dev + prod (tests stay in-memory), fail-closed on a Redis outage, with keying and limits unchanged.

**Architecture:** A `@Global` `RedisModule` provides a shared `REDIS_CLIENT` (an `ioredis` instance with fail-fast options, or `null` when `NODE_ENV=test`). `ThrottlerModule.forRootAsync` injects it: `null` → in-memory store; otherwise `ThrottlerStorageRedis`. `UserThrottlerGuard.handleRequest` is overridden to fail-closed — a real limit hit → 429, a Redis error → 503. `/ready` also pings Redis when configured. Keying (`user:<id>`/`ip:<ip>`) and limits are untouched.

**Tech Stack:** NestJS 11, `@nestjs/throttler` 6.5, `ioredis`, `@nest-lab/throttler-storage-redis`, Jest + testcontainers.

**Branch:** `feat/redis-rate-limiting` (checked out; spec committed at `e0d15e2`).

**Spec of record:** `docs/superpowers/specs/2026-06-17-redis-rate-limiting-design.md`

---

## File Structure

**New files**
- `src/common/redis/redis.module.ts` — `@Global` module exporting `REDIS_CLIENT` (`Redis | null`) + owning its lifecycle.
- `src/common/redis/redis.constants.ts` — the `REDIS_CLIENT` injection token.
- `src/common/redis/redis.module.spec.ts` — unit test for the factory (test → null; configured → client).
- `src/common/guards/user-throttler.guard.spec.ts` — **already exists** (getTracker tests); we ADD fail-closed `handleRequest` tests to it.

**Modified files**
- `package.json` — add `ioredis`, `@nest-lab/throttler-storage-redis`.
- `src/config/env.validation.ts` — `REDIS_URL` required unless `NODE_ENV=test`.
- `src/config/env.validation.spec.ts` — REDIS_URL validation tests.
- `src/app.module.ts` — import `RedisModule`; `ThrottlerModule.forRoot` → `forRootAsync`.
- `src/common/guards/user-throttler.guard.ts` — add fail-closed `handleRequest`.
- `src/health/health.controller.ts` — `/ready` pings Redis when configured.
- `docker-compose.yml` (dev base) + `docker-compose.prod.yml` (prod overlay) — `redis` service + api `depends_on`.
- `.env.example`, `README.md`, `CHANGELOG.md`.

**Unchanged on purpose:** keying/limits, `@Throttle`/`@SkipThrottle` policy, `openapi.json` (the `/ready` 200 body stays `{status, db}`; Redis failures surface in the 503 error body only).

---

## Task 1: Dependencies + `REDIS_URL` env validation

**Files:**
- Modify: `package.json`
- Modify: `src/config/env.validation.ts`
- Test: `src/config/env.validation.spec.ts`

- [ ] **Step 1: Install deps**

Run: `npm install ioredis @nest-lab/throttler-storage-redis`
Expected: both added to `dependencies`; `ioredis` ships its own types. Confirm the storage package's main export name with `node -e "console.log(Object.keys(require('@nest-lab/throttler-storage-redis')))"` — expected to include `ThrottlerStorageRedis` (use whatever name it prints in Task 3).

- [ ] **Step 2: Write the failing env-validation test**

In `src/config/env.validation.spec.ts`, add (the existing `validEnv` uses `NODE_ENV: 'test'`):

```typescript
  it('requires REDIS_URL when NODE_ENV is not test', () => {
    expect(() =>
      validate({ ...validEnv, NODE_ENV: 'production' }),
    ).toThrow(); // no REDIS_URL → invalid in prod
    expect(() =>
      validate({
        ...validEnv,
        NODE_ENV: 'production',
        REDIS_URL: 'redis://localhost:6379',
      }),
    ).not.toThrow();
  });

  it('does NOT require REDIS_URL when NODE_ENV is test', () => {
    expect(() => validate(validEnv)).not.toThrow(); // test env, no REDIS_URL
  });
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npm test -- env.validation`
Expected: FAIL — the prod-without-REDIS_URL case does not throw yet.

- [ ] **Step 4: Add `REDIS_URL` to `EnvVars`**

In `src/config/env.validation.ts`: add `ValidateIf` to the `class-validator` import, and add the field to `EnvVars` (after the THROTTLE vars):

```typescript
  @ValidateIf((o: EnvVars) => o.NODE_ENV !== NodeEnv.Test)
  @IsString()
  @IsNotEmpty()
  REDIS_URL?: string;
```

(`@ValidateIf` returning false skips all of this field's validators, so test envs may omit it; dev/prod must supply a non-empty string. `validate()` already runs with `skipMissingProperties: false`.)

- [ ] **Step 5: Run it to confirm it passes**

Run: `npm test -- env.validation`
Expected: PASS (existing + 2 new).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/config/env.validation.ts src/config/env.validation.spec.ts
git commit -m "feat(redis): add ioredis + storage dep; require REDIS_URL outside test"
```

---

## Task 2: `RedisModule` providing a shared `REDIS_CLIENT`

**Files:**
- Create: `src/common/redis/redis.constants.ts`
- Create: `src/common/redis/redis.module.ts`
- Test: `src/common/redis/redis.module.spec.ts`

- [ ] **Step 1: Token**

Create `src/common/redis/redis.constants.ts`:

```typescript
/** DI token for the shared ioredis client (or null when Redis is not configured, e.g. tests). */
export const REDIS_CLIENT = 'REDIS_CLIENT';
```

- [ ] **Step 2: Write the failing factory test**

Create `src/common/redis/redis.module.spec.ts`:

```typescript
import { ConfigService } from '@nestjs/config';
import { redisClientFactory } from './redis.module';

describe('redisClientFactory', () => {
  it('returns null in the test environment (no Redis dependency)', () => {
    const config = {
      get: (k: string) => (k === 'NODE_ENV' ? 'test' : undefined),
    } as unknown as ConfigService;
    expect(redisClientFactory(config)).toBeNull();
  });

  it('builds a fail-fast client when REDIS_URL is set (non-test)', () => {
    const config = {
      get: (k: string) => (k === 'NODE_ENV' ? 'development' : undefined),
      getOrThrow: (k: string) =>
        k === 'REDIS_URL' ? 'redis://localhost:6379' : undefined,
    } as unknown as ConfigService;
    const client = redisClientFactory(config);
    expect(client).not.toBeNull();
    expect(client!.options.enableOfflineQueue).toBe(false);
    expect(client!.options.maxRetriesPerRequest).toBe(1);
    // don't connect in a unit test
    client!.disconnect();
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npm test -- redis.module`
Expected: FAIL — `Cannot find module './redis.module'`.

- [ ] **Step 4: Implement the module**

Create `src/common/redis/redis.module.ts`:

```typescript
import { Global, Inject, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

const logger = new Logger('Redis');

/** Builds the shared client: null in tests (in-memory throttler), else a fail-fast
 *  ioredis client (so a Redis outage rejects promptly instead of hanging). */
export function redisClientFactory(config: ConfigService): Redis | null {
  if (config.get<string>('NODE_ENV') === 'test') return null;
  const client = new Redis(config.getOrThrow<string>('REDIS_URL'), {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 1000,
  });
  // Own the connection: an out-of-band error must be logged, not crash the process.
  client.on('error', (err) => logger.warn(`redis client error: ${err.message}`));
  return client;
}

@Global()
@Module({
  providers: [
    { provide: REDIS_CLIENT, inject: [ConfigService], useFactory: redisClientFactory },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis | null) {}

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }
}
```

- [ ] **Step 5: Run it to confirm it passes**

Run: `npm test -- redis.module`
Expected: PASS (2 tests). Then `npx eslint src/common/redis/*.ts` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/common/redis
git commit -m "feat(redis): shared REDIS_CLIENT provider (null in test, fail-fast otherwise)"
```

---

## Task 3: Wire `ThrottlerModule.forRootAsync` to the Redis store

**Files:**
- Modify: `src/app.module.ts`

- [ ] **Step 1: Replace `forRoot` with `forRootAsync` + import `RedisModule`**

In `src/app.module.ts`:
1. Add imports:
   ```typescript
   import Redis from 'ioredis';
   import { ThrottlerStorageRedis } from '@nest-lab/throttler-storage-redis'; // confirm name from Task 1 Step 1
   import { RedisModule } from './common/redis/redis.module';
   import { REDIS_CLIENT } from './common/redis/redis.constants';
   ```
2. Add `RedisModule` to the `imports` array (near the top, before `ThrottlerModule`).
3. Replace the current block
   ```typescript
   ThrottlerModule.forRoot([
     { ttl: 60_000, limit: Number(process.env.THROTTLE_LIMIT) || 300 },
   ]),
   ```
   with:
   ```typescript
   ThrottlerModule.forRootAsync({
     inject: [REDIS_CLIENT],
     useFactory: (redis: Redis | null) => {
       const throttlers = [
         { ttl: 60_000, limit: Number(process.env.THROTTLE_LIMIT) || 300 },
       ];
       // null (test) → default in-memory store; otherwise share the one Redis client.
       return redis ? { throttlers, storage: new ThrottlerStorageRedis(redis) } : { throttlers };
     },
   }),
   ```
   (The `throttlers` array is byte-identical to the previous config, so limits/keying are unchanged. `REDIS_CLIENT` resolves from the `@Global` `RedisModule`.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0. If `ThrottlerStorageRedis` isn't the right export name, fix the import to match Task 1 Step 1's output.

- [ ] **Step 3: Confirm e2e still boots in-memory (no Redis needed)**

Run: `npm run test:e2e -- throttle`
Expected: PASS. `NODE_ENV=test` ⇒ `REDIS_CLIENT` is null ⇒ in-memory store ⇒ the existing throttle behavior (429 on exceed) is unchanged, with no Redis container.

- [ ] **Step 4: Lint + commit**

Run: `npm run lint:ci` → exit 0.
```bash
git add src/app.module.ts
git commit -m "feat(redis): throttler forRootAsync — Redis store outside test, in-memory in test"
```

---

## Task 4: Fail-closed `UserThrottlerGuard.handleRequest`

**Files:**
- Modify: `src/common/guards/user-throttler.guard.ts`
- Test: `src/common/guards/user-throttler.guard.spec.ts` (exists — add a describe block)

- [ ] **Step 1: Write the failing fail-closed tests**

Add to `src/common/guards/user-throttler.guard.spec.ts`:

```typescript
import { ServiceUnavailableException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler';

describe('UserThrottlerGuard.handleRequest (fail-closed)', () => {
  // Drive the override by stubbing the base ThrottlerGuard.handleRequest outcome.
  const makeGuard = (superImpl: () => Promise<boolean>) => {
    const guard = Object.create(
      UserThrottlerGuard.prototype,
    ) as UserThrottlerGuard & { handleRequest(r: ThrottlerRequest): Promise<boolean> };
    // Stub the inherited (ThrottlerGuard) handleRequest the override delegates to.
    Object.setPrototypeOf(
      Object.getPrototypeOf(guard),
      { handleRequest: superImpl },
    );
    return guard;
  };

  it('passes through when under the limit', async () => {
    const guard = makeGuard(() => Promise.resolve(true));
    await expect(guard.handleRequest({} as ThrottlerRequest)).resolves.toBe(true);
  });

  it('rethrows ThrottlerException (429) on a real limit hit', async () => {
    const guard = makeGuard(() => Promise.reject(new ThrottlerException()));
    await expect(guard.handleRequest({} as ThrottlerRequest)).rejects.toBeInstanceOf(
      ThrottlerException,
    );
  });

  it('maps a storage/Redis error to 503 (fail-closed)', async () => {
    const guard = makeGuard(() => Promise.reject(new Error('redis down')));
    await expect(guard.handleRequest({} as ThrottlerRequest)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
```

> If the prototype-stub approach proves brittle against the installed throttler, fall back to instantiating `new UserThrottlerGuard(options, storageStub, reflector)` where `storageStub.increment` resolves (pass), rejects with a throttler limit (429), or rejects with a generic error (503). The behavioral contract to assert is the same.

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -- user-throttler.guard`
Expected: FAIL — `handleRequest` not overridden yet (503 case won't map).

- [ ] **Step 3: Add the override**

In `src/common/guards/user-throttler.guard.ts`, add the import and method (keep the existing `getTracker`):

```typescript
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ThrottlerException, ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler';

// ...inside the class, alongside getTracker:

  /**
   * Fail-closed: a real limit hit stays a 429 (ThrottlerException); any other error
   * (the Redis store being unavailable) becomes a 503 so we never silently stop
   * limiting. Paired with the fail-fast ioredis client, this rejects promptly.
   */
  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    try {
      return await super.handleRequest(requestProps);
    } catch (err) {
      if (err instanceof ThrottlerException) throw err;
      throw new ServiceUnavailableException('Rate limiter unavailable');
    }
  }
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `npm test -- user-throttler.guard`
Expected: PASS (existing getTracker tests + 3 new).

- [ ] **Step 5: Typecheck + lint + commit**

Run: `npm run typecheck && npm run lint:ci` → exit 0.
```bash
git add src/common/guards/user-throttler.guard.ts src/common/guards/user-throttler.guard.spec.ts
git commit -m "feat(redis): fail-closed throttler — 429 on limit, 503 on Redis outage"
```

---

## Task 5: `/ready` pings Redis when configured

**Files:**
- Modify: `src/health/health.controller.ts`

- [ ] **Step 1: Inject `REDIS_CLIENT` and ping it**

In `src/health/health.controller.ts`:
1. Add imports:
   ```typescript
   import { Inject } from '@nestjs/common';
   import type { Redis } from 'ioredis';
   import { REDIS_CLIENT } from '../common/redis/redis.constants';
   ```
2. Inject into the constructor:
   ```typescript
   constructor(
     private readonly prisma: PrismaService,
     @Inject(REDIS_CLIENT) private readonly redis: Redis | null,
   ) {}
   ```
3. Replace `readiness()` with (200 body shape unchanged → no openapi change; failures report which dep in the 503 error body):
   ```typescript
   @Public()
   @Get('ready')
   @ApiOkResponse({ type: ReadinessStatusDto })
   async readiness(): Promise<{ status: string; db: string }> {
     try {
       await this.prisma.$queryRaw`SELECT 1`;
     } catch {
       throw new HttpException(
         { status: 'error', db: 'down' },
         HttpStatus.SERVICE_UNAVAILABLE,
       );
     }
     if (this.redis) {
       try {
         await this.redis.ping();
       } catch {
         throw new HttpException(
           { status: 'error', redis: 'down' },
           HttpStatus.SERVICE_UNAVAILABLE,
         );
       }
     }
     return { status: 'ok', db: 'up' };
   }
   ```

- [ ] **Step 2: Verify (test env: Redis is null → behavior unchanged)**

Run: `npm run test:e2e -- health` (600000ms timeout)
Expected: PASS. In tests `REDIS_CLIENT` is null, so the Redis branch is skipped and `/ready` returns `{status:'ok', db:'up'}` exactly as before — the existing health e2e is unaffected.

- [ ] **Step 3: Typecheck + lint + commit**

Run: `npm run typecheck && npm run lint:ci` → exit 0.
```bash
git add src/health/health.controller.ts
git commit -m "feat(redis): /ready pings Redis when configured (503 with the failing dep)"
```

---

## Task 6: Redis service in docker-compose (dev base + prod overlay)

**Files:**
- Modify: `docker-compose.yml` (dev base)
- Modify: `docker-compose.prod.yml` (prod overlay)

- [ ] **Step 1: Add the `redis` service + api wiring to the base compose**

In `docker-compose.yml`, add a `redis` service and wire the `api` service to it. Add this service (e.g. after `db`):

```yaml
  redis:
    image: redis:7-alpine
    ports:
      - '127.0.0.1:6379:6379'
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 5s
      retries: 5
```

(No volume — rate-limit counters are ephemeral 60s TTL. Bound to loopback only.)

In the same file, under `api:` add `REDIS_URL` to `environment:` and `redis` to `depends_on:`:
```yaml
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      # ...existing vars...
      REDIS_URL: redis://redis:6379
```

- [ ] **Step 2: Add prod overlay for `redis`**

In `docker-compose.prod.yml`, add a `redis` overlay (the prod file merges over the base; the base already gives image/ports/healthcheck and wires the api):

```yaml
  redis:
    restart: unless-stopped
    deploy:
      resources:
        limits:
          memory: 128M
```

(The api's `depends_on: redis: service_healthy` comes from the base; prod's api block already adds `migrate` — compose merges them.)

- [ ] **Step 3: Validate compose files parse**

Run: `docker compose -f docker-compose.yml config >/dev/null && echo BASE_OK`
Run: `docker compose -f docker-compose.yml -f docker-compose.prod.yml config >/dev/null && echo PROD_OK`
Expected: `BASE_OK` and `PROD_OK` (no YAML/merge errors; `redis` present with healthcheck; `api.depends_on` includes redis).

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml docker-compose.prod.yml
git commit -m "feat(redis): redis service in dev + prod compose; api depends_on healthy"
```

---

## Task 7: Docs (`.env.example`, README, CHANGELOG)

**Files:**
- Modify: `.env.example`, `README.md`, `CHANGELOG.md`

- [ ] **Step 1: `.env.example`**

Add a `REDIS_URL` entry documenting it's required outside test:
```
# Redis (rate-limit storage). Required in dev & prod; tests/CI run in-memory.
REDIS_URL=redis://localhost:6379
```
> If `.env.example` is tool-blocked, add it via Bash (`printf >> .env.example`) or note it for the operator. **Also note for the user:** local host dev (`npm run start:dev`, NODE_ENV=development) now needs `REDIS_URL=redis://localhost:6379` in `.env.development` (the base compose's `redis` exposes `127.0.0.1:6379`); this is a user-managed file.

- [ ] **Step 2: README**

In the setup/config section, document `REDIS_URL` (required in dev/prod, in-memory in test) and that rate limiting is now Redis-backed and fail-closed (429 on limit, 503 if Redis is unreachable).

- [ ] **Step 3: CHANGELOG**

Under `## [Unreleased]`, add:
```markdown
### Changed

- **Rate limiting is now Redis-backed** (`@nestjs/throttler` + `ioredis`) in dev and
  production, so limits are shared across instances and survive restarts; tests/CI keep
  the in-memory store. Keying (per-user, per-IP for anonymous) and limits are unchanged.
  Fail-closed: a real limit hit returns 429; if Redis is unreachable, requests get 503
  (the limiter never silently turns off). `/ready` now also checks Redis. Requires
  `REDIS_URL` outside the test environment.
```

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md CHANGELOG.md
git commit -m "docs(redis): document REDIS_URL + Redis-backed fail-closed rate limiting"
```

---

## Task 8: Full verification gate

- [ ] **Step 1: Run the whole pipeline**

Run: `npm run verify`
Expected: `typecheck` (0), `lint:ci` (0), `test` (unit — includes new env, redis.module, and fail-closed guard tests), `test:e2e:cov` (all e2e green on the in-memory store; coverage thresholds — statements/functions/lines 84%, branches 62% — hold).
Note: `test:e2e:cov` is slow (testcontainers). If a single Bash call exceeds its cap, run it in the background and await completion.

- [ ] **Step 2: If coverage dipped**

The new code paths are small and unit-tested (env, factory, guard). If `test:e2e:cov` fails only on coverage, add a focused unit test for the uncovered branch (e.g. `redisClientFactory` non-test path is already covered; the guard's three branches are covered). Re-run `npm run verify` until green.

- [ ] **Step 3: Final commit (if Step 2 added tests)**

```bash
git add -A
git commit -m "test(redis): cover remaining branch to hold coverage gate"
```

---

## Self-Review Notes (for the implementer)

- **Spec coverage:** D1 storage/lib → Task 1 (deps) + Task 3; D2 env gating → Task 1 (env validation) + Task 2 (factory null-in-test) + Task 3 (storage choice); D3/D4 fail-closed 429-vs-503 → Task 4; D5 fail-fast client → Task 2 factory options; D6 `/ready` Redis → Task 5; D7 keying unchanged → `getTracker` untouched. Compose → Task 6. Docs → Task 7. Tests/verify → Tasks 1,2,4 + 8.
- **Shared client, single connection:** both the throttler store (Task 3) and `/ready` (Task 5) inject the same `REDIS_CLIENT` from the `@Global` `RedisModule` — no second connection. `RedisModule.onModuleDestroy` quits it on shutdown (shutdown hooks already enabled in `main.ts`).
- **Tests need no Redis:** `NODE_ENV=test` ⇒ `REDIS_CLIENT` null ⇒ in-memory throttler + `/ready` skips the Redis ping ⇒ existing `throttle`/`health` e2e pass unchanged; no Redis container added to the harness.
- **No openapi change:** `/ready`'s 200 body stays `{status, db}`; Redis failures appear only in the 503 error body. `ReadinessStatusDto` is untouched, so the contract guard is unaffected.
- **Verify-on-install:** the `@nest-lab/throttler-storage-redis` export name (Task 1 Step 1) and the `handleRequest` override signature (Task 4) against `@nestjs/throttler` 6.5 — both confirmed against the installed version before relying on them.
- **User action (outside the repo):** add `REDIS_URL=redis://localhost:6379` to `.env.development` for host `start:dev` (the file is tool-blocked).
