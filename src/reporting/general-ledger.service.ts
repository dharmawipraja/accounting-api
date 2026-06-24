import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';
import { AccountsService } from '../ledger/accounts/accounts.service';
import { BalancesService } from '../ledger/balances/balances.service';
import { signedNet } from '../ledger/balances/signing';
import { POSTED_JE } from '../ledger/balances/posted-entry.sql';
import { truncateToUtcDay } from '../common/dates/utc-day';

interface LineRow {
  date: Date;
  entry_ref: string | null;
  description: string | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
}

@Injectable()
export class GeneralLedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly balances: BalancesService,
  ) {}

  private day(d: Date): Date {
    return truncateToUtcDay(d);
  }

  async generate(accountId: string, from: Date, to: Date) {
    const account = await this.accounts.findById(accountId); // 404 if missing
    const dayBefore = new Date(this.day(from).getTime() - 86_400_000);
    const opening = await this.balances.accountBalance(accountId, dayBefore);
    let running = Money.of(opening.balance);

    const rows = await this.prisma.$queryRaw<LineRow[]>(Prisma.sql`
      SELECT je.date, je.entry_ref, jl.description, jl.debit, jl.credit
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.account_id = ${accountId} AND ${POSTED_JE}
        AND je.date >= ${this.day(from)} AND je.date <= ${this.day(to)}
      ORDER BY je.date ASC, je.entry_number ASC`);

    const lines = rows.map((r) => {
      const delta = signedNet(
        account.normalBalance,
        Money.of(r.debit.toString()),
        Money.of(r.credit.toString()),
      );
      running = running.add(delta);
      return {
        date: r.date.toISOString().slice(0, 10),
        entryRef: r.entry_ref,
        description: r.description,
        debit: Money.of(r.debit.toString()).toPersistence(),
        credit: Money.of(r.credit.toString()).toPersistence(),
        runningBalance: running.toPersistence(),
      };
    });

    return {
      account: {
        id: account.id,
        code: account.code,
        name: account.name,
        normalBalance: account.normalBalance,
      },
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      openingBalance: Money.of(opening.balance).toPersistence(),
      lines,
      closingBalance: running.toPersistence(),
    };
  }
}
