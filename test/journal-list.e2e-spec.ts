import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { CompanyService } from '../src/company/company.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { JournalService } from '../src/ledger/journal/journal.service';
import { UsersService } from '../src/users/users.service';
import { AuthService } from '../src/auth/auth.service';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Journal-entry list (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let token: string;
  let acc: Record<string, string>;

  const get = (url: string) =>
    request(app.getHttpServer() as App)
      .get(url)
      .set('Authorization', `Bearer ${token}`);

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
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    await app.get(CompanyService).seedIfEmpty();
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const accounts = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    await app.get(UsersService).create({
      email: 'jl@test.io',
      password: 'secret123',
      name: 'JL',
      role: 'VIEWER',
    });
    token = (await app.get(AuthService).login('jl@test.io', 'secret123'))
      .accessToken;

    const posting = app.get(PostingService);
    const manual = (date: string, amt: string) => ({
      date: new Date(date),
      description: `Entry ${date}`,
      sourceType: 'MANUAL' as const,
      createdBy: 'a',
      lines: [
        { accountId: acc['1-1000'], debit: amt },
        { accountId: acc['3-1000'], credit: amt },
      ],
    });
    await posting.post(manual('2026-02-10', '1000000'), 'p');
    await posting.post(manual('2026-03-15', '2000000'), 'p');
    // one DRAFT (not posted)
    await app.get(JournalService).createDraft({
      date: new Date('2026-02-20'),
      description: 'Draft entry',
      createdBy: 'a',
      lines: [
        { accountId: acc['1-1000'], debit: '500000' },
        { accountId: acc['3-1000'], credit: '500000' },
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  it('lists entries newest-first with header + totalDebit (4dp) + lineCount, no lines[]', async () => {
    const res = await get('/ledger/journal-entries').expect(200);
    const body = res.body as {
      data: { date: string; totalDebit: string; lineCount: number }[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.total).toBe(3); // 2 posted + 1 draft
    expect(body.data).toHaveLength(3);
    expect(body.data[0].date >= body.data[1].date).toBe(true); // date desc
    const item = body.data[0];
    expect(item).toHaveProperty('totalDebit');
    expect(item).toHaveProperty('lineCount', 2);
    expect(item).not.toHaveProperty('lines');
    expect(item.totalDebit).toMatch(/^\d+\.\d{4}$/); // 4dp string
  });

  it('filters by status=DRAFT (the approver "find pending drafts" case)', async () => {
    const res = await get('/ledger/journal-entries?status=DRAFT').expect(200);
    const body = res.body as {
      data: { status: string; description: string }[];
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.data[0].status).toBe('DRAFT');
    expect(body.data[0].description).toBe('Draft entry');
  });

  it('filters by sourceType, date range, and fiscalYear', async () => {
    expect(
      (
        (await get('/ledger/journal-entries?sourceType=MANUAL').expect(200))
          .body as { total: number }
      ).total,
    ).toBe(3);
    const march = (
      await get('/ledger/journal-entries?from=2026-03-01&to=2026-03-31').expect(
        200,
      )
    ).body as { data: { date: string }[]; total: number };
    expect(march.total).toBe(1);
    expect(march.data[0].date).toBe('2026-03-15');
    expect(
      (
        (await get('/ledger/journal-entries?fiscalYear=2026').expect(200))
          .body as { total: number }
      ).total,
    ).toBe(2); // only POSTED entries carry fiscalYear; drafts have null
  });

  it('paginates with limit/offset (total reflects the full set)', async () => {
    const res = await get('/ledger/journal-entries?limit=1').expect(200);
    const body = res.body as { data: unknown[]; total: number; limit: number };
    expect(body.data).toHaveLength(1);
    expect(body.total).toBe(3);
    expect(body.limit).toBe(1);
  });

  it('rejects bad filter values with 400', async () => {
    await get('/ledger/journal-entries?status=GARBAGE').expect(400);
    await get('/ledger/journal-entries?fiscalYear=abc').expect(400);
  });
});
