import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { CompanyService } from '../src/company/company.service';
import { YearEndCloseService } from '../src/close/year-end-close.service';
import {
  ClosedPeriodError,
  ClosedYearError,
  ValidationFailedError,
} from '../src/common/errors/domain-errors';
import { bootstrapTestApp } from './e2e-helpers';

describe('PostingService TOCTOU guard (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let posting: PostingService;
  let kasId: string;
  let modalId: string;

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp({ pipe: false }));
    await app.get(CompanyService).seedIfEmpty();
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    await app.get(PeriodsService).generatePeriods(2027);
    await app.get(PeriodsService).generatePeriods(2029);
    await app.get(PeriodsService).generatePeriods(2030);
    await app.get(PeriodsService).generatePeriods(2031);
    posting = app.get(PostingService);
    const { data: accounts } = await app.get(AccountsService).list();
    kasId = accounts.find((a) => a.code === '1-1000')!.id;
    modalId = accounts.find((a) => a.code === '3-1000')!.id;
  }, 120_000);

  afterAll(() => cleanup());

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
    // TOCTOU: mint a token while jun is OPEN, then close jun before the tx runs —
    // the in-tx guard's FOR SHARE period re-check must reject (period no longer OPEN).
    const jun = periods.find((p) => p.name === '2026-06')!;
    const preparedOk = await posting.preparePosting(
      balanced(new Date('2026-06-15')),
      'p',
    );
    // Close the period AFTER preparing — simulates the TOCTOU race.
    // (may is already closed; close jun to test in-tx guard on a freshly-closed period)
    await app.get(PeriodsService).close(jun.id, 'admin');
    await expect(
      prisma.client.$transaction((tx) =>
        posting.createPostedEntryInTx(tx, preparedOk),
      ),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('in-tx guard rejects a post into a CLOSED year (ClosedYearError)', async () => {
    // TOCTOU: mint PreparedPosting while 2030 is open, then close the year so
    // the in-tx guard (assertPostablePeriodInTx) is the one that fires.
    const prepared = await posting.preparePosting(
      balanced(new Date('2030-03-15')),
      'p',
    );
    await app.get(YearEndCloseService).close(2030, 'admin');
    await expect(
      prisma.client.$transaction((tx) =>
        posting.createPostedEntryInTx(tx, prepared),
      ),
    ).rejects.toBeInstanceOf(ClosedYearError);
  });

  it('in-tx guard rejects reverseInTx into a CLOSED year (allowClosedYear=false)', async () => {
    // TOCTOU: post an entry in 2031, mint PreparedReversal (allowClosedYear=false, the
    // default) while the year is still open, then close the year so the in-tx guard fires.
    const entry = await posting.post(balanced(new Date('2031-03-15')), 'p');
    // prepareReversal with no opts — allowClosedYear defaults to false.
    const prepared = await posting.prepareReversal(entry.id, 'p', undefined);
    await app.get(YearEndCloseService).close(2031, 'admin');
    await expect(
      prisma.client.$transaction((tx) => posting.reverseInTx(tx, prepared)),
    ).rejects.toBeInstanceOf(ClosedYearError);
  });

  it('posting vs year-close serialize: post either commits-before or is rejected; never orphans', async () => {
    const close = app.get(YearEndCloseService);
    const [postRes] = await Promise.all([
      posting
        .post(balanced(new Date('2029-06-15')), 'p')
        .then((e) => ({ ok: true as const, e }))
        .catch((err: unknown) => ({ ok: false as const, err })),
      close.close(2029, 'admin').catch(() => null),
    ]);
    // Year ends CLOSED regardless of which operation won.
    expect((await close.getStatus(2029))?.status).toBe('CLOSED');
    // The post either committed (before close) or was rejected with ClosedYearError — never another error.
    if (!postRes.ok) expect(postRes.err).toBeInstanceOf(ClosedYearError);
    // No MANUAL POSTED entry orphaned into 2029 after close: exactly 1 if post won, 0 if close won.
    const manual = await prisma.client.journalEntry.count({
      where: { fiscalYear: 2029, status: 'POSTED', sourceType: 'MANUAL' },
    });
    expect(manual).toBe(postRes.ok ? 1 : 0);
    // A fresh post into the now-closed year is firmly rejected.
    await expect(
      posting.post(balanced(new Date('2029-06-16')), 'p'),
    ).rejects.toBeInstanceOf(ClosedYearError);
  });

  it('posting vs period-close serialize: post commits-before or is rejected', async () => {
    const periods = app.get(PeriodsService);
    const sep = (await periods.list(2026)).find((p) => p.name === '2026-09')!;
    const [postRes] = await Promise.all([
      posting
        .post(balanced(new Date('2026-09-15')), 'p')
        .then(() => ({ ok: true as const }))
        .catch((err: unknown) => ({ ok: false as const, err })),
      periods.close(sep.id, 'admin').catch(() => null),
    ]);
    // Period ends CLOSED regardless of which operation won.
    expect(
      (await periods.list(2026)).find((p) => p.name === '2026-09')!.status,
    ).toBe('CLOSED');
    // The post either committed or was rejected with ValidationFailedError (in-tx guard).
    if (!postRes.ok)
      expect((postRes as { err: unknown }).err).toBeInstanceOf(
        ValidationFailedError,
      );
    // A fresh post into the now-closed period is rejected by the pre-tx check (ClosedPeriodError).
    await expect(
      posting.post(balanced(new Date('2026-09-16')), 'p'),
    ).rejects.toBeInstanceOf(ClosedPeriodError);
  });
});
