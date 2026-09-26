# Operator activation — remaining go-live wiring

Everything in the codebase is built and merged; the items below are **operator
actions** that require real infrastructure/secrets and cannot land in-repo. They
are the only open work from the 2026-06-17 production-readiness audit (whose full
text lives in git history — `git show <commit>:docs/production-readiness-audit-2026-06-17.md`,
removed 2026-06-25 once its code backlog was closed).

## Pending activation (scaffolding is merged but inert until you wire it)

| Item | What to do | Where |
| --- | --- | --- |
| **Offsite + encrypted backups** (OPS-DB-1, High) | Set `BACKUP_AGE_RECIPIENT` (age public key) and `BACKUP_S3_BUCKET` (or rsync target), and add the backup-image tools, so dumps push offsite encrypted. Today backups live only in a local Docker volume on the same VM — a VM/disk loss destroys DB **and** backups. | `scripts/backup.sh`, `docker-compose.prod.yml`, [backup-and-restore.md](./backup-and-restore.md) |
| **Alert delivery** (OPS-OBS-1, High) | Set `ALERT_SLACK_WEBHOOK_URL` (or generic `ALERT_WEBHOOK_URL`) in the VM's `.env` and restart alertmanager — delivery is now env-driven, no YAML editing. The alert *rules* exist and fire; until the var is set they reach no one. Optionally add `ALERT_HEARTBEAT_URL` (healthchecks.io ping) so the always-firing `Watchdog` acts as a dead-man's switch on the pipeline itself. | `docker-compose.monitoring.yml`, [deploy.md](./deploy.md) |
| **Metrics scrape token** (OPS-OBS-4, High) | Set `METRICS_TOKEN` in the VM's `.env` and write the same value to the git-ignored `monitoring/secrets/metrics_token` (owned by uid 65534, mode 600) — `monitoring/prometheus.yml` reads it via `credentials_file`, so no tracked file holds the secret. Without both, `/metrics` 401s (fail-closed in production) and `ApiDown` fires. | `docker-compose.monitoring.yml`, [deploy.md](./deploy.md) → Monitoring |
| **External uptime check** (OPS-OBS-5, High) | Create a free UptimeRobot / healthchecks.io / Better Stack probe against `https://$DOMAIN/health` (1-min interval). Prometheus lives on the same VM as the API, so whole-VM death silences every in-VM alert — an outside probe is the only monitor that catches it. | [deploy.md](./deploy.md) |
| **CD deploy** (OPS-CI-1, High) | Create a `production` GitHub Environment (branch/tag policy: `main` + release tags) holding `DEPLOY_SSH_HOST` / `DEPLOY_SSH_USER` / `DEPLOY_SSH_KEY` (+ `DEPLOY_PATH`) secrets, then set the repo variable `DEPLOY_ENABLED=true` to activate the already-written SSH deploy job. The CD workflow (gated on a green CI run for the released SHA) publishes the runtime + migrate images to GHCR and deploys nothing until the variable is `true`. On the VM: `docker login ghcr.io` (if packages are private) and add `APP_DB_PASSWORD` to `.env` (required by the least-privilege `accounting_app` DB role — the first deploy creates it). | `.github/workflows/cd.yml`, [deploy.md](./deploy.md) |

> CI itself is already active (the repo has a remote and the `verify`/`audit`/`docker`
> jobs run on push). Once CD is activated, enable branch-protection on `main`
> requiring `verify` + `audit` to pass.

## Deferred by design (deliberate — not gaps)

- **Year-end-close / engine stay e2e-guarded, not unit-mocked** (OPS-TEST-2 deepening). The merged-coverage gate covers them via real-DB e2e; see [testing.md](./testing.md).
- **Per-request timeout vs socket cut** (OPS-RES-2 follow-up — defaults now ordered: DB statement 30s → 408 at 35s → socket cut 40s): if you raise `REQUEST_TIMEOUT_MS` above ~35s, also env-drive `server.requestTimeout` so the socket isn't cut before the 408 interceptor responds.
- `OPS-DB-2` trigram migration is already applied (not editable). (All CI/CD actions, incl. Trivy, are now SHA-pinned.)

## Not a bug (recorded for posterity)

- `OPS-DB-3` (ephemeral `DELETE`+`DROP COLUMN` in an early migration); `NEW-2` (the `balanced`/`reconciles` report flags check the accounting identity, so they can't catch a close-ordering error — by nature, not a defect).
