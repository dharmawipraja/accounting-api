#!/bin/sh
# postgres docker-entrypoint init hook (runs ONLY when the data volume is
# empty). Creates the least-privilege `accounting_app` role and its default
# privileges before the first migration, so every table the migrate service
# later creates as the owner is granted automatically. Existing volumes are
# covered by the migrate service's idempotent step (scripts/db/ensure-app-role.js),
# which applies the same SQL after every `prisma migrate deploy` — and is what
# grants DELETE on the hard-delete allow-list (those tables do not exist yet here).
#
# No `exit` here on purpose: the entrypoint *sources* non-executable hooks, and
# an `exit` would end the entrypoint itself.
set -eu

if [ -z "${APP_DB_PASSWORD:-}" ]; then
  echo "10-accounting-app-role: APP_DB_PASSWORD not set — skipping accounting_app role creation"
else
  # SET (not SELECT set_config) so the password is never echoed to the log.
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    --set=app_pw="$APP_DB_PASSWORD" <<'EOSQL'
SET accounting.app_db_password = :'app_pw';
\i /docker-entrypoint-app-role.sql
EOSQL
fi
