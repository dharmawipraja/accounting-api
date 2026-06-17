# Production-Readiness Audit — accounting-api

**Date:** 2026-06-17
**Scope:** Full codebase (~9.2k LOC `src/`, ~5.6k LOC `test/`) — NestJS 11 + Prisma 7 (`@prisma/adapter-pg`) + Postgres 16 + Redis 7, single-VM Docker Compose + Caddy + GitHub Actions CI.
**Method:** Four parallel deep-read audits (financial correctness & concurrency, security & hardening, architecture & dead code, operational readiness). A second independent verification pass then re-read the source — §1 exhaustively (every cited path end-to-end), §2–§4 spot-checked across all severities — and found **no factual errors**. See the [Verification log](#appendix-verification-log-2026-06-17) appendix for what was confirmed, the severity calibrations, and one item the line-by-line surfaced.

---

## Executive summary

This is a genuinely well-engineered codebase. The double-entry core, gapless numbering, idempotency, money handling, soft-delete discipline, SQL parameterization, auth wiring, container/migration strategy, and test posture are all production-quality and should be left alone.

It is **not yet production-grade**, but the gaps are a small number of real financial-correctness bugs plus last-mile operator wiring — not architectural rot.

- **2 confirmed money-corrupting bugs** (P0) — reversals into a closed year, and out-of-order year-end close double-counting retained earnings. **Both now FIXED** (commits `bfcdbd1`, `a902c7e` on `fix/close-reversal-p0-bugs`, test-first).
- **1 real High security gap** — no refresh-token revocation/rotation.
- **Several disaster-recovery / ops wiring gaps** — local-only backups, undelivered alerts, CI-without-CD, config-validation drift, stale runbooks.
- **Maintainability debt** — four near-identical transactional document services; modest dead code; batchable nits.

### Severity legend

| Tag | Meaning |
|-----|---------|
| 🔴 Critical / P0 | Corrupts data or money; fix before any production use |
| 🟠 High | Security/DR/correctness gap; fix before go-live |
| 🟡 Medium | Should fix; limited blast radius |
| ⚪ Low | Hardening / consistency / polish |
| ✅ Verified safe | Investigated a suspicion and cleared it |

### Do-this-first list

1. **Fix the two P0 financial bugs** (they silently corrupt the ledger).
2. **Add refresh-token revocation/rotation** (SEC-1).
3. **Offsite + encrypted backups** (OPS-DB-1) and **wire alert delivery** (OPS-OBS-1).
4. **Close config-validation drift** — add `CORS_ORIGIN` / `ENABLE_SWAGGER` / `LOG_LEVEL` to `env.validation.ts` (OPS-CFG-1).
5. **Fix the doc traps** — `perf-baseline.md` stale rate limit, `deploy.md` missing Redis + real rollback steps (OPS-DOC-*).
6. Add a CD/release pipeline (OPS-CI-1); push CI to a remote to activate it.

---

## 1. Financial correctness & concurrency

The core engine is correct. Two real bugs, both around the **year-end-close / reversal boundary**.

### 🔴 P0-1 — Reversals/voids can post into a CLOSED fiscal year (verified)

> **Status: ✅ FIXED** — commit `bfcdbd1` on `fix/close-reversal-p0-bugs`; guard added to `prepareReversal` with a `reopen()` bypass. e2e: `test/close-reversal-guard.e2e-spec.ts`.

- **File:** `src/ledger/posting/posting.service.ts:192–234` (`prepareReversal`)
- **Problem:** `preparePosting` (lines 97–105) and `postDraft` (lines 333–341) both reject a CLOSED fiscal year with `ClosedYearError`. `prepareReversal` checks only for an **open period** (lines 222–227) and resolves the fiscal year (229) but **omits the year-lock guard**. Every void path (`PaymentsService.void`, `SalesInvoicesService.void`, `PurchaseBillsService.void`, `journal.reverse`) flows through `prepareReversal` → `reverseInTx` → `createPostedEntryInTx`.
- **Why it's reachable:** `YearEndCloseService.close()` (`year-end-close.service.ts`) writes a closing entry and the `yearEndClosing` row but **does not close the monthly accounting periods** — they stay OPEN. So after a year-end close, voiding any document dated in that sealed year passes the open-period check and writes a brand-new POSTED reversal into the closed year, corrupting already-finalized retained earnings / net income. The asymmetry (forward post blocked, reversal allowed) is the tell.
- **Fix:** in `prepareReversal`, after resolving `fiscalYear`, add the same guard used by `preparePosting`:
  ```ts
  const closedYear = await this.prisma.client.yearEndClosing.findFirst({
    where: { fiscalYear, status: 'CLOSED' },
  });
  if (closedYear)
    throw new ClosedYearError('Fiscal year is closed; reopen it before reversing', { fiscalYear });
  ```
  (Note: `reopen()` itself reverses the closing entry within the closed year by design — if the guard is added, `reopen` must bypass it, e.g. via an internal flag, since it runs before the status flips to OPEN.)
- **Missing test:** no e2e exercises "void a document whose reversal date lands in a closed year." `close.e2e-spec.ts` covers forward posting and DRAFT posting into a closed year only.

### 🔴 P0-2 — Out-of-order year-end close double-counts retained earnings (verified)

> **Status: ✅ FIXED** — commit `a902c7e` on `fix/close-reversal-p0-bugs`; `close()` now uses `movementsBetween(fyStart, yearEnd)`. e2e: `test/close-out-of-order.e2e-spec.ts`.

- **File:** `src/close/year-end-close.service.ts:51`
- **Problem:** `close()` derives net income from `balances.balancesAsOf(yearEnd)` — a **cumulative, all-history** balance (`je.date <= yearEnd`) filtered to REVENUE/EXPENSE. That equals a single year's P&L **only if every prior year was already closed** (each prior CLOSING entry zeroes that year's P&L). There is no enforcement that years are closed in chronological order.
- **Impact:** Close FY2027 while FY2026 is still open → `balancesAsOf(2027-12-31)` for P&L = FY2026 + FY2027 movement, so FY2027's closing entry sweeps **two years** into Laba Ditahan. Later closing FY2026 sweeps FY2026 again → retained earnings overstated by FY2026 net income and the P&L accounts end non-zero. The "close years in order" invariant exists only in project docs, not in code.
- **Fix (preferred):** compute net income from `movementsBetween(fyStart, yearEnd)` so each close only sweeps its own year's movement — removes the ordering dependency entirely. **Alternative:** reject `close(N)` while any prior fiscal year with P&L activity is still OPEN.
- **Missing test:** no test closes years out of order; `close.e2e-spec.ts` only ever closes a single year.

