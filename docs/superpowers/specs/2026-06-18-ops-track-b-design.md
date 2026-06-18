# §4 Ops Track-B (infra hardening + scaffolding) — Design

- **Date:** 2026-06-18
- **Status:** Approved (design); pending implementation plan
- **Source:** §4 "Operational production-readiness" of `docs/production-readiness-audit-2026-06-17.md` — the Track-B remainder (infra items that need an operator decision/secret to *activate*). Track-A (in-repo decision-free) shipped 2026-06-18 (`886c89a`).
- **Type:** Infra hardening + parameterized scaffolding. Decision-free items are built + statically verified; the three High items (backups/alerts/CD) get **inert-until-configured** scaffolding so nothing requires live secrets today.

## 1. Scope & approach

Build everything safe in-repo now; leave the secret/infra-dependent items ready-to-flip. **EXCLUDES** OPS-TEST-2 (open-ended unit-coverage expansion — its own spec; the Track-A coverage floor already guards regression) and any change requiring live secrets/infra to merge.

**Key constraint — no behavior change until activated:** all scaffolding (B/C/D) is gated on env/secrets and no-ops to today's behavior when unset. None of this touches the app's request paths.

| Item | Sev | Cluster | Nature |
|------|-----|---------|--------|
| OPS-DEP-1 (Caddy security headers) | ⚪ | A | decision-free |
| OPS-DEP-2 (read_only rootfs + cap_drop) | ⚪ | A | decision-free (standalone smoke only) |
| OPS-CI-3 (image vuln scan) | ⚪ | A | decision-free |
| OPS-DB-1 (offsite + encrypted backups) | 🟠 | B | scaffolding (env-gated) |
| OPS-OBS-1 (alert delivery) | 🟠 | C | scaffolding (docs+structure) |
| OPS-CI-1 (CD pipeline) | 🟠 | D | scaffolding (secret-gated) |
| OPS-OBS-4 (metrics-token scrape coupling) | ⚪ | E | decision-free (doc) |
| OPS-OBS-5 (write-path perf scenario) | ⚪ | E | decision-free |

## 2. Clusters

### Cluster A — Edge & container hardening (decision-free)
- **OPS-DEP-1** — add a `header` block to `Caddyfile` mirroring Helmet's app-layer values: `X-Content-Type-Options "nosniff"`, `X-Frame-Options "SAMEORIGIN"`, `Referrer-Policy "no-referrer"`. (HSTS already present.) Verify `caddy fmt` / `caddy validate` if available; else YAML/Caddyfile syntax review.
- **OPS-DEP-2** — on the `api` and `migrate` services in `docker-compose.prod.yml`: `read_only: true`, `cap_drop: [ALL]`, `tmpfs: ['/tmp']`. Leave `db`/`redis`/`caddy` (official images with writable rootfs/cert needs). The Node app writes nothing to disk (confirmed: pino→stdout, Prisma→network). **Verification:** `docker build` then `docker run --rm --read-only --tmpfs /tmp -e <minimal env> <image>` and curl `/health` → 200 (liveness needs no DB). Full prod-stack confirmation is a deploy-time smoke (documented limitation).
- **OPS-CI-3** — add a Trivy scan to the CI `docker` job (`aquasecurity/trivy-action`): scan the built `accounting-api:ci` image, `severity: HIGH,CRITICAL`, `ignore-unfixed: true`, `exit-code: 1`. Fails the job on a fixable HIGH/CRITICAL.

