# Production Readiness WS4 — Observability & Performance Baseline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the running system observable (traceId correlation, `/metrics`, error tracking) and set a load/perf baseline — with no application feature changes.

**Architecture:** Three app-code tasks (traceId, prom-client `/metrics` + a behavior-preserving `PrismaService` pool-ref refactor, DSN-gated Sentry) then two infra/config tasks (an *optional* monitoring stack + backup-freshness alerting, and a k6 baseline). App tasks are TDD'd; infra tasks are validate + smoke. The 138-test suite is the regression net.

**Tech Stack:** NestJS 11, prom-client, @sentry/node, Prometheus/Alertmanager/Grafana/node-exporter (optional stack), k6, pino.

**Spec:** `docs/superpowers/specs/2026-06-12-production-readiness-ws4-observability-design.md`

**Ground rules:** NOT on `main` — create branch `ws4-observability` first. Docker running. `verify` = `typecheck && lint:ci && test && test:e2e:cov`. Real routes: reports `/reports/*`, journal `/ledger/journal-entries` (`POST /ledger/journal-entries?post=true` = create-and-post). Never run `prisma format`.

## File structure
- `src/app.module.ts` (genReqId), `src/common/filters/all-exceptions.filter.ts` (traceId + Sentry capture), `src/config/env.validation.ts` (new optional env) — Tasks 1/2/3.
- `src/metrics/` — `metrics.module.ts`, `metrics.service.ts`, `metrics.interceptor.ts`, `metrics.controller.ts`, `metrics-token.guard.ts` (Task 2, new).
- `src/common/prisma/prisma.service.ts` (pool-ref refactor), `src/ledger/posting/posting.service.ts` (counter), `Caddyfile` (/metrics 403) — Task 2.
- `src/main.ts` (Sentry.init) — Task 3.
- `docker-compose.monitoring.yml`, `monitoring/*`, `scripts/backup.sh` (textfile metric) — Task 4 (new).
- `perf/baseline.js`, `docs/runbooks/perf-baseline.md` — Task 5 (new).
- Tests: `test/trace-id.e2e-spec.ts`, `test/metrics.e2e-spec.ts`, `src/common/filters/all-exceptions.filter.spec.ts` (Sentry cases).

---

## Task 1: traceId correlation

**Files:** `src/app.module.ts`, `src/common/filters/all-exceptions.filter.ts`; Test: `test/trace-id.e2e-spec.ts`

- [ ] **Step 1: Branch**

```bash
git checkout -b ws4-observability
```

- [ ] **Step 2: Failing e2e** `test/trace-id.e2e-spec.ts` (mirror an existing e2e bootstrap — Test module + ValidationPipe + AllExceptionsFilter + makePrismaOverride + startTestDb; no auth needed for `/health`):

```ts
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('traceId correlation (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;

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
  }, 120_000);

  afterAll(async () => { await app.close(); await prisma.$disconnect(); await db?.stop(); });

  it('echoes a generated X-Request-Id on a normal response', async () => {
    const res = await request(app.getHttpServer() as App).get('/health').expect(200);
    expect(res.headers['x-request-id']).toMatch(/[0-9a-f-]{36}/);
  });

  it('reuses an inbound X-Request-Id', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/health').set('X-Request-Id', 'trace-abc-123').expect(200);
    expect(res.headers['x-request-id']).toBe('trace-abc-123');
  });

  it('includes traceId in an error envelope', async () => {
    // an unauthenticated protected route -> 401 envelope; assert traceId present
    const res = await request(app.getHttpServer() as App).get('/reports/balance-sheet').expect(401);
    expect((res.body as { traceId?: string }).traceId).toBeTruthy();
  });
});
```
Run `npm run test:e2e -- trace-id` → FAIL (no X-Request-Id header; no traceId in body).

- [ ] **Step 3: genReqId** in `src/app.module.ts` — add `import { randomUUID } from 'crypto';` and replace the `pinoHttp` block:

