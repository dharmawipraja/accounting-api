import { Test } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('traceId correlation (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = makePrismaOverride(db.url);
    await prisma.$connect();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = mod.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  it('echoes a generated UUID X-Request-Id on a normal response', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/health')
      .expect(200);
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('reuses an inbound X-Request-Id', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/health')
      .set('X-Request-Id', 'trace-abc-123')
      .expect(200);
    expect(res.headers['x-request-id']).toBe('trace-abc-123');
  });

  it('ignores an oversized/garbage inbound X-Request-Id and generates a UUID', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/health')
      .set('X-Request-Id', 'x'.repeat(200))
      .expect(200);
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('correlates: the error envelope traceId equals the X-Request-Id header (same id)', async () => {
    // an unauthenticated protected route -> 401 envelope; the traceId MUST be the
    // same id echoed in the response header (that correlation is the whole point).
    const res = await request(app.getHttpServer() as App)
      .get('/v1/reports/balance-sheet')
      .set('X-Request-Id', 'trace-corr-xyz')
      .expect(401);
    expect(res.headers['x-request-id']).toBe('trace-corr-xyz');
    expect((res.body as { traceId?: string }).traceId).toBe('trace-corr-xyz');
  });
});
