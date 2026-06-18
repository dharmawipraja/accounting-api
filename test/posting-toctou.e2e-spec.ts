import { Test } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { CompanyService } from '../src/company/company.service';
import { YearEndCloseService } from '../src/close/year-end-close.service';
import {
  ClosedYearError,
  ValidationFailedError,
} from '../src/common/errors/domain-errors';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('PostingService TOCTOU guard (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let posting: PostingService;
  let kasId: string;
  let modalId: string;

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
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    await app.get(PeriodsService).generatePeriods(2027);
    posting = app.get(PostingService);
    const { data: accounts } = await app.get(AccountsService).list();
    kasId = accounts.find((a) => a.code === '1-1000')!.id;
    modalId = accounts.find((a) => a.code === '3-1000')!.id;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  const balanced = (date: Date) => ({
    date,
    description: 'toctou',
    sourceType: 'MANUAL' as const,
    lines: [
      { accountId: kasId, debit: '100.0000' },
      { accountId: modalId, credit: '100.0000' },
    ],
    createdBy: 'creator',
  });

  it('in-tx guard rejects a post into a CLOSED period (ValidationFailedError)', async () => {
    const periods = await app.get(PeriodsService).list(2026);
    const may = periods.find((p) => p.name === '2026-05')!;
    await app.get(PeriodsService).close(may.id, 'admin');
    await expect(
      prisma.client.$transaction((tx) =>
        posting.createPostedEntryInTx(
          tx,
          balanced(new Date('2026-05-15')),
          'p',
          may.id,
          2026,
        ),
      ),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('in-tx guard rejects a post into a CLOSED year (ClosedYearError)', async () => {
    // Close an empty 2027 (no activity → status CLOSED, no closing entry).
    await app.get(YearEndCloseService).close(2027, 'admin');
    const p2027 = (await app.get(PeriodsService).list(2027)).find(
      (p) => p.name === '2027-01',
    )!;
    await expect(
      prisma.client.$transaction((tx) =>
        posting.createPostedEntryInTx(
          tx,
          balanced(new Date('2027-01-15')),
          'p',
          p2027.id,
          2027,
        ),
      ),
    ).rejects.toBeInstanceOf(ClosedYearError);
  });
});
