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

describe('Reporting general ledger (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let token: string;
  let acc: Record<string, string>;
  let kasId: string;

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
    await app.get(CompanyService).seedIfEmpty();
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    await app.get(UsersService).create({
      email: 'v@ledger.test',
      password: 'secret123',
      name: 'V',
      role: 'VIEWER',
    });
    token = (await app.get(AuthService).login('v@ledger.test', 'secret123'))
      .accessToken;
    const { data: accounts } = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    kasId = acc['1-1000'];

    const posting = app.get(PostingService);
    // Opening capital: Dr Kas 10,000,000 / Cr Modal 10,000,000
    await posting.post(
      {
        date: new Date('2026-01-01'),
        description: 'Modal awal',
        sourceType: 'OPENING',
        createdBy: 'sys',
        lines: [
          { accountId: acc['1-1000'], debit: '10000000' },
          { accountId: acc['3-1000'], credit: '10000000' },
        ],
      },
      'sys',
    );
    // A cash sale: Dr Kas 2,000,000 / Cr Pendapatan 2,000,000
    await posting.post(
      {
        date: new Date('2026-02-10'),
        description: 'Penjualan tunai',
        sourceType: 'MANUAL',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: '2000000' },
          { accountId: acc['4-1000'], credit: '2000000' },
        ],
      },
      'p',
    );
    // A cash expense: Dr Beban Gaji 500,000 / Cr Kas 500,000
    await posting.post(
      {
        date: new Date('2026-02-15'),
        description: 'Bayar gaji',
        sourceType: 'MANUAL',
        createdBy: 'a',
        lines: [
          { accountId: acc['5-2000'], debit: '500000' },
          { accountId: acc['1-1000'], credit: '500000' },
        ],
      },
      'p',
    );
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  const get = (url: string) =>
    request(app.getHttpServer() as App)
      .get(url)
      .set('Authorization', `Bearer ${token}`);

  it('returns opening balance, 3 lines with running balances, and correct closing balance for Kas', async () => {
    const res = await get(
      `/v1/reports/general-ledger?accountId=${kasId}&from=2026-01-01&to=2026-12-31`,
    ).expect(200);
    const body = res.body as {
      openingBalance: string;
      closingBalance: string;
      lines: {
        date: string;
        entryRef: string | null;
        description: string | null;
        debit: string;
        credit: string;
        runningBalance: string;
      }[];
    };

    // Nothing posted before 2026-01-01, so opening is zero
    expect(body.openingBalance).toBe('0.0000');

    // 3 transactions hit Kas: opening capital, cash sale, cash expense
    expect(body.lines).toHaveLength(3);

    // Each line must have required fields
    for (const line of body.lines) {
      expect(line).toHaveProperty('entryRef');
      expect(line).toHaveProperty('debit');
      expect(line).toHaveProperty('credit');
      expect(line).toHaveProperty('runningBalance');
    }

    // Running balance trace (Kas is DEBIT-normal):
    // After opening capital: 0 + 10,000,000 = 10,000,000
    expect(body.lines[0].runningBalance).toBe('10000000.0000');
    // After cash sale: 10,000,000 + 2,000,000 = 12,000,000
    expect(body.lines[1].runningBalance).toBe('12000000.0000');
    // After cash expense: 12,000,000 − 500,000 = 11,500,000
    expect(body.lines[2].runningBalance).toBe('11500000.0000');

    // Closing balance = last running balance
    expect(body.closingBalance).toBe('11500000.0000');
    expect(body.closingBalance).toBe(
      body.lines[body.lines.length - 1].runningBalance,
    );
  });

  it('rejects from > to with 422', async () => {
    await get(
      `/v1/reports/general-ledger?accountId=${kasId}&from=2026-12-31&to=2026-01-01`,
    ).expect(422);
  });

  it('returns 404 for an unknown accountId', async () => {
    await get(
      '/v1/reports/general-ledger?accountId=00000000-0000-0000-0000-000000000000&from=2026-01-01&to=2026-12-31',
    ).expect(404);
  });
});
