import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { LedgerTx } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';
import { AccountsService } from '../ledger/accounts/accounts.service';
import { BalancesService } from '../ledger/balances/balances.service';
import { signedNet } from '../ledger/balances/signing';
import { POSTED_JE } from '../ledger/balances/posted-entry.sql';
import { truncateToUtcDay } from '../common/dates/utc-day';
import { businessDate } from '../common/dates/business-date';
import { ValidationFailedError } from '../common/errors/domain-errors';

interface LineRow {
  date: Date;
  entry_id: string;
  entry_number: number;
  line_no: number;
  entry_ref: string | null;
  description: string | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
}

/** Hard per-request line cap — a busy account over a wide range must not be
 *  able to materialize an unbounded row set in a 768M container. */
export const GL_MAX_LINES = 10_000;
/** Widest accepted from→to span: one leap year plus a day. */
export const GL_MAX_RANGE_DAYS = 366;

/** Keyset position of one ledger line in the report's total order
 *  (date, entry_number, entry id, line_no). Posted entries always carry an
 *  entry_number; entry id breaks any theoretical (date, number) tie. */
export interface GlCursor {
  date: string; // YYYY-MM-DD
  entryNumber: number;
  entryId: string;
  lineNo: number;
}

/** Opaque continuation token: base64url JSON of a GlCursor. */
export function encodeGlCursor(c: GlCursor): string {
  return Buffer.from(
    JSON.stringify([c.date, c.entryNumber, c.entryId, c.lineNo]),
  ).toString('base64url');
}

export function decodeGlCursor(token: string): GlCursor {
  const bad = () =>
    new ValidationFailedError('Invalid general-ledger cursor', {
      cursor: token,
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) throw bad();
  const [date, entryNumber, entryId, lineNo] = parsed as unknown[];
  // int4 columns: an out-of-range value would be a Postgres error (500).
  const isInt4 = (v: unknown) =>
    Number.isInteger(v) && Math.abs(v as number) <= 2_147_483_647;
  if (
    typeof date !== 'string' ||
    !isInt4(entryNumber) ||
    typeof entryId !== 'string' ||
    entryId.length === 0 ||
    entryId.length > 64 ||
    !isInt4(lineNo)
  )
    throw bad();
  businessDate(date); // 422 unless a real YYYY-MM-DD day
  return {
    date,
    entryNumber: entryNumber as number,
    entryId,
    lineNo: lineNo as number,
  };
}

/** SQL row-value of a line's keyset position (aliases je / jl). */
const LINE_KEY = Prisma.sql`(je.date, je.entry_number, je.id, jl.line_no)`;
const cursorKey = (c: GlCursor) =>
  Prisma.sql`(${businessDate(c.date)}::date, ${c.entryNumber}::int, ${c.entryId}::text, ${c.lineNo}::int)`;

@Injectable()
export class GeneralLedgerService {
  constructor(
    private readonly accounts: AccountsService,
    private readonly balances: BalancesService,
  ) {}

  private day(d: Date): Date {
    return truncateToUtcDay(d);
  }

  /** The account's posted lines over [from, to] (after `cursor` when given),
   *  capped at maxLines + 1. */
  private lines(
    tx: LedgerTx,
    accountId: string,
    from: Date,
    to: Date,
    maxLines: number,
    cursor?: GlCursor,
  ): Promise<LineRow[]> {
    const after = cursor
      ? Prisma.sql`AND ${LINE_KEY} > ${cursorKey(cursor)}`
      : Prisma.empty;
    return tx.$queryRaw<LineRow[]>(Prisma.sql`
      SELECT je.date, je.id AS entry_id, je.entry_number, jl.line_no,
             je.entry_ref, jl.description, jl.debit, jl.credit
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.account_id = ${accountId} AND ${POSTED_JE}
        AND je.date >= ${this.day(from)} AND je.date <= ${this.day(to)}
        ${after}
      ORDER BY je.date ASC, je.entry_number ASC, je.id ASC, jl.line_no ASC
      LIMIT ${maxLines + 1}`);
  }

  /** Raw debit/credit sums of the account's posted lines at or before the
   *  cursor position — the running balance carried into the next page. */
  private async sumThroughCursor(
    tx: LedgerTx,
    accountId: string,
    cursor: GlCursor,
  ): Promise<{ debit: Prisma.Decimal; credit: Prisma.Decimal }> {
    const rows = await tx.$queryRaw<
      { debit: Prisma.Decimal; credit: Prisma.Decimal }[]
    >(Prisma.sql`
      SELECT COALESCE(SUM(jl.debit), 0) AS debit, COALESCE(SUM(jl.credit), 0) AS credit
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.account_id = ${accountId} AND ${POSTED_JE}
        AND ${LINE_KEY} <= ${cursorKey(cursor)}`);
    return rows[0];
  }

  async generate(
    accountId: string,
    from: Date,
    to: Date,
    maxLines = GL_MAX_LINES,
    cursorToken?: string,
  ) {
    const cursor =
      cursorToken === undefined ? undefined : decodeGlCursor(cursorToken);
    if (cursor) {
      const d = businessDate(cursor.date).getTime();
      if (d < this.day(from).getTime() || d > this.day(to).getTime())
        throw new ValidationFailedError(
          'cursor is outside the requested from/to range',
          { cursor: cursorToken },
        );
    }
    const account = await this.accounts.findById(accountId); // 404 if missing
    const dayBefore = new Date(this.day(from).getTime() - 86_400_000);
    // Opening, lines and closing read one snapshot (BalancesService.snapshot),
    // so opening + Σlines always ties to closing (when not truncated).
    // With a cursor, "opening" is the running balance through the cursor line
    // (everything before `from` plus the earlier pages), so page N+1 continues
    // exactly where page N's last runningBalance left off.
    const { opening, rows, closing } = await this.balances.snapshot(
      async (tx) => ({
        opening: cursor
          ? await this.sumThroughCursor(tx, accountId, cursor).then((r) => ({
              balance: signedNet(
                account.normalBalance,
                Money.of(r.debit.toString()),
                Money.of(r.credit.toString()),
              ).toPersistence(),
            }))
          : await this.balances.accountBalance(accountId, dayBefore, {
              tx,
            }),
        rows: await this.lines(tx, accountId, from, to, maxLines, cursor),
        // Closing comes from the balance aggregate, not the running sum, so
        // it stays the true as-of balance even when the list is truncated.
        closing: await this.balances.accountBalance(accountId, this.day(to), {
          tx,
        }),
      }),
    );
    let running = Money.of(opening.balance);

    const truncated = rows.length > maxLines;
    const included = truncated ? rows.slice(0, maxLines) : rows;

    const lines = included.map((r) => {
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
      truncated,
      nextCursor: truncated
        ? encodeGlCursor({
            date: included[included.length - 1].date.toISOString().slice(0, 10),
            entryNumber: included[included.length - 1].entry_number,
            entryId: included[included.length - 1].entry_id,
            lineNo: included[included.length - 1].line_no,
          })
        : null,
      closingBalance: Money.of(closing.balance).toPersistence(),
    };
  }
}