```ts
    LoggerModule.forRoot({
      pinoHttp: {
        autoLogging: true,
        genReqId: (req, res) => {
          const id =
            (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
          res.setHeader('X-Request-Id', id);
          return id;
        },
        redact: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
        ],
      },
    }),
```

- [ ] **Step 4: traceId in the envelope** in `src/common/filters/all-exceptions.filter.ts` — add `traceId?: string` to the `ErrorEnvelope` interface, and set it from the request id (the `url` hoist from WS2 already grabs `req`; extend it):

```ts
    const req = ctx.getRequest<{ url?: string; id?: string }>();
    const url = req.url ?? 'unknown';
    // ... existing branches build `envelope` ...
    if (req.id) envelope.traceId = req.id;
    response.status(status).json(envelope);
```
(Place the `if (req.id) ...` immediately before `response.status(...).json(envelope)` so it applies to every branch.)

- [ ] **Step 5: Run → PASS**

Run: `npm run test:e2e -- trace-id` → 3 pass. Then `npm run typecheck && npm run lint:ci`.

- [ ] **Step 6: Commit**

```bash
git add src/app.module.ts src/common/filters/all-exceptions.filter.ts test/trace-id.e2e-spec.ts
git commit -m "feat(obs): traceId correlation (X-Request-Id reuse/echo + error-envelope traceId)"
```

---

## Task 2: `/metrics` (Prometheus) + DB-pool refactor + counter

**Files:** `package.json` (prom-client), `src/metrics/*` (new), `src/common/prisma/prisma.service.ts`, `src/ledger/posting/posting.service.ts`, `src/config/env.validation.ts`, `Caddyfile`; Test: `test/metrics.e2e-spec.ts`

- [ ] **Step 1: Add prom-client** — `npm install prom-client`.

- [ ] **Step 2: PrismaService pool-ref refactor** — `src/common/prisma/prisma.service.ts`: construct an explicit `pg.Pool`, keep the reference, expose stats:

```ts
import { Pool } from 'pg';
// ...
  readonly client: ExtendedPrismaClient;
  private readonly pool: Pool;

  constructor(config: ConfigService) {
    const pool = new Pool({
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
      max: config.get<number>('DB_POOL_MAX') ?? 15,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      statement_timeout: config.get<number>('DB_STATEMENT_TIMEOUT_MS') ?? 30000,
    });
    const adapter = new PrismaPg(pool);
    super({ adapter });
    this.pool = pool;
    this.client = applySoftDelete(this);
  }

  getPoolStats(): { total: number; idle: number; waiting: number } {
    return { total: this.pool.totalCount, idle: this.pool.idleCount, waiting: this.pool.waitingCount };
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    await this.pool.end();
  }
```
(The WS3 `db-runtime-config` e2e — `SHOW statement_timeout='30s'` — MUST still pass; this is the same pool config, just an explicit `Pool`.)

- [ ] **Step 3: MetricsService** `src/metrics/metrics.service.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { Registry, collectDefaultMetrics, Histogram, Counter, Gauge } from 'prom-client';
import { PrismaService } from '../common/prisma/prisma.service';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly httpDuration: Histogram<string>;
  private readonly ledgerPosted: Counter<string>;

  constructor(private readonly prisma: PrismaService) {
    collectDefaultMetrics({ register: this.registry });
    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers: [this.registry],
    });
    this.ledgerPosted = new Counter({
      name: 'ledger_entries_posted_total',
      help: 'Total posted journal entries',
      registers: [this.registry],
    });
    const stats = () => this.prisma.getPoolStats();
    new Gauge({ name: 'db_pool_total', help: 'pg pool total connections',
      registers: [this.registry], collect() { this.set(stats().total); } });
    new Gauge({ name: 'db_pool_idle', help: 'pg pool idle connections',
      registers: [this.registry], collect() { this.set(stats().idle); } });
    new Gauge({ name: 'db_pool_waiting', help: 'pg pool waiting requests',
      registers: [this.registry], collect() { this.set(stats().waiting); } });
  }

  incLedgerEntriesPosted(): void { this.ledgerPosted.inc(); }
  async metrics(): Promise<string> { return this.registry.metrics(); }
  contentType(): string { return this.registry.contentType; }
}
```

