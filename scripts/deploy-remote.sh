#!/bin/sh
# CD deploy step, run ON THE VM over SSH by .github/workflows/cd.yml (the
# `deploy` job sends this file's content via appleboy/ssh-action `script_path`,
# from the checkout of the ref being deployed). It is NOT run on the CI runner.
# Kept as a committed file (not an inline `script:`) so CI's shellcheck lints the
# exact commands CD executes. Inputs (exported by the action's `envs:`):
# API_IMAGE, MIGRATE_IMAGE (immutable :<sha> tags just pushed), DEPLOY_SHA,
# DEPLOY_PATH (repo checkout on the VM). POSIX sh — the remote login shell runs it.
set -eu
cd "$DEPLOY_PATH"
# Keep the compose files / Caddyfile / scripts in step with the images.
PREV_SHA=
if [ -d .git ]; then
  PREV_SHA=$(git rev-parse HEAD)
  git fetch --quiet origin
  git checkout --quiet --detach "$DEPLOY_SHA"
fi
export API_IMAGE MIGRATE_IMAGE
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
# Pull the images CI just pushed, then start WITHOUT building so the
# host never runs a stale locally-built image.
$COMPOSE pull
# Stop the OLD api before migrate runs: old code against the new
# schema can hit new CHECKs/triggers (e.g. a void without voided_on
# -> 500). up then runs migrate to completion and starts the new api.
$COMPOSE stop api
$COMPOSE up -d --no-build
# Single-file bind mounts pin the file's inode: git checkout replaces
# a changed file with a NEW inode, so a running container keeps
# reading the OLD content (`caddy reload` inside it re-reads the old
# file too), and `up` recreates a service only when its compose
# definition changed. So compare what each RUNNING container reads
# with the checked-out file and recreate just that service when they
# differ (--no-deps leaves api/db alone; caddy: a few seconds of
# refused connections, certs persist in caddy_data). Keyed on the
# live content, not on git history: a re-run after a failed deploy
# still converges, and a second run is a no-op. Any failure to read
# (service not running, file missing) also recreates.
# <compose command> <service> then (<path in container> <checked-out file>)...:
# recreate the service once if ANY of its files differ.
refresh_bind_mounts() {
  c=$1 svc=$2
  shift 2
  while [ $# -ge 2 ]; do
    # shellcheck disable=SC2086 # $c is a multi-word compose command
    if ! $c exec -T "$svc" cat "$1" 2>/dev/null | cmp -s - "$2"; then
      echo "$2 differs from (or is unreadable in) the running $svc: recreating $svc"
      # shellcheck disable=SC2086
      $c up -d --no-build --no-deps --force-recreate "$svc"
      return
    fi
    shift 2
  done
  echo "$svc: running container already has the checked-out config"
}
refresh_bind_mounts "$COMPOSE" caddy /etc/caddy/Caddyfile Caddyfile
refresh_bind_mounts "$COMPOSE" backup /backup.sh scripts/backup.sh
# The monitoring overlay (when the operator runs it) mounts each service's
# config as a DIRECTORY (monitoring/<service>/), so the container sees the
# checked-out files, but the services only read them at start. Recreate a
# service when its config dir (or the overlay compose file) changed between the
# previous and the deployed commit; on a re-run (nothing to diff) recreate them
# all — cheap, and converges after a deploy that failed half-way.
MON="$COMPOSE -f docker-compose.monitoring.yml"
# `ps` interpolates the overlay (GRAFANA_ADMIN_PASSWORD is required): report a
# failure instead of silently treating it as "overlay not running". stderr goes
# to a file, not into $mon_ps (a compose warning must not read as "running").
mon_err=$(mktemp)
if ! mon_ps=$($MON ps -q prometheus 2>"$mon_err"); then
  echo "WARN: cannot inspect the monitoring overlay ($(cat "$mon_err")); skipping its config refresh." >&2
  echo "WARN: set GRAFANA_ADMIN_PASSWORD in $DEPLOY_PATH/.env if the overlay runs here." >&2
elif [ -z "$mon_ps" ]; then
  echo "monitoring overlay not running: nothing to refresh"
else
  for svc in prometheus alertmanager loki alloy grafana; do
    if [ -n "$PREV_SHA" ] && [ "$PREV_SHA" != "$DEPLOY_SHA" ] &&
      git diff --quiet "$PREV_SHA" "$DEPLOY_SHA" -- \
        "monitoring/$svc" docker-compose.monitoring.yml; then
      echo "$svc: config unchanged"
    else
      echo "$svc: config changed (or re-run): recreating"
      $MON up -d --no-build --no-deps --force-recreate "$svc"
    fi
  done
fi
rm -f "$mon_err"
