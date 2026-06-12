# Production Readiness — WS4: Observability & Performance Baseline — Design Spec

- **Date:** 2026-06-12
- **Status:** Approved (pending written-spec review)
- **Owner:** budi@maul.is
- **Builds on:** the feature-complete 6-phase API + WS1 (quality gate) + WS2 (code integrity) + WS3 (runtime/deploy), all merged. No application features are added.

## 1. Program context

Fourth and FINAL production-readiness workstream ([[production-readiness-program]]): **WS1 → WS2 → WS3 → WS4 (this).** WS4 makes the running system observable and sets a capacity baseline.

**Decisions (from brainstorming):** **instrument-only + optional stack** (the app exposes everything; Prometheus/Grafana/Alertmanager ship as a *separate optional* compose file, not on the 4 GB prod VM by default); **Sentry SDK, DSN-gated, off by default**; **k6** for the load baseline. Self-hosted bias.

**Existing:** nestjs-pino (autoLogging + auth/cookie redaction + pino-http default reqId), `/health` + `/ready`, `AllExceptionsFilter` (typed envelope; logs unhandled at error, Prisma 4xx-mapped at warn). No metrics/tracing/error-grouping yet. DB pool tuned (max 15, statement_timeout 30s) via a `PoolConfig` passed to `PrismaPg`.

## 2. Piece 1 — `traceId` correlation

Make the per-request id stable and visible end-to-end so client responses ↔ logs ↔ Sentry share one id.
- **`genReqId`** in `LoggerModule.forRoot`'s `pinoHttp`: reuse an inbound `X-Request-Id` header if present (trusted from Caddy/clients), else generate a UUID (`crypto.randomUUID()`). Set it on the response (`res.setHeader('X-Request-Id', id)` inside `genReqId`, which receives `(req, res)`).
- **`AllExceptionsFilter`**: read the id (`(req as { id?: string }).id`) and add `traceId` to the envelope (top-level field) so every error response carries it. Existing `details.errors` (class-validator) is preserved.

This is foundational (Sentry + logs key off the same id) — implemented first.

## 3. Piece 2 — `/metrics` (Prometheus)

