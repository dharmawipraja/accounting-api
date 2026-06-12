# Throttle Policy Hardening — Design Spec

- **Date:** 2026-06-12
- **Status:** Approved (pending written-spec review)
- **Owner:** budi@maul.is
- **Builds on:** the feature-complete + production-hardened (WS1–WS4) accounting API. A backlog item the WS4 k6 load test surfaced. No application features change.

## 1. Problem

The global rate limiter is `ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])` — **100 req/60s keyed by source IP** (the `@nestjs/throttler` default), and the report/ledger/invoice hot paths are not `@SkipThrottle`. Two issues:
- **Shared office IP:** at "one company, heavier volume" all internal users likely share one NAT egress IP, so 100 req/min is a budget split across *everyone* — a few concurrent users browsing reports/lists hit 429s. The WS4 baseline showed a single-IP 20-VU burst returning ~88% 429 (underlying p95 ~8.5 ms — the limiter, not latency).
- **No brute-force limit on login:** `POST /auth/login` and `/refresh` are `@Public` and sit under the same global limit; there is no dedicated tight per-IP cap.

## 2. Decision

Key the general limit **per authenticated user** (not per IP), and add a **strict per-IP override on login**. Per-user keying requires `req.user` to be set at throttle time, so the global guard chain is reordered so auth runs first.

## 3. Mechanism

1. **Reorder the `APP_GUARD` chain** in `src/app.module.ts` from `ThrottlerGuard → JwtAuthGuard → RolesGuard` to **`JwtAuthGuard → UserThrottlerGuard → RolesGuard`**. (Global guards run in registration order.) `JwtAuthGuard` honors `@Public` (no user set for public routes) and verifies the JWT for authenticated routes, so `req.user` is populated (verified) before the throttler keys. JWT verification before throttling is cheap and acceptable at single-company scale.

2. **`UserThrottlerGuard extends ThrottlerGuard`** (`src/common/guards/user-throttler.guard.ts`) overriding the tracker:
```ts
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const userId = (req.user as { id?: string } | undefined)?.id;
    return Promise.resolve(userId ? `user:${userId}` : `ip:${String(req.ip)}`);
  }
}
```
Authenticated traffic → limited per **verified** `user.id` (shared IP irrelevant, no token-spoofing evasion since the id comes from a JwtAuthGuard-verified token); anonymous routes (login/refresh) → fall back to **per-IP**. Replaces the bare `ThrottlerGuard` as the `APP_GUARD`.

3. **One global `default` throttler** at the per-user budget, plus a **strict per-route override** on the auth endpoints via `@Throttle` in `src/auth/auth.controller.ts`:
```ts
@Throttle({ default: { ttl: 60_000, limit: Number(process.env.THROTTLE_LOGIN_LIMIT) || 10 } })  // on POST login
@Throttle({ default: { ttl: 60_000, limit: Number(process.env.THROTTLE_REFRESH_LIMIT) || 30 } }) // on POST refresh
```
Login/refresh are anonymous → IP-keyed; `@Throttle` gives each route its own per-route bucket, so the strict login cap is independent of the general budget.

`ThrottlerModule.forRoot([{ ttl: 60_000, limit: Number(process.env.THROTTLE_LIMIT) || 300 }])`.

**Regression-safety detail:** most e2e suites obtain tokens by calling `AuthService.login()` **directly** (a service call that never hits the controller/throttler), so the strict HTTP login limit does not trip them — only the dedicated throttle e2e exercises the HTTP login path. `@SkipThrottle` on `/health` + `/metrics` is unchanged.

## 4. Limits (env-tunable; defaults below)

| Scope | Default | Env var |
|---|---|---|
| Default, **per user** | 300 / 60s | `THROTTLE_LIMIT` |
| `POST /auth/login`, per IP | 10 / 60s | `THROTTLE_LOGIN_LIMIT` |
| `POST /auth/refresh`, per IP | 30 / 60s | `THROTTLE_REFRESH_LIMIT` |

`forRoot` and the `@Throttle` decorators read `process.env.*` at module-load with a numeric fallback (so a missing/garbage value safely defaults). Add the three to `EnvVars` as `@IsOptional @IsInt @Min(1)` so a bad value is caught at boot.

## 5. Testing

- **Unit** (`src/common/guards/user-throttler.guard.spec.ts`): `getTracker({ user: { id: 'u1' } })` → `'user:u1'`; `getTracker({ ip: '1.2.3.4' })` → `'ip:1.2.3.4'`.
- **e2e** (`test/throttle.e2e-spec.ts`, fresh app = fresh in-memory store): 11 rapid `POST /auth/login` with bad creds → the first 10 are 401, the **11th is 429** (strict login cap bites); a normal low-volume authenticated request still returns its usual status (not 429).
- **Regression:** the full **143 e2e + 35 unit** stay green with the reorder + per-user keying (proves the guard-order change and the login cap don't break existing auth/RBAC/throttle behavior, and that suites using `AuthService.login()` directly are unaffected).

## 6. Build sequence (for the plan)

1. **`UserThrottlerGuard` + unit test** — the keyed guard.
2. **Wire it + reorder + limits** — `app.module.ts` (reorder `APP_GUARD`, swap in `UserThrottlerGuard`, `THROTTLE_LIMIT`), `auth.controller.ts` (`@Throttle` on login/refresh), `env.validation.ts` (3 optional vars) + the throttle e2e + full regression.

(Small enough to be one or two tasks.)

## 7. Notes / out of scope

- In-memory throttle store is correct for the single instance (no Redis). If the app is ever scaled horizontally, switch to `@nest-lab/throttler-storage-redis`.
- This does not change `@SkipThrottle` on health/metrics, nor any application behavior.
- The deploy runbook's env list should gain the three optional `THROTTLE_*` vars (a one-line doc follow-up, included in the plan).
