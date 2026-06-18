import { Test } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { YearEndCloseService } from '../src/close/year-end-close.service';
import { ClosedYearError } from '../src/common/errors/domain-errors';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

/**
 * P0-1: a reversal/void whose date lands in a CLOSED fiscal year must be
 * rejected, exactly like a forward post — the year-lock applies to BOTH the
 * forward and the reversal path. `reopen()` is the only sanctioned way to
 * write into a closed year (it bypasses the guard internally).
 */
describe('Year-end close — reversal year-lock (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let acc: Record<string, string>;
  let posting: PostingService;
  let close: YearEndCloseService;
  let entryId: string;

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
    await app.init();
    await app.get(CompanyService).seedIfEmpty();
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const { data: accounts } = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    posting = app.get(PostingService);
    close = app.get(YearEndCloseService);

    const entry = await posting.post(
      {
        date: new Date('2026-02-10'),
        description: 'Sale',
        sourceType: 'MANUAL',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: '1000000' },
          { accountId: acc['4-1000'], credit: '1000000' },
        ],
      },
      'p',
    );
    entryId = entry.id;
    await close.close(2026, 'admin');
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  it('rejects reversing an entry whose date lands in a closed fiscal year', async () => {
    await expect(posting.reverse(entryId, 'u')).rejects.toBeInstanceOf(
      ClosedYearError,
    );
  });

  it('after reopening the year, the same entry can be reversed', async () => {
    const rec = await close.reopen(2026, 'admin');
    expect(rec.status).toBe('OPEN');
    const reversal = await posting.reverse(entryId, 'u');
    expect(reversal.status).toBe('POSTED');
    expect(reversal.sourceType).toBe('REVERSAL');
  });
});
