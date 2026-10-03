import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/** Stops the shared e2e Postgres container started by global-setup.ts. */
export default async function globalTeardown(): Promise<void> {
  const container = (globalThis as { __E2E_PG__?: StartedPostgreSqlContainer })
    .__E2E_PG__;
  await container?.stop();
}
