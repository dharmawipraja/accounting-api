import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { BalancesService } from '../src/ledger/balances/balances.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';

describe('Balances (e2e)', () => {
  let app: INestApplication;
  let cleanup: () => Promise<void>;
  let token: string;
  let kasId: string;
  let modalId: string;

  beforeAll(async () => {
    ({ app, cleanup } = await bootstrapTestApp());
    await app.get(CompanyService).seedIfEmpty();
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    await app.get(UsersService).create({
      email: 'v@x.com',
      password: 'secret123',
      name: 'V',
      role: 'VIEWER',
    });
    token = (await app.get(AuthService).login('v@x.com', 'secret123'))
      .accessToken;
    const { data: accounts } = await app.get(AccountsService).list();
    kasId = accounts.find((a) => a.code === '1-1000')!.id;
    modalId = accounts.find((a) => a.code === '3-1000')!.id;
    const posting = app.get(PostingService);
    for (let i = 0; i < 5; i++) {
      await posting.post(
        {
          date: new Date('2026-02-10'),
          description: 'cap',
          sourceType: 'MANUAL',
          createdBy: 'c',
          lines: [
            { accountId: kasId, debit: '100000' },
            { accountId: modalId, credit: '100000' },
          ],
        },
        'p',
      );
    }
  }, 120_000);

  afterAll(() => cleanup());

  it('trial balance always nets to zero', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/v1/ledger/trial-balance?asOf=2026-12-31')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const body = res.body as { totalDebit: string; totalCredit: string };
    expect(body.totalDebit).toBe('500000.0000');
    expect(body.totalCredit).toBe('500000.0000');
    expect(body.totalDebit).toBe(body.totalCredit);
  });

  it('reports a single account balance', async () => {
    const res = await request(app.getHttpServer() as App)
      .get(`/v1/ledger/accounts/${kasId}/balance?asOf=2026-12-31`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const body = res.body as { balance: string };
    expect(body.balance).toBe('500000.0000'); // Kas is DEBIT-normal
  });

  it('a reversed entry nets to zero in balances (posted_at filter includes REVERSED)', async () => {
    const posting = app.get(PostingService);
    const kasBalance = async (): Promise<string> => {
      const r = await request(app.getHttpServer() as App)
        .get(`/v1/ledger/accounts/${kasId}/balance?asOf=2026-12-31`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      return (r.body as { balance: string }).balance;
    };
    // Post an extra entry: Kas 500000 -> 600000.
    const entry = await posting.post(
      {
        date: new Date('2026-02-10'),
        description: 'extra',
        sourceType: 'MANUAL',
        createdBy: 'c',
        lines: [
          { accountId: kasId, debit: '100000' },
          { accountId: modalId, credit: '100000' },
        ],
      },
      'p',
    );
    expect(await kasBalance()).toBe('600000.0000');

    // Reverse it: the REVERSED original + its POSTED reversal both count -> back to 500000.
    await posting.reverse(entry.id, 'p');
    expect(await kasBalance()).toBe('500000.0000');

    // Trial balance still nets to zero.
    const tb = await request(app.getHttpServer() as App)
      .get('/v1/ledger/trial-balance?asOf=2026-12-31')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const body = tb.body as { totalDebit: string; totalCredit: string };
    expect(body.totalDebit).toBe(body.totalCredit);
  });

  it('balancesAsOf returns per-account rows with metadata (Kas debit-side)', async () => {
    const rows = await app
      .get(BalancesService)
      .balancesAsOf(new Date('2026-12-31'));
    const kas = rows.find((r) => r.code === '1-1000');
    expect(kas).toBeDefined();
    expect(kas!.type).toBe('ASSET');
    expect(Number(kas!.debit)).toBeGreaterThan(0);
    // every posted account present; totals tie (Σ debit == Σ credit)
    const td = rows.reduce((s, r) => s + Number(r.debit), 0);
    const tc = rows.reduce((s, r) => s + Number(r.credit), 0);
    expect(td).toBeCloseTo(tc, 4);
  });

  it('movementsBetween sums only entries dated in the range', async () => {
    const all = await app
      .get(BalancesService)
      .movementsBetween(new Date('2026-01-01'), new Date('2026-12-31'));
    const none = await app
      .get(BalancesService)
      .movementsBetween(new Date('2027-01-01'), new Date('2027-12-31'));
    expect(all.length).toBeGreaterThan(0);
    expect(none.length).toBe(0);
  });
});
