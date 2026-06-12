# Production Readiness — WS3: Runtime & Deploy Hardening — Design Spec

- **Date:** 2026-06-12
- **Status:** Approved (pending written-spec review)
- **Owner:** budi@maul.is
- **Builds on:** the feature-complete 6-phase API + WS1 (quality gate) + WS2 (code integrity), all merged. No application features are added.

## 1. Program context

Third of four production-readiness workstreams ([[production-readiness-program]]): **WS1 (done) → WS2 (done) → WS3 (this) → WS4.** WS3 makes the app deployable and resilient on a **single VM / Docker host** the operator owns.

**Decisions (from brainstorming):** single VM **~2 vCPU / 4 GB**, one company at heavier volume, single app instance; **Caddy** reverse proxy with **auto-HTTPS**; **`pg_dump` sidecar + restore runbook**; a **base + `docker-compose.prod.yml` override** structure.

## 2. Architecture / topology

```
Internet ─TLS→ caddy (80/443, auto-HTTPS) ──→ api:3000 (no public port)
                                                 │
                migrate (one-shot, runs first) ──┤→ db:5432 (127.0.0.1 only)
                backup (cron pg_dump sidecar) ───┘
```

Deploy command: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`. The base `docker-compose.yml` keeps the dev-friendly `db`+`api`; the prod override adds `caddy`/`migrate`/`backup` and hardens `api`/`db`.

## 3. Piece 1 — App-level runtime config (the only app-code change)

**`src/common/prisma/prisma.service.ts`** — pass a tuned `PoolConfig` to `PrismaPg` instead of a bare string:

```ts
constructor(config: ConfigService) {
  const adapter = new PrismaPg({
    connectionString: config.getOrThrow<string>('DATABASE_URL'),
    max: config.get<number>('DB_POOL_MAX') ?? 15,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: config.get<number>('DB_STATEMENT_TIMEOUT_MS') ?? 30000,
  });
  super({ adapter });
  this.client = applySoftDelete(this);
}
```
(`@prisma/adapter-pg` 7.x accepts a `pg.PoolConfig`; if this build requires a `pg.Pool` instance, build `new Pool({...})` from the `pg` dep and pass that. `statement_timeout` is a 30 s **DB-level backstop** above the 20 s payments interactive-tx timeout set earlier — see [[invoicing-phase4-gotchas]].)

**`src/main.ts`** — server timeouts + body limit (robust behind Caddy):
```ts
const server = app.getHttpServer();
server.keepAliveTimeout = 65_000;   // > typical proxy keep-alive
server.headersTimeout = 66_000;     // must exceed keepAliveTimeout
server.requestTimeout = 30_000;
```
Body limit aligned to 1 MB via Nest's body parser (`app.useBodyParser('json', { limit: '1mb' })` and `'urlencoded'` likewise; Nest 11 `NestExpressApplication`), matching Caddy's edge cap.

**`src/config/env.validation.ts`** — add optional, defaulted vars (keep `validate()` working):
```ts
@IsOptional() @IsInt() @Min(1) @Max(100) DB_POOL_MAX?: number;
@IsOptional() @IsInt() @Min(1000) DB_STATEMENT_TIMEOUT_MS?: number;
```
(import `IsOptional`.) Defaults live in code (above); the compose may set them.

## 4. Piece 2 — Migration service + container hardening

**`docker-compose.prod.yml` `migrate` service** — one-shot, built from the Dockerfile `build` stage (has the Prisma CLI + `prisma/`):
```yaml
  migrate:
    build: { context: ., target: build }
    command: ['npx', 'prisma', 'migrate', 'deploy']
    environment:
      DATABASE_URL: postgresql://accounting:${POSTGRES_PASSWORD:?}@db:5432/accounting?schema=public
    depends_on: { db: { condition: service_healthy } }
    restart: 'no'
