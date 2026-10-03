import { execSync } from 'node:child_process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { E2E_TEMPLATE_DB, POSTGRES_TEST_IMAGE } from './testcontainers';

/** Jest e2e globalSetup: ONE Postgres container for the whole run, with the
 *  full migration history applied ONCE into a template database. Each spec's
 *  startTestDb() then clones it (`CREATE DATABASE … TEMPLATE`, a file copy) —
 *  instead of starting a container and replaying every migration per spec.
 *  The env vars set here reach the test workers (spawned after this runs). */
export default async function globalSetup(): Promise<void> {
  const container = await new PostgreSqlContainer(POSTGRES_TEST_IMAGE).start();
  (globalThis as { __E2E_PG__?: unknown }).__E2E_PG__ = container;

  const admin = new URL(container.getConnectionUri());
  admin.pathname = '/postgres';
  const template = new URL(admin);
  template.pathname = `/${E2E_TEMPLATE_DB}`;

  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${E2E_TEMPLATE_DB}`);
  } finally {
    await client.end();
  }
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: template.toString() },
    stdio: 'inherit',
  });

  process.env.E2E_PG_ADMIN_URL = admin.toString();
}
