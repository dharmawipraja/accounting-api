import { INestApplication, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../src/app.module';
import { AuditService } from '../src/audit/audit.service';
import { RejectionAuditLimiter } from '../src/audit/rejection-audit-limiter';
import { globalValidationPipe } from '../src/audit/validated-body';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { asOfOrToday } from '../src/common/dates/query-dates';
import { startTestDb, TestDb } from './testcontainers';

/** Tomorrow's company calendar day (WIB, as asOfOrToday resolves "today"),
 *  YYYY-MM-DD — the first date a void / reversal may NOT use. */
export function tomorrowWib(): string {
  return wibDayPlus(1);
}

/** The WIB calendar day `days` after today, as YYYY-MM-DD. */
export function wibDayPlus(days: number): string {
  return new Date(asOfOrToday().getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

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
  /** Tear down in afterAll: app.close (also closes the HTTP listener) →
   *  prisma.$disconnect → db.stop. */
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
  // Same as main.ts: no ETags (API responses are Cache-Control: no-store).
  app.set('etag', false);
  // Same body caps as main.ts (the Nest default is 100 KB).
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { limit: '1mb', extended: true });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  if (opts.pipe !== false) {
    app.useGlobalPipes(globalValidationPipe());
  }
  app.useGlobalFilters(
    new AllExceptionsFilter(
      app.get(AuditService),
      app.get(RejectionAuditLimiter),
    ),
  );
  opts.configure?.(app);
  await app.init();
  // Listen ONCE on IPv4 loopback. Given an unlistened server, supertest calls
  // listen(0) per request — binding `::` dual-stack — and then connects to
  // 127.0.0.1:<port>; macOS lets that `::` bind succeed on a port another
  // local process holds on 127.0.0.1, so the request reached THAT process
  // (foreign 426 Upgrade Required / 405 responses). A bound server makes
  // supertest reuse address().port. app.close() in cleanup closes it.
  await app.listen(0, '127.0.0.1');
  const cleanup = async () => {
    await app.close();
    await prisma.$disconnect();
    await db.stop();
  };
  return { app, prisma, db, cleanup };
}
