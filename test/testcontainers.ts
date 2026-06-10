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

export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer('postgres:16').start();
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
