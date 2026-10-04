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
import {
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';

interface LineRow {
  account_id: string;
  date: Date;
  entry_id: string;
  entry_number: number;
  line_no: number;
  entry_ref: string | null;
  description: string | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
}

interface SumRow {
  account_id: string;
  open_debit: Prisma.Decimal;
  open_credit: Prisma.Decimal;
  close_debit: Prisma.Decimal;
  close_credit: Prisma.Decimal;
  cur_debit: Prisma.Decimal;
  cur_credit: Prisma.Decimal;
}

interface GlAccount {
  id: string;
  code: string;
  name: string;
  normalBalance: string;
}

/** Hard per-request line cap — a busy account over a wide range must not be
 *  able to materialize an unbounded row set in a 768M container. */
export const GL_MAX_LINES = 10_000;
/** Widest accepted from→to span: one leap year plus a day. */
export const GL_MAX_RANGE_DAYS = 366;
/** Most accounts one multi-account (book) request may select. */
export const GL_MAX_ACCOUNTS = 200;

/** Keyset position of one ledger line in the report's total order
 *  (date, entry_number, entry id, line_no). Posted entries always carry an
 *  entry_number; entry id breaks any theoretical (date, number) tie. */
interface GlCursor {
  date: string; // YYYY-MM-DD
  entryNumber: number;
  entryId: string;
  lineNo: number;
}

/** A multi-account (book) position: the line cursor inside one account. The
 *  book's total order is (account code, then the line order above). */
interface GlBookCursor {
  accountId: string;
  line: GlCursor;
}

const lineTuple = (c: GlCursor) => [c.date, c.entryNumber, c.entryId, c.lineNo];

/** Opaque continuation token: base64url JSON of a GlCursor. */
export function encodeGlCursor(c: GlCursor): string {
  return Buffer.from(JSON.stringify(lineTuple(c))).toString('base64url');
}

/** Book token: the same JSON array with the account id prepended. */
export function encodeGlBookCursor(c: GlBookCursor): string {
  return Buffer.from(
    JSON.stringify([c.accountId, ...lineTuple(c.line)]),
  ).toString('base64url');
}

const isId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 64;

function parseCursor(token: string, length: 4 | 5): unknown[] {
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
  if (!Array.isArray(parsed) || parsed.length !== length) throw bad();
  const t = parsed as unknown[];
  const [date, entryNumber, entryId, lineNo] = t.slice(length - 4);
  // int4 columns: an out-of-range value would be a Postgres error (500).
  const isInt4 = (v: unknown) =>
    Number.isInteger(v) && Math.abs(v as number) <= 2_147_483_647;
  if (
    typeof date !== 'string' ||
    !isInt4(entryNumber) ||
    !isId(entryId) ||
    !isInt4(lineNo) ||
    (length === 5 && !isId(t[0]))
  )
    throw bad();
  businessDate(date); // 422 unless a real YYYY-MM-DD day
  return t;
}

const toLine = (t: unknown[]): GlCursor => ({
  date: t[0] as string,
  entryNumber: t[1] as number,
  entryId: t[2] as string,
  lineNo: t[3] as number,
});

export function decodeGlCursor(token: string): GlCursor {
  return toLine(parseCursor(token, 4));
}

export function decodeGlBookCursor(token: string): GlBookCursor {
  const t = parseCursor(token, 5);
  return { accountId: t[0] as string, line: toLine(t.slice(1)) };
}

/** SQL row-value of a line's keyset position (aliases je / jl). */
const LINE_KEY = Prisma.sql`(je.date, je.entry_number, je.id, jl.line_no)`;
const cursorKey = (c: GlCursor) =>
  Prisma.sql`(${businessDate(c.date)}::date, ${c.entryNumber}::int, ${c.entryId}::text, ${c.lineNo}::int)`;

const money = (d: Prisma.Decimal) => Money.of(d.toString());

/** Which accounts a book request covers: explicit ids, or a code range of
 *  postable accounts (either bound optional). */
type GlSelection =
  | { accountIds: string[] }
  | { fromCode?: string; toCode?: string };

@Injectable()
export class GeneralLedgerService {
  constructor(
    private readonly accounts: AccountsService,
    private readonly balances: BalancesService,
  ) {}

  private day(d: Date): Date {
    return truncateToUtcDay(d);
  }

  private assertCursorInRange(
    line: GlCursor,
    from: Date,
    to: Date,
    token: string,
  ) {
    const d = businessDate(line.date).getTime();
    if (d < this.day(from).getTime() || d > this.day(to).getTime())
      throw new ValidationFailedError(
        'cursor is outside the requested from/to range',
        { cursor: token },
      );
  }

  /** One page of the ledger of `accounts` (ordered by code) over [from, to]:
   *  per-account sums in ONE grouped scan of each account's history up to
   *  `to` (opening before `from`, closing at `to`, and the running balance
   *  through the cursor line), plus the next maxLines + 1 lines in the book
   *  order. Sections span the cursor's account through the last included
   *  line's account (through the end when not truncated). */
  private async page(
    tx: LedgerTx,
    accounts: GlAccount[],
    from: Date,
    to: Date,
    maxLines: number,
    cursor?: GlBookCursor,
  ) {
    const ids = accounts.map((a) => a.id);
    const cursorCode = cursor
      ? accounts.find((a) => a.id === cursor.accountId)?.code
      : undefined;
    const throughCursor = cursor
      ? Prisma.sql`jl.account_id = ${cursor.accountId} AND ${LINE_KEY} <= ${cursorKey(cursor.line)}`
      : Prisma.sql`false`;
    const sums = await tx.$queryRaw<SumRow[]>(Prisma.sql`
      SELECT jl.account_id,
             COALESCE(SUM(jl.debit) FILTER (WHERE je.date < ${this.day(from)}), 0) AS open_debit,
             COALESCE(SUM(jl.credit) FILTER (WHERE je.date < ${this.day(from)}), 0) AS open_credit,
             COALESCE(SUM(jl.debit), 0) AS close_debit,
             COALESCE(SUM(jl.credit), 0) AS close_credit,
             COALESCE(SUM(jl.debit) FILTER (WHERE ${throughCursor}), 0) AS cur_debit,
             COALESCE(SUM(jl.credit) FILTER (WHERE ${throughCursor}), 0) AS cur_credit
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.account_id = ANY(${ids}::text[]) AND ${POSTED_JE}
        AND je.date <= ${this.day(to)}
      GROUP BY jl.account_id`);
    const after =
      cursor && cursorCode !== undefined
        ? Prisma.sql`AND (a.code > ${cursorCode} OR (jl.account_id = ${cursor.accountId} AND ${LINE_KEY} > ${cursorKey(cursor.line)}))`
        : Prisma.empty;
    const rows = await tx.$queryRaw<LineRow[]>(Prisma.sql`
      SELECT jl.account_id, je.date, je.id AS entry_id, je.entry_number, jl.line_no,
             je.entry_ref, jl.description, jl.debit, jl.credit
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      JOIN accounts a ON a.id = jl.account_id
      WHERE jl.account_id = ANY(${ids}::text[]) AND ${POSTED_JE}
        AND je.date >= ${this.day(from)} AND je.date <= ${this.day(to)}
        ${after}
      ORDER BY a.code ASC, je.date ASC, je.entry_number ASC, je.id ASC, jl.line_no ASC
      LIMIT ${maxLines + 1}`);

    const truncated = rows.length > maxLines;
    const included = truncated ? rows.slice(0, maxLines) : rows;
    const last = included[included.length - 1];
    const byId = new Map(sums.map((s) => [s.account_id, s]));
    const first = cursor
      ? accounts.findIndex((a) => a.id === cursor.accountId)
      : 0;
    const end = truncated
      ? accounts.findIndex((a) => a.id === last.account_id) + 1
      : accounts.length;

    const sections = accounts.slice(first, end).map((account) => {
      const s = byId.get(account.id);
      const net = (d?: Prisma.Decimal, c?: Prisma.Decimal) =>
        signedNet(
          account.normalBalance,
          money(d ?? new Prisma.Decimal(0)),
          money(c ?? new Prisma.Decimal(0)),
        );
      // With a cursor, the cursor account's "opening" is the running balance
      // through the cursor line, so page N+1 continues where page N left off.
      const opening =
        cursor && account.id === cursor.accountId
          ? net(s?.cur_debit, s?.cur_credit)
          : net(s?.open_debit, s?.open_credit);
      let running = opening;
      const lines = included
        .filter((r) => r.account_id === account.id)
        .map((r) => {
          running = running.add(net(r.debit, r.credit));
          return {
            date: r.date.toISOString().slice(0, 10),
            entryRef: r.entry_ref,
            description: r.description,
            debit: money(r.debit).toPersistence(),
            credit: money(r.credit).toPersistence(),
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
        openingBalance: opening.toPersistence(),
        lines,
        // From the sums, not the running total, so it stays the true as-of
        // balance at `to` even when the section is cut by the line cap.
        closingBalance: net(s?.close_debit, s?.close_credit).toPersistence(),
      };
    });
    const lastLine: GlCursor = last && {
      date: last.date.toISOString().slice(0, 10),
      entryNumber: last.entry_number,
      entryId: last.entry_id,
      lineNo: last.line_no,
    };
    return {
      sections,
      truncated,
      next: truncated ? { accountId: last.account_id, line: lastLine } : null,
    };
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
    if (cursor) this.assertCursorInRange(cursor, from, to, cursorToken!);
    const account = await this.accounts.findById(accountId); // 404 if missing
    // Sums and lines read one snapshot (BalancesService.snapshot), so
    // opening + Σlines always ties to closing (when not truncated).
    const page = await this.balances.snapshot((tx) =>
      this.page(
        tx,
        [account],
        from,
        to,
        maxLines,
        cursor && { accountId, line: cursor },
      ),
    );
    const s = page.sections[0];
    return {
      account: s.account,
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      openingBalance: s.openingBalance,
      lines: s.lines,
      truncated: page.truncated,
      nextCursor: page.next ? encodeGlCursor(page.next.line) : null,
      closingBalance: s.closingBalance,
    };
  }

  /** Buku Besar over several accounts: one section per selected account in
   *  code order, paged by one line cap across the whole book. */
  async generateBook(
    selection: GlSelection,
    from: Date,
    to: Date,
    maxLines = GL_MAX_LINES,
    cursorToken?: string,
  ) {
    const cursor =
      cursorToken === undefined ? undefined : decodeGlBookCursor(cursorToken);
    if (cursor) this.assertCursorInRange(cursor.line, from, to, cursorToken!);
    const page = await this.balances.snapshot(async (tx) => {
      const accounts = await this.select(tx, selection);
      if (cursor && !accounts.some((a) => a.id === cursor.accountId))
        throw new ValidationFailedError(
          'cursor does not belong to the selected accounts',
          { cursor: cursorToken },
        );
      return this.page(tx, accounts, from, to, maxLines, cursor);
    });
    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      // A cursor account with no lines left was completed on the previous
      // page — don't repeat it as an empty continuation.
      accounts: page.sections.filter(
        (s) =>
          !(cursor && s.account.id === cursor.accountId && !s.lines.length),
      ),
      truncated: page.truncated,
      nextCursor: page.next ? encodeGlBookCursor(page.next) : null,
    };
  }

  /** Live accounts of the selection, ordered by code; 404 for an unknown id,
   *  422 past GL_MAX_ACCOUNTS. */
  private async select(
    tx: LedgerTx,
    selection: GlSelection,
  ): Promise<GlAccount[]> {
    const fields = { id: true, code: true, name: true, normalBalance: true };
    if ('accountIds' in selection) {
      const ids = [...new Set(selection.accountIds)];
      const found = await tx.account.findMany({
        where: { id: { in: ids }, deletedAt: null },
        select: fields,
        orderBy: { code: 'asc' },
      });
      const missing = ids.filter((id) => !found.some((a) => a.id === id));
      if (missing.length)
        throw new NotFoundDomainError('Account not found', { ids: missing });
      return found;
    }
    const found = await tx.account.findMany({
      where: {
        deletedAt: null,
        isPostable: true,
        code: { gte: selection.fromCode, lte: selection.toCode },
      },
      select: fields,
      orderBy: { code: 'asc' },
      take: GL_MAX_ACCOUNTS + 1,
    });
    if (found.length > GL_MAX_ACCOUNTS)
      throw new ValidationFailedError(
        `The code range selects more than ${GL_MAX_ACCOUNTS} accounts; narrow fromCode/toCode`,
        { fromCode: selection.fromCode, toCode: selection.toCode },
      );
    return found;
  }
}
