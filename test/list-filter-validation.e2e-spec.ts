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
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('List-filter validation (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let token: string; // viewer token

  const server = () => app.getHttpServer() as App;
  const get = (url: string) =>
    request(server()).get(url).set('Authorization', `Bearer ${token}`);

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
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.get(CompanyService).seedIfEmpty();
    await app.get(AccountsService).seedIfEmpty();
    await app.get(TaxCodesService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const users = app.get(UsersService);
    await users.create({
      email: 'viewer@filter.test',
      password: 'secret123',
      name: 'Viewer',
      role: 'VIEWER',
    });
    token = (
      await app.get(AuthService).login('viewer@filter.test', 'secret123')
    ).accessToken;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  it('rejects a bad status filter with 400', () =>
    get('/v1/sales-invoices?status=GARBAGE').expect(400));
  it('accepts a valid status filter', () =>
    get('/v1/sales-invoices?status=POSTED').expect(200));
  it('rejects a non-uuid partnerId with 400', () =>
    get('/v1/sales-invoices?partnerId=not-a-uuid').expect(400));
  it('rejects a bad payment direction with 400', () =>
    get('/v1/payments?direction=GARBAGE').expect(400));
  it('rejects a bad asOf on trial-balance with 400', () =>
    get('/v1/ledger/trial-balance?asOf=notadate').expect(400));
});
