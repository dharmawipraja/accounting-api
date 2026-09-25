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

async function main() {
  const connectionString = process.env.DATABASE_URL;
  const password = process.env.APP_DB_PASSWORD;
  if (!connectionString) throw new Error('DATABASE_URL (owner) is required');
  if (!password) throw new Error('APP_DB_PASSWORD is required');

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
