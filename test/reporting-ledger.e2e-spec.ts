import request from 'supertest';
import { type App } from 'supertest/types';
import { INestApplication } from '@nestjs/common';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { GeneralLedgerService } from '../src/reporting/general-ledger.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { bootstrapTestApp } from './e2e-helpers';

describe('Reporting general ledger (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let token: string;
  let acc: Record<string, string>;
  let kasId: string;

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());
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

  afterAll(() => cleanup());

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
      truncated: boolean;
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

    // All 3 lines fit under the cap
    expect(body.truncated).toBe(false);
  });

  it('caps lines at maxLines and keeps closingBalance correct when truncated', async () => {
    const gl = app.get(GeneralLedgerService);
    const report = await gl.generate(
      kasId,
      new Date('2026-01-01'),
      new Date('2026-12-31'),
      2,
    );
    expect(report.truncated).toBe(true);
    expect(report.lines).toHaveLength(2);
    // Closing must be the true as-of balance, not the partial running sum.
    expect(report.closingBalance).toBe('11500000.0000');
  });

  it('pages past the cap with nextCursor; running balances continue across pages', async () => {
    const gl = app.get(GeneralLedgerService);
    const from = new Date('2026-01-01');
    const to = new Date('2026-12-31');
    const full = await gl.generate(kasId, from, to);
    expect(full.nextCursor).toBeNull();

    const pages: Awaited<ReturnType<typeof gl.generate>>[] = [];
    let cursor: string | undefined;
    do {
      const page = await gl.generate(kasId, from, to, 1, cursor);
      pages.push(page);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    // Page size 1 over 3 lines → 2 truncated pages + a final page.
    expect(pages.map((p) => p.truncated)).toEqual([true, true, false]);
    // Concatenated pages == the unpaged report, line for line.
    expect(pages.flatMap((p) => p.lines)).toEqual(full.lines);
    // Page N+1 opens at page N's last running balance (computed server-side).
    for (let i = 1; i < pages.length; i++) {
      const prev = pages[i - 1].lines;
      expect(pages[i].openingBalance).toBe(
        prev[prev.length - 1].runningBalance,
      );
    }
    expect(pages[0].openingBalance).toBe(full.openingBalance);
    for (const p of pages) expect(p.closingBalance).toBe('11500000.0000');
  });

  it('the cursor round-trips over HTTP; malformed or out-of-range cursors are 422', async () => {
    const page1 = await app
      .get(GeneralLedgerService)
      .generate(kasId, new Date('2026-01-01'), new Date('2026-12-31'), 2);
    const res = await get(
      `/v1/reports/general-ledger?accountId=${kasId}&from=2026-01-01&to=2026-12-31&cursor=${page1.nextCursor}`,
    ).expect(200);
    const body = res.body as {
      openingBalance: string;
      lines: { runningBalance: string }[];
      nextCursor: string | null;
    };
    expect(body.openingBalance).toBe('12000000.0000');
    expect(body.lines.map((l) => l.runningBalance)).toEqual(['11500000.0000']);
    expect(body.nextCursor).toBeNull();

    await get(
      `/v1/reports/general-ledger?accountId=${kasId}&from=2026-01-01&to=2026-12-31&cursor=garbage`,
    ).expect(422);
    // Cursor positioned on 2026-02-10 but the range starts later → 422.
    await get(
      `/v1/reports/general-ledger?accountId=${kasId}&from=2026-03-01&to=2026-12-31&cursor=${page1.nextCursor}`,
    ).expect(422);
  });

  it('rejects a date span longer than 366 days with 422', async () => {
    await get(
      `/v1/reports/general-ledger?accountId=${kasId}&from=2016-01-01&to=2026-12-31`,
    ).expect(422);
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

  it('orders two lines of one entry on the same account by line_no', async () => {
    // Build a draft whose lines are stored physically out of order (line 2
    // inserted before line 1), then promote it through postDraft. Without the
    // jl.line_no tie-breaker the heap/index order would list L2 first.
    const bank = acc['1-1100'];
    const draft = await prisma.client.journalEntry.create({
      data: {
        date: new Date('2026-03-05'),
        description: 'same-account lines',
        sourceType: 'MANUAL',
        createdBy: 'a',
      },
    });
    const line = (
      lineNo: number,
      debit: string,
      credit: string,
      accountId = bank,
    ) =>
      prisma.client.journalLine.create({
        data: {
          journalEntryId: draft.id,
          lineNo,
          accountId,
          debit,
          credit,
          description: `L${lineNo}`,
        },
      });
    await line(2, '0', '100');
    await line(1, '300', '0');
    await line(3, '0', '200', acc['3-1000']);
    await app.get(PostingService).postDraft(draft.id, 'p');

    const res = await get(
      `/v1/reports/general-ledger?accountId=${bank}&from=2026-03-01&to=2026-03-31`,
    ).expect(200);
    const body = res.body as { lines: { description: string }[] };
    expect(body.lines.map((l) => l.description)).toEqual(['L1', 'L2']);
  });
});