### 🟡 Medium / ⚪ Low (investigated; not money-loss)

- **FIN-M1 — Draft payment validation isn't cumulative across allocations to the same document** — `src/invoicing/payments.service.ts:133–163`. Two allocations in one payment each equal to the full outstanding both pass *draft* validation; the post-time `FOR UPDATE` loop (336–388) catches it with a 409, so no double-apply — but the user gets a confusing late 409 instead of a clean 422, and `payment.amount` is stored as the inflated sum. **Fix:** track a running `Map<documentId, Money>` in `createDraft` and subtract before the outstanding check.
- **FIN-M2 — Partner ownership not re-verified at post time** — `payments.service.ts:278–429`. `createDraft` validates `target.partnerId === input.partnerId`; `post` re-checks status/outstanding under lock but not partner. Safe in practice (posted docs are immutable) — defense-in-depth inconsistency only.
- **FIN-M3 — Payment `void` decrements `amountPaid` with no floor** — `payments.service.ts:455–466`. Invoice/bill voids guard (`amount_paid !== 0`), payment void doesn't. Cleared as safe (one-void-per-payment guard bounds it), but the asymmetry invites a future regression; a `Money` floor would harden it.
- **FIN-M4 — `TaxCodesService.validateRate` uses `Number(rate)` float** — `src/tax/tax-codes.service.ts:41–49`. Bounds-check only (`> 0 && < 1`); actual tax math uses `Money`/`Decimal`. No money impact; could tighten to reject > 6 decimal places (column precision).
- **FIN-L1 — Balances SQL doesn't filter `je.deleted_at IS NULL`** — `src/ledger/balances/balances.service.ts:68–82,163–169`. Safe today (only DRAFTs are soft-deletable, and they have `posted_at = NULL` so they're already excluded), but inconsistent with `aging.service.ts` which does filter. Add the predicate to make the invariant explicit.
- **FIN-L2 — Idempotency `complete()` runs in a separate transaction** — `src/common/idempotency/idempotency.interceptor.ts:67–72`. A crash between the handler commit and `complete()` leaves the key stuck "in-flight" → retries get `409 in progress` forever. No money lost. **Fix:** TTL/cleanup on stale in-flight keys, or fold `complete` into the handler tx.

### ✅ Verified safe (financial)