### Cluster B — Backup hardening scaffolding (OPS-DB-1)
`scripts/backup.sh`, after the existing `pg_dump -Fc`:
1. **Encrypt (gated):** if `BACKUP_AGE_RECIPIENT` is set AND `age` is on PATH → `age -r "$BACKUP_AGE_RECIPIENT" -o "$dump.age" "$dump" && rm "$dump"` (offsite the `.age`). If the var is set but `age` is missing → log an error, keep the plaintext local dump (don't fail the backup).
2. **Offsite (gated):** if `BACKUP_S3_BUCKET` set AND an uploader (`aws` or `rclone`) present → push the (encrypted-if-enabled) dump to the bucket; elif `BACKUP_RSYNC_TARGET` set AND `rsync` present → rsync it. Same tool-missing → log + skip (local dump retained).
3. **Unset env → identical to today** (local dump + retention prune only).
The `backup` service image is bare `postgres:16` (no `age`/`aws`/`rclone`). Document in `deploy.md` ("Activate offsite backups"): set the env + provide the tools (custom backup image or bind-mount). Encryption tool = **age** (simpler than gpg); uploaders = **aws-cli or rclone (S3) / rsync** — operator picks by which env they set.

### Cluster C — Alert delivery scaffolding (OPS-OBS-1)
Rewrite `monitoring/alertmanager.yml` to carry a ready-to-use, **commented** `webhook_configs` receiver (a single URL line to fill — works for Slack incoming webhooks, Discord, or a custom handler). The inert default (alerts fire, go nowhere — as today) stays the active config until the operator uncomments + sets the URL. Add a `deploy.md` "Activate alerts" section. **Rationale for docs+structure over env-templating:** `prom/alertmanager` is a minimal image without a usable `envsubst`/shell-entrypoint surface, so a templated entrypoint would be fragile; a one-line uncomment is the robust activation path.

### Cluster D — CD pipeline scaffolding (OPS-CI-1)
New `.github/workflows/cd.yml`:
- Trigger: `push` to `main`.
- **Build + push to GHCR:** `docker/build-push-action` → `ghcr.io/${{ github.repository }}`, auth via the built-in `GITHUB_TOKEN` (no extra secret), tags `${{ github.sha }}` + `latest`. `permissions: { contents: read, packages: write }`.
- **Optional deploy job:** `needs: [push]`, `if: ${{ secrets.DEPLOY_SSH_HOST != '' }}` → SSH to the VM (`appleboy/ssh-action` or raw ssh with `DEPLOY_SSH_KEY`/`DEPLOY_SSH_HOST`/`DEPLOY_SSH_USER`) and run `docker compose -f docker-compose.yml -f docker-compose.prod.yml pull && up -d`. Inert (push-only) until the SSH secrets exist.
Add a `deploy.md` "CD pipeline" section (GHCR auth, the deploy secrets, branch protection note). Activates only once the repo is pushed to GitHub.

### Cluster E — Observability/perf polish (decision-free)
- **OPS-OBS-4** — `deploy.md` (or a `monitoring/README`): document that if `METRICS_TOKEN` is set, the Prometheus scrape config's `authorization` block MUST be uncommented or scrapes 401 → `ApiDown` false-fires. Reference `monitoring/prometheus.yml`.
- **OPS-OBS-5** — add a write-path scenario to `perf/baseline.js`: log in (`POST /v1/auth/login`) → capture the access token → `POST /v1/ledger/journal-entries` a balanced draft → post it (or the createAndPost path). Keep it a separate, opt-in scenario/stage so the existing read baseline is unchanged; respect the 300/min per-user throttle.

## 3. Testing & verification

| Item | How verified in-repo | Activation (operator) |
|------|----------------------|------------------------|
| Caddy headers | `caddy validate`/fmt or syntax review | n/a |
| read_only | `docker run --read-only --tmpfs /tmp` + `/health` 200 | deploy-time prod-stack smoke |
| Trivy | CI YAML valid; step present | runs on real CI |
| backup.sh | `sh -n` syntax; logic walk for the unset-env path = unchanged | set env + tools, run a real backup |
| alertmanager.yml | YAML validity; inert default unchanged | uncomment + set URL, fire a test alert |
| cd.yml | workflow YAML valid; gated deploy `if` correct | push to GitHub + add SSH secrets |
| k6 write scenario | `k6` parse (`k6 inspect`) or node syntax | run against a deployed instance |

The existing app test suite (unit + e2e) is untouched and must stay green (none of this changes app code). Acknowledge the known environmental e2e flakiness (confirm any failure in isolation).

## 4. Risks & mitigations
| Risk | Mitigation |
|------|-----------|
| `read_only` breaks the app at deploy (untestable here beyond a standalone smoke) | App writes nothing to disk (verified); `tmpfs /tmp` covers transient needs; standalone `docker run --read-only` smoke; documented as deploy-time-confirm |
| Backup scaffolding silently no-ops when tools missing | Script logs an explicit error when env is set but the tool is absent; local dump always retained; activation docs list the tools |
| CD deploy job runs with wrong/missing secrets | Gated on `secrets.DEPLOY_SSH_HOST != ''`; push-to-GHCR is the only unconditional step and uses the built-in token |
| Trivy false-fails on unfixable CVEs in base image | `ignore-unfixed: true`; HIGH/CRITICAL only |
| Alert config typo breaks alertmanager boot | Inert default stays valid; the webhook block ships commented; activation is a documented one-liner |

## 5. Out of scope
OPS-TEST-2 (broad unit-coverage expansion — own spec). Any change that needs a live secret/target to *merge* (everything here merges inert). Switching base images, multi-registry publishing, blue-green/canary deploy, or a secrets manager — future specs if pursued.