- [ ] **Step 4: MetricsInterceptor** `src/metrics/metrics.interceptor.ts`:

```ts
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<{ method: string; route?: { path?: string } }>();
    const res = ctx.switchToHttp().getResponse<{ statusCode: number }>();
    const end = this.metrics.httpDuration.startTimer();
    return next.handle().pipe(
      tap({
        next: () => end({ method: req.method, route: req.route?.path ?? 'unmatched', status: String(res.statusCode) }),
        error: () => end({ method: req.method, route: req.route?.path ?? 'unmatched', status: String(res.statusCode || 500) }),
      }),
    );
  }
}
```

- [ ] **Step 5: token guard** `src/metrics/metrics-token.guard.ts`:

```ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MetricsTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}
  canActivate(ctx: ExecutionContext): boolean {
    const token = this.config.get<string>('METRICS_TOKEN');
    if (!token) return true; // no token configured -> rely on Caddy network isolation
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    if (req.headers.authorization === `Bearer ${token}`) return true;
    throw new UnauthorizedException();
  }
}
```

- [ ] **Step 6: controller** `src/metrics/metrics.controller.ts`:

```ts
import { Controller, Get, Header, Res, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { MetricsService } from './metrics.service';
import { MetricsTokenGuard } from './metrics-token.guard';

@SkipThrottle()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Public()
  @UseGuards(MetricsTokenGuard)
  @Get()
  async scrape(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metrics.contentType());
    res.send(await this.metrics.metrics());
  }
}
```

- [ ] **Step 7: module** `src/metrics/metrics.module.ts` (global so any service can inject `MetricsService`):

```ts
import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { MetricsInterceptor } from './metrics.interceptor';
import { MetricsTokenGuard } from './metrics-token.guard';

@Global()
@Module({
  providers: [MetricsService, MetricsTokenGuard, { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor }],
  controllers: [MetricsController],
  exports: [MetricsService],
})
export class MetricsModule {}
```
Register `MetricsModule` in `src/app.module.ts` `imports` (after `AuditModule`).

- [ ] **Step 8: counter in PostingService** `src/ledger/posting/posting.service.ts` — inject `MetricsService` into the constructor and call `this.metrics.incLedgerEntriesPosted()` at the end of `createPostedEntryInTx` (after the entry is created, before return). Add `import { MetricsService } from '../../metrics/metrics.service';` and `private readonly metrics: MetricsService,` to the constructor. (Counts every posted entry — manual, invoice, bill, payment, close — the central choke point. A rare tx rollback after this point over-counts by 1; acceptable for a throughput metric.)

- [ ] **Step 9: env + Caddy** — `src/config/env.validation.ts`: `@IsOptional @IsString() METRICS_TOKEN?: string;`. `Caddyfile`: block `/metrics` from the internet — inside the `{$DOMAIN}` block, BEFORE `reverse_proxy`:
```
	@metrics path /metrics
	respond @metrics "Not found" 404
```

- [ ] **Step 10: e2e** `test/metrics.e2e-spec.ts` — bootstrap like Task 1 (no `METRICS_TOKEN` in env, so `/metrics` is open in the test). Assert:
```ts
  it('exposes Prometheus metrics families', async () => {
    const res = await request(app.getHttpServer() as App).get('/metrics').expect(200);
    const body = res.text;
    for (const m of ['process_cpu', 'nodejs_', 'http_request_duration_seconds', 'db_pool_total', 'db_pool_idle', 'db_pool_waiting', 'ledger_entries_posted_total']) {
      expect(body).toContain(m);
    }
  });
  it('increments ledger_entries_posted_total after a post', async () => {
    // seed company/accounts/periods + an ADMIN/ACCOUNTANT+APPROVER token, post one journal entry via the service or HTTP, then:
    const before = await scrapeCounter('ledger_entries_posted_total');
    await postOneEntry(); // create-and-post a balanced manual entry
    const after = await scrapeCounter('ledger_entries_posted_total');
    expect(after).toBeGreaterThan(before);
  });
```
(Provide a `scrapeCounter` helper that GETs `/metrics` and parses the `ledger_entries_posted_total <n>` line; `postOneEntry` seeds via the established services + posts a balanced Dr Kas/Cr Modal entry. Mirror the seed pattern from `test/close.e2e-spec.ts`.) Run `npm run test:e2e -- metrics` → after wiring, pass.

