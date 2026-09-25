import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { CompanyService } from '../src/company/company.service';
import { YearEndCloseService } from '../src/close/year-end-close.service';
import { BalancesService } from '../src/ledger/balances/balances.service';
import {
  ClosedPeriodError,
  ClosedYearError,
  ConflictDomainError,
  ValidationFailedError,
} from '../src/common/errors/domain-errors';
import { nextSequenceNumber } from '../src/common/db/sequence';
import { bootstrapTestApp } from './e2e-helpers';

describe('PostingService TOCTOU guard (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let posting: PostingService;
  let kasId: string;
  let modalId: string;
  let revenueId: string;

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
    await app.get(PeriodsService).generatePeriods(2032);
    await app.get(PeriodsService).generatePeriods(2033);
    posting = app.get(PostingService);
    const { data: accounts } = await app.get(AccountsService).list();
    kasId = accounts.find((a) => a.code === '1-1000')!.id;
    modalId = accounts.find((a) => a.code === '3-1000')!.id;
    revenueId = accounts.find((a) => a.code === '4-1000')!.id;
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

  it('in-tx guard rejects a post into a CLOSED period (ClosedPeriodError, 409 CLOSED_PERIOD like the pre-tx check)', async () => {
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
    ).rejects.toBeInstanceOf(ClosedPeriodError);
  });

  it('sequence updated_at is written in UTC even when the session time zone is not UTC', async () => {
    const [{ skew }] = await prisma.transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL TIME ZONE 'Asia/Jakarta'`;
      await nextSequenceNumber(tx, 'document_sequences', {
        document_type: 'TZ-PROBE',
        fiscal_year: 2026,
      });
      return tx.$queryRaw<{ skew: number }[]>`
        SELECT ABS(EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - updated_at)))::float8 AS skew
        FROM document_sequences
        WHERE document_type = 'TZ-PROBE' AND fiscal_year = 2026`;
    });
    // A local (UTC+7) wall-clock value would be 25,200 s off.
    expect(skew).toBeLessThan(60);
  });

  describe('in-tx account re-check (FOR SHARE)', () => {
    let n = 0;
    const freshAccount = async () =>
      app.get(AccountsService).create({
        code: `1-17${String(++n).padStart(2, '0')}`,
        name: `TOCTOU acct ${n}`,
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        normalBalance: 'DEBIT',
        parentCode: '1-0000',
      });
    const onAccount = (accountId: string) => ({
      ...balanced(new Date('2026-07-15')),
      lines: [
        { accountId, debit: '100.0000' },
        { accountId: modalId, credit: '100.0000' },
      ],
    });

    it('rejects an account deactivated after preparation (INVALID_ACCOUNT)', async () => {
      const a = await freshAccount();
      const prepared = await posting.preparePosting(onAccount(a.id), 'p');
      await app.get(AccountsService).deactivate(a.id);
      await expect(
        prisma.transaction((tx) => posting.createPostedEntryInTx(tx, prepared)),
      ).rejects.toMatchObject({ code: 'INVALID_ACCOUNT' });
    });

    it('rejects an account soft-deleted after preparation (INVALID_ACCOUNT)', async () => {
      const a = await freshAccount();
      const prepared = await posting.preparePosting(onAccount(a.id), 'p');
      await app.get(AccountsService).softDelete(a.id, 'admin');
      await expect(
        prisma.transaction((tx) => posting.createPostedEntryInTx(tx, prepared)),
      ).rejects.toMatchObject({ code: 'INVALID_ACCOUNT' });
      expect(
        await prisma.client.journalLine.count({ where: { accountId: a.id } }),
      ).toBe(0);
    });

    it('still posts when the accounts stay valid', async () => {
      const a = await freshAccount();
      const prepared = await posting.preparePosting(onAccount(a.id), 'p');
      const je = await prisma.transaction((tx) =>
        posting.createPostedEntryInTx(tx, prepared),
      );
      expect(je.status).toBe('POSTED');
    });
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
    // The post either committed or was rejected with ClosedPeriodError (in-tx guard).
    if (!postRes.ok)
      expect((postRes as { err: unknown }).err).toBeInstanceOf(
        ClosedPeriodError,
      );
    // A fresh post into the now-closed period is rejected by the pre-tx check (ClosedPeriodError).
    await expect(
      posting.post(balanced(new Date('2026-09-16')), 'p'),
    ).rejects.toBeInstanceOf(ClosedPeriodError);
  });

  /** Poll pg_locks until some session is WAITING on the advisory lock for
   *  `fiscalYear` (the close blocked behind an in-flight post), or fail after
   *  ~10s. pg_advisory_xact_lock(bigint) shows as classid = high 32 bits,
   *  objid = low 32 bits, objsubid = 1 — so an unrelated advisory waiter (e.g.
   *  the admin-pool or period-generation key) can't satisfy the wait. */
  const waitForAdvisoryWaiter = async (fiscalYear: number) => {
    for (let i = 0; i < 200; i++) {
      const rows = await prisma.client.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND classid = 0 AND objid = ${fiscalYear}::int::oid AND objsubid = 1`;
      if (rows[0].n > 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('close never blocked on the fiscal-year advisory lock');
  };

  const sale = (date: string, amount: string) => ({
    date: new Date(date),
    description: 'sale',
    sourceType: 'MANUAL' as const,
    lines: [
      { accountId: kasId, debit: amount },
      { accountId: revenueId, credit: amount },
    ],
    createdBy: 'creator',
  });

  it('year-end close computes P&L under the exclusive lock: a post committing while close waits is closed too', async () => {
    const close = app.get(YearEndCloseService);
    await posting.post(sale('2032-03-10', '1000'), 'p');
    // A post in flight: it holds the SHARED year lock with its entry inserted but
    // not yet committed when the close starts.
    const lateOk = await posting.preparePosting(sale('2032-06-10', '250'), 'p');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const insertedP = new Promise<void>((r) => (inserted = r));
    const postTx = prisma.client.$transaction(
      async (tx) => {
        const e = await posting.createPostedEntryInTx(tx, lateOk);
        inserted();
        await gate;
        return e;
      },
      { timeout: 20_000 },
    );
    await insertedP;
    const closeP = close.close(2032, 'admin');
    await waitForAdvisoryWaiter(2032);
    release();
    await postTx;
    const rec = await closeP;

    // The late entry was swept into the closing entry: revenue nets to 0 over FY
    // (closing included), and netIncome counts both sales.
    expect(rec.netIncome.toFixed(4)).toBe('1250.0000');
    const rows = await app
      .get(BalancesService)
      .movementsBetween(new Date('2032-01-01'), new Date('2032-12-31'));
    const rev = rows.find((r) => r.accountId === revenueId)!;
    expect(rev.balance).toBe('0.0000');
    const pl = rows.filter((r) => r.type === 'REVENUE' || r.type === 'EXPENSE');
    for (const r of pl) expect(r.balance).toBe('0.0000');
  }, 30_000);

  it('concurrent closes of an empty year: exactly one wins, the other is a Conflict', async () => {
    const close = app.get(YearEndCloseService);
    const results = await Promise.allSettled([
      close.close(2033, 'a'),
      close.close(2033, 'b'),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toBeInstanceOf(ConflictDomainError);
    expect(
      await prisma.client.yearEndClosing.count({
        where: { fiscalYear: 2033, status: 'CLOSED' },
      }),
    ).toBe(1);
  });

  it('concurrent reopens of an entry-less closed year: exactly one wins, the other is rejected', async () => {
    const close = app.get(YearEndCloseService);
    // Own fixture: an empty year closed here, independent of the test above.
    await app.get(PeriodsService).generatePeriods(2034);
    await close.close(2034, 'admin');
    expect((await close.getStatus(2034))?.status).toBe('CLOSED');
    const results = await Promise.allSettled([
      close.reopen(2034, 'a'),
      close.reopen(2034, 'b'),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toBeInstanceOf(ValidationFailedError);
    expect((await close.getStatus(2034))?.status).toBe('OPEN');
  });
});
