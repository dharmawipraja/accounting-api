#!/usr/bin/env node
/* Idempotent least-privilege grants step, run by the migrate service right
 * after `prisma migrate deploy`:
 *
 *   DATABASE_URL=<owner url> APP_DB_PASSWORD=<pw> node scripts/db/ensure-app-role.js
 *
 * Connects as the schema OWNER (DATABASE_URL — the same URL migrate used) and
 * applies scripts/db/app-role.sql: (re)creates the `accounting_app` role with
 * APP_DB_PASSWORD and grants it DML on every table, including any the migration
 * just created. Plain CommonJS on purpose: runs in the migrate (Dockerfile
 * `build` stage) image with only node + node_modules (`pg`).
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

// docker-compose.prod.yml interpolates APP_DB_PASSWORD RAW into the api's
// DATABASE_URL (postgresql://accounting_app:${APP_DB_PASSWORD}@db/...), where
// compose cannot percent-encode it. A reserved character (@ : / ? # % space…)
// would silently produce a broken or mis-parsed URL, so only RFC 3986
// "unreserved" characters are accepted (e.g. `openssl rand -hex 24`).
const URL_SAFE_PASSWORD = /^[A-Za-z0-9._~-]+$/;

async function main() {
  const connectionString = process.env.DATABASE_URL;
  const password = process.env.APP_DB_PASSWORD;
  if (!connectionString) throw new Error('DATABASE_URL (owner) is required');
  if (!password) throw new Error('APP_DB_PASSWORD is required');
  if (!URL_SAFE_PASSWORD.test(password)) {
    throw new Error(
      'APP_DB_PASSWORD must be URL-safe (only A-Z a-z 0-9 . _ ~ -) because it is ' +
        'embedded unencoded in the api DATABASE_URL; generate one with `openssl rand -hex 24`',
    );
  }

  const sql = fs.readFileSync(path.join(__dirname, 'app-role.sql'), 'utf8');
  const client = new Client({ connectionString });
  await client.connect();
  try {
    // Bound parameter → the password never appears in statement text/logs.
    await client.query("SELECT set_config('accounting.app_db_password', $1, false)", [password]);
    // Simple-query protocol: the multi-statement file runs as one implicit tx.
    await client.query(sql);
  } finally {
    await client.end();
  }
  console.log('ensure-app-role: accounting_app role + grants are up to date');
}

main().catch((err) => {
  console.error(`ensure-app-role: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
