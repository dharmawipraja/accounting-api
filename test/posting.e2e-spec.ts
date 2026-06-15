import { Test } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { CompanyService } from '../src/company/company.service';
import {
  UnbalancedEntryError,
  ClosedPeriodError,
} from '../src/common/errors/domain-errors';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('PostingService (e2e)', () => {
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
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    posting = app.get(PostingService);
    const accounts = await app.get(AccountsService).list();
    kasId = accounts.find((a) => a.code === '1-1000')!.id;
    modalId = accounts.find((a) => a.code === '3-1000')!.id;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  const balanced = (createdBy = 'u1') => ({
    date: new Date('2026-02-10'),
    description: 'Owner injects capital',
    sourceType: 'MANUAL' as const,
    createdBy,
    lines: [
      { accountId: kasId, debit: '1000000' },
      { accountId: modalId, credit: '1000000' },
    ],
  });

  it('posts a balanced entry and assigns a gapless number', async () => {
    const entry = await posting.post(balanced(), 'poster1');
    expect(entry.status).toBe('POSTED');
    expect(entry.entryNumber).toBe(1);
    expect(entry.entryRef).toBe('JE/2026/000001');
    const next = await posting.post(balanced(), 'poster1');
    expect(next.entryNumber).toBe(2);
  });

  it('rejects an unbalanced entry', async () => {
    await expect(
      posting.post(
        {
          ...balanced(),
          lines: [
            { accountId: kasId, debit: '5' },
            { accountId: modalId, credit: '4' },
          ],
        },
        'poster1',
      ),
    ).rejects.toBeInstanceOf(UnbalancedEntryError);
  });

  it('rejects posting into a date with no open period', async () => {
    await expect(
      posting.post({ ...balanced(), date: new Date('2030-01-01') }, 'poster1'),
    ).rejects.toBeInstanceOf(ClosedPeriodError);
  });

  it('enforces segregation of duties when enabled (poster = creator -> 403)', async () => {
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: true });
    await expect(posting.post(balanced('same'), 'same')).rejects.toMatchObject({
      code: 'SEGREGATION_OF_DUTIES',
    });
  });

  it('assigns gapless numbers under concurrency (no gaps, no dupes)', async () => {
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    const before = await prisma.client.journalEntry.count({
      where: { fiscalYear: 2026, status: { not: 'DRAFT' } },
    });
    const N = 12;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        posting.post(balanced(), 'p').catch(() => null),
      ),
    );
    const numbers = results.filter(Boolean).map((e) => e!.entryNumber!);
    expect(new Set(numbers).size).toBe(numbers.length); // no duplicates
    const sorted = [...numbers].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++)
      expect(sorted[i] - sorted[i - 1]).toBe(1); // contiguous
    const after = await prisma.client.journalEntry.count({
      where: { fiscalYear: 2026, status: { not: 'DRAFT' } },
    });
    expect(after - before).toBe(N);
  });

  it('reverses a posted entry; original -> REVERSED, reversal posted, swapped lines', async () => {
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    const entry = await posting.post(balanced(), 'p');
    const reversal = await posting.reverse(entry.id, 'p');
    expect(reversal.sourceType).toBe('REVERSAL');
    expect(reversal.reversalOfId).toBe(entry.id);
    const original = await prisma.client.journalEntry.findUnique({
      where: { id: entry.id },
    });
    expect(original?.status).toBe('REVERSED');
    expect(original?.reversedById).toBe(reversal.id);
    const lines = await prisma.client.journalLine.findMany({
      where: { journalEntryId: reversal.id },
      orderBy: { lineNo: 'asc' },
    });
    // original line 1 (Kas debit) -> reversal credit; line 2 (Modal credit) -> reversal debit
    expect(lines[0].credit.toString()).toBe('1000000');
    expect(lines[0].debit.toString()).toBe('0');
    expect(lines[1].debit.toString()).toBe('1000000');
    expect(lines[1].credit.toString()).toBe('0');
  });

  it('rejects reversing an already-reversed entry (422)', async () => {
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    const entry = await posting.post(balanced(), 'p');
    await posting.reverse(entry.id, 'p');
    await expect(posting.reverse(entry.id, 'p')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('consumes no number when posting fails (gapless under failure)', async () => {
    const seqBefore = await prisma.client.journalSequence.findUnique({
      where: { fiscalYear: 2026 },
    });
    await expect(
      posting.post(
        {
          ...balanced(),
          lines: [
            { accountId: kasId, debit: '5' },
            { accountId: modalId, credit: '4' },
          ],
        },
        'p',
      ),
    ).rejects.toBeInstanceOf(UnbalancedEntryError);
    const seqAfter = await prisma.client.journalSequence.findUnique({
      where: { fiscalYear: 2026 },
    });
    expect(seqAfter?.nextNumber).toBe(seqBefore?.nextNumber);
  });

  it('rejects posting into a CLOSED period', async () => {
    const periods = await app.get(PeriodsService).list(2026);
    const april = periods.find((p) => p.name === '2026-04')!;
    await app.get(PeriodsService).close(april.id, 'admin');
    await expect(
      posting.post({ ...balanced(), date: new Date('2026-04-15') }, 'p'),
    ).rejects.toBeInstanceOf(ClosedPeriodError);
  });

  it('rejects posting to a non-postable header account', async () => {
    const accounts = await app.get(AccountsService).list();
    const header = accounts.find((a) => a.code === '1-0000')!; // Aset header, isPostable=false
    await expect(
      posting.post(
        {
          ...balanced(),
          lines: [
            { accountId: header.id, debit: '1000000' },
            { accountId: modalId, credit: '1000000' },
          ],
        },
        'p',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ACCOUNT' });
  });

  it('reverses on a custom date and dates the reversal in that period', async () => {
    const entry = await posting.post(balanced(), 'p');
    const reversal = await posting.reverse(
      entry.id,
      'p',
      new Date('2026-03-15'),
    );
    expect(reversal.date.toISOString().slice(0, 10)).toBe('2026-03-15');
  });
});
