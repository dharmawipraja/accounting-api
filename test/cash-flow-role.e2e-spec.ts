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
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Cash flow role-based filter (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prismaOverride: PrismaService;
  let adminToken: string;

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
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const users = app.get(UsersService);
    await users.create({
      email: 'admin@cfr.test',
      password: 'secret123',
      name: 'Admin',
      role: 'ADMIN',
    });
    adminToken = (
      await app.get(AuthService).login('admin@cfr.test', 'secret123')
    ).accessToken;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prismaOverride.$disconnect();
    await db?.stop();
  });

  it('a CASH-role account with a non-legacy code participates in cash flow', async () => {
    // A second bank account whose code is NOT in the old CASH_CODES set.
    // Created via raw Prisma (the role column exists after Task 1) so this test
    // does NOT depend on the create-DTO role threading (Task 6). parentId is
    // nullable and irrelevant to the cash-flow report, so it is omitted.
    const bank2 = await prismaOverride.client.account.create({
      data: {
        code: '1-1150',
        name: 'Bank Kedua',
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        normalBalance: 'DEBIT',
        role: 'CASH',
      },
    });
    // Opening balance into the new bank: Dr 1-1150 1,000,000 / Cr 3-9000 (equity).
    const accounts = await app.get(AccountsService).listAll();
    const equity = accounts.find((a) => a.code === '3-9000')!;
    await app.get(PostingService).post(
      {
        date: new Date('2026-02-01'),
        description: 'Open Bank Kedua',
        sourceType: 'MANUAL',
        createdBy: 'a',
        lines: [
          { accountId: bank2.id, debit: '1000000' },
          { accountId: equity.id, credit: '1000000' },
        ],
      },
      'admin',
    );
    const res = await request(app.getHttpServer() as App)
      .get('/v1/reports/cash-flow?from=2026-01-01&to=2026-12-31')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as { kasAkhir: string; reconciles: boolean };
    // Under the OLD code (CASH_CODES = {1-1000,1-1100}) the 1-1150 debit would be a
    // non-cash adjustment and kasAkhir would EXCLUDE it. Role-based, it is cash.
    expect(body.kasAkhir).toBe('1000000.0000');
    expect(body.reconciles).toBe(true);
  });
});
