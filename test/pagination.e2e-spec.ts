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
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Pagination (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let acct: string;
  const server = () => app.getHttpServer() as App;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = makePrismaOverride(db.url);
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    const users = app.get(UsersService);
    await users.create({
      email: 'acct@page.test',
      password: 'secret123',
      name: 'Acct',
      role: 'ACCOUNTANT',
    });
    acct = (await app.get(AuthService).login('acct@page.test', 'secret123'))
      .accessToken;
    // Seed 5 partners directly via the service (no HTTP, no idempotency key).
    const partners = app.get(BusinessPartnersService);
    for (const n of [1, 2, 3, 4, 5]) {
      await partners.create({
        code: `PG-${n}`,
        name: `PT Page ${n}`,
        isCustomer: true,
      });
    }
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  it('returns the { data, total, limit, offset } envelope and honors limit', async () => {
    const res = await request(server())
      .get('/v1/partners?limit=3&offset=0')
      .set('Authorization', `Bearer ${acct}`)
      .expect(200);
    const body = res.body as {
      data: unknown[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.limit).toBe(3);
    expect(body.offset).toBe(0);
    expect(body.data.length).toBe(3);
    expect(body.total).toBeGreaterThanOrEqual(5);
  });

  it('offset advances the page without overlap', async () => {
    const page1 = (
      await request(server())
        .get('/v1/partners?limit=2&offset=0')
        .set('Authorization', `Bearer ${acct}`)
        .expect(200)
    ).body as { data: { id: string }[] };
    const page2 = (
      await request(server())
        .get('/v1/partners?limit=2&offset=2')
        .set('Authorization', `Bearer ${acct}`)
        .expect(200)
    ).body as { data: { id: string }[] };
    const ids = new Set(page1.data.map((p) => p.id));
    for (const p of page2.data) expect(ids.has(p.id)).toBe(false);
  });

  it('rejects an over-max limit (400 from the ValidationPipe)', async () => {
    await request(server())
      .get('/v1/partners?limit=500')
      .set('Authorization', `Bearer ${acct}`)
      .expect(400);
  });
});
