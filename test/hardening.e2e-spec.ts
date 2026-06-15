import { Test } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import helmet from 'helmet';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Hardening (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prismaOverride: PrismaService;

  beforeAll(async () => {
    db = await startTestDb();
    prismaOverride = makePrismaOverride(db.url);
    await prismaOverride.$connect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaOverride)
      .compile();
    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.use(helmet());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prismaOverride.$disconnect();
    await db?.stop();
  });

  it('GET /ready reports the database is up', () => {
    return request(app.getHttpServer() as App)
      .get('/ready')
      .expect(200)
      .expect((r) => {
        const body = r.body as { db: string };
        expect(body.db).toBe('up');
      });
  });

  it('GET /ready returns 503 when the database is down', async () => {
    const spy = jest
      .spyOn(prismaOverride, '$queryRaw')
      .mockRejectedValueOnce(new Error('connection refused'));
    await request(app.getHttpServer() as App)
      .get('/ready')
      .expect(503);
    spy.mockRestore();
  });

  it('sets security headers via helmet', () => {
    return request(app.getHttpServer() as App)
      .get('/health')
      .expect(200)
      .expect((r) => {
        expect(r.headers['x-dns-prefetch-control']).toBeDefined();
      });
  });

  it('rejects unknown body properties (400)', () => {
    return request(app.getHttpServer() as App)
      .post('/v1/auth/login')
      .send({ email: 'a@b.com', password: 'secret123', injected: 'x' })
      .expect(400);
  });
});
