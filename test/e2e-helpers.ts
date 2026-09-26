import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../src/app.module';
import { AuditService } from '../src/audit/audit.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { startTestDb, TestDb } from './testcontainers';

/**
 * Builds a PrismaService pointed at a testcontainer URL. NestJS freezes
 * ConfigModule's view of process.env at require() time, so e2e tests override
 * PrismaService rather than mutating process.env.DATABASE_URL. Non-DATABASE_URL
 * keys (JWT secrets/TTLs from setup-env.ts) fall through to process.env.
 */
export function makePrismaOverride(url: string): PrismaService {
  const mockConfig = {
    getOrThrow: (key: string) =>
      key === 'DATABASE_URL' ? url : (process.env[key] as string),
    get: (key: string) => (key === 'DATABASE_URL' ? url : process.env[key]),
  } as unknown as ConfigService;
  return new PrismaService(mockConfig);
}

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  db: TestDb;
  /** Tear down in afterAll: app.close → prisma.$disconnect → db.stop. */
  cleanup: () => Promise<void>;
}

/**
 * Boots the full app against a fresh testcontainer DB, mirroring main.ts's
 * middleware stack. The single source for the e2e bootstrap skeleton.
 *
 * @param opts.pipe      false to skip the ValidationPipe (service-layer specs that
 *                       don't exercise DTO validation). Default true → the canonical
 *                       prod pipe (whitelist + transform + forbidNonWhitelisted).
 * @param opts.configure pre-init hook for extra middleware (e.g. helmet); runs AFTER
 *                       the global filter and BEFORE app.init().
 * @param opts.appDbUrl  optional hook run on the migrated DB before boot; returns the
 *                       DATABASE_URL the APP connects with (e.g. a least-privilege
 *                       role). Default: the container superuser URL (`db.url`).
 */
export async function bootstrapTestApp(
  opts: {
    pipe?: boolean;
    configure?: (app: INestApplication) => void;
    appDbUrl?: (db: TestDb) => Promise<string> | string;
  } = {},
): Promise<TestApp> {
  const db = await startTestDb();
  const prisma = makePrismaOverride(
    opts.appDbUrl ? await opts.appDbUrl(db) : db.url,
  );
  await prisma.$connect();
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .compile();
  const app = mod.createNestApplication<NestExpressApplication>();
  // Same body caps as main.ts (the Nest default is 100 KB).
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { limit: '1mb', extended: true });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  if (opts.pipe !== false) {
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
  }
  app.useGlobalFilters(new AllExceptionsFilter(app.get(AuditService)));
  opts.configure?.(app);
  await app.init();
  const cleanup = async () => {
    await app.close();
    await prisma.$disconnect();
    await db.stop();
  };
  return { app, prisma, db, cleanup };
}