Gapless JE & document numbering (INSERT-ON-CONFLICT + `SELECT … FOR UPDATE` in-tx); `postDraft` double-number race (locks draft, re-checks status before consuming a number); concurrent over-allocation / double-settle (per-doc `FOR UPDATE` + cumulative re-check, proven by `payments.e2e-spec.ts:290–341`); reversal double-reverse (`@@unique([reversalOfId])` + P2002 mapping); atomic document posting (lock→number→entry→finalize in one `$transaction`); year-end close/reopen serialization (`pg_advisory_xact_lock` + status re-check); tax engine balance & per-code rupiah rounding; `Money` class (decimal.js only, rejects JS numbers, ROUND_HALF_UP @ 4dp); `journal_lines` one-sided CHECK constraint; reporting sign conventions & post-close zeroing; aging ↔ control reconciliation.

---

## 2. Security & hardening

No Critical findings: no public registration (user creation is CLI-only via `scripts/create-admin.ts`), no committed secrets, raw SQL parameterized, RBAC and global guards correctly wired.

### 🟠 SEC-1 (High) — No refresh-token revocation (stateless refresh tokens)

- **File:** `src/auth/auth.service.ts:38–56`; no `RefreshToken`/`Session` model in schema.
- **Problem:** Refresh tokens are plain stateless JWTs validated only by signature + `isActive` + expiry (`JWT_REFRESH_TTL=7d`). No rotation, no `jti`, no denylist. A leaked refresh token is valid for the full 7 days and can't be revoked; `refresh()` doesn't rotate (old token stays valid). Deactivating a user stops it, partially mitigating.
- **Fix:** persist refresh tokens (or a hashed `jti`) in a table; rotate-on-use + reuse detection; provide a revoke/logout path. Minimum: a `tokenVersion` column on `User` embedded in the JWT and checked on refresh.

### 🟡 Medium

- **SEC-2 — Idempotency-Key header unvalidated/unbounded** — `idempotency.interceptor.ts:40–44`, stored verbatim as PK (`IdempotencyKey.key String @id`, no length cap), no TTL/cleanup. Authenticated abuse → table/storage growth. **Fix:** validate (UUID or ≤128 chars, else 400) before `reserve()`; add a scheduled purge of completed keys.
- **SEC-3 — Login throttle is X-Forwarded-For spoofable** — `src/common/guards/user-throttler.guard.ts:16–24` + `main.ts` `trust proxy: 1`. Anonymous routes key on `ip:${req.ip}`; Caddy (`reverse_proxy api:3000`) doesn't strip/overwrite an inbound `X-Forwarded-For`, so a client-supplied XFF rotates the perceived IP and defeats the per-IP login limit (10/min). **Fix:** have Caddy set a trusted client header (`header_up X-Forwarded-For {remote_host}` or `trusted_proxies`) and overwrite inbound XFF; consider also keying login throttling by submitted email.
- **SEC-4 — Company settings readable by every authenticated role (verified)** — `src/company/company.controller.ts:16` (`@Get()` has no `@Roles`; only `@Patch()` is ADMIN). Any user incl. VIEWER reads `npwp`, legal name, address, and the `segregationOfDutiesEnabled` / `isPkp` control flags. **Fix:** gate the GET (`@Roles(Role.ADMIN, Role.ACCOUNTANT)`) or make it an explicit, documented decision.

### ⚪ Low

