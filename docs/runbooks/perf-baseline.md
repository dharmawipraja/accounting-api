# Performance Baseline Runbook (k6)

A repeatable load/perf baseline over the read-heavy hot paths. The script
`perf/baseline.js` exercises the report/query endpoints + the DB pool **without
mutating data**, so it is safe to run against any environment that has a seeded
user. This is the authenticated baseline the operator runs; the `setup()` logs in
and reuses the access token for every virtual user (VU).

## What it measures

| Metric | k6 source | What it tells you |
| --- | --- | --- |
| p95 latency | `http_req_duration` `p(95)` | server+query latency under load (threshold `<500ms`) |
| error rate | `http_req_failed` | share of non-2xx/3xx responses (threshold `<1%`) |
| throughput (RPS) | `http_reqs` (the `…/s` rate) | requests/sec the stack sustained |

The script's thresholds (in `options.thresholds`) **fail the run** (non-zero k6
exit) if p95 ≥ 500ms or the failure rate ≥ 1% — so it doubles as a pass/fail gate
when you choose to wire it into CI (see *Not a default CI gate* below).

## Prerequisites

1. A **running stack** reachable over HTTP. For a local baseline, bring up
   `db` + `migrate` + `api` (the api binds `127.0.0.1:3000`):
   ```bash
   export DOMAIN=localhost   # any value; api/db/migrate don't use Caddy
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build db migrate api
   # wait for health:
   curl -s http://127.0.0.1:3000/health   # -> {"status":"ok"}
   ```
2. A **seeded user** whose credentials the script logs in with. There is **no
   public signup** — users require an ADMIN to create them. The lightest way to
   bootstrap one ADMIN against a live container is a Nest standalone context that
   reuses the compiled `UsersService` (same argon2 hashing as the app):
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T api node -e '
     const { NestFactory } = require("@nestjs/core");
     const { AppModule } = require("./dist/src/app.module");
     const { UsersService } = require("./dist/src/users/users.service");
     (async () => {
       const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
       try {
         await app.get(UsersService).create({
           email: "perf-admin@local.test", password: "perfsecret123",
           name: "Perf Admin", role: "ADMIN",
         });
         console.log("CREATED");
       } catch (e) {
         if (String(e.message).toLowerCase().includes("already exists")) console.log("EXISTS");
         else throw e;
       } finally { await app.close(); }
     })().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
   '
   ```
   Any role with read access (`ADMIN`/`ACCOUNTANT`/`APPROVER`) works for the
   read-only hot paths.

## Run command

Run k6 from the official container, streaming the script over stdin. From a
container, `127.0.0.1` is the container itself, so target the host via
`host.docker.internal` (macOS/Windows Docker Desktop) — or use `--network host`
on Linux and keep `BASE_URL=http://127.0.0.1:3000`:

```bash
docker run --rm -i \
  -e BASE_URL=http://host.docker.internal:3000 \
  -e USER_EMAIL=perf-admin@local.test \
  -e USER_PASSWORD=perfsecret123 \
  grafana/k6 run - < perf/baseline.js
```

Default load profile (in the script): ramp `0→20` VUs over 30s, hold 20 VUs for
1m, ramp down over 15s. Override stages ad-hoc for a quick smoke without editing
the file, e.g. `… grafana/k6 run --stage 15s:20 --stage 30s:20 --stage 10s:0 - < perf/baseline.js`.

## Reading the k6 summary

At the end k6 prints a `THRESHOLDS` block (✓/✗ per threshold) and a
`TOTAL RESULTS` block. The lines that matter:

- `http_req_duration … p(95)=…` — the p95 latency; the threshold line above it
  shows ✓ if `<500ms`.
- `http_reqs … <n> <rate>/s` — total requests and the achieved **RPS**.
- `http_req_failed … <pct>` — error rate; ✓ if `<1%`.

A non-zero k6 exit means a threshold was crossed (look for `✗` and a
`thresholds … have been crossed` error line).

## Watch the DB pool during the run

The hot paths share the pg pool exposed via `prom-client`. While the load runs,
poll `/metrics` (it is `@Public()` + `@SkipThrottle()`, so it is never
rate-limited) and watch the pool gauges:

```bash
watch -n1 'curl -s http://127.0.0.1:3000/metrics | grep -E "^db_pool_(total|idle|waiting) "'
```

- `db_pool_total` rising toward `DB_POOL_MAX` (default 15) under load is normal.
- **`db_pool_waiting > 0` (sustained) means the pool is saturated** — requests are
  queueing for a connection. That is the signal to raise `DB_POOL_MAX` (and check
  Postgres `max_connections`). The `DbPoolSaturated` alert fires on this.

