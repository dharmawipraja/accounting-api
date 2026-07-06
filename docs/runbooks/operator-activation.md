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
| **Alert delivery** (OPS-OBS-1, High) | Set `ALERT_SLACK_WEBHOOK_URL` (or generic `ALERT_WEBHOOK_URL`) in the VM's `.env` and restart alertmanager — delivery is now env-driven, no YAML editing. The alert *rules* exist and fire; until the var is set they reach no one. | `docker-compose.monitoring.yml`, [deploy.md](./deploy.md) |
| **CD deploy** (OPS-CI-1, High) | Add `DEPLOY_SSH_HOST` / `DEPLOY_SSH_USER` / `DEPLOY_SSH_KEY` (+ `DEPLOY_PATH`) repo secrets to activate the already-written, secret-gated SSH deploy job. The CD workflow publishes to GHCR and is inert until these exist. | `.github/workflows/cd.yml`, [deploy.md](./deploy.md) |

> CI itself is already active (the repo has a remote and the `verify`/`audit`/`docker`
> jobs run on push). Once CD is activated, enable branch-protection on `main`
> requiring `verify` + `audit` to pass.

## Deferred by design (deliberate — not gaps)

- **Year-end-close / engine stay e2e-guarded, not unit-mocked** (OPS-TEST-2 deepening). The merged-coverage gate covers them via real-DB e2e; see [testing.md](./testing.md).
- **Per-request timeout vs socket cut** (OPS-RES-2 follow-up — defaults now ordered: DB statement 30s → 408 at 35s → socket cut 40s): if you raise `REQUEST_TIMEOUT_MS` above ~35s, also env-drive `server.requestTimeout` so the socket isn't cut before the 408 interceptor responds.
- SHA-pin the Trivy CI action; `OPS-DB-2` trigram migration is already applied (not editable).

## Not a bug (recorded for posterity)

- `OPS-DB-3` (ephemeral `DELETE`+`DROP COLUMN` in an early migration); `NEW-2` (the `balanced`/`reconciles` report flags check the accounting identity, so they can't catch a close-ordering error — by nature, not a defect).
