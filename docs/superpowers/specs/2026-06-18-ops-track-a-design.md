# §4 Ops Track-A (decision-free in-repo hardening) — Design

- **Date:** 2026-06-18
- **Status:** Approved (design); pending implementation plan
- **Source:** §4 "Operational production-readiness" of `docs/production-readiness-audit-2026-06-17.md` — the **decision-free, in-repo** subset (Track-A). The remaining §4 items (offsite backups, alert delivery, CD pipeline) are Track-B (need operator decisions/secrets) and are out of scope here.
- **Type:** Hardening + docs + tests. No behavior change for valid configs; the config-validation items make malformed env fail fast at boot.

## 1. Scope

The full decision-free in-repo batch (verified still-open against the code 2026-06-18). **EXCLUDES** OPS-TEST-2 (open-ended broad unit-coverage expansion — its own effort) and all Track-B infra items.

| Item | Sev | Cluster |
|------|-----|---------|
| OPS-CFG-1 (`CORS_ORIGIN`/`ENABLE_SWAGGER`/`LOG_LEVEL` not in `env.validation.ts`) | High | 1 |
| OPS-CFG-2 (CORS `.split(',')` no trim/filter) | Med | 1 |
| OPS-OBS-2 (no Sentry `beforeSend` PII scrub) | Med | 2 |
| OPS-OBS-3 (no `LOG_LEVEL` pino wiring) | Med | 2 |
| OPS-RES-1 (no uncaught handlers) | Low | 2 |
| OPS-CI-2 (no unit `coverageThreshold`) | Med | 3 |
| OPS-DOC-1 (stale rate limit in `perf-baseline.md`) | High | 4 |
| OPS-DOC-2 (`deploy.md` omits Redis) | High | 4 |
| OPS-DOC-3 (`deploy.md` rollback thin) | High (partial) | 4 |
| OPS-DOC-4 (`deploy.md` no monitoring overlay mention) | Low | 4 |
| OPS-TEST-1 (no unit specs for document-number/document-posting) | High | 5 |
| OPS-TEST-3 (`journal.e2e` uses `Date.now()` idempotency keys) | Low | 5 |

## 2. Clusters

### Cluster 1 — Config validation & CORS (CFG-1, CFG-2)
Add to the `EnvVars` class in `env.validation.ts` (all `@IsOptional()`):
- `CORS_ORIGIN?: string` — comma-separated origins (validated as a string only; semantics unchanged).
- `ENABLE_SWAGGER?: string` with `@IsIn(['true','false'])` — fail-fast on typos (the `main.ts` check stays `=== 'true'`, already fail-safe; this adds boot-time validation + documentation).
- `LOG_LEVEL?: string` with `@IsIn(['fatal','error','warn','info','debug','trace','silent'])`.

Fix `main.ts:29`: `process.env.CORS_ORIGIN?.split(',').map((o) => o.trim()).filter(Boolean)` and treat an empty array as `false` (fail-closed — CORS disabled rather than an array of empty strings).

### Cluster 2 — Observability & resilience (OBS-2, OBS-3, RES-1)
- **Sentry `beforeSend`** inside the existing `Sentry.init(...)` (DSN-gated, `main.ts:13`): conservative PII scrub — drop `event.request.data` (bodies), redact `authorization`/`cookie` request headers, strip the query string. Only runs when `SENTRY_DSN` is set.
- **`LOG_LEVEL`** wired into the `nestjs-pino` `LoggerModule` config (`pinoHttp.level = LOG_LEVEL ?? 'info'`). Locate the existing `LoggerModule.forRoot(...)` and read the validated value.
- **Uncaught handlers** (`main.ts`, registered around `bootstrap`): `process.on('uncaughtException', …)` → log + `Sentry.captureException` (if DSN) + flush + `process.exit(1)` (process state is undefined; Docker `unless-stopped` restarts). `process.on('unhandledRejection', …)` → log + capture, **no exit** (standard, less-disruptive default). Decision recorded: exit on `uncaughtException` only.

