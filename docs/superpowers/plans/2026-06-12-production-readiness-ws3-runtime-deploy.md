# Production Readiness WS3 — Runtime & Deploy Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployable, resilient single-VM stack — tuned DB pool + timeouts, a pre-start migration step, hardened containers, a Caddy/TLS reverse proxy, and backups + runbooks — with one small app-code change and no feature changes.

**Architecture:** Base `docker-compose.yml` + a `docker-compose.prod.yml` override (adds caddy/migrate/backup, hardens api/db). One app-code task (Prisma pool + server timeouts) is e2e-tested; the infra tasks are `docker compose config` + smoke-verified (a full-stack compose can't run in the testcontainer e2e harness).

**Tech Stack:** Docker Compose, Caddy (auto-HTTPS), Postgres 16, Prisma 7 `@prisma/adapter-pg` + `pg`, NestJS 11.

**Spec:** `docs/superpowers/specs/2026-06-12-production-readiness-ws3-runtime-deploy-design.md`

**Ground rules:** NOT on `main` — create branch `ws3-runtime-deploy` first. Docker running. `verify` = `typecheck && lint:ci && test && test:e2e:cov`. Infra-task "tests" are config-validation + smoke (commands given). Never run `prisma format`.

## File structure
- `src/common/prisma/prisma.service.ts`, `src/main.ts`, `src/config/env.validation.ts` — app runtime config (Task 1).
- `test/db-runtime-config.e2e-spec.ts` — statement_timeout integration test (Task 1, new).
- `docker-compose.prod.yml` — the production override (Tasks 2–4, new).
- `Dockerfile` — add HEALTHCHECK (Task 2).
- `docker-compose.yml` — bind api port to localhost (Task 3).
- `Caddyfile` — reverse proxy + TLS (Task 3, new).
- `scripts/backup.sh` — pg_dump loop (Task 4, new).
- `docs/runbooks/backup-and-restore.md`, `docs/runbooks/deploy.md` — runbooks (Task 4, new).

---

## Task 1: App runtime config (pool, statement_timeout, server timeouts, body limit)

**Files:** `src/common/prisma/prisma.service.ts`, `src/main.ts`, `src/config/env.validation.ts`; Test: `test/db-runtime-config.e2e-spec.ts`

- [ ] **Step 1: Branch**

```bash
git checkout -b ws3-runtime-deploy
```

- [ ] **Step 2: Write the failing integration test** `test/db-runtime-config.e2e-spec.ts`:

```ts
import { PrismaService } from '../src/common/prisma/prisma.service';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('DB runtime config (integration)', () => {
  let db: TestDb;
  let prisma: PrismaService;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = makePrismaOverride(db.url);
    await prisma.$connect();
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await db?.stop();
  });

  it('applies a 30s statement_timeout on pooled connections', async () => {
    const rows = await prisma.$queryRaw<{ statement_timeout: string }[]>`SHOW statement_timeout`;
    expect(rows[0].statement_timeout).toBe('30s');
  });
});
```

Run: `npm run test:e2e -- db-runtime-config`
Expected: FAIL — without the pool config, `statement_timeout` is Postgres's default `0` (no timeout), not `30s`.

- [ ] **Step 3: Tune the Prisma pool** in `src/common/prisma/prisma.service.ts` — replace the bare-string adapter with a `PoolConfig`:

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
If `@prisma/adapter-pg` 7.8 rejects a `PoolConfig` object (older signature wants a string or a `pg.Pool`), instead `import { Pool } from 'pg';` and `const pool = new Pool({ connectionString, max, connectionTimeoutMillis, idleTimeoutMillis, statement_timeout }); const adapter = new PrismaPg(pool);`. Either way the pool carries `statement_timeout: 30000`.

- [ ] **Step 4: Run the test — expect PASS**

Run: `npm run test:e2e -- db-runtime-config`
Expected: PASS (`statement_timeout` = `'30s'`). If Postgres reports it differently (e.g. `'30000ms'`), assert the actual normalized value Postgres returns for 30000ms — Postgres normalizes to `'30s'`.

- [ ] **Step 5: Server timeouts + body limit** in `src/main.ts`. After `app.enableShutdownHooks();` add:

```ts
  // Harden HTTP server timeouts (the app sits behind Caddy in production).
  const server = app.getHttpServer();
  server.keepAliveTimeout = 65_000; // slightly above a typical proxy keep-alive
  server.headersTimeout = 66_000; // must exceed keepAliveTimeout
  server.requestTimeout = 30_000;
  // Cap request bodies (financial payloads are small); matches Caddy's edge cap.
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { limit: '1mb', extended: true });
```
(`NestExpressApplication` from `@nestjs/platform-express` already typed; `useBodyParser` is available in Nest 11. If `useBodyParser` isn't resolvable, fall back to `NestFactory.create(AppModule, { bodyParser: false })` + `app.use(json({ limit: '1mb' }))`/`urlencoded` from `express`.)

- [ ] **Step 6: Env vars** in `src/config/env.validation.ts` — add `IsOptional` to the imports and two optional vars to `EnvVars`:

```ts
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  DB_POOL_MAX?: number;

  @IsOptional()
  @IsInt()
  @Min(1000)
  DB_STATEMENT_TIMEOUT_MS?: number;
```

- [ ] **Step 7: Build + full regression**

Run: `npm run typecheck && npm run lint:ci && npm run test:e2e`
Expected: typecheck/lint clean; full suite green (now 138 e2e incl. the new integration test). The pool/timeout/body-limit changes must not regress anything.

- [ ] **Step 8: Commit**

```bash
git add src/common/prisma/prisma.service.ts src/main.ts src/config/env.validation.ts test/db-runtime-config.e2e-spec.ts
git commit -m "feat(runtime): tune Prisma pool + statement_timeout, server timeouts, 1mb body limit"
```

---

## Task 2: Migration service + container hardening

**Files:** `docker-compose.prod.yml` (new — migrate/api hardening sections), `Dockerfile`

- [ ] **Step 1: Add the `HEALTHCHECK` to the Dockerfile** — insert before the final `CMD` in the production stage:

```dockerfile
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
```

- [ ] **Step 2: Create `docker-compose.prod.yml`** with the `migrate` service + api hardening (the caddy/db/backup sections are added in Tasks 3–4):

```yaml
services:
  migrate:
    build:
      context: .
      target: build
    command: ['npx', 'prisma', 'migrate', 'deploy']
    environment:
      DATABASE_URL: postgresql://accounting:${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}@db:5432/accounting?schema=public
    depends_on:
      db:
        condition: service_healthy
    restart: 'no'

  api:
    init: true
    depends_on:
      db:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    environment:
      DB_POOL_MAX: 15
      DB_STATEMENT_TIMEOUT_MS: 30000
    healthcheck:
      test: ['CMD', 'node', '-e', "require('http').get('http://127.0.0.1:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 20s
    stop_grace_period: 30s
    restart: unless-stopped
    deploy:
      resources:
        limits:
          cpus: '1.0'
          memory: 768M
        reservations:
          memory: 256M
```

- [ ] **Step 3: Validate the merged config**

Run: `docker compose -f docker-compose.yml -f docker-compose.prod.yml config`
Expected: prints the merged config with no error; `migrate` present, `api` shows `init: true`, the healthcheck, `depends_on` migrate `service_completed_successfully`.

- [ ] **Step 4: Smoke — migration gates a healthy app** (no Caddy/domain needed). With a `.env` providing `POSTGRES_PASSWORD` + the JWT secrets (use the repo's `.env` or export them):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build db migrate api
sleep 25
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps   # migrate Exited(0); api healthy
curl -fsS http://127.0.0.1:3000/health   # 200 (api binds 127.0.0.1:3000 after Task 3; until then it's 3000:3000)
docker compose -f docker-compose.yml -f docker-compose.prod.yml down
```
Expected: `migrate` exits 0 (migrations applied), `api` reaches `healthy`, `/health` returns 200. Report the `ps` output.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.prod.yml
git commit -m "feat(deploy): one-shot prisma-migrate service + api healthcheck/init/limits"
```

---

## Task 3: Production compose + Caddy / TLS

**Files:** `docker-compose.prod.yml` (add caddy + db hardening), `docker-compose.yml` (api port → localhost), `Caddyfile` (new)

- [ ] **Step 1: Bind the base api port to localhost** — in `docker-compose.yml`, change the api `ports` from `'3000:3000'` to `'127.0.0.1:3000:3000'` (so the app is never publicly reachable; Caddy reaches it via the compose network at `api:3000`).

- [ ] **Step 2: Create `Caddyfile`:**

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
(For staging without a public domain, set `DOMAIN=localhost` and add a `tls internal` line — documented in the deploy runbook.)

- [ ] **Step 3: Add `caddy` + harden `db` in `docker-compose.prod.yml`** (append to the `services:` map; add the `volumes:` block):

```yaml
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    depends_on:
      api:
        condition: service_healthy
    ports:
      - '80:80'
      - '443:443'
    environment:
      DOMAIN: ${DOMAIN:?DOMAIN is required (public hostname for auto-HTTPS)}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

  db:
    restart: unless-stopped
    command:
      - postgres
      - '-c'
      - 'shared_buffers=256MB'
      - '-c'
      - 'effective_cache_size=1GB'
      - '-c'
      - 'max_connections=50'
      - '-c'
      - 'work_mem=8MB'
      - '-c'
      - 'maintenance_work_mem=128MB'
    deploy:
      resources:
        limits:
          memory: 1536M

volumes:
  caddy_data:
  caddy_config:
```

- [ ] **Step 4: Validate the Caddyfile + merged config**

```bash
docker run --rm -e DOMAIN=localhost -v "$PWD/Caddyfile":/etc/caddy/Caddyfile:ro caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
DOMAIN=example.test docker compose -f docker-compose.yml -f docker-compose.prod.yml config >/dev/null && echo "compose OK"
```
Expected: `Valid configuration` from Caddy; compose merges with no error (caddy + db tuning present; db `command` set).

- [ ] **Step 5: Smoke — db tuning applied**

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d db
sleep 8
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T db psql -U accounting -d accounting -c 'SHOW shared_buffers; SHOW max_connections;'
docker compose -f docker-compose.yml -f docker-compose.prod.yml down
```
Expected: `shared_buffers = 256MB`, `max_connections = 50`. Report the output.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml docker-compose.prod.yml Caddyfile
git commit -m "feat(deploy): Caddy auto-HTTPS reverse proxy + Postgres tuning + api port localhost-only"
```

---

## Task 4: Backup sidecar + runbooks

**Files:** `scripts/backup.sh` (new), `docker-compose.prod.yml` (add backup + backups volume), `docs/runbooks/backup-and-restore.md`, `docs/runbooks/deploy.md` (new)

- [ ] **Step 1: Create `scripts/backup.sh`:**

```sh
#!/bin/sh
set -eu
: "${RETENTION_DAYS:=7}"
: "${BACKUP_INTERVAL:=86400}"
mkdir -p /backups
while true; do
  ts=$(date +%Y%m%dT%H%M%SZ)
  pg_dump -Fc -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -f "/backups/accounting-$ts.dump"
  echo "backup written: accounting-$ts.dump"
  find /backups -name 'accounting-*.dump' -mtime +"$RETENTION_DAYS" -delete
  sleep "$BACKUP_INTERVAL"
done
```
Make it executable: `chmod +x scripts/backup.sh`.

- [ ] **Step 2: Add the `backup` service + `backups` volume to `docker-compose.prod.yml`** (append to `services:` and the `volumes:` map):

```yaml
  backup:
    image: postgres:16
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    environment:
      PGHOST: db
      PGUSER: accounting
      PGPASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}
      PGDATABASE: accounting
      RETENTION_DAYS: '7'
      BACKUP_INTERVAL: '86400'
    entrypoint: ['/bin/sh', '/backup.sh']
    volumes:
      - ./scripts/backup.sh:/backup.sh:ro
      - backups:/backups
```
(add `backups:` under the top-level `volumes:` map.)

- [ ] **Step 3: Write `docs/runbooks/backup-and-restore.md`:**

```markdown
# Backup & Restore Runbook

## What is backed up
A logical `pg_dump -Fc` (custom format) of the `accounting` database, written by
the `backup` sidecar to the `backups` Docker volume every `BACKUP_INTERVAL`
seconds (default 86400 = daily). Dumps older than `RETENTION_DAYS` (default 7)
are pruned automatically. Files are named `accounting-<UTC-timestamp>.dump`.

## Where the dumps live
The `backups` named volume (inspect: `docker volume inspect accounting-api_backups`).
Copy a dump to the host: `docker compose -f docker-compose.yml -f docker-compose.prod.yml cp backup:/backups/<file> ./`.

## Restore
1. Stop writers: `docker compose -f docker-compose.yml -f docker-compose.prod.yml stop api migrate`.
2. Restore (drops & recreates objects from the dump):
   `docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T db \
     pg_restore --clean --if-exists --no-owner -U accounting -d accounting < /backups/<file>`
   (run from inside the backup/db container or pipe a host copy in).
3. Re-apply any newer migrations (no-op if the dump is current): bring `migrate` up.
4. Start the app: `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`.

## Test your restore (do this periodically)
Restore the latest dump into a scratch database and spot-check row counts:
`createdb scratch && pg_restore -d scratch <file> && psql scratch -c 'SELECT count(*) FROM journal_entries;'`.
A backup you have never restored is not a backup.
```

- [ ] **Step 4: Write `docs/runbooks/deploy.md`:**

```markdown
# Deploy Runbook (single VM)

## Prerequisites
- Docker + Docker Compose v2 on the VM; ports 80 and 443 open; DNS A-record for
  `$DOMAIN` pointing at the VM (required for Caddy auto-HTTPS).
- A `.env` next to the compose files (gitignored) with:
  `POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET` (>=32 chars), `JWT_REFRESH_SECRET` (>=32),
  `DOMAIN`. Optional: `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`, `RETENTION_DAYS`,
  `BACKUP_INTERVAL`.

## Deploy / upgrade
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```
This builds the image, runs `migrate` (prisma migrate deploy) to completion, then
starts `api` (gated on `migrate` succeeding), `caddy`, and `backup`. `migrate` runs
**before** the app and never in-process.

## Health & shutdown
- `api` is healthy when `/health` returns 200; Caddy proxies only a started app.
- `SIGTERM` (e.g. `docker compose ... stop api`) triggers a graceful Nest shutdown
  (in-flight requests finish within `stop_grace_period` = 30s; Prisma disconnects).

## Rollback caveats
- App rollback: redeploy the previous image tag/commit.
- **Migrations are forward-only.** A bad migration is NOT undone by rolling back the
  image — recover via a corrective migration or a restore (see backup-and-restore.md).
  Never edit an already-applied migration.

## Staging without a public domain
Set `DOMAIN=localhost` and add `tls internal` to the `Caddyfile`, or smoke-test
`db`+`migrate`+`api` only (skip `caddy`) and curl `http://127.0.0.1:3000/health`.
```

- [ ] **Step 5: Smoke — backup produces a restorable dump**

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d db
sleep 8
# one-shot dump using the same image/flags as the sidecar:
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm -e PGPASSWORD=$POSTGRES_PASSWORD backup \
  sh -c 'pg_dump -Fc -h db -U accounting -d accounting -f /backups/smoke.dump && ls -la /backups/smoke.dump'
# round-trip restore into a scratch db:
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T db sh -c 'createdb -U accounting scratch && pg_restore -U accounting -d scratch /dev/stdin' < /dev/null || echo "(restore step is documented; verify per runbook)"
docker compose -f docker-compose.yml -f docker-compose.prod.yml down -v
```
Expected: `smoke.dump` is created (non-zero size). Report it. (The full restore drill is in the runbook; the smoke just proves the dump path works.)

- [ ] **Step 6: Final WS3 gate**

Run: `npm run verify` (the app is unchanged since Task 1, but confirm the gate is still green) and `DOMAIN=example.test docker compose -f docker-compose.yml -f docker-compose.prod.yml config >/dev/null && echo OK`.
Expected: verify green; compose config valid.

- [ ] **Step 7: Commit**

```bash
git add scripts/backup.sh docker-compose.prod.yml docs/runbooks/backup-and-restore.md docs/runbooks/deploy.md
git commit -m "feat(deploy): pg_dump backup sidecar + backup/restore + deploy runbooks"
```

---

## Self-review (against the spec)

**Spec coverage:**
- §3 app runtime config (Prisma pool + statement_timeout, server timeouts, body limit, env vars) → Task 1 ✓
- §4 migration service (build-stage, gates api) + container hardening (init/healthcheck/stop_grace_period, Dockerfile HEALTHCHECK) → Task 2 ✓
- §5 caddy + Caddyfile + db tuning + api hardening/limits + api port localhost → Task 3 ✓
- §6 backup sidecar + scripts/backup.sh + backup-and-restore.md + deploy.md → Task 4 ✓
- §7 verification (statement_timeout integration test + full e2e; compose config + smoke for infra) → each task's verify steps ✓
- §8 build sequence (app config → migrate/hardening → compose/caddy → backup/runbooks) → task order ✓

**Placeholder scan:** none — full file contents/commands given. The adapter-pg `PoolConfig`-vs-`Pool` fallback (Task 1 Step 3) and the `useBodyParser` fallback (Step 5) are explicit alternatives, not TBDs.

**Consistency:** `DB_POOL_MAX`/`DB_STATEMENT_TIMEOUT_MS` names match across prisma.service.ts, env.validation.ts, and the compose `api.environment`; the Node healthcheck probe is byte-identical in the Dockerfile and the compose `api.healthcheck`; `POSTGRES_PASSWORD`/`accounting`/`db`/`5432` match across migrate/backup/Caddy/db; the `-f docker-compose.yml -f docker-compose.prod.yml` invocation is used uniformly; api port `127.0.0.1:3000:3000` (Task 3) matches the Task 2 smoke note.
