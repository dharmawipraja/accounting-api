# Design: Redis-Backed Rate Limiting (Fail-Closed)

- **Date:** 2026-06-17
- **Status:** Approved (design); pending spec review → implementation plan
- **Type:** Infrastructure / hardening (no API surface change)
- **Repo:** `accounting-api` (NestJS 11 + `@nestjs/throttler` 6.5, single-VM, behind Caddy)

## 1. Context & Motivation

Rate limiting currently uses `@nestjs/throttler` with the **default in-memory store** and a
custom `UserThrottlerGuard` that keys by authenticated user (`user:<id>`) or, for anonymous
routes, client IP (`ip:<ip>`). In-memory storage is correct for one app instance, but the
counters are **per-process**: they are not shared across instances and do not survive a
restart. Moving the throttler's storage to **Redis** makes the limit shared and durable —
the prerequisite for ever running more than one app instance, and it removes the
restart-resets-the-counter gap. This change moves **only the storage**; keying and limits
are unchanged.

## 2. Goals / Non-Goals

**Goals**
- Back the throttler with Redis in dev + prod; keep tests/CI on the in-memory store.
- Preserve the exact keying (`user:<id>` / `ip:<ip>`) and all limits/overrides.
- **Fail-closed** at runtime: if Redis is unavailable, reject rather than silently stop limiting.
- Make readiness reflect the new hard dependency.

**Non-Goals**
- No caching, sessions, or job queue (Redis is used for rate limiting only).
- No change to keying, limits, or the `@Throttle`/`@SkipThrottle` policy.
- No multi-instance deployment in this change (this only makes it *possible* later).
- No OpenAPI/response-shape change (429/503 use the existing error envelope).

## 3. Decisions

| # | Decision | Choice | Why |
|---|----------|--------|-----|
| D1 | Storage | **Redis** via `@nest-lab/throttler-storage-redis` + `ioredis` | Maintained Redis adapter for `@nestjs/throttler` v6; shared + durable counters |
| D2 | Environment gating | **Required in dev + prod; in-memory in test** (`REDIS_URL` required unless `NODE_ENV=test`) | Real storage where the app actually runs; no Redis container in the test/CI harness |
| D3 | Runtime failure mode | **Fail-closed** | User decision — abuse protection is never silently off |
| D4 | Status codes | Limit exceeded → **429**; Redis unavailable → **503** | A dependency outage is not "you exceeded your quota"; distinct + clearer for clients/dashboards |
| D5 | Outage latency | **Fail fast** (`enableOfflineQueue: false`, low `maxRetriesPerRequest`, `commandTimeout`) | Fail-closed must reject promptly, not hang on connection retries |
| D6 | Readiness | `/ready` also PINGs Redis (non-test) | Redis is now a hard dependency; readiness should reflect it |
| D7 | Keying | **Unchanged** (`UserThrottlerGuard`) | Out of scope; only storage moves |

## 4. Detailed Design

### 4.1 Scope — what stays the same
`UserThrottlerGuard.getTracker` (user-or-IP keying) is unchanged. Limits are unchanged:
global `300 / 60s` (`THROTTLE_LIMIT`), `POST /v1/auth/login` `10 / 60s`
(`THROTTLE_LOGIN_LIMIT`), `POST /v1/auth/refresh` `30 / 60s` (`THROTTLE_REFRESH_LIMIT`),
and `@SkipThrottle()` on `/health`, `/ready`, `/metrics`. Only the storage backend changes.

### 4.2 Dependencies & environment validation
- Add deps: `@nest-lab/throttler-storage-redis`, `ioredis`.
- `src/config/env.validation.ts` (`EnvVars`): add `REDIS_URL`, required **unless** test:
  ```ts
  @ValidateIf((o: EnvVars) => o.NODE_ENV !== NodeEnv.Test)
  @IsString()
  @IsNotEmpty()
  REDIS_URL?: string;
  ```
  Dev (`.env.development`) and prod (Docker env) must supply it; the test harness
  (`test/setup-env.ts`, `NODE_ENV=test`) does not.

### 4.3 Throttler module wiring
Convert `ThrottlerModule.forRoot([...])` to `forRootAsync` (it needs `ConfigService` /
`NODE_ENV` to choose the store). Pseudostructure:
```ts
ThrottlerModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const throttlers = [{ ttl: 60_000, limit: Number(process.env.THROTTLE_LIMIT) || 300 }];
    if (config.get('NODE_ENV') === 'test') {
      return { throttlers }; // default in-memory store
    }
    const redis = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      enableOfflineQueue: false,     // fail fast when disconnected
      maxRetriesPerRequest: 1,
      commandTimeout: 1000,
      lazyConnect: false,
    });
    return { throttlers, storage: new ThrottlerStorageRedis(redis) };
  },
});
```
Keep the exact `throttlers` array (same ttl/limit) in both branches so behaviour is identical;
only `storage` differs. The `ioredis` instance is owned here; register an `'error'` listener
(log, don't crash — mirrors `PrismaService`'s pool error handling) and disconnect on shutdown.

