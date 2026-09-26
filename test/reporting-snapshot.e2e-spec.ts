import * as request from 'supertest';
import { type App } from 'supertest/types';
import { INestApplication } from '@nestjs/common';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { BalancesService } from '../src/ledger/balances/balances.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';

/**
 * AUDIT3 iteration 2: multi-query reports must read ONE snapshot. Each test
 * commits a posted entry on a separate connection BETWEEN the report's first
 * and later queries (via a spy on the first BalancesService call). Under the
 * old per-query READ COMMITTED reads the report came back internally
 * inconsistent; under the REPEATABLE READ snapshot it must equal the report
 * taken just before the concurrent commit.
 */
describe('Reporting snapshot consistency (e2e)', () => {
  let app: INestApplication;
  let cleanup: () => Promise<void>;
  let token: string;
  let acc: Record<string, string>;
  let posting: PostingService;
  let balances: BalancesService;

  beforeAll(async () => {
    ({ app, cleanup } = await bootstrapTestApp());
    await app.get(CompanyService).seedIfEmpty();
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    await app.get(UsersService).create({
      email: 'v@snap.test',
      password: 'secret123',
      name: 'V',
      role: 'VIEWER',
    });
    token = (await app.get(AuthService).login('v@snap.test', 'secret123'))
      .accessToken;
    const { data: accounts } = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    posting = app.get(PostingService);
    balances = app.get(BalancesService);

    await postCashSale('2026-01-05', '10000000');
  }, 120_000);

  afterEach(() => jest.restoreAllMocks());
  afterAll(() => cleanup());

  /** Dr Kas / Cr Pendapatan — committed on its own pooled connection. */
  function postCashSale(date: string, amount: string) {
    return posting.post(
      {
        date: new Date(date),
        description: `Concurrent cash sale ${date}`,
        sourceType: 'MANUAL',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: amount },
          { accountId: acc['4-1000'], credit: amount },
        ],
      },
      'p',
    );
  }

  /** After the FIRST call to `method` returns, commit a concurrent entry. */
  function commitAfterFirstCall(
    method: 'movementsBetween' | 'balancesAsOf' | 'accountBalance',
    commit: () => Promise<unknown>,
  ) {
    const original = balances[method].bind(balances) as (
      ...a: unknown[]
    ) => Promise<unknown>;
    let fired = false;
    jest.spyOn(balances, method).mockImplementation((async (
      ...args: unknown[]
    ) => {
      const result = await original(...args);
      if (!fired) {
        fired = true;
        await commit();
      }
      return result;
    }) as never);
    return () => fired;
  }

  const get = (url: string) =>
    request(app.getHttpServer() as App)
      .get(url)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .then((r) => r.body as Record<string, unknown>);

  it('cash flow: a post committed between its queries leaves it reconciled and equal to the pre-commit report', async () => {
    const url = '/v1/reports/cash-flow?from=2026-02-01&to=2026-02-28';
    const before = await get(url);
    expect(before.reconciles).toBe(true);

    // Commit after the kasAwal balance read: under per-query reads kasAkhir
    // would see the sale while the flow sections would not (reconciles:false).
    const fired = commitAfterFirstCall('balancesAsOf', () =>
      postCashSale('2026-02-10', '777000'),
    );
    const during = await get(url);
    expect(fired()).toBe(true);
    expect(during.reconciles).toBe(true);
    expect(during).toEqual(before);

    // The concurrent entry is visible to the next report.
    const after = await get(url);
    expect(after.reconciles).toBe(true);
    expect(after.kasAkhir).not.toBe(before.kasAkhir);
  });

  it('general ledger: opening + lines ties to closing when a back-dated post commits mid-report', async () => {
    const url = `/v1/reports/general-ledger?accountId=${acc['1-1000']}&from=2026-03-01&to=2026-03-31`;
    await postCashSale('2026-03-10', '50000');
    const before = await get(url);

    // Dated BEFORE `from`: moves closing but not opening/lines unless the
    // report reads one snapshot.
    const fired = commitAfterFirstCall('accountBalance', () =>
      postCashSale('2026-02-20', '123000'),
    );
    const during = await get(url);
    expect(fired()).toBe(true);
    expect(during).toEqual(before);
    const lines = during.lines as { runningBalance: string }[];
    expect(lines[lines.length - 1].runningBalance).toBe(during.closingBalance);
  });

  it('balance sheet: current-year earnings come from the same snapshot as the balances', async () => {
    const url = '/v1/reports/balance-sheet?asOf=2026-04-30';
    const before = await get(url);
    expect(before.balanced).toBe(true);

    const fired = commitAfterFirstCall('balancesAsOf', () =>
      postCashSale('2026-04-15', '888000'),
    );
    const during = await get(url);
    expect(fired()).toBe(true);
    expect(during).toEqual(before);
  });
});
