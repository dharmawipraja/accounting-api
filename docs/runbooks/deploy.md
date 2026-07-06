# Deploy Runbook (single VM)

## Prerequisites
- Docker + Docker Compose v2 on the VM; ports 80 and 443 open; DNS A-record for
  `$DOMAIN` pointing at the VM (required for Caddy auto-HTTPS).
- A `.env` next to the compose files (gitignored) with:
  `POSTGRES_PASSWORD`, `JWT_ACCESS_SECRET` (>=32 chars), `JWT_REFRESH_SECRET` (>=32),
  `DOMAIN`. Optional: `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`, `RETENTION_DAYS`,
  `BACKUP_INTERVAL`, `THROTTLE_LIMIT` (per-user requests/min, default 300),
  `THROTTLE_LOGIN_LIMIT` (per-IP login attempts/min, default 10),
  `THROTTLE_REFRESH_LIMIT` (per-IP refresh attempts/min, default 30).
- **Redis** must be running and reachable at `REDIS_URL` before the API starts. The
  rate limiter is **fail-closed**: without Redis the API returns `503` on every
  throttled route, so a deploy can come up "running" (container healthy) yet 503 all
  business requests. The prod compose stack includes a `redis` service; if you run
  the API standalone, provision Redis and set `REDIS_URL` first.

## Deploy / upgrade
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```
This builds the image, runs `migrate` (prisma migrate deploy) to completion, then
starts `api` (gated on `migrate` succeeding), `caddy`, and `backup`. `migrate` runs
**before** the app and never in-process.

## Health & shutdown
- `api` is healthy when `/ready` returns 200 (DB + Redis reachable — a dependency outage now marks the container unhealthy); `/health` stays a bare liveness probe. Caddy proxies only a started app.
- One-time caveat: migration `20260705163429_scope_idempotency_keys_by_user`
  clears the `idempotency_keys` cache to add the NOT NULL `user_id` column. On
  the deploy that first applies it, a client retrying a write completed in the
  previous ~24h with the same `Idempotency-Key` re-executes instead of
  replaying — apply it in a low-traffic window.
- `SIGTERM` (e.g. `docker compose ... stop api`) triggers a graceful Nest shutdown
  (idle keep-alive sockets close, in-flight requests finish within `stop_grace_period` = 45s, THEN Prisma/Redis disconnect).

## X-Forwarded-For / client IP trust (SEC-3)
Caddy (the TLS edge) **ignores any client-supplied `X-Forwarded-For` by default**
to prevent spoofing — it sets `X-Forwarded-For` to the real connecting client
before proxying to `api`. The app's `trust proxy: 1` therefore sees the true
client IP, so the per-IP login throttle cannot be bypassed with a forged header.
No Caddy directive is required; this is the default behavior of `reverse_proxy`.
(The app-side per-account login throttle — keyed by the submitted email — is the
complementary defense already in place.)

**Only if a CDN or L4 load balancer is ever placed in front of Caddy**, Caddy
must be told to trust it so it accepts the upstream's `X-Forwarded-For`:
```caddyfile
reverse_proxy api:3000 {
	trusted_proxies static private_ranges
}
```
Add the global option `trusted_proxies_strict` for right-to-left XFF parsing when
the upstream appends to the right (CloudFlare, AWS ALB, HAProxy) — this prevents
leftmost-IP spoofing.

**Deploy-time verification:** against a deployed instance, hammer the login limit
from one source while rotating a forged `X-Forwarded-For`; it should still 429
(the forged header is ignored), confirming the real client IP is used.

## Rollback

1. **App-only rollback (no schema change):** redeploy the previous image tag/commit —
   `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d` after
   checking out the prior commit (or pinning the prior image tag). Caddy/api/backup
   restart against the unchanged DB.
2. **Migrations are forward-only.** Rolling back the image does NOT undo a migration.
   If a bad migration shipped:
   a. Stop the API: `docker compose ... stop api`.
   b. Prefer a **corrective forward migration** (a new migration that fixes the bad
      one) over editing history — never edit an already-applied migration.
   c. If data is corrupted, **restore from backup**: follow `backup-and-restore.md`
      (stop `api`, restore the latest good `pg_dump -Fc` into the `db` volume, then
      bring `api` back up). Accept the data delta since that backup.
3. After any rollback, verify `/health` (200) and `/ready` (200 — DB + Redis reachable).

## Monitoring (optional)

An optional observability overlay ships in `docker-compose.monitoring.yml`
(Prometheus + Grafana + alertmanager + **Loki/Alloy log aggregation**).
The subsections below explain each piece; this checklist is the whole
activation, in order:

### Bring the stack up (checklist)

1. **On the VM, add to the `.env`** next to the compose files:

   ```bash
   GRAFANA_ADMIN_PASSWORD=<strong password>        # required
   ALERT_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...   # or ALERT_WEBHOOK_URL (see below)
   # ALERT_SLACK_CHANNEL=#alerts                   # optional override
   # ALERT_HEARTBEAT_URL=https://hc-ping.com/<uuid>  # optional dead-man's switch
   ```

2. **Deploy with the overlay added** (same command as always, one more `-f`):

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml \
     -f docker-compose.monitoring.yml up -d --build
   ```