### 4.4 Fail-closed guard behavior
Override `handleRequest` in `UserThrottlerGuard` to distinguish "limit exceeded" from
"storage unavailable":
```ts
async handleRequest(req: ThrottlerRequest): Promise<boolean> {
  try {
    return await super.handleRequest(req);
  } catch (err) {
    if (err instanceof ThrottlerException) throw err;            // 429 — real limit hit
    throw new ServiceUnavailableException('Rate limiter unavailable'); // 503 — Redis down
  }
}
```
`super.handleRequest` is where the base guard calls `storage.increment(...)` and throws
`ThrottlerException` (429) on limit. A Redis error surfaces there as a non-`ThrottlerException`
→ mapped to **503**. Combined with the fail-fast client (D5), this rejects promptly.
`AllExceptionsFilter` already maps `HttpException.getStatus()`, so 429 and 503 flow through
the standard error envelope (no filter change). (Confirm the exact `handleRequest` signature
against `@nestjs/throttler` 6.5 at implementation time.)

### 4.5 Readiness probe
`HealthController` `GET /ready` currently does `prisma.$queryRaw\`SELECT 1\``. Add a Redis
`PING` when Redis is configured (non-test): if either DB or Redis is unreachable, `/ready`
returns 503 with which dependency failed. `/health` (liveness) stays as-is (no external deps).
The Redis client used by `/ready` is the same module-provided instance (inject it), not a new
connection.

### 4.6 Deployment (docker-compose)
- Add a `redis` service (`redis:7-alpine`) to **`docker-compose.yml`** (dev) and
  **`docker-compose.prod.yml`** (prod), each with `healthcheck: redis-cli ping`.
- Prod `api` gains `depends_on: { redis: { condition: service_healthy } }` (so boot waits for
  Redis — boot-time hard dependency).
- Counters are ephemeral (60s TTL) → **no persistence** (no AOF/RDB, no volume). Redis is not
  published to the host; it lives on the internal compose network.
- `REDIS_URL`: `redis://redis:6379` (prod compose), `redis://localhost:6379` (dev
  `.env.development`). Optional `requirepass` is out of scope (internal network only); note it
  as a future hardening option.

### 4.7 Config/docs
`.env.example` + README document `REDIS_URL` (and that test/CI don't need it). CHANGELOG
`[Unreleased]` entry. No `openapi.json` regeneration needed (no request/response shape change).

## 5. Testing

- **Unit** — `UserThrottlerGuard.handleRequest`: (a) under limit → passes; (b) `ThrottlerException`
  from `super` → 429 rethrown; (c) generic/Redis error from `super` → `ServiceUnavailableException`
  (503). Mock the super behavior / storage; no real Redis.
- **e2e** — unchanged: `NODE_ENV=test` ⇒ in-memory store, so `test/throttle.e2e-spec.ts` keeps
  passing with no Redis container. Add an assertion (if not present) that the policy still
  yields 429 on exceed.
- **env.validation** unit test: `REDIS_URL` required when `NODE_ENV` is dev/prod, optional when
  test.
- Full `npm run verify` green; coverage thresholds hold.

## 6. Risks & Mitigations

- **Fail-closed turns a Redis blip into user-facing 503s.** Accepted (D3). Mitigated by
  boot-time `depends_on healthy`, fail-fast client (no hangs), `/ready` reflecting Redis so the
  orchestrator can react, and a log/metric on storage errors for visibility.
- **`ioredis` offline-queue hang.** Mitigated by `enableOfflineQueue: false` + `commandTimeout`.
- **Throttler v6 `handleRequest` signature drift.** Verify the override signature against the
  installed version during implementation; fall back to wrapping the storage if the guard hook
  differs.
- **Dev friction (Redis now required for dev).** Mitigated: the dev compose provides Redis;
  tests/CI don't need it.

## 7. Build Sequence

1. Deps (`ioredis`, `@nest-lab/throttler-storage-redis`) + `REDIS_URL` env validation.
2. `ThrottlerModule.forRootAsync` (test → in-memory; else Redis + fail-fast client) + owned
   client lifecycle.
3. `UserThrottlerGuard.handleRequest` fail-closed (429 vs 503) + unit tests.
4. `/ready` Redis PING.
5. Compose: `redis` service (dev + prod) + prod `depends_on`.
6. Docs (`.env.example`, README, CHANGELOG).
7. `npm run verify` (e2e on in-memory) green.
