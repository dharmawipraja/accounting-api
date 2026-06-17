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
import { CompanyService } from '../src/company/company.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Company settings (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prismaOverride: PrismaService;
  let adminToken: string;
  let accountantToken: string;
  let approverToken: string;
  let viewerToken: string;

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
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    await app.get(CompanyService).seedIfEmpty();
    const users = app.get(UsersService);
    await users.create({
      email: 'admin@x.com',
      password: 'secret123',
      name: 'A',
      role: 'ADMIN',
    });
    adminToken = (await app.get(AuthService).login('admin@x.com', 'secret123'))
      .accessToken;

    const mkToken = async (
      email: string,
      role: 'ACCOUNTANT' | 'APPROVER' | 'VIEWER',
    ) => {
      await users.create({ email, password: 'secret123', name: role, role });
      return (await app.get(AuthService).login(email, 'secret123')).accessToken;
    };
    accountantToken = await mkToken('acct@x.com', 'ACCOUNTANT');
    approverToken = await mkToken('appr@x.com', 'APPROVER');
    viewerToken = await mkToken('view@x.com', 'VIEWER');
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prismaOverride.$disconnect();
    await db?.stop();
  });

  it('returns the seeded singleton with SoD enabled by default', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/v1/company/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as {
      segregationOfDutiesEnabled: boolean;
      baseCurrency: string;
      fiscalYearStartMonth: number;
    };
    expect(body.segregationOfDutiesEnabled).toBe(true);
    expect(body.baseCurrency).toBe('IDR');
    expect(body.fiscalYearStartMonth).toBe(1);
  });

  it('lets an admin toggle segregation of duties', async () => {
    await request(app.getHttpServer() as App)
      .patch('/v1/company/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ segregationOfDutiesEnabled: false })
      .expect(200)
      .expect((r) => {
        const body = r.body as { segregationOfDutiesEnabled: boolean };
        expect(body.segregationOfDutiesEnabled).toBe(false);
      });
  });

  it('seedIfEmpty is idempotent (still one row)', async () => {
    await app.get(CompanyService).seedIfEmpty();
    const count = await prismaOverride.client.companySettings.count();
    expect(count).toBe(1);
  });

  it('SEC-4: company settings GET is limited to ADMIN and ACCOUNTANT', async () => {
    const get = (token: string) =>
      request(app.getHttpServer() as App)
        .get('/v1/company/settings')
        .set('Authorization', `Bearer ${token}`);
    await get(adminToken).expect(200);
    await get(accountantToken).expect(200);
    await get(approverToken).expect(403);
    await get(viewerToken).expect(403);
  });
});
