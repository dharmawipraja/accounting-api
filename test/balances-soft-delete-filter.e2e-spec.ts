import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { BalancesService } from '../src/ledger/balances/balances.service';
import { bootstrapTestApp } from './e2e-helpers';

describe('Balances — soft-delete filter (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let acc: Record<string, string>;
  let posting: PostingService;
  let balances: BalancesService;

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp({ pipe: false }));
    await app.get(CompanyService).seedIfEmpty();
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const { data: accounts } = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    posting = app.get(PostingService);
    balances = app.get(BalancesService);
  }, 120_000);

  afterAll(() => cleanup());

  it('excludes a soft-deleted POSTED journal entry from balances', async () => {
    const entry = await posting.post(
      {
        date: new Date('2026-02-10'),
        description: 'Sale',
        sourceType: 'MANUAL',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: '100000' },
          { accountId: acc['4-1000'], credit: '100000' },
        ],
      },
      'p',
    );
    const before = await balances.accountBalance(
      acc['4-1000'],
      new Date('2026-12-31'),
    );
    expect(before.credit).toBe('100000.0000');
    // Manufacture the otherwise-impossible state: soft-delete a POSTED entry.
    await prisma.client.journalEntry.update({
      where: { id: entry.id },
      data: { deletedAt: new Date() },
    });
    const after = await balances.accountBalance(
      acc['4-1000'],
      new Date('2026-12-31'),
    );
    expect(after.credit).toBe('0.0000');
  });
});
