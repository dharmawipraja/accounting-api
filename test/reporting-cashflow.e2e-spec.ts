import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
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

describe('Reporting cash flow (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let token: string;
  let acc: Record<string, string>;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = makePrismaOverride(db.url);
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = moduleRef.createNestApplication();
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
      email: 'v@cf.test',
      password: 'secret123',
      name: 'V',
      role: 'VIEWER',
    });
    token = (await app.get(AuthService).login('v@cf.test', 'secret123'))
      .accessToken;
    const accounts = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));

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

  it('cash flow reconciles: kasAwal + netChange === kasAkhir', async () => {
    const res = await get(
      '/reports/cash-flow?from=2026-01-01&to=2026-12-31',
    ).expect(200);
    const body = res.body as {
      reconciles: boolean;
      kasAwal: string;
      kasAkhir: string;
      netChange: string;
      netIncome: string;
      operating: { adjustments: unknown[]; total: string };
      investing: { lines: unknown[]; total: string };
      financing: { lines: unknown[]; total: string };
    };

    expect(body.reconciles).toBe(true);
    expect(body.kasAwal).toBe('0.0000');
    // Kas: +10,000,000 (opening) + 2,000,000 (sale) − 500,000 (expense) = 11,500,000
    expect(body.kasAkhir).toBe('11500000.0000');
    expect(body.netChange).toBe('11500000.0000');
    // Net income: revenue 2,000,000 − expense 500,000
    expect(body.netIncome).toBe('1500000.0000');

    // Section breakdown (catches miscategorization the reconciliation alone can't):
    // operating = net income only (no working-capital movement in this seed);
    // financing = Modal 10,000,000; investing = nothing.
    expect(body.operating.total).toBe('1500000.0000');
    expect(body.financing.total).toBe('10000000.0000');
    expect(body.investing.total).toBe('0.0000');
    // operating + investing + financing === netChange
    const opTotal = Number(body.operating.total);
    const invTotal = Number(body.investing.total);
    const finTotal = Number(body.financing.total);
    expect(opTotal + invTotal + finTotal).toBeCloseTo(
      Number(body.netChange),
      4,
    );
  });

  it('rejects from > to with 422', async () => {
    await get('/reports/cash-flow?from=2026-12-31&to=2026-01-01').expect(422);
  });
});