```
`api` gains `depends_on: { db: { condition: service_healthy }, migrate: { condition: service_completed_successfully } }` — migrations run **before the app starts, never in-process**; the app image stays `--omit=dev`.

**Container hardening** (on `api`, in the override): `init: true` (tini as PID 1 — reaps zombies, forwards `SIGTERM`); a Node-based `healthcheck` (no curl in the slim image):
```yaml
    healthcheck:
      test: ['CMD', 'node', '-e', "require('http').get('http://127.0.0.1:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 20s
    stop_grace_period: 30s
    restart: unless-stopped
```
Also add a `HEALTHCHECK` instruction to the **Dockerfile** (same Node probe) so the image is self-describing. `enableShutdownHooks` (already present) drains Nest on `SIGTERM` within the grace period.

## 5. Piece 3 — Production compose + Caddy / TLS

**`caddy` service:** `caddy:2-alpine`, ports `80:80` + `443:443`, a mounted `./Caddyfile`, persistent `caddy_data` (ACME certs) + `caddy_config` volumes, `restart: unless-stopped`.

**`Caddyfile`:**
```
{$DOMAIN} {
	reverse_proxy api:3000
	request_body {
		max_size 1MB
	}
	encode gzip
	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
}
```
`DOMAIN` is env-driven (auto-HTTPS needs DNS→VM + ports 80/443 open). For staging/no-domain, document `{$DOMAIN}` with `tls internal`.

**`api` hardening (override):** **remove the public `3000:3000` port** (only Caddy reaches it over the compose network) + the healthcheck/init/limits above + `deploy.resources.limits: { cpus: '1.0', memory: 768M }` (+ reservations).

**`db` hardening (override):** `restart: unless-stopped`; `deploy.resources.limits: { memory: 1536M }`; 4 GB tuning via `command`:
```
postgres -c shared_buffers=256MB -c effective_cache_size=1GB
  -c max_connections=50 -c work_mem=8MB -c maintenance_work_mem=128MB
```
(`max_connections` 50 > pool 15 + backup + admin; all values documented as tunable.) Keep the `pg_isready` healthcheck; keep the host port at `127.0.0.1` (admin only).

## 6. Piece 4 — Backup sidecar + runbooks

**`backup` service:** `postgres:16` (has `pg_dump`), mounts `./scripts/backup.sh` + a `backups` named volume, `restart: unless-stopped`, env `PGHOST=db`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`/`RETENTION_DAYS`/`BACKUP_INTERVAL`.

**`scripts/backup.sh`:**
```sh
#!/bin/sh
set -eu
: "${RETENTION_DAYS:=7}"; : "${BACKUP_INTERVAL:=86400}"
mkdir -p /backups
while true; do
  ts=$(date +%Y%m%dT%H%M%SZ)
  pg_dump -Fc -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -f "/backups/accounting-$ts.dump"
  find /backups -name 'accounting-*.dump' -mtime +"$RETENTION_DAYS" -delete
  sleep "$BACKUP_INTERVAL"
done
```
(`PGPASSWORD` from env; custom format `-Fc` for `pg_restore`.)

**`docs/runbooks/backup-and-restore.md`** — what's backed up (logical `pg_dump -Fc`), schedule/retention/location, and a tested step-by-step **restore** (`docker compose stop api migrate` → `pg_restore --clean --if-exists -d` into `db` → start) + a "verify your restore" drill.

**`docs/runbooks/deploy.md`** — first-deploy (`.env` secrets + `DOMAIN`, ports 80/443), `docker compose -f … -f … up -d --build`, how the `migrate` service gates the app, the SIGTERM-drain behavior, and **rollback caveats** (migrations are forward-only — a bad migration needs a restore or a corrective migration, not a down-migration).

## 7. Testing / verification

WS3 is mostly infra, so verification is **config-validation + smoke** (a full-stack compose can't run inside the app's testcontainer e2e harness):
- **Piece 1 (e2e/integration + the existing suite):** an integration test asserts `SHOW statement_timeout` returns `'30s'` on a `prisma.client.$queryRaw` connection; the full **137-test e2e suite stays green** (the pool/timeout/body-limit changes don't regress).
- **Pieces 2–4 (smoke, run by the implementer with Docker):** `docker compose -f docker-compose.yml -f docker-compose.prod.yml config` validates; `docker build` succeeds; bringing the stack up locally (with `DOMAIN` set to a localhost name + Caddy `tls internal`, or testing the api/db/migrate without Caddy) shows: `migrate` completes first → `api` becomes **healthy** → `/health` 200; a `SIGTERM` (`docker compose stop api`) drains an in-flight request; `backup.sh` produces a `.dump` and `pg_restore` round-trips into a scratch DB. These smoke steps are documented in the runbooks so they're repeatable.
- The WS1 CI `docker` job MAY gain a `docker compose … config` validation step (cheap guard).

## 8. Build sequence (for the plan)

1. **App runtime config** (Piece 1) — `PrismaService` pool + `statement_timeout`, `main.ts` server timeouts + body limit, env vars; integration + full-e2e tested. Pure app code, independent — do first.
2. **Migration service + container hardening** (Piece 2) — `migrate` service, `init`/healthcheck/`stop_grace_period`, Dockerfile `HEALTHCHECK`; compose-config + smoke.
3. **Production compose + Caddy/TLS** (Piece 3) — `caddy` + `Caddyfile` + db tuning + api hardening/limits + remove public api port; compose-config + smoke.
4. **Backup sidecar + runbooks** (Piece 4) — `backup` service + `scripts/backup.sh` + the two runbooks; smoke (dump + restore).

## 9. Out of scope / notes

- No application feature changes; WS4 (observability + load/perf) is a separate spec.
- Secrets (`POSTGRES_PASSWORD`, JWT secrets, `DOMAIN`) come from a `.env` on the VM (already gitignored), never committed; the deploy runbook lists the required set.
- The WS1 CI/Dependabot still activate only on the first GitHub push (a standing user action).
- Auth rate-limit tightening and metrics/error-tracking are WS4, not here.