## How this validates `DB_POOL_MAX` + `statement_timeout`

- **`DB_POOL_MAX`** — concurrent VUs force concurrent queries through the pool. If
  `db_pool_waiting` stays at 0 and p95 holds under load, the pool size is adequate
  for that concurrency; if it climbs, the pool is the bottleneck. The baseline is
  how you size `DB_POOL_MAX` against real concurrency.
- **`statement_timeout`** (the pg `statement_timeout`, default 30s via
  `DB_STATEMENT_TIMEOUT_MS`) — a runaway/slow query under load is killed at the DB
  rather than pinning a pool connection indefinitely. A clean baseline (no errors,
  no growing `db_pool_waiting`) confirms no query is approaching the timeout; a
  cluster of 500s with the timeout in the logs would point at it.

## ⚠️ Rate limiter caveat (load testing)

The app applies a global throttle of **300 requests / 60s per authenticated user**
(`app.module.ts` `ThrottlerModule`, `ttl: 60_000`, `limit` default 300 via
`THROTTLE_LIMIT`), backed by Redis in dev/prod and **fail-closed** (429 on the
limit; 503 if Redis is unreachable). Auth endpoints are stricter and per-IP: login
**10/60s** (`THROTTLE_LOGIN_LIMIT`), refresh/logout **30/60s** (`THROTTLE_REFRESH_LIMIT`).
The report/ledger/invoice hot paths are **not** `@SkipThrottle()`, so a k6 run that
drives more than 300 req/min as a single user trips `429 Too Many Requests` — which
k6 counts as `http_req_failed`. That is the limiter working as designed, **not** an
app or DB problem.

To baseline the protected hot paths above the per-user quota you must therefore either:
- spread load across **multiple authenticated users** (each gets its own 300/min bucket); or
- temporarily raise `THROTTLE_LIMIT` for the test window; or
- keep a single user **under** the quota (≲5 req/s) — still a clean latency/pool baseline.

`/health`, `/ready`, and `/metrics` are `@SkipThrottle()`, so a `/health` smoke (below)
proves k6 + raw concurrency without tripping the limiter.

## Recorded baseline

Environment: local Docker stack (`db`+`migrate`+`api`, api `127.0.0.1:3000`),
single-host k6 (`grafana/k6`) over `host.docker.internal`, macOS Docker Desktop,
fresh DB (no posted entries). Recorded 2026-06-12.

**Authenticated hot paths** — `perf/baseline.js` endpoints, run at a
throttle-respecting rate (1 VU, ~1.6 RPS for 40s) so the per-IP limiter does not
inject 429s; this isolates real server+query latency on the four hot paths:

| Metric | Value | Threshold | Result |
| --- | --- | --- | --- |
| p95 latency (`http_req_duration`) | **16.67 ms** | `<500ms` | ✓ |
| error rate (`http_req_failed`) | **0.00%** (0/69) | `<1%` | ✓ |
| throughput (`http_reqs`) | **69 reqs @ 1.65 RPS** | — | — |
| DB pool waiting (`db_pool_waiting`) | **0** (`db_pool_total=1`) | no saturation | ✓ |

**Raw concurrency smoke** — `/health` (`@SkipThrottle()`), 5 VUs for 20s, to prove
k6 + the app sustain high concurrency without the rate limiter in the way:

| Metric | Value | Threshold | Result |
| --- | --- | --- | --- |
| p95 latency (`http_req_duration`) | **1.62 ms** | `<500ms` | ✓ |
| error rate (`http_req_failed`) | **0.00%** (0/80,863) | `<1%` | ✓ |
| throughput (`http_reqs`) | **80,863 reqs @ 4,043 RPS** | — | — |

> Note: the default-profile 20-VU run of `perf/baseline.js` from a single IP shows
> p95=8.52ms with `http_req_failed≈88%` — the failures are all `429`s from the
> per-IP throttle, not latency/DB errors (the underlying p95 is still well under
> 500ms). See the rate-limiter caveat above; baseline the hot paths distributed or
> under the per-IP ceiling.

## Not a default CI gate

This baseline is **not** wired into `npm run verify` or the default CI — it needs
the full Docker stack (db+migrate+api) and a seeded user, which the unit/e2e suites
do not require, and a single-runner load test is sensitive to the per-IP throttle
and shared-runner noise.

To run it on a schedule, add a **nightly** job (e.g. a GitHub Actions
`schedule:` workflow) that brings up the compose stack, seeds an ADMIN, runs k6
(distributed or under the per-IP ceiling), and fails the job on a crossed
threshold. Keep it nightly rather than per-PR so transient runner load doesn't
flake PRs.

## Teardown

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml down
# add -v to also drop the pgdata volume
```