- [ ] **Step 11: regression + commit**

Run: `npm run typecheck && npm run lint:ci && npm run test:e2e` → full suite green (incl. the WS3 `db-runtime-config` statement_timeout test). Then:
```bash
git add package.json package-lock.json src/metrics src/common/prisma/prisma.service.ts src/ledger/posting/posting.service.ts src/app.module.ts src/config/env.validation.ts Caddyfile test/metrics.e2e-spec.ts
git commit -m "feat(obs): prom-client /metrics (http+pool+ledger), Caddy-blocked, optional token"
```

---

## Task 3: Error tracking (Sentry, DSN-gated)

**Files:** `package.json` (@sentry/node), `src/main.ts`, `src/common/filters/all-exceptions.filter.ts`, `src/config/env.validation.ts`; Test: `src/common/filters/all-exceptions.filter.spec.ts`

- [ ] **Step 1: Add @sentry/node** — `npm install @sentry/node`.

- [ ] **Step 2: Failing unit cases** — append to `src/common/filters/all-exceptions.filter.spec.ts` (mock the SDK at top: `jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));` and `import * as Sentry from '@sentry/node';`):

```ts
  it('reports a 500/unknown error to Sentry', () => {
    (Sentry.captureException as jest.Mock).mockClear();
    const m = mockHost();
    filter.catch(new Error('boom'), m.host);
    expect(m.code()).toBe(500);
    expect(Sentry.captureException as jest.Mock).toHaveBeenCalledTimes(1);
  });
  it('does NOT report a mapped 4xx (DomainError) to Sentry', () => {
    (Sentry.captureException as jest.Mock).mockClear();
    const m = mockHost();
    filter.catch(new ConflictDomainError('dup', {}), m.host);
    expect(m.code()).toBe(409);
    expect(Sentry.captureException as jest.Mock).not.toHaveBeenCalled();
  });
```
Run `npx jest all-exceptions.filter.spec` → the new cases FAIL (filter doesn't call Sentry yet).

- [ ] **Step 3: Sentry capture in the filter** — in `src/common/filters/all-exceptions.filter.ts`, `import * as Sentry from '@sentry/node';`. In the **final `else`** (the unhandled/500 branch) and the **unmapped-Prisma-code** branch, after logging, add:
```ts
      Sentry.captureException(exception, { tags: { traceId: req.id }, extra: { path: url } });
```
(Only those two 500 branches. Do NOT call it for DomainError/HttpException/mapped-Prisma/validation branches.)

- [ ] **Step 4: Sentry.init in main.ts** — at the very top of `bootstrap()` (before `NestFactory.create`):
```ts
  if (process.env.SENTRY_DSN) {
    const Sentry = await import('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
      release: process.env.SENTRY_RELEASE,
      tracesSampleRate: 0,
    });
  }
```
(No DSN → never initialized → `captureException` is a safe no-op.)

- [ ] **Step 5: env** — `src/config/env.validation.ts`: `@IsOptional @IsString() SENTRY_DSN?: string; @IsOptional @IsString() SENTRY_ENVIRONMENT?: string; @IsOptional @IsString() SENTRY_RELEASE?: string;`

- [ ] **Step 6: Run + regression**

Run: `npx jest all-exceptions.filter.spec` → all pass. `npm run typecheck && npm run lint:ci && npm test` → green (the app boots with no DSN; no Sentry network calls in tests). Optionally `npm run test:e2e` to confirm the app still serves.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/main.ts src/common/filters/all-exceptions.filter.ts src/common/filters/all-exceptions.filter.spec.ts src/config/env.validation.ts
git commit -m "feat(obs): DSN-gated Sentry error reporting (500s only, with traceId)"
```

---

## Task 4: Optional monitoring stack + backup-failure alerting

**Files:** `docker-compose.monitoring.yml` (new), `monitoring/{prometheus.yml,alerts.yml,alertmanager.yml,grafana-dashboard.json,grafana-provisioning/*}` (new), `scripts/backup.sh` (textfile metric)

- [ ] **Step 1: backup.sh writes a freshness metric** — in `scripts/backup.sh`, after a successful `pg_dump`, write the textfile metric (atomic rename):
```sh
  ts=$(date +%Y%m%dT%H%M%SZ)
  pg_dump -Fc -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -f "/backups/accounting-$ts.dump"
  echo "backup written: accounting-$ts.dump"
  mkdir -p /backup-metrics
  printf 'backup_last_success_timestamp_seconds %s\n' "$(date +%s)" > /backup-metrics/backup.prom.tmp
  mv /backup-metrics/backup.prom.tmp /backup-metrics/backup.prom
  find /backups -name 'accounting-*.dump' -mtime +"$RETENTION_DAYS" -delete
```
And in `docker-compose.prod.yml`, add a `backup_metrics:/backup-metrics` volume mount to the `backup` service + declare `backup_metrics` under top-level `volumes`. (So the metric file is produced even without the monitoring stack.)

- [ ] **Step 2: `monitoring/prometheus.yml`:**
```yaml
global:
  scrape_interval: 15s
rule_files:
  - /etc/prometheus/alerts.yml
alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']
scrape_configs:
  - job_name: api
    metrics_path: /metrics
    static_configs:
      - targets: ['api:3000']
  - job_name: node-exporter
    static_configs:
      - targets: ['node-exporter:9100']
```
(If `METRICS_TOKEN` is used, add `authorization: { credentials: '<token>' }` under the api job — documented in the runbook.)

- [ ] **Step 3: `monitoring/alerts.yml`:**
```yaml
groups:
  - name: accounting-api
    rules:
      - alert: ApiDown
        expr: up{job="api"} == 0
        for: 2m
        labels: { severity: critical }
        annotations: { summary: 'API is down (no /metrics scrape for 2m)' }
      - alert: HighErrorRate
        expr: sum(rate(http_request_duration_seconds_count{status=~"5.."}[5m])) / sum(rate(http_request_duration_seconds_count[5m])) > 0.05
        for: 5m
        labels: { severity: warning }
        annotations: { summary: '5xx rate over 5% for 5m' }
      - alert: HighLatencyP95
        expr: histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le)) > 1
        for: 10m
        labels: { severity: warning }
        annotations: { summary: 'p95 latency over 1s for 10m' }
      - alert: DbPoolSaturated
        expr: db_pool_waiting > 0
        for: 5m
        labels: { severity: warning }
        annotations: { summary: 'DB pool has waiting requests for 5m (raise DB_POOL_MAX?)' }
      - alert: BackupStale
        expr: time() - backup_last_success_timestamp_seconds > 93600
        for: 10m
        labels: { severity: critical }
        annotations: { summary: 'No successful DB backup in >26h' }
```

- [ ] **Step 4: `monitoring/alertmanager.yml`** (receiver skeleton):
```yaml
route:
  receiver: default
  group_by: ['alertname']
receivers:
  - name: default
    # Fill in a real receiver, e.g. email_configs / slack_configs / webhook_configs.
    # webhook_configs:
    #   - url: 'https://example.com/alerts'
```

- [ ] **Step 5: `docker-compose.monitoring.yml`** (Prometheus + Alertmanager + Grafana + node-exporter on the shared default network):
```yaml
services:
  prometheus:
    image: prom/prometheus:latest
    restart: unless-stopped
    volumes:
      - ./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - ./monitoring/alerts.yml:/etc/prometheus/alerts.yml:ro
      - prometheus_data:/prometheus
    ports: ['127.0.0.1:9090:9090']

  alertmanager:
    image: prom/alertmanager:latest
    restart: unless-stopped
    volumes:
      - ./monitoring/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro

  node-exporter:
    image: prom/node-exporter:latest
    restart: unless-stopped
    command: ['--collector.textfile.directory=/backup-metrics']
    volumes:
      - backup_metrics:/backup-metrics:ro

  grafana:
    image: grafana/grafana:latest
    restart: unless-stopped
    environment:
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD:?GRAFANA_ADMIN_PASSWORD is required}
    volumes:
      - ./monitoring/grafana-provisioning:/etc/grafana/provisioning:ro
      - ./monitoring/grafana-dashboard.json:/var/lib/grafana/dashboards/accounting.json:ro
      - grafana_data:/var/lib/grafana
    ports: ['127.0.0.1:3001:3000']

volumes:
  prometheus_data:
  grafana_data:
  backup_metrics:
    external: true
    name: accounting-api_backup_metrics
```
Also create `monitoring/grafana-provisioning/datasources/prometheus.yml` (a Prometheus datasource pointing at `http://prometheus:9090`) and `monitoring/grafana-provisioning/dashboards/dashboards.yml` (a file provider loading `/var/lib/grafana/dashboards`).

- [ ] **Step 6: `monitoring/grafana-dashboard.json`** — a minimal valid dashboard (panels: request rate by status, p95 latency, `db_pool_*`, `rate(ledger_entries_posted_total[5m])`, `time()-backup_last_success_timestamp_seconds`). Keep it a valid Grafana dashboard JSON (schemaVersion + panels array + a templating/time block). It must parse as JSON.

- [ ] **Step 7: Validate**
```bash
docker run --rm -v "$PWD/monitoring/prometheus.yml":/p.yml prom/prometheus:latest promtool check config /p.yml
docker run --rm -v "$PWD/monitoring/alerts.yml":/a.yml prom/prometheus:latest promtool check rules /a.yml
DOMAIN=example.test GRAFANA_ADMIN_PASSWORD=x docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.monitoring.yml config >/dev/null && echo "compose OK"
node -e "JSON.parse(require('fs').readFileSync('monitoring/grafana-dashboard.json','utf8')); console.log('dashboard JSON OK')"
```
Expected: promtool "SUCCESS" for config + rules; compose OK; dashboard JSON OK. (promtool note: the api/node-exporter targets are resolved at runtime — `check config` validates syntax, not connectivity.)

- [ ] **Step 8: Smoke — backup writes the metric**
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d db
sleep 8
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm --entrypoint sh backup -c 'pg_dump -Fc -h db -U accounting -d accounting -f /backups/x.dump && mkdir -p /backup-metrics && printf "backup_last_success_timestamp_seconds %s\n" "$(date +%s)" > /backup-metrics/backup.prom && cat /backup-metrics/backup.prom'
docker compose -f docker-compose.yml -f docker-compose.prod.yml down -v
```
Expected: a `backup_last_success_timestamp_seconds <epoch>` line. Report it.

- [ ] **Step 9: Commit**

```bash
git add docker-compose.monitoring.yml monitoring docker-compose.prod.yml scripts/backup.sh
git commit -m "feat(obs): optional Prometheus/Grafana/Alertmanager stack + backup-freshness alert"
```

---

## Task 5: k6 load / performance baseline

**Files:** `perf/baseline.js` (new), `docs/runbooks/perf-baseline.md` (new)

- [ ] **Step 1: `perf/baseline.js`:**
```js
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  stages: [
    { duration: '30s', target: 20 },
    { duration: '1m', target: 20 },
    { duration: '15s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  const res = http.post(`${BASE}/auth/login`, JSON.stringify({
    email: __ENV.USER_EMAIL, password: __ENV.USER_PASSWORD,
  }), { headers: { 'Content-Type': 'application/json' } });
  check(res, { 'login 200': (r) => r.status === 200 });
  return { token: res.json('accessToken') };
}

export default function (data) {
  const headers = { Authorization: `Bearer ${data.token}` };
  // read-heavy hot paths
  http.get(`${BASE}/reports/balance-sheet`, { headers });
  http.get(`${BASE}/reports/income-statement?from=2026-01-01&to=2026-12-31`, { headers });
  http.get(`${BASE}/ledger/trial-balance`, { headers });
  http.get(`${BASE}/sales-invoices`, { headers });
  sleep(1);
}
```
(A read-only baseline is the safe default — it exercises the report/query hot paths + the pool without mutating data. The runbook documents how to add a write path if desired.)

- [ ] **Step 2: `docs/runbooks/perf-baseline.md`** — document: prerequisites (a running stack + a seeded user via the deploy/seed flow); the run command
  `docker run --rm -i -e BASE_URL=http://host.docker.internal:3000 -e USER_EMAIL=… -e USER_PASSWORD=… grafana/k6 run - < perf/baseline.js`;
  how to read the k6 summary (p95, RPS via `http_reqs`, `http_req_failed`); watching `db_pool_waiting`/`db_pool_total` on `/metrics` during the run to spot pool saturation; the **recorded baseline** (fill in p95 / RPS / error-rate / max pool-waiting from your run); and how it validates `DB_POOL_MAX` + `statement_timeout`. Note it is NOT a default CI gate (needs the full stack); mention turning it into a nightly job later.

- [ ] **Step 3: Smoke run** — bring up the stack (db+migrate+api), seed an ADMIN user, run a short k6 (`--stages 10s:5,10s:0` override or the script) against `http://127.0.0.1:3000`, confirm the thresholds pass, and record the numbers into the runbook's baseline section. Report the k6 summary line (p95, http_req_failed). Then tear down.

- [ ] **Step 4: Final WS4 gate**

Run: `npm run verify` (app green end-to-end). Then:
```bash
git add perf/baseline.js docs/runbooks/perf-baseline.md
git commit -m "perf(obs): k6 load baseline over hot paths + perf runbook"
```

---

## Self-review (against the spec)

**Spec coverage:**
- §2 traceId (genReqId reuse/echo X-Request-Id + envelope traceId) → Task 1 ✓
- §3 /metrics (prom-client: process + http-by-route + db-pool via PrismaService refactor + ledger counter; @Public+@SkipThrottle+token; Caddy 403) → Task 2 ✓
- §4 Sentry (DSN-gated init + filter capture-on-500-only + env) → Task 3 ✓
- §5 optional monitoring stack (compose.monitoring + prometheus/alerts/alertmanager/grafana + node-exporter) + backup-freshness (backup.sh textfile + alert) → Task 4 ✓
- §6 k6 baseline (perf/baseline.js + perf-baseline.md) → Task 5 ✓
- §7 testing (traceId e2e, metrics e2e + counter increment, Sentry unit 500-only, promtool/compose/JSON validate, k6 smoke; full suite green incl statement_timeout) → each task ✓
- §8 sequence (traceId → metrics → sentry → monitoring → k6) → task order ✓

**Placeholder scan:** none — full code/config in every step. The k6 recorded-baseline numbers and the Grafana panel JSON are produced/authored during implementation (the procedure + a valid skeleton are specified), not left as TBDs.

**Consistency:** `MetricsService`/`getPoolStats`/`incLedgerEntriesPosted` names match across metrics.service.ts, prisma.service.ts, posting.service.ts; metric names (`http_request_duration_seconds`, `db_pool_total/idle/waiting`, `ledger_entries_posted_total`, `backup_last_success_timestamp_seconds`) match across the service, the e2e assertions, prometheus alerts, and the dashboard; `traceId`/`X-Request-Id` consistent across genReqId, the filter, and the Sentry tag; `METRICS_TOKEN`/`SENTRY_*` env names match env.validation + usage; the `backup_metrics` volume name matches backup.sh, docker-compose.prod.yml, and docker-compose.monitoring.yml.
