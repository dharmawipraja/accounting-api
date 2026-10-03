import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

export interface TestDb {
  url: string;
  prisma: PrismaClient;
  stop: () => Promise<void>;
}

// Same digest-pinned image as docker-compose.yml's `db` service, so tests run
// against the exact Postgres build production does (bump both together).
export const POSTGRES_TEST_IMAGE =
  'postgres:16@sha256:fe03a7605299a34ddf5e4f285dff78c3d7190a576b3c6b46f2fcff69f4bffd54';

/** Database global-setup.ts migrates once; every spec clones it. */
export const E2E_TEMPLATE_DB = 'accounting_e2e_template';

/** On the run's ONE shared Postgres (global-setup.ts), against the admin DB. */
async function onAdminDb(sql: string): Promise<void> {
  const adminUrl = process.env.E2E_PG_ADMIN_URL;
  if (!adminUrl)
    throw new Error(
      'E2E_PG_ADMIN_URL is unset — run e2e specs through test/jest-e2e.json (its globalSetup starts the shared Postgres)',
    );
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** A fresh, fully migrated database for one spec: a copy of the migrated
 *  template (CREATE DATABASE … TEMPLATE), dropped again by stop(). Isolation
 *  equals the old container-per-spec setup for everything database-scoped
 *  (schema, data, _prisma_migrations); roles are cluster-wide but the specs
 *  that create one (db-app-role) do so idempotently. */
export async function startTestDb(): Promise<TestDb> {
  const name = `e2e_${randomUUID().replace(/-/g, '')}`;
  await onAdminDb(`CREATE DATABASE ${name} TEMPLATE ${E2E_TEMPLATE_DB}`);
  const u = new URL(process.env.E2E_PG_ADMIN_URL!);
  u.pathname = `/${name}`;
  const url = u.toString();
  try {
    const prisma = new PrismaClient({ adapter: new PrismaPg(url) });
    await prisma.$connect();
    return {
      url,
      prisma,
      stop: async () => {
        try {
          await prisma.$disconnect();
        } finally {
          await onAdminDb(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        }
      },
    };
  } catch (err) {
    await onAdminDb(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    throw err;
  }
}