3. **Confirm delivery is armed:** `docker compose logs alertmanager | head`
   must show `alert delivery ACTIVE (...)` — a `WARN: no ALERT_*_URL set`
   means step 1's variable didn't reach the container.

4. **Open Grafana — via SSH tunnel.** Grafana (3001) and Prometheus (9090)
   bind to `127.0.0.1` on the VM on purpose (not exposed through Caddy):

   ```bash
   ssh -L 3001:127.0.0.1:3001 -L 9090:127.0.0.1:9090 <user>@<vm>
   ```

   Then browse `http://localhost:3001` (admin / `GRAFANA_ADMIN_PASSWORD`).
   The accounting dashboard and both datasources (Prometheus, Loki) are
   auto-provisioned; logs live under **Explore → Loki**.

5. **Fire-drill the alerting** (do this once — an alert channel you've never
   seen a message in is not activated): `docker compose stop api`, wait ~3
   minutes, confirm `ApiDown` lands in the channel, then
   `docker compose start api` and confirm the resolved notice.

6. **Create the external uptime check** (OPS-OBS-5): a free UptimeRobot /
   healthchecks.io / Better Stack probe on `https://$DOMAIN/health`, 1-minute
   interval — see the failure-domain note at the end of this section.

Steps 1–5 are one sitting on the VM; step 6 is a two-minute signup anywhere.

### Logs (Loki + Alloy)

Alloy tails every compose container via the Docker socket and pushes to Loki
(single-binary, filesystem storage, **30-day retention**, internal-only — no
published port). Grafana auto-provisions the Loki datasource: **Explore →
Loki**, query by compose service, then filter pino JSON at query time, e.g.

```logql
{service="api"} | json | req_id="<traceId>"     # full story of one request
{service="api"} | json | level >= 40             # warn+error only
```

