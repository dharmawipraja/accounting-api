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
if [ -d .git ]; then
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
refresh_bind_mount() { # <service> <path in container> <checked-out file>
  if $COMPOSE exec -T "$1" cat "$2" 2>/dev/null | cmp -s - "$3"; then
    echo "$3: running $1 already has this content"
  else
    echo "$3 differs from (or is unreadable in) the running $1: recreating $1"
    $COMPOSE up -d --no-build --no-deps --force-recreate "$1"
  fi
}
refresh_bind_mount caddy /etc/caddy/Caddyfile Caddyfile
refresh_bind_mount backup /backup.sh scripts/backup.sh

