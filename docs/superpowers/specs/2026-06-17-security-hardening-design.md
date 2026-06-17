# Security & hardening cleanup — design

**Date:** 2026-06-17
**Branch:** `fix/security-hardening` (off `main` @ `b4e8253`)
**Source:** §2 of `docs/production-readiness-audit-2026-06-17.md` (the schema-light app/code/config items).

## Goal

Close out the §2 Security & hardening findings that are app-level, schema-free, and exercisable without the (still-absent) git remote or a live deployment. SEC-1 (refresh-token revocation — a schema feature) and the pure-infra items are deferred to their own follow-ups. Each fix is independent and lands as its own test-first commit.

## Scope

Six items: **SEC-2, SEC-3 (app-side), SEC-4, SEC-5, SEC-6, SEC-8.** One new runtime dependency (`@nestjs/schedule`, for SEC-2's purge); one new optional env var (`IDEMPOTENCY_COMPLETED_TTL_MS`). **No schema or migration changes.**

**Deferred (documented follow-ups, not implemented here):**
- **SEC-1** — refresh-token revocation/rotation (schema feature: `RefreshToken`/`jti` store or `tokenVersion`); its own spec next.
- **SEC-3 (infra)** — Caddy `trusted_proxies` / overwrite inbound `X-Forwarded-For`; the definitive IP-spoofing fix, needs a live deploy.
- **SEC-7** — revoke `UPDATE`/`DELETE` on `audit_log` from the app DB role (DB grant / trigger); needs deploy + DB-role management.

## Resolved decisions

1. **SEC-2 malformed-key status: 422** (`ValidationFailedError`), matching the existing missing-key rejection in the same interceptor — not 400. Consistency over the audit's loose "400" wording.
2. **SEC-4 allowed roles for the `GET`: `ADMIN` + `ACCOUNTANT`.** `APPROVER` and `VIEWER` get 403. (The `Role` enum is `ADMIN | ACCOUNTANT | APPROVER | VIEWER`, from `@prisma/client`.)
3. **SEC-6 decoy-hash fix: implemented now** (not documented-only), despite being Low — the change is small and removes the timing side-channel cleanly.

## Findings & approach

### SEC-2 — Idempotency-Key validation + scheduled purge of completed keys 🟡
**Files:** `src/common/idempotency/idempotency.interceptor.ts`, `src/common/idempotency/idempotency.service.ts`, a new `src/common/idempotency/idempotency-purge.service.ts`, `src/common/idempotency/idempotency.module.ts` (wire the purge service), `src/app.module.ts` (`ScheduleModule.forRoot()`), `src/config/env.validation.ts`, `package.json` (+`@nestjs/schedule`).

**Current:** the interceptor extracts the header (`idempotency.interceptor.ts:40–41`) and only checks presence (`:42–43`, throws `ValidationFailedError` → 422). The key is stored verbatim as the PK (`IdempotencyKey.key String @id`, no length cap). There is no TTL/cleanup of completed keys → authenticated abuse grows the table unbounded.

**Change:**
- **Validate:** before `reserve()` (`:61`), reject a key that is not length **1–128** matching **`^[A-Za-z0-9._:-]+$`** with `ValidationFailedError` (→ 422). UUIDs (the frontend default) pass; this bounds the PK and rejects oversized/garbage keys.
- **Purge:** add `@nestjs/schedule`; `ScheduleModule.forRoot()` in `AppModule`. New `IdempotencyPurgeService` with an `@Cron` (hourly) that calls a pure, testable `IdempotencyService.purgeCompleted(olderThanMs)` deleting rows where `completedAt < now − retention` (only completed keys; in-flight rows — `completedAt = null` — are never purged here, the FIN-L2 lazy-expiry owns those). Retention via new optional env `IDEMPOTENCY_COMPLETED_TTL_MS` (default **86_400_000 / 24h**), declared in `env.validation.ts` mirroring `IDEMPOTENCY_INFLIGHT_TTL_MS` (`@IsOptional @IsInt @Min(...)`).

**Acceptance:** a 129-char or bad-charset Idempotency-Key is rejected with 422 before any reservation; a valid UUID still works; `purgeCompleted` deletes completed keys older than the retention and leaves fresh completed and in-flight rows intact.

### SEC-3 (app-side) — Login throttle keyed by submitted email 🟡
**File:** `src/common/guards/user-throttler.guard.ts`.

**Current:** `getTracker` keys anonymous routes (login/refresh) by `ip:${req.ip}`. With a client-supplied `X-Forwarded-For` (Caddy does not overwrite it today), the perceived IP rotates and defeats the per-IP login limit.

**Change:** in `getTracker`, when the request is anonymous and carries a login email (`req.body?.email`), key by `login:${email.toLowerCase()}` **alone — not combined with the IP**. Combining with IP would let a rotating spoofed `X-Forwarded-For` restore a fresh per-(email, IP) budget and defeat the per-account limit; keying by email alone bounds account-targeted brute force **independent of the client IP**. Login already declares a per-route `@Throttle` (`auth.controller.ts:32`); only the tracker key changes. Refresh (no `email`, has `refreshToken`) keeps IP keying.

**Acceptance:** repeated logins for one email past the limit return 429 even when the client IP varies between requests.

**Scope note:** this app-side fix bounds *single-account* brute force (rotate IP, same email). *Multi-account spraying* (rotate email, same source) stays bounded only by the per-IP limit, which remains XFF-spoofable until the Caddy trusted-proxy config lands (deferred infra item above). If `req.body` is unavailable when `getTracker` runs (e.g. a future middleware-order change), login degrades to the current IP keying — safe, just less strict.

### SEC-4 — Role-gate company settings `GET` 🟡
**File:** `src/company/company.controller.ts`.

**Current:** `@Get()` (`:16`) has no `@Roles`; any authenticated role (incl. VIEWER) reads `npwp`, legal name, address, and the `segregationOfDutiesEnabled` / `isPkp` control flags. Only `@Patch()` is ADMIN-gated.

**Change:** add `@Roles(Role.ADMIN, Role.ACCOUNTANT)` to `get()`.

**Acceptance:** ADMIN and ACCOUNTANT receive 200; VIEWER and APPROVER receive 403.

### SEC-5 — Metrics guard fail-closed + constant-time compare ⚪
**File:** `src/metrics/metrics-token.guard.ts`.

**Current:** `if (!token) return true;` (`:15`) — fully public when `METRICS_TOKEN` is unset (fail-open), relying on Caddy. Plain `===` compare.

**Change:** NODE_ENV-aware fail-**closed** — when no token is configured, **deny (401) in production**, allow only in non-production (dev convenience); read `NODE_ENV` via the already-injected `ConfigService`. Replace `===` with a length-guarded `crypto.timingSafeEqual`.

**Acceptance:** production + unset token → 401; non-production + unset token → allowed; correct bearer → allowed; wrong bearer → 401 (constant-time compare).

### SEC-6 — Constant-time login (decoy hash) ⚪
**Files:** `src/auth/auth.service.ts`, `src/users/users.service.ts` (small helper).

**Current:** `login()` (`:22–30`) returns before any argon2 verify when the user is absent → timing side-channel (the message is already constant, so no message-based enumeration).

**Change:** always run a verify — against the user's real hash if present, else against a fixed module-level **decoy argon2id hash** (same OWASP params) — then branch on validity and `isActive`. Add a `UsersService` helper to verify a raw password against an arbitrary hash. The error message stays the constant "Invalid credentials".

**Acceptance:** a login attempt for a nonexistent user performs a hash verification (no early return) and returns the same error as a wrong password; existing login/refresh e2e stay green.

### SEC-8 — `npm audit` gate scope ⚪
**File:** `package.json`.

**Current:** `audit:ci` is `npm audit --omit=dev --audit-level=high` — ignores dev deps and moderate advisories.

**Change:** set `audit:ci` to `--audit-level=moderate` (prod deps); add a non-blocking `audit:dev` (full tree, `|| true`) for visibility.

**Acceptance:** `npm run audit:ci` enforces moderate+ on prod deps; `npm run audit:dev` reports without failing. **Caveat:** CI is not running yet (no remote), so this takes effect once CI is active.

## Testing strategy (TDD — RED first where there is behavior)

- **SEC-2** — unit on the key-validation rule (valid UUID accepted; 129-char, bad charset, empty rejected with 422 before `reserve`); **real-Postgres e2e** on `purgeCompleted` (manufacture an old completed key + a fresh completed key + an in-flight row → only the old completed row is deleted). DB-predicate logic gets a DB-backed test per the FIN-L2 lesson (mocked Prisma cannot validate a `where`).
- **SEC-3** — e2e: exceed the login limit for one email while varying the client IP → still 429.
- **SEC-4** — e2e: ADMIN/ACCOUNTANT 200; VIEWER/APPROVER 403.
- **SEC-5** — unit on the guard: prod+no-token deny, dev+no-token allow, right/wrong bearer.
- **SEC-6** — unit: nonexistent-user login runs a verify (assert the verify path is exercised) and returns the constant error; existing auth e2e stay green.
- **SEC-8** — none (script/config); verified by running the scripts locally.

## Delivery

- One small commit per finding (clean history, easy revert), each with its test.
- After each commit: `npm run typecheck`, `eslint --max-warnings 0` on changed files, and the relevant unit/e2e. Full unit + e2e suite before finishing.
- New e2e bootstraps call `enableVersioning` (URI, defaultVersion '1') per repo convention.
- Branch `fix/security-hardening` → fast-forward merge to `main` (no remote configured).
- Update `docs/production-readiness-audit-2026-06-17.md` to mark SEC-2/3/4/5/6/8 fixed and record SEC-1/SEC-3-infra/SEC-7 as deferred.

## Risks

- **SEC-3 tracker reads `req.body`:** global guards run after Express body-parser middleware, so `req.body.email` is populated when `getTracker` runs; verified by the login e2e. If a future refactor moves body parsing, the email-keying degrades to IP-only (still safe, just less strict).
- **SEC-2 purge cron in a single process:** `@nestjs/schedule` runs in-process; on a single-VM single-process deployment this is correct. If the app ever scales horizontally, the hourly purge would run per-instance (idempotent deletes, harmless) — note for the SEC-1/scale follow-up.
- **SEC-4 behavior change:** gating the `GET` may 403 a frontend view that previously showed company info to VIEWER/APPROVER. Resolved decision is ADMIN+ACCOUNTANT; revisit if the FE needs broader read.
- **SEC-5/SEC-6** are Low and self-contained; covered by focused unit tests.
