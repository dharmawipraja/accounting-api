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

## Rollback caveats
- App rollback: redeploy the previous image tag/commit.
- **Migrations are forward-only.** A bad migration is NOT undone by rolling back the
  image — recover via a corrective migration or a restore (see backup-and-restore.md).
  Never edit an already-applied migration.

## Staging without a public domain
Don't edit the committed `Caddyfile` (it would dirty the repo and risk shipping a
non-prod TLS setting). Instead either:
- **Skip Caddy:** smoke-test `db`+`migrate`+`api` only and curl `http://127.0.0.1:3000/health`
  (`docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d db migrate api`); or
- **Throwaway internal TLS:** copy the Caddyfile, append `tls internal`, and mount the copy
  via a one-off override file — e.g. `cp Caddyfile /tmp/Caddyfile.staging && printf '\n\ttls internal\n' >> /tmp/Caddyfile.staging`, then a small `docker-compose.staging.yml` that remaps `caddy.volumes` to `/tmp/Caddyfile.staging:/etc/caddy/Caddyfile:ro`, and add `-f docker-compose.staging.yml` to the up command. `DOMAIN=localhost`, then `curl -k https://localhost/health`.

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
moderate-or-higher advisory in prod deps), and `docker` (production image build).
Recommended next step: enable branch protection on `main` requiring the `verify`
and `audit` checks to pass before merge.
