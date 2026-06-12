import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
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

  it('echoes a generated X-Request-Id on a normal response', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/health')
      .expect(200);
    expect(res.headers['x-request-id']).toMatch(/[0-9a-f-]{36}/);
  });

  it('reuses an inbound X-Request-Id', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/health')
      .set('X-Request-Id', 'trace-abc-123')
      .expect(200);
    expect(res.headers['x-request-id']).toBe('trace-abc-123');
  });

  it('includes traceId in an error envelope', async () => {
    // an unauthenticated protected route -> 401 envelope; assert traceId present
    const res = await request(app.getHttpServer() as App)
      .get('/reports/balance-sheet')
      .expect(401);
    expect((res.body as { traceId?: string }).traceId).toBeTruthy();
  });
});
