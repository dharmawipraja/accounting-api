import { Injectable } from '@nestjs/common';
import { YearEndClosing } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';
import {
  PostingService,
  POSTING_TX_OPTIONS,
} from '../ledger/posting/posting.service';
import type { LedgerTx } from '../common/prisma/prisma.service';
import { BalancesService } from '../ledger/balances/balances.service';
import { CompanyService } from '../company/company.service';
import { PostLineInput } from '../ledger/posting/posting.types';
import { asOfOrToday } from '../common/dates/query-dates';
import { yearNotEndedViolation } from './close-date-rule';
import {
  ConflictDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';

@Injectable()
export class YearEndCloseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: PostingService,
    private readonly balances: BalancesService,
    private readonly company: CompanyService,
  ) {}

  async getStatus(fiscalYear: number): Promise<YearEndClosing | null> {
    return this.prisma.client.yearEndClosing.findUnique({
      where: { fiscalYear },
    });
  }

  async close(fiscalYear: number, closedBy: string): Promise<YearEndClosing> {
    // Fast path only: a friendly early 409 without opening a tx. The
    // authoritative check is the re-read under the exclusive year lock below.
    const existing = await this.getStatus(fiscalYear);
    if (existing?.status === 'CLOSED') {
      throw new ConflictDomainError('Fiscal year is already closed', {
        fiscalYear,
      });
    }
    const { start: fyStart, end: yearEnd } =
      await this.company.fiscalYearBounds(fiscalYear);
    // A year still running (its end after today, WIB) cannot be closed.
    const notEnded = yearNotEndedViolation(fiscalYear, yearEnd, asOfOrToday());
    if (notEnded)
      throw new ValidationFailedError(
        'Fiscal year has not ended yet; it can be closed from its last day on',
        notEnded,
      );

    await this.prisma.transaction(
      async (tx) => {
        // FIRST take the exclusive per-fiscal-year lock and re-check status: it
        // serializes concurrent closes (no double-close / orphaned second entry)
        // AND waits out every in-flight post (they hold the SHARED lock), so the
        // P&L read below sees each committed post and no new post can land in
        // the year until this tx ends — nothing is left unclosed.
        const locked = await this.lockAndReadClosing(tx, fiscalYear);
        if (locked?.status === 'CLOSED') {
          throw new ConflictDomainError('Fiscal year is already closed', {
            fiscalYear,
          });
        }

        const { lines, netIncome } = await this.buildClosingLines(
          tx,
          fyStart,
          yearEnd,
        );
        const incomeStr = netIncome.toPersistence();

        // Empty year: no P&L movement — mark closed without an entry.
        let closingEntryId: string | null = null;
        if (lines.length > 0) {
          // preparePosting's validation reads (period, accounts) run on the base
          // client; its period/year status is re-asserted in-tx by the posting
          // guard. The guard's SHARED year lock is re-entrant for this session,
          // which already holds the EXCLUSIVE one.
          // Trade-off (accepted): those base-client reads borrow a SECOND pool
          // connection while this tx holds one. Close is a rare ADMIN-only
          // action, so the extra connection can't exhaust the pool in practice,
          // and they are plain reads that never wait on this tx's locks.
          const prepared = await this.posting.preparePosting(
            {
              date: yearEnd,
              description: `Year-end close FY${fiscalYear}`,
              sourceType: 'CLOSING' as const,
              createdBy: closedBy,
              lines,
            },
            closedBy,
          );
          closingEntryId = (
            await this.posting.createPostedEntryInTx(tx, prepared)
          ).id;
        }
        const closed = {
          status: 'CLOSED' as const,
          closingEntryId,
          netIncome: incomeStr,
          closedAt: new Date(),
          closedBy,
        };
        await tx.yearEndClosing.upsert({
          where: { fiscalYear },
          create: { fiscalYear, ...closed },
          update: { ...closed, reopenedAt: null, reopenedBy: null },
        });
      },
      // The lock wait + P&L aggregate run inside the tx: allow beyond the 5s
      // default, within the budget asserted by tx-timeout-budget.spec.
      POSTING_TX_OPTIONS,
    );
    return this.getStatus(fiscalYear) as Promise<YearEndClosing>;
  }

  /** Closing lines from THIS year's P&L movement only — not the cumulative
   *  balance — read on the locked tx. Using movementsBetween makes close
   *  order-independent: closing a later year before an earlier one no longer
   *  sweeps the earlier year's earnings twice into Laba Ditahan. Prior CLOSING
   *  entries and their reopen REVERSALs are excluded so a re-close sees the
   *  same business movement. Balanced by a Laba Ditahan line for net income. */
  private async buildClosingLines(
    tx: LedgerTx,
    fyStart: Date,
    yearEnd: Date,
  ): Promise<{ lines: PostLineInput[]; netIncome: Money }> {
    const rows = (
      await this.balances.movementsBetween(fyStart, yearEnd, {
        excludeClosing: true,
        tx,
      })
    ).filter((r) => r.type === 'REVENUE' || r.type === 'EXPENSE');
    const lines: PostLineInput[] = [];
    let netIncome = Money.zero(); // Σ(credit − debit)
    for (const r of rows) {
      const position = Money.of(r.debit).subtract(Money.of(r.credit)); // debit − credit
      if (position.isZero()) continue;
      netIncome = netIncome.subtract(position);
      lines.push(
        position.isNegative()
          ? {
              accountId: r.accountId,
              debit: position.multiply('-1').toPersistence(),
            }
          : { accountId: r.accountId, credit: position.toPersistence() },
      );
    }
    if (lines.length > 0 && !netIncome.isZero()) {
      const retained = await tx.account.findFirst({
        where: { role: 'RETAINED_EARNINGS' },
      });
      if (!retained) {
        throw new ValidationFailedError(
          'Laba Ditahan account missing from chart',
          { role: 'RETAINED_EARNINGS' },
        );
      }
      lines.push(
        netIncome.isNegative()
          ? {
              accountId: retained.id,
              debit: netIncome.multiply('-1').toPersistence(),
            }
          : { accountId: retained.id, credit: netIncome.toPersistence() },
      );
    }
    return { lines, netIncome };
  }

  /** Take the exclusive per-fiscal-year advisory lock (auto-released at tx end) and read the
   *  current closing row under it — the close/reopen serializer; the caller re-checks the
   *  returned status (and, on reopen, uses THIS closingEntryId, never a pre-lock read). EXCLUSIVE
   *  lock, deliberately distinct from posting's pg_advisory_xact_lock_shared
   *  (assertPostablePeriodInTx) — do not merge the two. */
  private async lockAndReadClosing(
    tx: LedgerTx,
    fiscalYear: number,
  ): Promise<{ status: string; closingEntryId: string | null } | null> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${fiscalYear})`;
    const rows = await tx.$queryRaw<
      { status: string; closing_entry_id: string | null }[]
    >`
      SELECT status, closing_entry_id FROM year_end_closings
      WHERE fiscal_year = ${fiscalYear}`;
    return rows.length > 0
      ? { status: rows[0].status, closingEntryId: rows[0].closing_entry_id }
      : null;
  }

  async reopen(
    fiscalYear: number,
    reopenedBy: string,
  ): Promise<YearEndClosing> {
    // Fast path only: a friendly early 422 without opening a tx.
    const rec = await this.getStatus(fiscalYear);
    if (!rec || rec.status !== 'CLOSED') {
      throw new ValidationFailedError('Fiscal year is not closed', {
        fiscalYear,
      });
    }
    await this.prisma.transaction(async (tx) => {
      // Serialize against concurrent reopen/close and re-read the closing row
      // under the lock: a reopen + re-close that committed after the pre-read
      // above replaced closingEntryId, so the reversal must target the id
      // read HERE (never double-reverse a stale entry or leave the current
      // one standing).
      const locked = await this.lockAndReadClosing(tx, fiscalYear);
      if (locked?.status !== 'CLOSED') {
        throw new ValidationFailedError('Fiscal year is not closed', {
          fiscalYear,
        });
      }
      if (locked.closingEntryId) {
        // Same accepted trade-off as close(): prepareReversal's plain reads
        // borrow a second pool connection; the closing entry is committed
        // and cannot change while we hold the exclusive year lock.
        const prepared = await this.posting.prepareReversal(
          locked.closingEntryId,
          reopenedBy,
          undefined,
          { allowClosedYear: true },
        );
        await this.posting.reverseInTx(tx, prepared);
      }
      await tx.yearEndClosing.update({
        where: { fiscalYear },
        data: { status: 'OPEN', reopenedAt: new Date(), reopenedBy },
      });
    }, POSTING_TX_OPTIONS);
    return this.getStatus(fiscalYear) as Promise<YearEndClosing>;
  }
}
