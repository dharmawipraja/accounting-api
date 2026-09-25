import { execSync } from 'node:child_process';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

export interface TestDb {
  container: StartedPostgreSqlContainer;
  url: string;
  prisma: PrismaClient;
  stop: () => Promise<void>;
}

// Same digest-pinned image as docker-compose.yml's `db` service, so tests run
// against the exact Postgres build production does (bump both together).
export const POSTGRES_TEST_IMAGE =
  'postgres:16@sha256:fe03a7605299a34ddf5e4f285dff78c3d7190a576b3c6b46f2fcff69f4bffd54';

export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer(POSTGRES_TEST_IMAGE).start();
  try {
    const url = container.getConnectionUri();

    // Apply the schema to the fresh container. prisma.config.ts reads DATABASE_URL
    // from env; dotenv does NOT override an already-set env var, so the container
    // URL we pass here wins over any .env value.
    execSync('npx prisma migrate deploy', {
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'inherit',
    });

    const adapter = new PrismaPg(url);
    const prisma = new PrismaClient({ adapter });
    await prisma.$connect();

    return {
      container,
      url,
      prisma,
      stop: async () => {
        try {
          await prisma.$disconnect();
        } finally {
          await container.stop();
        }
      },
    };
  } catch (err) {
    // Don't leak the container if migration or connection fails mid-setup.
    await container.stop();
    throw err;
  }
}