Keep labels minimal (only `service`/`container` are indexed — that's
deliberate; don't promote traceId or route to labels). Backfill note: on first
start Alloy reads existing log files; entries older than Loki's 7-day ingest
window are dropped with a one-time burst of `400 timestamp too old` in alloy
logs — harmless. Positions persist in the `alloy_data` volume, so restarts
resume instead of re-reading.

> **Metrics auth coupling (OPS-OBS-4):** if you set `METRICS_TOKEN` on the api, you MUST
> uncomment the `authorization.credentials` block in `monitoring/prometheus.yml` with the
> same token, or scrapes get `401` and the `ApiDown` alert false-fires.

### Activate alert delivery (OPS-OBS-1)

Delivery is **env-driven** — no YAML editing. Set ONE variable in the `.env` next
to the compose files and restart alertmanager:

- `ALERT_SLACK_WEBHOOK_URL` — native Slack receiver (optional
  `ALERT_SLACK_CHANNEL`, default `#alerts`). Use this for Slack: incoming
  webhooks reject Alertmanager's generic JSON, so a Slack URL in the generic
  var would 400 and drop every alert.
- `ALERT_WEBHOOK_URL` — generic webhook receiver (a custom handler, or Discord
  with a `/slack`-suffixed URL).

The alertmanager entrypoint substitutes the URL into
`monitoring/alertmanager-slack.yml` / `alertmanager-webhook.yml` at startup and
logs `alert delivery ACTIVE (...)`; with neither var set it falls back to the
inert `monitoring/alertmanager.yml` and logs a WARN. Unresolved alerts re-notify
every 4h. Send a test by triggering a rule (e.g. stop the api so `ApiDown`
fires) and confirm it lands in the channel.

Optionally also set `ALERT_HEARTBEAT_URL` (e.g. a [healthchecks.io](https://healthchecks.io)
ping URL with a ~15-minute grace period): the always-firing `Watchdog` alert
POSTs there every ~10 minutes and **never** reaches the notification channel.
If the heartbeat goes silent, the Prometheus→Alertmanager pipeline itself is
down — the failure mode no in-VM alert can report.

> **The VM is one failure domain.** Prometheus and the API share the machine,
> so whole-VM death silences everything above. Pair the heartbeat with an
> **external uptime check** (UptimeRobot / healthchecks.io / Better Stack)
> probing `https://$DOMAIN/health` from outside — that is the only monitor
> that catches the VM itself dying.

## Staging without a public domain
Don't edit the committed `Caddyfile` (it would dirty the repo and risk shipping a
non-prod TLS setting). Instead either:
- **Skip Caddy:** smoke-test `db`+`migrate`+`api` only and curl `http://127.0.0.1:3000/health`
  (`docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d db migrate api`); or
- **Throwaway internal TLS:** copy the Caddyfile, append `tls internal`, and mount the copy
  via a one-off override file — e.g. `cp Caddyfile /tmp/Caddyfile.staging && printf '\n\ttls internal\n' >> /tmp/Caddyfile.staging`, then a small `docker-compose.staging.yml` that remaps `caddy.volumes` to `/tmp/Caddyfile.staging:/etc/caddy/Caddyfile:ro`, and add `-f docker-compose.staging.yml` to the up command. `DOMAIN=localhost`, then `curl -k https://localhost/health`.

### Activate offsite + encrypted backups (OPS-DB-1)

`scripts/backup.sh` writes a local `pg_dump` by default. To also encrypt and ship
offsite, set env on the `backup` service (all optional; unset = local-only, as today):
- `BACKUP_AGE_RECIPIENT` — an [age](https://age-encryption.org) recipient public key;
  the dump is encrypted to `*.dump.age` before leaving the host.
- **S3:** `BACKUP_S3_BUCKET` (e.g. `my-bucket/accounting`) + AWS creds (`AWS_ACCESS_KEY_ID`/
  `AWS_SECRET_ACCESS_KEY`/`AWS_DEFAULT_REGION`) for `aws`, or an `rclone` remote config.
- **rsync:** `BACKUP_RSYNC_TARGET` (e.g. `user@host:/backups/`) with SSH access.

The default `backup` image (`postgres:16`) does NOT include `age`/`aws`/`rclone`/`rsync`.
Provide them via a custom backup image (recommended) or a bind-mount; the script logs a
clear WARN and keeps the local dump if a configured tool is missing. Restore: decrypt
with `age -d -i <key> file.dump.age > file.dump`, then follow `backup-and-restore.md`.

## CD pipeline (OPS-CI-1)

`.github/workflows/cd.yml` is **manual** (`workflow_dispatch`) — it does NOT run on push.
To release: GitHub → **Actions** → **CD** → **Run workflow** → pick the **tag** (or branch)
from the ref dropdown → **Run**. It builds/deploys exactly the selected ref.
1. **Publish** — builds and pushes the image to `ghcr.io/<owner>/<repo>:<tag>`, `:<sha>`,
   and `:latest` (`<tag>` = the selected ref name, e.g. `v1.2.0`) using the built-in
   `GITHUB_TOKEN` (no extra secret; ensure the repo's Package settings allow Actions to
   write packages). Tip: create an annotated tag first (`git tag -a v1.2.0 -m ... && git
   push origin v1.2.0`), then select it in the dropdown.
2. **Deploy (optional, gated)** — runs ONLY if a `DEPLOY_SSH_HOST` secret is set. Add
   `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PATH` (repo dir on the
   VM) as Actions secrets; the VM's compose must reference the GHCR image. Until then,
   CD only publishes.

## Activating CI (SEC-8)
The CI workflow (`.github/workflows/ci.yml`) is committed but dormant — the repo
has no git remote, so nothing triggers it. To activate:
```bash
# 1. Create a GitHub repository, then add it as the remote:
git remote add origin git@github.com:<org>/accounting-api.git
# 2. Push main (this triggers CI on push):
git push -u origin main
```
On push/PR to `main`, CI runs three jobs: `verify` (Prisma generate + typecheck +
lint + unit + e2e with coverage), `audit` (`npm run audit:ci`, fails on a
moderate-or-higher advisory in prod deps), and `docker` (production image build +
Trivy HIGH/CRITICAL vulnerability scan, `exit-code 1`).
Recommended next step: enable branch protection on `main` requiring the `verify`
and `audit` checks to pass before merge.
