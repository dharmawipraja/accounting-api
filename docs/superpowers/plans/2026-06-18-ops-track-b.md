# §4 Ops Track-B Infra Hardening + Scaffolding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the edge/containers and add inert-until-configured scaffolding for offsite backups, alert delivery, and CD — closing the §4 Track-B backlog without requiring any live secret to merge.

**Architecture:** Pure infra/config changes (Caddyfile, compose, CI/CD workflows, backup script, alertmanager, perf script, docs). No application code changes. Scaffolding (backups/alerts/CD) is gated on env/secrets and no-ops to today's behavior when unset.

**Tech Stack:** Caddy, Docker Compose, GitHub Actions, Trivy, `age`/`aws`/`rclone`/`rsync` (backup), Prometheus/Alertmanager, k6.

## Global Constraints

- **No behavior change until activated.** Every scaffolding path is gated on env/secrets; unset ⇒ identical to today. No app code is touched, so the unit + e2e suites are unaffected (they must stay green; the known full-`verify` e2e flakiness is environmental — confirm any failure in isolation).
- **Backup local dump is the floor:** encryption/offsite failures must LOG and continue, never crash the backup loop or lose the local dump.
- **Caddy header values mirror Helmet** (app layer already sets them): `X-Content-Type-Options "nosniff"`, `X-Frame-Options "SAMEORIGIN"`, `Referrer-Policy "no-referrer"`.
- **read_only scope:** `api` + `migrate` services only (the app images we control). NOT `db`/`redis`/`caddy` (official images with writable rootfs/cert needs).
- **CD registry = GHCR** (`ghcr.io/${{ github.repository }}`, built-in `GITHUB_TOKEN`); deploy job gated `if: ${{ secrets.DEPLOY_SSH_HOST != '' }}`.
- **Verification is static + inert-default** (YAML/Caddy/shell/JS validity + a read-only docker smoke). Full activation is a deploy-time/operator step — documented, not run here.
- **EXCLUDE OPS-TEST-2** (own spec).

Verification tools available: `docker` / `docker compose config`, `python3 -c 'import yaml...'` for YAML, `node --check` for JS, `sh -n` for shell, `caddy validate` via `docker run caddy:2-alpine`.

---

## Task 1: Caddy security headers + Trivy CI scan (OPS-DEP-1, OPS-CI-3)

**Files:**
- Modify: `Caddyfile` (add header block)
- Modify: `.github/workflows/ci.yml` (Trivy step in the `docker` job)

- [ ] **Step 1: Add the header block to Caddyfile**