- **SEC-5 — `MetricsTokenGuard` fails open when `METRICS_TOKEN` unset (verified)** — `src/metrics/metrics-token.guard.ts:15` (`if (!token) return true;`). `/metrics` is then fully public, relying entirely on Caddy's 404. Plain `===` compare. **Fix:** require `METRICS_TOKEN` in production (fail-closed), use `crypto.timingSafeEqual`.
- **SEC-6 — Login not constant-time** — `auth.service.ts:22–30`. Message is constant (no enumeration via message) but argon2 verify is skipped for unknown users → timing side-channel. **Fix:** verify against a fixed decoy hash when the user is absent.
- **SEC-7 — Audit log append-only by convention only** — `src/audit/audit.service.ts:22–40` (create-only; read is ADMIN-gated, good). Table is writable by the app's DB role. **Fix:** revoke UPDATE/DELETE on `audit_log` from the app role (or a trigger / append-only sink); at minimum document the limitation.
- **SEC-8 — `npm audit` gate scope** — `package.json` `audit:ci` (`--omit=dev --audit-level=high`) ignores dev deps and moderate advisories. **Fix:** consider `--audit-level=moderate` for prod deps + a non-blocking dev scan. (Also: CI has no remote yet, so the gate isn't running.)

### ✅ Checked & OK (security)

argon2id @ OWASP params (t=3, 64 MiB, p=4), `passwordHash` stripped from responses; JWT secrets `@MinLength(32)` + required at boot, separate access/refresh secrets, `ignoreExpiration:false`; global guard chain (`JwtAuthGuard → UserThrottlerGuard → RolesGuard`) honors `@Public()`, only auth/health/ready/metrics public; RBAC 403s correctly; SQL injection — `trigram-search.ts` inlines only constant identifiers and binds all values, all other raw SQL parameterized; `ValidationPipe` whitelist+forbidNonWhitelisted+transform, `ParseUUIDPipe` on every `:id`, money regex, bounded pagination; rate limiting fail-closed (429/503) with fail-fast ioredis; no secrets committed or baked into the image; helmet on; CORS env-gated (defaults closed); 1 MB body limits; server timeouts hardened; error filter leaks no stack/internal messages; Swagger off in prod unless `ENABLE_SWAGGER=true`.

---

## 3. Architecture & dead code

### Dead code (grep-verified — safe quick wins)

- `Money.lessThan()` — `src/common/money/money.ts:56–58` — zero references.
- `UsersService.findByEmail()` — `src/users/users.service.ts:63` — only consumer is `test/users.e2e-spec.ts:61` (auth uses `findByEmailWithHash`).
- `AccountBalanceRow.parentId` — `src/ledger/balances/balances.service.ts:30,44,73,80,97` — selected/grouped/mapped but read by zero consumers.
- Duplicate `ReportLine` interface — defined identically in `income-statement.service.ts:9` and `balance-sheet.service.ts:9`; `ReportGroup`/`CashFlowLine` exported but used in-file only.
- Redundant manual `deletedAt: null` — `tax-codes.service.ts:107,114` (`TaxCode ∈ SOFT_DELETE_MODELS`, extension already injects it). (The `updateMany` ones in `deleteDraft` are intentional defense-in-depth — leave.)
- Test-only exports — `trigram-search.ts:7,96,122` (`SIMILARITY_THRESHOLD`, `buildTrigramIdQuery`, `buildTrigramCountQuery`) imported only by the spec.
- Duplicate HTTP-method constant — `audit.interceptor.ts:14` and `audit-query.dto.ts:15`.
- No commented-out code, no TODO/FIXME, no scaffolding, no unused npm deps.

### Duplication & shallow modules

The four transactional document services are near-identical twins — the highest-leverage maintainability issue:

- `listPage()` search-or-list-with-envelope copy-pasted ~5× — `sales-invoices.service.ts:191–248`, `purchase-bills.service.ts:195–252`, `payments.service.ts:195–259`, `journal.service.ts:190–257`, `business-partners.service.ts:74–116`.
- `present()` 4dp money-serialization copy-pasted 3× (sales ≡ purchase verbatim) — `sales-invoices.service.ts:405–451`, `purchase-bills.service.ts:408–454`, `payments.service.ts:497–515`. **All 12 `as unknown as Decimal` casts live here.**
- `void()` reverse-with-race-guard copy-pasted 3× — `sales:343–400`, `purchase:347–403`, `payments:431–492`.
- `deleteDraft()` conditional soft-delete copied 4× — `journal:94`, `sales:250`, `purchase:254`, `payments:261`.
- Control-account lookup 3× + redeclared code constants (`AR_CONTROL_CODE`/`AP_CONTROL_CODE` in 3 files).
- `taxableLines()` mapper identical 2× — `sales-invoices.service.ts:62` ≡ `purchase-bills.service.ts:64`.
- Twin response DTOs (`sales-invoice-response` ≡ `purchase-bill-response` save 3 fields); list envelope hand-rewritten 4–5×.
- `@ApiHeader(Idempotency-Key)` + `@Idempotent()` block repeated 14× across 6 controllers.
- `RawTxClient` (`posting.service.ts:26`) ≡ `RawTx` (`document-number.service.ts:4`); `buildEntryRef` (`posting.service.ts:374`) ≡ `buildRef` (`document-number.service.ts:34`).
- UTC day-truncation duplicated 5× (`balances:60`, `aging:23`, `general-ledger:24`, `periods:72`, `cash-flow:86`); `fiscalYearFor` reimplemented inline (`balance-sheet.service.ts:62–65`, `periods.service.ts:23–25`) despite public `PostingService.fiscalYearFor()`.

**Deletion-test verdicts:** `DocumentNumberService`, `CompanyService`, `MetricsService`, `BusinessPartnersService` earn their keep. `JournalService.postDraft`/`reverse` are true pass-throughs to `PostingService` (acceptable as a facade).

### Deepening opportunities

| # | Candidate | Files | Strength |
|---|-----------|-------|----------|
| A | Extract `listPaginated(model, {search, where, present})` + `serializeMoney(obj, fields)` helper | 4 transactional services + partners | **Strong** — collapses ~250 LOC into one tested seam; kills the cast family; one edit not 5 |
| E | Compose `@IdempotentWrite()` = `applyDecorators(Idempotent(), ApiHeader({...}))` | 14 handlers | **Strong (cheap)** — structurally prevents OpenAPI/behavior drift |
| B | Make trigram ranking one tested seam (drop the 3 test-only exports to internal) | `trigram-search.ts` | Worth exploring |
| C | Push period/closed-year TOCTOU checks inside the write transaction (`FOR SHARE` on period) | `posting.service.ts:65–107` + 4 callers | Worth exploring (scale-gated; payments rolls its own lock path) |
| D | Replace by-code account coupling (`CASH_CODES`, `AR/AP_CONTROL_CODE`, `RETAINED_EARNINGS_CODE`, …) with account role flags | 6 files | Worth exploring (a new bank account silently breaks cash-flow reconciliation today) |

The core modules (`PostingService`, `Money`, soft-delete extension, trigram search, `BalancesService`) pass the deletion test — genuinely deep, leave them.

### Code-quality nits (batch fix)

1. `as unknown as Decimal` casts in every `present()` (12×) — removed by candidate A.
2. Pagination limit drift — `PaginationQueryDto` `@Max(200)` vs `audit-query.dto.ts:22` `@Max(500)`; default `?? 50` repeated. Hoist `DEFAULT_PAGE_SIZE`/`MAX_LIMIT`.
3. P2002→409 try/catch repeated 12× — a `mapUniqueViolation()` helper, or lean on the global filter (already maps P2002→409).
4. `q.post === 'true'` string-boolean — `journal.controller.ts:83`; use a transformed boolean query type.
5. Two unbounded `findMany` lists (`accounts.service.ts:97`, `tax-codes.service.ts:105`) inconsistent with the `{data,total,limit,offset}` convention — document or paginate.
6. Inline `new Date(dto.date)` (`sales-invoices.controller.ts:68`, `journal.controller.ts:50`) vs reports' `range()` helper — settle on DTO `@Transform` to `Date`.
7. Naming drift — `reports.controller.ts:27–31` mixes `balanceSheetSvc` with `aging`/`cashFlow`.
8. List-query DTO inconsistency — partners use shared `SearchQueryDto`; invoicing uses bespoke `*ListQueryDto`. Standardize.
9. Raw `.toFixed(4)` bypassing `Money` — `balances.service.ts`, `general-ledger.service.ts:54–55`; route through `Money.toPersistence()`.
10. Loose casts in `soft-delete.extension.ts:64,71,93,100,198` — unavoidable at the Prisma-extension boundary; contain in one typed wrapper.

---

## 4. Operational production-readiness

Overall: well-built. Gaps are mostly operator wiring (alert delivery, offsite backups, CD) and config drift — no data-loss or security-hole infra defects.

### Container / Deploy

✅ **Solid:** multi-stage Dockerfile, non-root `USER node`, `HEALTHCHECK`, `--omit=dev`; migrations run out-of-process (`migrate` service runs `prisma migrate deploy`, `api` waits on `service_completed_successfully`); `unless-stopped` restart, `stop_grace_period: 30s`, resource limits, `init: true`, healthcheck-gated `depends_on`, ports bound to `127.0.0.1`; Caddy auto-HTTPS + HSTS + gzip + 1 MB cap + 404s `/metrics`.
- ⚪ **OPS-DEP-1** — `Caddyfile` sets no security headers beyond HSTS (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`). Helmet covers it at the app layer; add a Caddy `header` block for edge defense-in-depth.
- ⚪ **OPS-DEP-2** — no `read_only` rootfs / `cap_drop` on containers (optional hardening).

### Database ops

✅ **Solid:** FK/list-filter columns indexed; pg_trgm + 15 GIN indexes for fuzzy search; explicit env-driven `pg.Pool` (`max=15`, `connectionTimeoutMillis=5000`, `statement_timeout=30000`, idle-error handler, clean `onModuleDestroy`); real backup script (`pg_dump -Fc` + retention + freshness metric) and a genuinely good restore runbook.
- 🟠 **OPS-DB-1 (High)** — backups live only in a local Docker volume on the same VM (`docker-compose.prod.yml:91`, `scripts/backup.sh`); unencrypted. A VM/disk loss destroys DB **and** backups → no real DR. **Fix:** push dumps offsite (S3/B2/rsync) + encrypt (`age`/`gpg`).
- 🟡 **OPS-DB-2** — trigram `CREATE INDEX` (not `CONCURRENTLY`) in `20260616000000_add_trigram_search`; harmless now (small tables), but a future large-table re-run blocks writes. Migration-discipline note.
- ⚪ **OPS-DB-3** — `20260613000000_generalize_idempotency_keys` does `DELETE` + `DROP COLUMN`; data is ephemeral, immaterial.

### Observability

✅ **Solid:** prom-client `http_request_duration_seconds` labeled by **route template** (no cardinality blowup) + `ledger_entries_posted_total` + `db_pool_*`; structured pino with `authorization`/`cookie` redaction; `X-Request-Id` shape-validated + echoed + threaded into logs and the error envelope; DSN-gated Sentry with env/release tags capturing only 5xx; liveness (`/health`) vs readiness (`/ready`, DB+Redis, 503 names the failed dep) split, both `@SkipThrottle()`; meaningful alert rules (`monitoring/alerts.yml`).
- 🟠 **OPS-OBS-1 (High)** — `monitoring/alertmanager.yml` has only a placeholder receiver; **alerts reach no one**. Wire Slack/email/webhook before go-live.
- 🟡 **OPS-OBS-2** — no Sentry `beforeSend` PII scrub (`main.ts:11–19`); request bodies/user data could reach Sentry. Add a scrub hook.
- 🟡 **OPS-OBS-3** — no `LOG_LEVEL` env/pino config; prod logs at default verbosity. Add `LOG_LEVEL`.
- ⚪ **OPS-OBS-4** — `monitoring/prometheus.yml:12–15`: if `METRICS_TOKEN` is set but the `authorization:` block isn't uncommented, scrapes 401 → `ApiDown` false-fires. Document/template the coupling.
- ⚪ **OPS-OBS-5 (perf)** — `perf/baseline.js` covers only read paths (4 report GETs); add a write scenario (journal post / invoice create).

### Config / Env

✅ **Solid:** `env.validation.ts` is strict class-validator with fail-fast on boot (NODE_ENV enum, PORT range, JWT secrets `@MinLength(32)`, conditional `REDIS_URL`); `env-file-paths.ts` clean.
- 🟠 **OPS-CFG-1 (High, drift)** — `CORS_ORIGIN` and `ENABLE_SWAGGER` are read in `main.ts:29,56` but **absent from `env.validation.ts`** → malformed values pass silently (broken CORS, or Swagger exposed in prod). Add both (+ `LOG_LEVEL`) to `EnvVars`.
- 🟡 **OPS-CFG-2** — `main.ts:29` `CORS_ORIGIN?.split(',')` doesn't trim/filter empties. Use `.map(o=>o.trim()).filter(Boolean)`.
- ⚪ **OPS-CFG-3** — `.env.example` omits optional `METRICS_TOKEN`, `SENTRY_*`, `THROTTLE_*`, `ENABLE_SWAGGER`, `GRAFANA_ADMIN_PASSWORD`.

### Resilience

✅ **Solid:** `enableShutdownHooks()`; CORS fail-closed default; explicit server timeouts (`keepAliveTimeout=65s`, `headersTimeout=66s`, `requestTimeout=30s`); clean Prisma + Redis lifecycle (`enableOfflineQueue:false`, `maxRetriesPerRequest:1`, `commandTimeout:1000`); fail-closed rate limiting (429 limit / 503 Redis-down) passed through correctly by `AllExceptionsFilter`; bounded payment tx (`maxWait:5000, timeout:20000`).
- ⚪ **OPS-RES-1** — no `process.on('uncaughtException'/'unhandledRejection')` handler in `main.ts`; an out-of-request rejection crashes without a Sentry capture. Add top-level handlers.
- ⚪ **OPS-RES-2** — no app-level per-request timeout interceptor (bounded only by `requestTimeout`/`statement_timeout`); a slow non-DB path isn't independently capped.

### CI/CD

✅ **Solid:** `.github/workflows/ci.yml` = `verify` (typecheck + `lint:ci --max-warnings 0` + unit + `test:e2e:cov`) + `audit` + `docker` build; npm caching; least-priv permissions; concurrency cancellation; Node pinned via `.nvmrc`; dependabot (npm grouped + actions). E2E coverage thresholds enforced (`test/jest-e2e.json`: 84/62/84/84).
- 🟠 **OPS-CI-1 (High)** — **CI only, no CD**: no image publish/tag, no release/rollback pipeline; deploy is fully manual. Add a release workflow (build → tag → push image, optionally SSH-deploy).
- 🟡 **OPS-CI-2** — unit jest block has **no `coverageThreshold`** (only e2e is gated); new service code can ship untested. Add a unit threshold.
- ⚪ **OPS-CI-3** — `docker` CI job builds but discards the image (no publish, no Trivy/Grype scan). Add an image vuln scan.
- ⚪ **OPS-CI-4** — CI has no remote configured yet; push to GitHub to activate it.

### Testing posture

✅ **Solid:** 13 unit + 36 e2e specs; e2e against real Postgres via testcontainers (migrations tested every run, `maxWorkers:1`); strong concurrency/race coverage (idempotency same-key, 12-parallel posting, concurrent settlement); broad money-math regression (`money.spec.ts`).
- 🟠 **OPS-TEST-1 (High)** — **zero unit tests** for `src/invoicing/document-number.service.ts` (gapless per-(type,FY) sequencing) and `document-posting.service.ts` (atomic post orchestration); e2e-only. Add focused unit specs with mocked Prisma.
- 🟡 **OPS-TEST-2** — thin unit coverage overall (~13 specs / ~44 services); tax/posting/balances/close rely on e2e. Prioritize unit tests for tax rounding, posting balance validation, year-end P&L zeroing.
- ⚪ **OPS-TEST-3** — `test/journal.e2e-spec.ts` uses `Date.now()` for idempotency keys (~265, 287) vs `randomUUID()` elsewhere; cosmetic.

### Docs / Runbooks

✅ **Solid:** `README.md`, `SECURITY.md`, `CHANGELOG.md`, `backup-and-restore.md`, `frontend-guide.md` all accurate and current to `/v1`.
- 🟠 **OPS-DOC-1 (High)** — `docs/runbooks/perf-baseline.md` documents a **stale rate limit** ("100/60s per IP", old `ThrottlerModule.forRoot`); actual is 300/min per-user, Redis fail-closed. Operators misread k6 results.
- 🟠 **OPS-DOC-2 (High)** — `docs/runbooks/deploy.md` **omits Redis** from prerequisites; the API fails-closed (503) without it, so a first deploy can come up "running" but 503 every request.
- 🟠 **OPS-DOC-3 (High)** — `deploy.md` rollback is a one-liner with no concrete steps and no forward-only-migration/DB-mismatch handling. Add step-by-step rollback incl. restore-from-backup.
- 🟡 **OPS-DOC-4** — `deploy.md` never mentions the optional `docker-compose.monitoring.yml` overlay (`GRAFANA_ADMIN_PASSWORD`).

---

## 5. Suggested sequencing

1. **P0-1, P0-2** — financial guards + per-year close math, each test-first. (Highest value, lowest risk.)
2. **Quick wins in the same pass** — dead-code sweep (§3), `@IdempotentWrite()` decorator (candidate E), config-validation drift (OPS-CFG-1), doc traps (OPS-DOC-1/2/3).
3. **SEC-1** refresh-token revocation/rotation.
4. **DR/ops** — OPS-DB-1 (offsite encrypted backups), OPS-OBS-1 (alert delivery), OPS-CI-1 (CD pipeline).
5. **Architectural win** — candidate A (document-service consolidation; collapses ~250 LOC and removes the cast family).
6. **Remaining Medium/Low** hardening as capacity allows.

Treat candidates C and D as deliberate, scale-gated decisions the code already reasons about in comments — not bugs.

---

## Appendix: Verification log (2026-06-17)

A second pass independently re-read the source to confirm the findings (rather than relying on the original four-agent sweep). **Result: no factual errors found.** §1 was checked exhaustively (every cited path read end-to-end); §2–§4 were spot-checked across all severities. Calibration adjustments and one newly-found item are noted below.

### §1 Financial correctness — complete line-by-line pass (0 errors)

Files read end-to-end: `posting.service.ts`, `year-end-close.service.ts`, `payments.service.ts`, `document-posting.service.ts`, `document-number.service.ts`, `journal.service.ts`, `money.ts`, `tax.service.ts`, `balances.service.ts`, `idempotency.interceptor.ts`, `idempotency.service.ts`, `aging.service.ts`, `balance-sheet.service.ts`, `income-statement.service.ts`, `cash-flow.service.ts`, plus `schema.prisma` and the journal migration.

- **All seven bug claims confirmed real** (P0-1, P0-2, FIN-M1, FIN-M2, FIN-M3, FIN-L1, FIN-L2). FIN-M4 was not re-read but is consistent — all real tax math flows through `Money`/`Decimal` in `tax.service.ts`, so the float `validateRate` is bounds-only.
- **All "verified safe" claims confirmed genuinely safe**, including the DB backstops: `@@unique([reversalOfId])` (`schema.prisma:188` + migration index `journal_entries_reversal_of_id_key`) and the `journal_lines` CHECK `(debit=0 OR credit=0) AND (debit>0 OR credit>0)` (`20260611022405_add_journal/migration.sql:89`). Tax rounds each code once to rupiah (`tax.service.ts:117`) with a settlement guard (167) and balance assert (195); reporting contra signing is TYPE-based (`balance-sheet.service.ts:28`, `income-statement.service.ts:20`); aging filters POSTED + non-deleted docs/payments `<= asOf` (`aging.service.ts:57,61`); cash flow reconciles via the cash identity (`cash-flow.service.ts:113`).

### §2–§4 spot-checks (all confirmed)

SEC-1 (`auth.service.ts:38–56`), SEC-4 (`company.controller.ts:16`), SEC-5 (`metrics-token.guard.ts:15`), SEC-6 (`auth.service.ts:22–30`); OPS-CFG-1 (grep `main.ts` vs `env.validation.ts`), OPS-DOC-1/2 (runbook greps — `perf-baseline.md` literally states "100 requests / 60s per source IP"; `deploy.md` has zero "redis" mentions), OPS-OBS-1 (placeholder receiver), OPS-CI-1 (3 jobs, no publish), OPS-DB-1 (no offsite/encrypt in `backup.sh`), OPS-TEST-1 (no `src/invoicing/*.spec.ts`); dead code (`Money.lessThan`, `findByEmail`, `parentId`) via grep. All confirmed.

### Calibration adjustments (severity/wording — not factual errors)

- **OPS-CFG-1 → Medium, not High.** Both failure modes fail safe: `ENABLE_SWAGGER` uses `=== 'true'` (a typo keeps Swagger **off** — it cannot be "unexpectedly exposed"), and unset/garbage `CORS_ORIGIN` falls back to `?? false` (CORS closed). The "Swagger exposed in prod" impact line is wrong; the drift is still worth fixing.
- **P0-1 and P0-2 are real but *latent*.** Each requires a specific operator action to fire (voiding into a closed year; closing years out of sequence). They are legitimate correctness bugs — a system should enforce its own invariants — but they are not actively miscomputing today's books.
- **P0-1 wording.** A *document* void reverses into the original accounts (e.g. Revenue/AR), so it corrupts the sealed year's **reported figures and the close reconciliation** — it does not directly write the retained-earnings balance. (P0-2 *does* hit retained earnings directly, via the closing entry.)
- **SEC-1 "High" is threat-model-dependent.** With the `isActive` kill-switch and a 7-day refresh TTL, many teams would accept this as Medium for an internal API.

### New items the line-by-line surfaced (not in the original audit)

- **NEW-1 — Redundant `tax.calculate` per document post (Low — efficiency + a narrow consistency risk).** `DocumentPostingService.post` computes the tax once to build the journal lines (`document-posting.service.ts:78`), and the `finalize` callback then calls `computeTotals` — a second `tax.calculate` (`document-posting.service.ts:50`) — to store the document totals (`sales-invoices.service.ts:317`, `purchase-bills.service.ts:321`). So every invoice/bill post runs the tax engine twice (2× `taxCode.findMany` + recompute) from two separate reads. Beyond the waste, if a tax-code rate were edited between the two reads, the posted journal lines and the stored invoice totals could disagree. **Fix:** have `post()` pass the already-computed `calc`/totals into the `finalize` callback via `PostedDocContext` so one computation feeds both the journal and the stored totals.
- **NEW-2 — The `balanced` / `reconciles` report flags are tautological** (`balance-sheet.service.ts:119`, `cash-flow.service.ts:113`). They check the accounting identity (A = L+E; kasAwal + netChange = kasAkhir), which holds for any balanced ledger regardless of close correctness — so neither flag would catch P0-2's corruption. Not a bug, but it explains why P0-2 stays invisible to the existing self-checks.