A lean `MetricsModule` (`src/metrics/`) using **`prom-client`** directly (one dep; matches the codebase's hand-rolled-module style):
- **`MetricsService`** owns a `prom-client` `Registry`; calls `collectDefaultMetrics({ register })` (process/runtime: CPU, memory, event-loop lag, GC, handles); declares the custom metrics below.
- **HTTP** — a global `MetricsInterceptor` records `http_request_duration_seconds` (Histogram, labels `method`, `route`, `status`) where `route` is the **Express route pattern** (`req.route?.path ?? 'unmatched'`) — never the raw URL (avoids id-cardinality blowup). Registered via `APP_INTERCEPTOR`.
- **DB pool** — gauges `db_pool_total` / `db_pool_idle` / `db_pool_waiting`, collected from the `pg.Pool`. **`PrismaService` is refactored** to construct `new Pool(poolConfig)` explicitly (the fallback WS3 anticipated), keep a `readonly pool: Pool`, pass it to `new PrismaPg(this.pool)`, and expose `getPoolStats() = { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }`. `MetricsService` registers a gauge `collect()` callback reading it.
- **Domain** — one counter `ledger_entries_posted_total`, incremented in `PostingService.createPostedEntryInTx` (the single financial choke point every posted entry flows through). Minimal + easily extensible; `MetricsService` exposes `incLedgerEntriesPosted()` injected into `PostingService`.
- **`MetricsController`** — `@Public()` + `@SkipThrottle()` `GET /metrics` returns `register.metrics()` as `text/plain; version=0.0.4`. An optional `MetricsTokenGuard` requires `Authorization: Bearer <METRICS_TOKEN>` when `METRICS_TOKEN` is set (no token configured → open, but still Caddy-blocked).
- **Security:** `/metrics` is **not exposed publicly** — the `Caddyfile` returns `403` for `/metrics` (and `respond /metrics 403`); the optional monitoring stack scrapes `api:3000/metrics` over a shared Docker network. New optional env `METRICS_TOKEN`.

## 4. Piece 3 — Error tracking (Sentry, DSN-gated)

Integrate **`@sentry/node`**, gated on `SENTRY_DSN`:
- In `main.ts`, **before** `NestFactory.create`, `if (process.env.SENTRY_DSN) Sentry.init({ dsn, environment: SENTRY_ENVIRONMENT ?? NODE_ENV, release: SENTRY_RELEASE, tracesSampleRate: 0 })`. No DSN → never initialized → all SDK calls are safe no-ops; zero overhead.
- `AllExceptionsFilter` calls `Sentry.captureException(exception, { tags: { traceId }, extra: { path } })` **only on the 500/unmapped branch** — 4xx, mapped Prisma codes, and `DomainError`s are expected and are NOT reported. Attach the `traceId` and a sanitized request context (reuse the WS2 `sanitize()` helper for any body; never send secrets/PII headers).
- New optional env: `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` (all `@IsOptional`).
- Works with Sentry SaaS free-tier OR a self-hosted GlitchTip (Sentry-API-compatible) — operator sets the DSN.

## 5. Piece 4 — Optional monitoring stack + backup-failure alerting

**`docker-compose.monitoring.yml`** (separate, optional; `docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.monitoring.yml up -d` or run on another host): `prometheus`, `alertmanager`, `grafana`, `node-exporter` — sharing a network with `api`. Committed config under `monitoring/`:
- **`prometheus.yml`** — scrapes `api:3000/metrics` (with `Authorization: Bearer ${METRICS_TOKEN}` if set) + `node-exporter:9100`; 15 s interval; loads `alerts.yml`.
- **`alerts.yml`** — rules: high 5xx rate (`rate(http_request_duration_seconds_count{status=~"5.."}[5m]) ...`), p95 latency over threshold, **DB-pool saturation** (`db_pool_waiting > 0` sustained), app-down (`up{job="api"} == 0`), and **backup freshness** (`time() - backup_last_success_timestamp_seconds > 93600` → 26 h).
- **`alertmanager.yml`** — routing skeleton with a commented receiver (email/Slack/webhook) for the operator to fill in.
- **`grafana-dashboard.json`** — request rate/latency/error panels, DB-pool, `ledger_entries_posted_total`, and backup age; provisioned via a Grafana datasource+dashboard provisioning config.

**Backup-failure alerting:** `scripts/backup.sh` writes `backup_last_success_timestamp_seconds <epoch>` to `/backup-metrics/backup.prom` (a new shared `backup_metrics` volume) **after each successful `pg_dump`**; `node-exporter` runs with `--collector.textfile.directory=/backup-metrics` mounting that volume; Prometheus scrapes it; the freshness rule fires if it goes stale. A silent `pg_dump` failure now pages someone. The `backup.sh` change is tiny; the exporter + rule live in the optional stack. (The prod stack writes the metric file regardless, so it's ready to scrape.)

## 6. Piece 5 — k6 load / performance baseline

**`perf/baseline.js`** (k6): `setup()` logs in (a seeded user) → returns a token; the default VU function drives a mixed scenario over the **hot paths** — reads (`GET /reports/balance-sheet`, `/reports/income-statement`, `/ledger/trial-balance`, `/sales-invoices`) and a write (`POST /journal` create-and-post a balanced entry) — weighted read-heavy. `options`: a VU ramp (`stages` to ~20–30 VUs) and `thresholds` (`http_req_duration: ['p(95)<500']`, `http_req_failed: ['rate<0.01']`). Run via the `grafana/k6` container against the running stack (`BASE_URL`, `TOKEN`/creds via env).

**`docs/runbooks/perf-baseline.md`** — how to seed/auth, run (`docker run --rm -i grafana/k6 run - <perf/baseline.js` or a compose `profiles` service), read the summary, and the **recorded baseline** (RPS, p95, error rate, observed `db_pool_waiting` from `/metrics`) — and how it validates the pool (max 15) + `statement_timeout` under concurrency. A repeatable capacity baseline; NOT a default CI gate (it needs the full stack), with a note on making it a nightly job later.

## 7. Testing / verification

- **Piece 1 (e2e):** a response carries `X-Request-Id`; an error response body has a `traceId`; sending an inbound `X-Request-Id` is echoed/reused.
- **Piece 2 (e2e):** `GET /metrics` returns Prometheus text containing `process_cpu`/`nodejs_`/`http_request_duration_seconds`/`db_pool_total`/`db_pool_idle`/`db_pool_waiting`/`ledger_entries_posted_total`; posting a journal entry increments `ledger_entries_posted_total`; the HTTP histogram count increases after a request; with `METRICS_TOKEN` set, `/metrics` without the bearer → 401. The WS3 `statement_timeout=30s` integration test still passes (the pool-ref refactor is behavior-preserving).
- **Piece 3 (unit/integration):** with `SENTRY_DSN` unset the app boots and the filter path runs with no Sentry call (mock `@sentry/node`); on a synthetic 500 the filter calls `captureException` once; on a 4xx (DomainError/Prisma-mapped) it does NOT.
- **Full app e2e (138 + the new specs) stays green.**
- **Piece 4 (validate + smoke):** `promtool check config monitoring/prometheus.yml` + `promtool check rules monitoring/alerts.yml` (via `prom/prometheus` image) pass; `docker compose -f … -f docker-compose.monitoring.yml config` valid; `grafana-dashboard.json` is valid JSON; `backup.sh` writes `backup.prom` with the metric line (smoke).
- **Piece 5 (smoke):** a short k6 run against the stack passes the thresholds; record the baseline numbers in the runbook.

## 8. Build sequence (for the plan)

1. **traceId correlation** (Piece 1) — genReqId + response header + envelope `traceId`. App code, e2e. Foundational.
2. **`/metrics`** (Piece 2) — `prom-client` MetricsModule + HTTP interceptor + `PrismaService` pool-ref refactor + db-pool gauges + `ledger_entries_posted_total` + Caddy `/metrics` 403. App code + Caddyfile, e2e.
3. **Sentry** (Piece 3) — `@sentry/node` DSN-gated init + filter capture-on-500 + env vars. App code, unit/integration.
4. **Optional monitoring stack + backup alerting** (Piece 4) — `docker-compose.monitoring.yml` + `monitoring/*` config + `backup.sh` textfile metric + node-exporter. Validate + smoke.
5. **k6 baseline** (Piece 5) — `perf/baseline.js` + `docs/runbooks/perf-baseline.md` + a smoke run. Script + runbook.

## 9. Out of scope / notes

- No application feature changes. This is the final workstream — the production-readiness program closes after WS4.
- No distributed tracing (single service; `traceId` correlation suffices). `tracesSampleRate: 0` (Sentry errors only).
- The optional monitoring stack is *not* deployed on the prod VM by default (resource headroom); the operator brings it up or runs it on a separate host.
- Secrets (`METRICS_TOKEN`, `SENTRY_DSN`, Grafana admin) come from the VM `.env`, never committed; the deploy runbook lists them.