In `Caddyfile`, replace the single HSTS header line (line 9) with the full header set:
```caddyfile
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "SAMEORIGIN"
		Referrer-Policy "no-referrer"
	}
```
(Caddy's `header` block form replaces the single-line directive; keeps HSTS, adds the three.)

- [ ] **Step 2: Validate the Caddyfile**

Run:
```bash
DOMAIN=example.com docker run --rm -e DOMAIN -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```
Expected: `Valid configuration`. (If `caddy validate` flags the env placeholder, it still adapts `{$DOMAIN}` from the provided env — the run sets `DOMAIN`.)

- [ ] **Step 3: Add the Trivy scan to the CI `docker` job**

In `.github/workflows/ci.yml`, the `docker` job currently ends after `docker build -t accounting-api:ci .`. Append a scan step:
```yaml
      - name: Scan image for vulnerabilities (Trivy)
        uses: aquasecurity/trivy-action@0.28.0
        with:
          image-ref: accounting-api:ci
          severity: HIGH,CRITICAL
          ignore-unfixed: true
          exit-code: '1'
```
(Pin `0.28.0`; if that tag doesn't resolve when CI runs, bump to the latest `aquasecurity/trivy-action` release. `ignore-unfixed` avoids failing on un-patchable base-image CVEs.)

- [ ] **Step 4: Validate the workflow YAML**

Run:
```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('ci.yml valid')"
```
Expected: `ci.yml valid`.

- [ ] **Step 5: Commit**

```bash
git add Caddyfile .github/workflows/ci.yml
git commit -m "feat(ops): Caddy security headers (OPS-DEP-1); Trivy image scan in CI (OPS-CI-3)"
```

---

## Task 2: Container read-only hardening (OPS-DEP-2)

**Files:**
- Modify: `docker-compose.prod.yml` (`api` + `migrate` services)

- [ ] **Step 1: Add hardening keys to `api` and `migrate`**

In `docker-compose.prod.yml`, add to the `api` service block (alongside `init: true` etc.):
```yaml
    read_only: true
    cap_drop:
      - ALL
    tmpfs:
      - /tmp
```
Add the same three keys to the `migrate` service block (alongside `command`/`environment`). Leave `db`, `redis`, `caddy` unchanged.

- [ ] **Step 2: Validate the compose file**

Run:
```bash
POSTGRES_PASSWORD=x DOMAIN=example.com docker compose -f docker-compose.yml -f docker-compose.prod.yml config >/dev/null && echo "compose valid"
```
Expected: `compose valid` (the merged config parses with the new keys).

- [ ] **Step 3: Read-only smoke (no read-only-fs errors at boot)**

The app writes nothing to disk (pino→stdout, Prisma→network), so a read-only rootfs + `tmpfs /tmp` must not produce a filesystem error. Build and run the image read-only with dummy env (it need not fully boot without DB — we only assert no read-only-fs error appears):
```bash
docker build -t accounting-api:rotest .
docker run --rm -d --name rotest --read-only --tmpfs /tmp \
  -e NODE_ENV=production -e PORT=3000 \
  -e DATABASE_URL=postgresql://u:u@127.0.0.1:5432/db \
  -e JWT_ACCESS_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  -e JWT_REFRESH_SECRET=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  -e JWT_ACCESS_TTL=900s -e JWT_REFRESH_TTL=7d \
  -e REDIS_URL=redis://127.0.0.1:6379 accounting-api:rotest
sleep 6
docker logs rotest 2>&1 | grep -iE "EROFS|read-only file system" && echo "FAIL: read-only-fs error" || echo "OK: no read-only-fs error"
docker rm -f rotest >/dev/null 2>&1 || true
```
Expected: `OK: no read-only-fs error`. (A DB/Redis connection error in the logs is fine and expected — it is NOT a read-only-fs error; the grep targets only EROFS / "read-only file system". If `FAIL` appears, a dependency writes to the rootfs at startup → add a `tmpfs` for that path or relax `read_only` for that service, and note it.)

- [ ] **Step 4: Commit**

```bash
git add docker-compose.prod.yml
git commit -m "feat(ops): read_only rootfs + cap_drop + tmpfs on api/migrate (OPS-DEP-2)"
```

---

## Task 3: Backup offsite + encryption scaffolding (OPS-DB-1)

**Files:**
- Modify: `scripts/backup.sh`
- Modify: `docs/runbooks/deploy.md` (or `backup-and-restore.md` — pick deploy.md "Activate offsite backups")

- [ ] **Step 1: Add gated encrypt + offsite to backup.sh**

In `scripts/backup.sh`, replace the body of the loop from after the `pg_dump` line through the `find ... -delete` prune. The new loop body (keep `set -eu`, the `ts=`, and the `pg_dump` line as-is, then):
```sh
  echo "backup written: accounting-$ts.dump"
  dump="/backups/accounting-$ts.dump"

  # Encrypt (gated): age recipient + age binary both required, else keep plaintext.
  if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
    if command -v age >/dev/null 2>&1; then
      if age -r "$BACKUP_AGE_RECIPIENT" -o "$dump.age" "$dump"; then
        rm -f "$dump"; dump="$dump.age"; echo "backup encrypted: $(basename "$dump")"
      else
        echo "WARN: age encryption failed — keeping plaintext local dump" >&2; rm -f "$dump.age"
      fi
    else
      echo "WARN: BACKUP_AGE_RECIPIENT set but 'age' not on PATH — unencrypted local dump kept" >&2
    fi
  fi

  # Offsite (gated): S3 (aws or rclone) takes precedence, else rsync. Failures log + continue.
  if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
    if command -v aws >/dev/null 2>&1; then
      aws s3 cp "$dump" "s3://$BACKUP_S3_BUCKET/$(basename "$dump")" && echo "offsite (s3/aws): $(basename "$dump")" || echo "WARN: s3 (aws) upload failed — local dump retained" >&2
    elif command -v rclone >/dev/null 2>&1; then
      rclone copyto "$dump" "$BACKUP_S3_BUCKET/$(basename "$dump")" && echo "offsite (s3/rclone): $(basename "$dump")" || echo "WARN: s3 (rclone) upload failed — local dump retained" >&2
    else
      echo "WARN: BACKUP_S3_BUCKET set but neither 'aws' nor 'rclone' on PATH — local dump only" >&2
    fi
  elif [ -n "${BACKUP_RSYNC_TARGET:-}" ]; then
    if command -v rsync >/dev/null 2>&1; then
      rsync -a "$dump" "$BACKUP_RSYNC_TARGET" && echo "offsite (rsync): $(basename "$dump")" || echo "WARN: rsync upload failed — local dump retained" >&2
    else
      echo "WARN: BACKUP_RSYNC_TARGET set but 'rsync' not on PATH — local dump only" >&2
    fi
  fi

  mkdir -p /backup-metrics
  printf 'backup_last_success_timestamp_seconds %s\n' "$(date +%s)" > /backup-metrics/backup.prom.tmp
  mv /backup-metrics/backup.prom.tmp /backup-metrics/backup.prom
  find /backups -name 'accounting-*.dump*' -mtime +"$RETENTION_DAYS" -delete
  sleep "$BACKUP_INTERVAL"
```
Notes: the prune glob is widened `accounting-*.dump` → `accounting-*.dump*` so encrypted `.dump.age` files also age out (matches `.dump` too — no change when encryption is off). The `|| echo` keeps `set -e` from killing the loop on a transient upload failure.

- [ ] **Step 2: Shell-syntax check + unset-env behavior reasoning**

Run: `sh -n scripts/backup.sh && echo "backup.sh syntax OK"`
Expected: `backup.sh syntax OK`. Confirm by reading: with `BACKUP_AGE_RECIPIENT`, `BACKUP_S3_BUCKET`, `BACKUP_RSYNC_TARGET` all unset, the two `if [ -n ... ]` guards are false → the script does exactly today's `pg_dump` + metrics + prune (identical behavior).

- [ ] **Step 3: Document activation in deploy.md**

Add an "Activate offsite backups (OPS-DB-1)" subsection to `docs/runbooks/deploy.md` (near the backup/monitoring content):
```md
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
```

- [ ] **Step 4: Commit**

```bash
git add scripts/backup.sh docs/runbooks/deploy.md
git commit -m "feat(ops): gated offsite + age-encrypted backups scaffolding (OPS-DB-1)"
```

---

## Task 4: Alert-delivery scaffolding (OPS-OBS-1)

**Files:**
- Modify: `monitoring/alertmanager.yml`
- Modify: `docs/runbooks/deploy.md`

- [ ] **Step 1: Add a ready-to-use commented webhook receiver**

Replace `monitoring/alertmanager.yml` with (the inert `default` receiver stays active; the webhook block is commented, ready to fill):
```yaml
route:
  receiver: default
  group_by: ['alertname']
receivers:
  - name: default
    # ALERTS REACH NO ONE until you configure a receiver below. To activate, paste
    # your webhook URL and switch `route.receiver` to `notify` (or add the block here).
    #
    # webhook_configs:        # generic — works for a custom handler, or Slack/Discord
    #   - url: 'https://hooks.slack.com/services/XXX/YYY/ZZZ'
    #     send_resolved: true
    #
    # For native Slack formatting instead of a raw webhook:
    # slack_configs:
    #   - api_url: 'https://hooks.slack.com/services/XXX/YYY/ZZZ'
    #     channel: '#alerts'
    #     send_resolved: true
```
(Keeping the active receiver `default` with no configs preserves today's inert behavior — alertmanager boots clean, alerts fire to nowhere — until the operator wires a real receiver.)

- [ ] **Step 2: Validate the YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('monitoring/alertmanager.yml')); print('alertmanager.yml valid')"`
Expected: `alertmanager.yml valid`.

- [ ] **Step 3: Document activation in deploy.md**

Add to the existing `## Monitoring (optional)` section in `docs/runbooks/deploy.md`:
```md
### Activate alert delivery (OPS-OBS-1)

By default `monitoring/alertmanager.yml` has an inert `default` receiver — rules in
`monitoring/alerts.yml` fire but reach no one. To deliver alerts, edit
`monitoring/alertmanager.yml`: uncomment the `webhook_configs` (generic; point at a
Slack incoming webhook, Discord, or your handler) **or** `slack_configs`, set the URL,
and ensure `route.receiver` names it. Restart alertmanager. Send a test by triggering a
rule (e.g. stop the api so `ApiDown` fires) and confirm it lands in the channel.
```

- [ ] **Step 4: Commit**

```bash
git add monitoring/alertmanager.yml docs/runbooks/deploy.md
git commit -m "feat(ops): ready-to-activate alertmanager webhook receiver + docs (OPS-OBS-1)"
```

---

## Task 5: CD pipeline scaffolding (OPS-CI-1)

**Files:**
- Create: `.github/workflows/cd.yml`
- Modify: `docs/runbooks/deploy.md`

- [ ] **Step 1: Create the CD workflow**

Create `.github/workflows/cd.yml`:
```yaml
name: cd
on:
  push:
    branches: [main]
concurrency:
  group: cd-${{ github.ref }}
  cancel-in-progress: false
jobs:
  push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v6
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: |
            ghcr.io/${{ github.repository }}:${{ github.sha }}
            ghcr.io/${{ github.repository }}:latest
  deploy:
    needs: [push]
    runs-on: ubuntu-latest
    # Inert until the deploy secrets exist. Add DEPLOY_SSH_HOST/USER/KEY to activate.
    if: ${{ secrets.DEPLOY_SSH_HOST != '' }}
    steps:
      - name: Deploy over SSH
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.DEPLOY_SSH_HOST }}
          username: ${{ secrets.DEPLOY_SSH_USER }}
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          script: |
            cd ${{ secrets.DEPLOY_PATH }}
            docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
            docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```
(GHCR push uses the built-in `GITHUB_TOKEN` — no extra secret. The `deploy` job is skipped entirely while `DEPLOY_SSH_HOST` is empty/undefined.)

- [ ] **Step 2: Validate the workflow YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/cd.yml')); print('cd.yml valid')"`
Expected: `cd.yml valid`.

- [ ] **Step 3: Document CD in deploy.md**

Add to `docs/runbooks/deploy.md` (near the "Activating CI" section):
```md
## CD pipeline (OPS-CI-1)

`.github/workflows/cd.yml` runs on push to `main` (once the repo is on GitHub):
1. **Publish** — builds and pushes the image to `ghcr.io/<owner>/<repo>:<sha>` and
   `:latest` using the built-in `GITHUB_TOKEN` (no extra secret; ensure the repo's
   Package settings allow Actions to write packages).
2. **Deploy (optional, gated)** — runs ONLY if a `DEPLOY_SSH_HOST` secret is set. Add
   `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_PATH` (repo dir on the
   VM) as Actions secrets; the VM's compose must reference the GHCR image. Until then,
   CD only publishes. Recommend branch protection requiring `verify` + `audit` first.
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/cd.yml docs/runbooks/deploy.md
git commit -m "feat(ops): CD workflow — GHCR publish + secret-gated SSH deploy (OPS-CI-1)"
```

---

## Task 6: Observability/perf polish (OPS-OBS-4, OPS-OBS-5)

**Files:**
- Modify: `docs/runbooks/deploy.md` (metrics-token coupling pointer)
- Modify: `perf/baseline.js` (write-path scenario)

- [ ] **Step 1: Surface the metrics-token coupling in deploy.md**

`monitoring/prometheus.yml` already documents the coupling inline (lines 12-15). Add a one-line pointer to the deploy.md `## Monitoring (optional)` section so an operator reading the runbook sees it:
```md
> **Metrics auth coupling (OPS-OBS-4):** if you set `METRICS_TOKEN` on the api, you MUST
> uncomment the `authorization.credentials` block in `monitoring/prometheus.yml` with the
> same token, or scrapes get `401` and the `ApiDown` alert false-fires.
```

- [ ] **Step 2: Add a gated write-path scenario to perf/baseline.js**

`perf/baseline.js` already logs in in `setup()`. Extend `setup()` to also resolve two account ids, and add an opt-in write block (gated on `__ENV.WRITE_SCENARIO`) to the default function. In `setup()`, after `return { token: ... }`, change it to also fetch accounts:
```js
export function setup() {
  const res = http.post(
    `${BASE}/auth/login`,
    JSON.stringify({ email: __ENV.USER_EMAIL, password: __ENV.USER_PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(res, { 'login 200': (r) => r.status === 200 });
  const token = res.json('accessToken');
  // Resolve two posting accounts for the optional write scenario (cash + capital).
  const accRes = http.get(`${BASE}/ledger/accounts`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const accounts = (accRes.json('data') || accRes.json() || []);
  const find = (code) => (accounts.find((a) => a.code === code) || {}).id;
  return { token, cashId: find('1-1000'), capitalId: find('3-1000') };
}
```
And in the default function, after the existing read GETs, add:
```js
  // Opt-in write scenario (set WRITE_SCENARIO=1). Posts a balanced journal entry.
  // NB: writes real data + consumes gapless numbers — run against a throwaway DB,
  // and stay under the 300/min per-user throttle.
  if (__ENV.WRITE_SCENARIO && data.cashId && data.capitalId) {
    const body = JSON.stringify({
      date: '2026-06-15',
      description: 'perf write',
      lines: [
        { accountId: data.cashId, debit: '1.0000', credit: '0.0000' },
        { accountId: data.capitalId, debit: '0.0000', credit: '1.0000' },
      ],
    });
    http.post(`${BASE}/ledger/journal-entries`, body, {
      headers: {
        Authorization: `Bearer ${data.token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `perf-${__VU}-${__ITER}`,
      },
    });
  }