### Cluster 3 — CI unit coverage gate (CI-2)
Add `coverageThreshold` to the unit `jest` block in `package.json`, **ratcheted to just below the measured current coverage** (measured AFTER Cluster 5 lands, so the floor reflects the new specs). Scope `collectCoverageFrom` to `src/**/*.ts` excluding `*.spec.ts`, DTOs, `main.ts`, and module/entry files. Goal: prevent regression, not force a coverage sprint. (The e2e block already gates 84/62/84/84.)

### Cluster 4 — Runbook docs (DOC-1/2/3/4)
- `perf-baseline.md:119`: replace "100 requests / 60s per source IP" with the actual policy — **300 requests / 60s per authenticated user, Redis-backed, fail-closed (429 on limit, 503 if Redis is down)**. Adjust any downstream interpretation text.
- `deploy.md`: add **Redis** to prerequisites with a note that the API fail-closes to 503 without it (a first deploy can come up "running" but 503 every request); enhance the **Rollback** section with concrete step-by-step restore-from-backup (cross-link `backup-and-restore.md`); add a line on the optional `docker-compose.monitoring.yml` overlay (`GRAFANA_ADMIN_PASSWORD`).

### Cluster 5 — Unit tests (TEST-1, TEST-3)
- **`document-number.service.spec.ts`** (new) — unit-test the gapless per-(type, FY) sequencing with a mocked tx/prisma: first call inserts seed row then returns 1; subsequent calls increment under `FOR UPDATE`; the ref-string format. The pure sequencing logic, high value.
- **`document-posting.service.spec.ts`** (new) — **focused** orchestration test with mocked `PostingService` + prisma: asserts the prepare-before-tx ordering, atomic post, and subledger reconciliation calls. Kept tight on orchestration/ordering (NOT deep mock-duplication of the e2e-covered money math). Decision recorded: include it, scoped tight; e2e remains the deep coverage.
- **`journal.e2e-spec.ts`**: replace the `Date.now()` idempotency keys (~lines 265, 287) with `randomUUID()` for consistency with the rest of the suite.

## 3. Testing & gates
- Cluster 1/2 changes are exercised by existing e2e (app still boots; CORS/Swagger/logging unchanged for valid config) plus a small unit test on the env-validation additions if the file has a spec (else rely on boot). The CORS-parse helper is pure → unit-testable.
- Cluster 5 adds the two unit specs + the e2e key change.
- Every task: `npm run db:generate` (unaffected but cheap), `typecheck` 0, `lint:ci` 0, relevant unit/e2e green. Final `npm run verify` (acknowledging the known environmental full-suite flakiness — re-run/confirm in isolation, not a code defect).
- No single-threaded behavior change for valid configurations; the only intended new runtime behaviors are fail-fast on malformed env and the uncaught-exception exit.

## 4. Sequencing
Cluster 5 (new tests) BEFORE Cluster 3 (threshold) — the coverage floor must be measured with the new specs present. Otherwise clusters are independent and can land in any order.

## 5. Risks & mitigations
| Risk | Mitigation |
|------|-----------|
| Adding env validation rejects a previously-tolerated value at boot | All three are `@IsOptional()`; only malformed *present* values fail — the intended fail-fast |
| `coverageThreshold` set too high → CI flaps | Ratchet to *below* measured current; it's a floor, not a target |
| `document-posting` unit test becomes brittle mock-duplication | Scoped tight to orchestration/ordering; e2e stays the deep coverage |
| Uncaught-exception `exit(1)` causes restart loops | Only on `uncaughtException` (truly unsafe state); `unhandledRejection` logs without exit; Docker `unless-stopped` already expects restarts |
| Sentry scrub drops useful debug context | Conservative scope (bodies + auth/cookie headers + query); stack traces and breadcrumbs retained |

## 6. Out of scope
Track-B (OPS-DB-1 offsite/encrypted backups, OPS-OBS-1 alert delivery, OPS-CI-1 CD pipeline, OPS-DEP-1/2, OPS-CI-3 image scan) — each needs an operator decision/secret. OPS-TEST-2 (broad unit-coverage expansion). These get their own specs when pursued.
