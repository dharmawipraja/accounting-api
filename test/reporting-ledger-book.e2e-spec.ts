import request from 'supertest';
import { type App } from 'supertest/types';
import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import {
  encodeGlCursor,
  GeneralLedgerService,
} from '../src/reporting/general-ledger.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { bootstrapTestApp } from './e2e-helpers';

type Book = Awaited<ReturnType<GeneralLedgerService['generateBook']>>;
type Section = Book['accounts'][number];

describe('Reporting general ledger book — multi-account (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let token: string;
  let gl: GeneralLedgerService;
  let acc: Record<string, string>;
  const from = new Date('2026-02-01');
  const to = new Date('2026-12-31');

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());
    await app.get(CompanyService).seedIfEmpty();
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    await app.get(UsersService).create({
      email: 'v@book.test',
      password: 'secret123',
      name: 'V',
      role: 'VIEWER',
    });
    token = (await app.get(AuthService).login('v@book.test', 'secret123'))
      .accessToken;
    const accounts = await app.get(AccountsService).listAll();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    gl = app.get(GeneralLedgerService);

    const posting = app.get(PostingService);
    const post = (
      date: string,
      sourceType: 'OPENING' | 'MANUAL',
      lines: { accountId: string; debit?: string; credit?: string }[],
    ) =>
      posting.post(
        {
          date: new Date(date),
          description: `${sourceType} ${date}`,
          sourceType,
          createdBy: 'a',
          lines,
        },
        'p',
      );
    // Before `from` (opening balances), then activity on Kas, Bank, revenue,
    // expense and capital inside the range.
    await post('2026-01-01', 'OPENING', [
      { accountId: acc['1-1000'], debit: '10000000' },
      { accountId: acc['1-1100'], debit: '5000000' },
      { accountId: acc['3-1000'], credit: '15000000' },
    ]);
    await post('2026-02-10', 'MANUAL', [
      { accountId: acc['1-1000'], debit: '2000000' },
      { accountId: acc['4-1000'], credit: '2000000' },
    ]);
    await post('2026-02-15', 'MANUAL', [
      { accountId: acc['5-2000'], debit: '500000' },
      { accountId: acc['1-1000'], credit: '500000' },
    ]);
    await post('2026-03-01', 'MANUAL', [
      { accountId: acc['1-1100'], debit: '700000' },
      { accountId: acc['1-1000'], credit: '700000' },
    ]);
    await post('2026-03-20', 'MANUAL', [
      { accountId: acc['1-1100'], debit: '300000' },
      { accountId: acc['4-1000'], credit: '300000' },
    ]);
  }, 120_000);

  afterAll(() => cleanup());

  const get = (url: string) =>
    request(app.getHttpServer() as App)
      .get(url)
      .set('Authorization', `Bearer ${token}`);

  const selected = () => [
    acc['5-2000'],
    acc['1-1000'],
    acc['4-1000'],
    acc['1-1100'],
    acc['3-1000'],
    acc['1-1200'], // no activity at all
  ];

  /** Merge a paged book back into one section per account. */
  function merge(pages: Book[]): Section[] {
    const out: Section[] = [];
    for (const p of pages)
      for (const s of p.accounts) {
        const prev = out[out.length - 1];
        if (prev && prev.account.id === s.account.id) {
          // A continuation opens at the previous page's last running balance.
          expect(s.openingBalance).toBe(
            prev.lines[prev.lines.length - 1].runningBalance,
          );
          prev.lines.push(...s.lines);
        } else out.push({ ...s, lines: [...s.lines] });
      }
    return out;
  }

  it('each section equals the single-account general ledger, in code order', async () => {
    const book = await gl.generateBook({ accountIds: selected() }, from, to);
    expect(book.truncated).toBe(false);
    expect(book.nextCursor).toBeNull();
    const codes = book.accounts.map((s) => s.account.code);
    expect(codes).toEqual([
      '1-1000',
      '1-1100',
      '1-1200',
      '3-1000',
      '4-1000',
      '5-2000',
    ]);
    for (const s of book.accounts) {
      const single = await gl.generate(s.account.id, from, to);
      expect(s).toEqual({
        account: single.account,
        openingBalance: single.openingBalance,
        lines: single.lines,
        closingBalance: single.closingBalance,
      });
    }
    const kas = book.accounts[0];
    expect(kas.openingBalance).toBe('10000000.0000');
    expect(kas.closingBalance).toBe('10800000.0000');
    expect(book.accounts[2].lines).toEqual([]);
    expect(book.accounts[2].closingBalance).toBe('0.0000');
  });

  it('pages across accounts with one line cap: continuous, no gaps or repeats, true closings', async () => {
    const full = await gl.generateBook({ accountIds: selected() }, from, to);
    const totalLines = full.accounts.reduce((n, s) => n + s.lines.length, 0);
    expect(totalLines).toBe(8);
    for (const size of [1, 2, 3, 4]) {
      const pages: Book[] = [];
      let cursor: string | undefined;
      do {
        const page = await gl.generateBook(
          { accountIds: selected() },
          from,
          to,
          size,
          cursor,
        );
        pages.push(page);
        cursor = page.nextCursor ?? undefined;
        expect(
          page.accounts.reduce((n, s) => n + s.lines.length, 0),
        ).toBeLessThanOrEqual(size);
      } while (cursor);
      expect(pages.length).toBe(Math.ceil(totalLines / size));
      expect(merge(pages)).toEqual(full.accounts);
    }
  });

  it('code range selects postable accounts only, ordered by code', async () => {
    const book = await gl.generateBook(
      { fromCode: '1-0000', toCode: '1-9999' },
      from,
      to,
    );
    const expected = await prisma.client.account.findMany({
      where: { code: { gte: '1-0000', lte: '1-9999' }, isPostable: true },
      orderBy: { code: 'asc' },
      select: { code: true },
    });
    expect(book.accounts.map((s) => s.account.code)).toEqual(
      expected.map((a) => a.code),
    );
    expect(book.accounts.map((s) => s.account.code)).not.toContain('1-0000');
    expect(book.accounts.length).toBeGreaterThan(2);
    // Only one bound: everything from 4-xxxx up.
    const upper = await gl.generateBook({ fromCode: '4-0000' }, from, to);
    expect(upper.accounts.every((s) => s.account.code >= '4-0000')).toBe(true);
    expect(upper.accounts.map((s) => s.account.code)).toContain('5-2000');
  });

  it('HTTP: accountIds list and code range, cursor round-trip', async () => {
    const ids = selected().join(',');
    const res = await get(
      `/v1/reports/general-ledger/book?accountIds=${ids}&from=2026-02-01&to=2026-12-31`,
    ).expect(200);
    const body = res.body as Book;
    expect(body.accounts).toHaveLength(6);
    expect(body.from).toBe('2026-02-01');

    const page1 = await gl.generateBook(
      { accountIds: selected() },
      from,
      to,
      2,
    );
    const res2 = await get(
      `/v1/reports/general-ledger/book?accountIds=${ids}&from=2026-02-01&to=2026-12-31&cursor=${page1.nextCursor}`,
    ).expect(200);
    const p2 = res2.body as Book;
    expect(p2.accounts[0].account.code).toBe('1-1000');
    expect(p2.accounts[0].openingBalance).toBe(
      page1.accounts[0].lines[1].runningBalance,
    );
    expect(p2.truncated).toBe(false);

    const range = await get(
      '/v1/reports/general-ledger/book?fromCode=4-0000&toCode=5-9999&from=2026-02-01&to=2026-12-31',
    ).expect(200);
    expect(
      (range.body as Book).accounts.every((s) => /^[45]-/.test(s.account.code)),
    ).toBe(true);
  });

  it('caps and validation: >200 ids, ids + range, unknown id, span, foreign/garbage cursors', async () => {
    const base = '/v1/reports/general-ledger/book';
    const tooMany = Array.from({ length: 201 }, () => randomUUID()).join(',');
    await get(
      `${base}?accountIds=${tooMany}&from=2026-02-01&to=2026-12-31`,
    ).expect(400); // DTO validation (ArrayMaxSize)
    await get(
      `${base}?accountIds=${acc['1-1000']}&fromCode=1&from=2026-02-01&to=2026-12-31`,
    ).expect(422);
    await get(
      `${base}?accountIds=not-a-uuid&from=2026-02-01&to=2026-12-31`,
    ).expect(400);
    await get(
      `${base}?accountIds=${randomUUID()}&from=2026-02-01&to=2026-12-31`,
    ).expect(404);
    await get(
      `${base}?accountIds=${acc['1-1000']}&from=2025-01-01&to=2026-12-31`,
    ).expect(422);
    await get(
      `${base}?accountIds=${acc['1-1000']}&from=2026-02-01&to=2026-12-31&cursor=garbage`,
    ).expect(422);
    // A single-account cursor is not a book cursor.
    const single = encodeGlCursor({
      date: '2026-02-10',
      entryNumber: 1,
      entryId: 'x',
      lineNo: 1,
    });
    await get(
      `${base}?accountIds=${acc['1-1000']}&from=2026-02-01&to=2026-12-31&cursor=${single}`,
    ).expect(422);
    // A cursor for an account outside the selection.
    const page1 = await gl.generateBook(
      { accountIds: selected() },
      from,
      to,
      1,
    );
    await get(
      `${base}?accountIds=${acc['4-1000']}&from=2026-02-01&to=2026-12-31&cursor=${page1.nextCursor}`,
    ).expect(422);
  });

  it('a code range selecting more than 200 accounts is a 422', async () => {
    await prisma.client.account.createMany({
      data: Array.from({ length: 201 }, (_, i) => ({
        code: `Z-${String(i).padStart(4, '0')}`,
        name: `Z ${i}`,
        type: 'ASSET' as const,
        subtype: 'CURRENT_ASSET' as const,
        normalBalance: 'DEBIT' as const,
      })),
    });
    await get(
      '/v1/reports/general-ledger/book?fromCode=Z&from=2026-02-01&to=2026-12-31',
    ).expect(422);
    await get(
      '/v1/reports/general-ledger/book?fromCode=Z&toCode=Z-0199&from=2026-02-01&to=2026-12-31',
    ).expect(200);
  });
});