```
(Paths follow the file's existing no-`/v1` convention — operator sets `BASE_URL` to include the version prefix, as the read GETs already assume. The default read baseline is unchanged when `WRITE_SCENARIO` is unset.)

- [ ] **Step 3: Validate the JS**

Run: `node --check perf/baseline.js && echo "baseline.js syntax OK"`
Expected: `baseline.js syntax OK`. (k6's `http`/`check`/`__VU`/`__ENV` globals aren't resolved by `node --check`, but the syntax parse confirms no structural errors; `k6 inspect perf/baseline.js` if k6 is installed.)

- [ ] **Step 4: Commit**

```bash
git add docs/runbooks/deploy.md perf/baseline.js
git commit -m "docs(ops): surface metrics-token coupling (OPS-OBS-4); add k6 write scenario (OPS-OBS-5)"
```

---

## Task 7: Final validation

- [ ] **Step 1: Confirm no app-code drift**

Run: `git diff --stat fe853f7..HEAD -- src/` (or the branch base) → expect NO `src/` files (this batch is all infra/docs/perf). Then `npm run lint:ci` → 0 (nothing in `{src,apps,libs,test}` changed, so it stays clean).

- [ ] **Step 2: Re-validate all touched configs in one pass**

```bash
python3 -c "import yaml; [yaml.safe_load(open(f)) for f in ['.github/workflows/ci.yml','.github/workflows/cd.yml','monitoring/alertmanager.yml']]; print('workflows + alertmanager YAML valid')"
POSTGRES_PASSWORD=x DOMAIN=example.com docker compose -f docker-compose.yml -f docker-compose.prod.yml config >/dev/null && echo "compose valid"
sh -n scripts/backup.sh && node --check perf/baseline.js && echo "backup.sh + baseline.js OK"
```
Expected: all three lines print their success message.

- [ ] **Step 2 (note):** No commit if clean.

---

## Self-Review notes

- **Spec coverage:** Cluster A → Tasks 1 (Caddy+Trivy) & 2 (read_only); Cluster B → Task 3 (backup); Cluster C → Task 4 (alerts); Cluster D → Task 5 (CD); Cluster E → Task 6 (obs/perf); Task 7 = final static re-validation. OPS-TEST-2 excluded per spec.
- **No behavior change until activated:** backup unset-env path = today's exact flow (verified by reasoning in Task 3 Step 2); alertmanager keeps the inert `default` receiver; CD `deploy` gated on `DEPLOY_SSH_HOST`; Caddy headers + read_only are runtime-only (no app code). The app test suite is untouched.
- **Watch-points:** (1) Task 2 read_only is the one with real deploy risk — the smoke only asserts no EROFS at boot (app may not fully start without DB; that's fine), full confirmation is deploy-time. (2) Trivy action tag `0.28.0` — bump if it doesn't resolve. (3) backup prune glob widened to `*.dump*` so encrypted files age out; harmless for `.dump`. (4) perf paths follow the existing no-`/v1` convention (BASE carries the prefix). (5) `appleboy/ssh-action@v1` + GHCR package-write permission are the two external assumptions for CD activation — documented.
