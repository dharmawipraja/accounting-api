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
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';

describe('BusinessPartners (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let token: string;

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
    await app.get(UsersService).create({
      email: 'a@p.test',
      password: 'secret123',
      name: 'A',
      role: 'ADMIN',
    });
    token = (await app.get(AuthService).login('a@p.test', 'secret123'))
      .accessToken;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  it('creates a customer partner (201)', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${token}`)
      .send({
        code: 'CUST-1',
        name: 'PT Pelanggan',
        npwp: '01.234.567.8-901.000',
        isCustomer: true,
      })
      .expect(201);
    expect((res.body as { isCustomer: boolean }).isCustomer).toBe(true);
  });

  it('rejects a partner that is neither customer nor vendor (422)', async () => {
    await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'NEITHER', name: 'X', isCustomer: false, isVendor: false })
      .expect(422);
  });

  it('rejects a duplicate code (409)', async () => {
    const body = { code: 'DUP', name: 'Y', isVendor: true };
    await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201);
    await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(409);
  });

  it('soft-deletes a partner (204) then it is gone from the list', async () => {
    const created = await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'DEL-1', name: 'Z', isCustomer: true })
      .expect(201);
    const id = (created.body as { id: string }).id;
    await request(app.getHttpServer() as App)
      .delete(`/v1/partners/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    const list = await request(app.getHttpServer() as App)
      .get('/v1/partners')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(
      (list.body as { data: { id: string }[] }).data.some((p) => p.id === id),
    ).toBe(false);
  });

  describe('search (?q=)', () => {
    it('fuzzy-matches a typo, ranks the closer name first, and excludes non-matches', async () => {
      const partners = app.get(BusinessPartnersService);
      await partners.create({
        code: 'SR-BUDI',
        name: 'PT Budi Jaya',
        isCustomer: true,
      });
      await partners.create({
        code: 'SR-SINAR',
        name: 'CV Sinar Abadi',
        isCustomer: true,
      });
      const res = await request(app.getHttpServer() as App)
        .get('/v1/partners?q=budih') // typo for "Budi"
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const body = res.body as { data: { name: string }[]; total: number };
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      expect(body.data[0].name).toBe('PT Budi Jaya');
      expect(body.data.every((p) => p.name !== 'CV Sinar Abadi')).toBe(true);
    });

    it('ignores a sub-min-length q (returns the normal list)', async () => {
      const res = await request(app.getHttpServer() as App)
        .get('/v1/partners?q=a&limit=5')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const body = res.body as { data: unknown[]; limit: number };
      expect(body.limit).toBe(5);
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('excludes a soft-deleted partner from search results', async () => {
      const partners = app.get(BusinessPartnersService);
      // Create a partner with a highly distinctive name to isolate this test
      const created = await partners.create({
        code: 'SRCH-DEL-BP',
        name: 'PT Zarthronex Deleted',
        isCustomer: true,
      });
      const id = created.id;

      // Confirm it appears in search before deletion
      const before = await request(app.getHttpServer() as App)
        .get('/v1/partners?q=Zarthronex')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const bodyBefore = before.body as {
        data: { id: string }[];
        total: number;
      };
      expect(bodyBefore.data.some((p) => p.id === id)).toBe(true);
      expect(bodyBefore.total).toBeGreaterThanOrEqual(1);

      // Soft-delete via the DELETE endpoint (same path as existing soft-delete test)
      await request(app.getHttpServer() as App)
        .delete(`/v1/partners/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      // Confirm it no longer appears in search results after deletion
      const after = await request(app.getHttpServer() as App)
        .get('/v1/partners?q=Zarthronex')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const bodyAfter = after.body as {
        data: { id: string }[];
        total: number;
      };
      expect(bodyAfter.data.some((p) => p.id === id)).toBe(false);
      expect(bodyAfter.total).toBe(0);
    });
  });
});
