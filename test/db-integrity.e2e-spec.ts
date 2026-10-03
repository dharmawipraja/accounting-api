import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { JournalService } from '../src/ledger/journal/journal.service';
import { statusFromException } from '../src/common/errors/exception-status';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { bootstrapTestApp } from './e2e-helpers';

/**
 * AUDIT3-9: database-level defense in depth. Every attempt here bypasses the
 * application (raw SQL straight at Postgres) and must be rejected by a DB
 * constraint/trigger. The last block proves the legitimate posting paths still
 * work with the triggers in place.
 */
describe('DB integrity — ledger invariants enforced by Postgres (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let acc: Record<string, string>;
  let posting: PostingService;
  let periodId: string;
  let partnerId: string;
  let invoiceId: string;
  let billId: string;
  let paymentId: string;

  const IMMUTABLE_ENTRY =
    /posted journal entry .* is immutable \(only the POSTED->REVERSED link-up is permitted\)/;
  const LINES_AFTER_POSTING =
    /posted journal entry .* is immutable \(lines cannot be added after posting\)/;

  type Tx = Prisma.TransactionClient;
  const inTx = (fn: (tx: Tx) => Promise<unknown>) =>
    prisma.$transaction(async (tx) => {
      await fn(tx);
    });
  const runSql = (sql: string) => prisma.client.$executeRawUnsafe(sql);

  const postEntry = (debitAcc = '1-1000', creditAcc = '4-1000') =>
    posting.post(
      {
        date: new Date('2026-02-10'),
        description: 'Sale',
        sourceType: 'MANUAL',
        createdBy: 'a',
        lines: [
          { accountId: acc[debitAcc], debit: '100000' },
          { accountId: acc[creditAcc], credit: '100000' },
        ],
      },
      'p',
    );

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp({ pipe: false }));
    await app.get(CompanyService).seedIfEmpty();
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const { data: accounts } = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    posting = app.get(PostingService);
    const [p] = await prisma.client.$queryRaw<{ id: string }[]>`
      SELECT id FROM accounting_periods WHERE name = '2026-02'`;
    periodId = p.id;
    const [bp] = await prisma.client.$queryRaw<{ id: string }[]>`
      INSERT INTO business_partners (id, code, name, is_customer, is_vendor, updated_at)
      VALUES (gen_random_uuid()::text, 'DBI-1', 'DB Integrity', true, true, now())
      RETURNING id`;
    partnerId = bp.id;
    const [inv] = await prisma.client.$queryRaw<{ id: string }[]>`
      INSERT INTO sales_invoices (id, partner_id, date, total, created_by, updated_at)
      VALUES (gen_random_uuid()::text, ${partnerId}, '2026-02-10', 100, 'a', now())
      RETURNING id`;
    invoiceId = inv.id;
    const [bill] = await prisma.client.$queryRaw<{ id: string }[]>`
      INSERT INTO purchase_bills (id, partner_id, date, total, created_by, updated_at)
      VALUES (gen_random_uuid()::text, ${partnerId}, '2026-02-10', 100, 'a', now())
      RETURNING id`;
    billId = bill.id;
    const [pay] = await prisma.client.$queryRaw<{ id: string }[]>`
      INSERT INTO payments (id, direction, partner_id, date, cash_account_id, amount, created_by, updated_at)
      VALUES (gen_random_uuid()::text, 'RECEIPT', ${partnerId}, '2026-02-10', ${acc['1-1100']}, 100, 'a', now())
      RETURNING id`;
    paymentId = pay.id;
  }, 120_000);

  afterAll(() => cleanup());

  describe('journal balance (deferred, checked at commit)', () => {
    it('rejects committing an unbalanced posted entry', async () => {
      await expect(
        inTx(async (tx) => {
          await tx.$executeRaw`
            INSERT INTO journal_entries (id, entry_number, entry_ref, fiscal_year, date, period_id,
              description, source_type, status, created_by, posted_by, posted_at, updated_at)
            VALUES ('dbi-unbal', 90001, 'JE/2026/090001', 2026, '2026-02-10', ${periodId},
              'unbalanced', 'MANUAL', 'POSTED', 'a', 'p', now(), now())`;
          await tx.$executeRaw`
            INSERT INTO journal_lines (id, journal_entry_id, line_no, account_id, debit, credit)
            VALUES (gen_random_uuid()::text, 'dbi-unbal', 1, ${acc['1-1000']}, 100, 0),
                   (gen_random_uuid()::text, 'dbi-unbal', 2, ${acc['4-1000']}, 0, 90)`;
        }),
      ).rejects.toThrow(/unbalanced|journal_entry_balanced/i);
    });

    it('a commit-time journal_entry_balanced failure via prisma.transaction maps to the generic 422 backstop', async () => {
      let caught: unknown;
      try {
        await prisma.transaction(async (tx) => {
          await tx.$executeRaw`
            INSERT INTO journal_entries (id, entry_number, entry_ref, fiscal_year, date, period_id,
              description, source_type, status, created_by, posted_by, posted_at, updated_at)
            VALUES ('dbi-unbal-422', 90009, 'JE/2026/090009', 2026, '2026-02-10', ${periodId},
              'unbalanced', 'MANUAL', 'POSTED', 'a', 'p', now(), now())`;
          await tx.$executeRaw`
            INSERT INTO journal_lines (id, journal_entry_id, line_no, account_id, debit, credit)
            VALUES (gen_random_uuid()::text, 'dbi-unbal-422', 1, ${acc['1-1000']}, 100, 0),
                   (gen_random_uuid()::text, 'dbi-unbal-422', 2, ${acc['4-1000']}, 0, 90)`;
        });
      } catch (err) {
        caught = err;
      }
      // At COMMIT Prisma 7 rethrows the pg adapter's bare DriverAdapterError
      // (originalCode 23514) — isConstraintViolation's bare-adapter arm.
      expect(caught).toBeDefined();
      expect(statusFromException(caught)).toBe(422);
      let status = 0;
      let body: unknown;
      const res = {
        status(c: number) {
          status = c;
          return this;
        },
        json(b: unknown) {
          body = b;
          return this;
        },
      };
      new AllExceptionsFilter().catch(caught, {
        switchToHttp: () => ({
          getResponse: () => res,
          getRequest: () => ({ url: '/test' }),
        }),
      } as never);
      expect(status).toBe(422);
      expect(body).toEqual({
        code: 'VALIDATION_FAILED',
        message: 'The request violates a data constraint',
      });
      const [{ n }] = await prisma.client.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM journal_entries WHERE id = 'dbi-unbal-422'`;
      expect(Number(n)).toBe(0);
    });

    it('rejects committing a posted entry with a single line / no lines', async () => {
      await expect(
        inTx(async (tx) => {
          await tx.$executeRaw`
            INSERT INTO journal_entries (id, entry_number, entry_ref, fiscal_year, date, period_id,
              description, source_type, status, created_by, posted_by, posted_at, updated_at)
            VALUES ('dbi-empty', 90002, 'JE/2026/090002', 2026, '2026-02-10', ${periodId},
              'no lines', 'MANUAL', 'POSTED', 'a', 'p', now(), now())`;
        }),
      ).rejects.toThrow(/at least 2 lines|journal_entry_balanced/i);
    });

    it('rejects posting (DRAFT→POSTED) an unbalanced draft directly', async () => {
      const draft = await app.get(JournalService).createDraft({
        date: new Date('2026-02-10'),
        description: 'unbalanced draft',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: '100' },
          { accountId: acc['4-1000'], credit: '100' },
        ],
      });
      await runSql(
        `UPDATE journal_lines SET credit = 50 WHERE journal_entry_id = '${draft.id}' AND line_no = 2`,
      ); // drafts are mutable
      await expect(
        runSql(
          `UPDATE journal_entries SET status = 'POSTED', posted_at = now(), posted_by = 'p',
             entry_number = 90003, entry_ref = 'JE/2026/090003', fiscal_year = 2026,
             period_id = '${periodId}' WHERE id = '${draft.id}'`,
        ),
      ).rejects.toThrow(/unbalanced|journal_entry_balanced/i);
    });
  });

  describe('posted-entry immutability', () => {
    it('rejects UPDATE of a posted line', async () => {
      const je = await postEntry();
      await expect(
        runSql(
          `UPDATE journal_lines SET debit = 1 WHERE journal_entry_id = '${je.id}' AND line_no = 1`,
        ),
      ).rejects.toThrow(/immutable/i);
    });

    it('rejects DELETE of a posted line', async () => {
      const je = await postEntry();
      await expect(
        runSql(`DELETE FROM journal_lines WHERE journal_entry_id = '${je.id}'`),
      ).rejects.toThrow(/immutable/i);
    });

    it.each([
      ['date', `date = '2026-02-11'`],
      ['description', `description = 'tampered'`],
      ['amount-bearing entry number', `entry_number = entry_number + 1000`],
      ['status back to DRAFT', `status = 'DRAFT'`],
      ['soft delete', `deleted_at = now(), deleted_by = 'x'`],
      ['updated_at only', `updated_at = now()`],
      ['no-op', `status = status`],
      ['posted_xid', `posted_xid = pg_current_xact_id()`],
      [
        'REVERSED without a reversal link',
        `status = 'REVERSED'`, // reversed_by_id stays NULL
      ],
    ])('rejects UPDATE of a posted entry (%s)', async (_label, set) => {
      const je = await postEntry();
      await expect(
        runSql(`UPDATE journal_entries SET ${set} WHERE id = '${je.id}'`),
      ).rejects.toThrow(IMMUTABLE_ENTRY);
    });

    describe('on an already-REVERSED entry', () => {
      let originalId: string;
      beforeAll(async () => {
        const je = await postEntry();
        await app.get(JournalService).reverse(je.id, 'p');
        originalId = je.id;
      });

      it.each([
        ['REVERSED→POSTED', `status = 'POSTED', reversed_by_id = NULL`],
        ['re-pointing reversed_by_id', `reversed_by_id = 'someone-else'`],
        ['updated_at only', `updated_at = now()`],
      ])('rejects %s', async (_label, set) => {
        await expect(
          runSql(
            `UPDATE journal_entries SET ${set} WHERE id = '${originalId}'`,
          ),
        ).rejects.toThrow(IMMUTABLE_ENTRY);
      });
    });

    it('rejects a no-op UPDATE used to re-own an old posted entry, then adding lines in the same tx', async () => {
      const je = await postEntry();
      await expect(
        inTx(async (tx) => {
          await tx.$executeRawUnsafe(
            `UPDATE journal_entries SET updated_at = now() WHERE id = '${je.id}'`,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO journal_lines (id, journal_entry_id, line_no, account_id, debit, credit)
             VALUES (gen_random_uuid()::text, '${je.id}', 3, '${acc['1-1000']}', 5, 0),
                    (gen_random_uuid()::text, '${je.id}', 4, '${acc['4-1000']}', 0, 5)`,
          );
        }),
      ).rejects.toThrow(IMMUTABLE_ENTRY);
      // …and without the UPDATE the INSERT alone is refused by the line guard.
      await expect(
        runSql(
          `INSERT INTO journal_lines (id, journal_entry_id, line_no, account_id, debit, credit)
           VALUES (gen_random_uuid()::text, '${je.id}', 3, '${acc['1-1000']}', 5, 0),
                  (gen_random_uuid()::text, '${je.id}', 4, '${acc['4-1000']}', 0, 5)`,
        ),
      ).rejects.toThrow(LINES_AFTER_POSTING);
    });

    it('a reversal tx cannot add lines to the ORIGINAL entry', async () => {
      const je = await postEntry();
      const [{ n }] = await prisma.client.$queryRaw<{ n: number }[]>`
        SELECT COALESCE(MAX(entry_number), 0)::int + 1 AS n FROM journal_entries WHERE fiscal_year = 2026`;
      await expect(
        inTx(async (tx) => {
          // A legitimate-looking reversal: posted reversal entry + the
          // original's POSTED→REVERSED link-up…
          await tx.$executeRawUnsafe(
            `INSERT INTO journal_entries (id, entry_number, entry_ref, fiscal_year, date, period_id,
               description, source_type, status, reversal_of_id, created_by, posted_by, posted_at, updated_at)
             VALUES ('dbi-rev-${n}', ${n}, 'JE/2026/X${n}', 2026, '2026-02-10', '${periodId}',
               'rev', 'REVERSAL', 'POSTED', '${je.id}', 'p', 'p', now(), now())`,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO journal_lines (id, journal_entry_id, line_no, account_id, debit, credit)
             VALUES (gen_random_uuid()::text, 'dbi-rev-${n}', 1, '${acc['4-1000']}', 100000, 0),
                    (gen_random_uuid()::text, 'dbi-rev-${n}', 2, '${acc['1-1000']}', 0, 100000)`,
          );
          await tx.$executeRawUnsafe(
            `UPDATE journal_entries SET status = 'REVERSED', reversed_by_id = 'dbi-rev-${n}', updated_at = now()
             WHERE id = '${je.id}'`,
          );
          // …then sneaking extra lines into the original.
          await tx.$executeRawUnsafe(
            `INSERT INTO journal_lines (id, journal_entry_id, line_no, account_id, debit, credit)
             VALUES (gen_random_uuid()::text, '${je.id}', 3, '${acc['1-1000']}', 5, 0),
                    (gen_random_uuid()::text, '${je.id}', 4, '${acc['4-1000']}', 0, 5)`,
          );
        }),
      ).rejects.toThrow(LINES_AFTER_POSTING);
    });

    it('posted_xid is stamped by the DB and cannot be pre-seeded on a draft', async () => {
      const draft = await app.get(JournalService).createDraft({
        date: new Date('2026-02-10'),
        description: 'xid probe',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: '1' },
          { accountId: acc['4-1000'], credit: '1' },
        ],
      });
      await runSql(
        `UPDATE journal_entries SET posted_xid = '12345'::xid8 WHERE id = '${draft.id}'`,
      );
      const [d] = await prisma.client.$queryRaw<{ x: string | null }[]>`
        SELECT posted_xid::text AS x FROM journal_entries WHERE id = ${draft.id}`;
      expect(d.x).toBeNull();
      await app.get(JournalService).postDraft(draft.id, 'p');
      const [p] = await prisma.client.$queryRaw<{ x: string | null }[]>`
        SELECT posted_xid::text AS x FROM journal_entries WHERE id = ${draft.id}`;
      expect(p.x).toMatch(/^[1-9][0-9]*$/);
    });

    it.each(['0', '12345'])(
      'a posted INSERT carrying posted_xid=%s is re-stamped with the current xid (and accepts its lines)',
      async (xid) => {
        const id = `dbi-xid-${xid}`;
        const num = 91000 + Number(xid.length);
        let same: boolean | undefined;
        await inTx(async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO journal_entries (id, entry_number, entry_ref, fiscal_year, date, period_id,
               description, source_type, status, created_by, posted_by, posted_at, updated_at, posted_xid)
             VALUES ('${id}', ${num}, 'JE/2026/0${num}', 2026, '2026-02-10', '${periodId}',
               'caller-supplied xid', 'MANUAL', 'POSTED', 'a', 'p', now(), now(), '${xid}'::xid8)`,
          );
          // Lines are accepted only if posted_xid = this tx's id.
          await tx.$executeRawUnsafe(
            `INSERT INTO journal_lines (id, journal_entry_id, line_no, account_id, debit, credit)
             VALUES (gen_random_uuid()::text, '${id}', 1, '${acc['1-1000']}', 7, 0),
                    (gen_random_uuid()::text, '${id}', 2, '${acc['4-1000']}', 0, 7)`,
          );
          const [r] = await tx.$queryRawUnsafe<{ same: boolean }[]>(
            `SELECT posted_xid = pg_current_xact_id() AS same FROM journal_entries WHERE id = '${id}'`,
          );
          same = r.same;
        });
        expect(same).toBe(true);
        const [after] = await prisma.client.$queryRaw<{ x: string }[]>`
          SELECT posted_xid::text AS x FROM journal_entries WHERE id = ${id}`;
        expect(after.x).not.toBe(xid);
      },
    );

    it('restore hardening snippet (backup-and-restore.md): posted_xid backfilled to 0 keeps the entry immutable', async () => {
      const je = await postEntry();
      // Exactly the documented post-restore statement, run as the owner.
      await inTx(async (tx) => {
        await tx.$executeRawUnsafe(
          `SET LOCAL session_replication_role = replica`,
        );
        await tx.$executeRawUnsafe(
          `UPDATE journal_entries SET posted_xid = '0'::xid8 WHERE posted_xid IS NOT NULL AND posted_xid <> '0'::xid8`,
        );
      });
      const [{ x }] = await prisma.client.$queryRaw<{ x: string }[]>`
        SELECT posted_xid::text AS x FROM journal_entries WHERE id = ${je.id}`;
      expect(x).toBe('0');
      await expect(
        runSql(
          `INSERT INTO journal_lines (id, journal_entry_id, line_no, account_id, debit, credit)
           VALUES (gen_random_uuid()::text, '${je.id}', 3, '${acc['1-1000']}', 5, 0),
                  (gen_random_uuid()::text, '${je.id}', 4, '${acc['4-1000']}', 0, 5)`,
        ),
      ).rejects.toThrow(LINES_AFTER_POSTING);
      await expect(
        runSql(
          `UPDATE journal_entries SET description = 'x' WHERE id = '${je.id}'`,
        ),
      ).rejects.toThrow(IMMUTABLE_ENTRY);
      // New posts are stamped normally afterwards.
      const fresh = await postEntry();
      const [{ y }] = await prisma.client.$queryRaw<{ y: string }[]>`
        SELECT posted_xid::text AS y FROM journal_entries WHERE id = ${fresh.id}`;
      expect(y).not.toBe('0');
    });

    it('rejects DELETE of a posted entry', async () => {
      const je = await postEntry();
      await expect(
        runSql(`DELETE FROM journal_entries WHERE id = '${je.id}'`),
      ).rejects.toThrow(
        /posted journal entry .* is immutable \(DELETE not permitted\)/,
      );
    });

    it('rejects INSERTing extra lines into an existing posted entry (later tx)', async () => {
      const je = await postEntry();
      await expect(
        runSql(
          `INSERT INTO journal_lines (id, journal_entry_id, line_no, account_id, debit, credit)
           VALUES (gen_random_uuid()::text, '${je.id}', 3, '${acc['1-1000']}', 5, 0),
                  (gen_random_uuid()::text, '${je.id}', 4, '${acc['4-1000']}', 0, 5)`,
        ),
      ).rejects.toThrow(LINES_AFTER_POSTING);
    });

    it('a line insert racing a DRAFT→POSTED promotion waits on the parent (FOR SHARE) and is rejected once it commits', async () => {
      const draft = await app.get(JournalService).createDraft({
        date: new Date('2026-02-10'),
        description: 'race: post vs line insert',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: '100' },
          { accountId: acc['4-1000'], credit: '100' },
        ],
      });
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let promoted!: () => void;
      const isPromoted = new Promise<void>((r) => (promoted = r));
      // Tx B: promote the draft (as postDraft does) and hold the tx open.
      const poster = prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `UPDATE journal_entries SET status = 'POSTED', posted_at = now(), posted_by = 'p',
               entry_number = 90777, entry_ref = 'JE/2026/090777', fiscal_year = 2026,
               period_id = '${periodId}' WHERE id = '${draft.id}'`,
          );
          promoted();
          await gate;
        },
        { timeout: 20_000 },
      );
      await isPromoted;
      // Tx A (autocommit, another connection): add a balanced pair of lines to
      // the entry B is posting. Without FOR SHARE it reads the pre-post
      // snapshot (still a draft) and slips in; with it, it waits for B.
      const inserter = runSql(
        `INSERT INTO journal_lines (id, journal_entry_id, line_no, account_id, debit, credit)
         VALUES (gen_random_uuid()::text, '${draft.id}', 3, '${acc['1-1000']}', 7, 0),
                (gen_random_uuid()::text, '${draft.id}', 4, '${acc['4-1000']}', 0, 7)`,
      ).then(
        () => ({ ok: true as const }),
        (err: unknown) => ({ ok: false as const, err }),
      );
      let settled = false;
      void inserter.then(() => (settled = true));
      for (let i = 0; i < 50 && !settled; i++) {
        const [{ n }] = await prisma.client.$queryRaw<{ n: number }[]>`
          SELECT COUNT(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE 'INSERT INTO journal_lines%'`;
        if (n > 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(settled).toBe(false); // A is blocked behind B, not already done
      release();
      await poster;
      const res = await inserter;
      expect(res.ok).toBe(false);
      expect(String((res as { err: unknown }).err)).toMatch(
        LINES_AFTER_POSTING,
      );
      expect(
        await prisma.client.journalLine.count({
          where: { journalEntryId: draft.id },
        }),
      ).toBe(2);
    });

    it.each([
      'journal_lines',
      'journal_entries',
      'sales_invoices',
      'sales_invoice_lines',
      'purchase_bills',
      'purchase_bill_lines',
      'payments',
      'payment_allocations',
      'sales_credit_notes',
      'sales_credit_note_lines',
      'purchase_debit_notes',
      'purchase_debit_note_lines',
    ])('rejects TRUNCATE %s', async (table) => {
      await expect(runSql(`TRUNCATE ${table} CASCADE`)).rejects.toThrow(
        /TRUNCATE is not permitted/i,
      );
    });

    it('still rejects TRUNCATE audit_log', async () => {
      await expect(runSql('TRUNCATE audit_log')).rejects.toThrow(
        /append-only/i,
      );
    });
  });

  describe('CHECK constraints', () => {
    it('rejects a posted journal entry with a NULL entry_number', async () => {
      await expect(
        inTx(async (tx) => {
          await tx.$executeRaw`
            INSERT INTO journal_entries (id, entry_number, fiscal_year, date, period_id,
              description, source_type, status, created_by, posted_by, posted_at, updated_at)
            VALUES ('dbi-nonum', NULL, 2026, '2026-02-10', ${periodId},
              'no number', 'MANUAL', 'POSTED', 'a', 'p', now(), now())`;
        }),
      ).rejects.toThrow(/journal_entries_posted_complete/);
    });

    it('rejects an overlapping accounting period', async () => {
      await expect(
        runSql(
          `INSERT INTO accounting_periods (id, fiscal_year, sequence, name, start_date, end_date, updated_at)
           VALUES (gen_random_uuid()::text, 2099, 1, 'overlap', '2026-02-15', '2026-03-15', now())`,
        ),
      ).rejects.toThrow(/accounting_periods_no_overlap/);
    });

    it('rejects a period whose start is after its end', async () => {
      await expect(
        runSql(
          `INSERT INTO accounting_periods (id, fiscal_year, sequence, name, start_date, end_date, updated_at)
           VALUES (gen_random_uuid()::text, 2098, 1, 'inverted', '2098-02-15', '2098-01-15', now())`,
        ),
      ).rejects.toThrow(/accounting_periods_dates_ordered/);
    });

    it('rejects an allocation with both targets', async () => {
      await expect(
        runSql(
          `INSERT INTO payment_allocations (id, payment_id, sales_invoice_id, purchase_bill_id, amount)
           VALUES (gen_random_uuid()::text, '${paymentId}', '${invoiceId}', '${billId}', 10)`,
        ),
      ).rejects.toThrow(/payment_allocations_one_target/);
    });

    it('rejects an allocation with no target', async () => {
      await expect(
        runSql(
          `INSERT INTO payment_allocations (id, payment_id, amount)
           VALUES (gen_random_uuid()::text, '${paymentId}', 10)`,
        ),
      ).rejects.toThrow(/payment_allocations_one_target/);
    });

    it('rejects amount_paid > total on an invoice and a bill', async () => {
      await expect(
        runSql(
          `UPDATE sales_invoices SET amount_paid = 101 WHERE id = '${invoiceId}'`,
        ),
      ).rejects.toThrow(/sales_invoices_amount_paid_range/);
      await expect(
        runSql(
          `UPDATE purchase_bills SET amount_paid = -1 WHERE id = '${billId}'`,
        ),
      ).rejects.toThrow(/purchase_bills_amount_paid_range/);
    });

    it('rejects a non-positive payment amount', async () => {
      await expect(
        runSql(`UPDATE payments SET amount = 0 WHERE id = '${paymentId}'`),
      ).rejects.toThrow(/payments_amount_positive/);
    });

    it('rejects a negative quantity / unit price on document lines', async () => {
      await expect(
        runSql(
          `INSERT INTO sales_invoice_lines (id, sales_invoice_id, line_no, description, account_id, quantity, unit_price, amount, tax_code_ids)
           VALUES (gen_random_uuid()::text, '${invoiceId}', 1, 'neg', '${acc['4-1000']}', -1, 10, -10, '{}')`,
        ),
      ).rejects.toThrow(/sales_invoice_lines_nonnegative/);
      await expect(
        runSql(
          `INSERT INTO purchase_bill_lines (id, purchase_bill_id, line_no, description, account_id, quantity, unit_price, amount, tax_code_ids)
           VALUES (gen_random_uuid()::text, '${billId}', 1, 'neg', '${acc['5-2000']}', 1, -10, -10, '{}')`,
        ),
      ).rejects.toThrow(/purchase_bill_lines_nonnegative/);
    });

    it('rejects a two-sided journal line (journal_lines_one_sided)', async () => {
      const draft = await app.get(JournalService).createDraft({
        date: new Date('2026-02-10'),
        description: 'one-sided check',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: '100' },
          { accountId: acc['4-1000'], credit: '100' },
        ],
      });
      await expect(
        runSql(
          `UPDATE journal_lines SET credit = 5 WHERE journal_entry_id = '${draft.id}' AND line_no = 1`,
        ),
      ).rejects.toThrow(/journal_lines_one_sided/);
    });
  });

  describe('documents: journal_entry_id set exactly when non-DRAFT (Task 16)', () => {
    const MIGRATION =
      '../prisma/migrations/20261002000000_document_journal_link_check_and_fk_indexes/migration.sql';

    it.each([
      ['sales_invoices', () => invoiceId],
      ['purchase_bills', () => billId],
      ['payments', () => paymentId],
    ])(
      '%s: rejects POSTED/VOID without a journal entry and a DRAFT carrying one',
      async (table, id) => {
        const constraint = new RegExp(`${table}_journal_entry_iff_not_draft`);
        await expect(
          runSql(`UPDATE ${table} SET status = 'POSTED' WHERE id = '${id()}'`),
        ).rejects.toThrow(constraint);
        await expect(
          runSql(
            `UPDATE ${table} SET status = 'VOID', voided_on = date WHERE id = '${id()}'`,
          ),
        ).rejects.toThrow(constraint);
        const entry = await postEntry();
        await expect(
          runSql(
            `UPDATE ${table} SET journal_entry_id = '${entry.id}' WHERE id = '${id()}'`,
          ),
        ).rejects.toThrow(constraint);
      },
    );

    it('migration pre-check aborts with a clear message when violating rows exist', async () => {
      const sql = readFileSync(join(__dirname, MIGRATION), 'utf8');
      const precheck = /DO \$\$[\s\S]*?END \$\$;/.exec(sql)![0];
      // Drop the constraint inside a rolled-back tx to manufacture a violator.
      await expect(
        inTx(async (tx) => {
          await tx.$executeRawUnsafe(
            'ALTER TABLE payments DROP CONSTRAINT payments_journal_entry_iff_not_draft',
          );
          await tx.$executeRawUnsafe(
            `UPDATE payments SET status = 'POSTED' WHERE id = '${paymentId}'`,
          );
          await tx.$executeRawUnsafe(precheck);
        }),
      ).rejects.toThrow(
        /document_journal_link_check migration aborted.*1 payments rows/,
      );
    });

    it('FK columns used by RESTRICT checks / joins are indexed', async () => {
      const rows = await prisma.client.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`;
      const names = rows.map((r) => r.indexname);
      expect(names).toEqual(
        expect.arrayContaining([
          'journal_entries_period_id_idx',
          'journal_entries_reversed_by_id_idx',
          'sales_invoices_journal_entry_id_idx',
          'purchase_bills_journal_entry_id_idx',
          'payments_journal_entry_id_idx',
          'year_end_closings_closing_entry_id_idx',
        ]),
      );
    });
  });

  describe('notes: voided_on set exactly when VOID', () => {
    const MIGRATION =
      '../prisma/migrations/20261011000000_note_voided_on_check/migration.sql';
    // A DRAFT note on the fixture invoice / bill, inserted inside the
    // (rolled-back) tx.
    const insertNote = (table: string, original: string, id: string) =>
      `INSERT INTO ${table} (id, partner_id, original_id, date, created_by, updated_at)
       SELECT '${id}', partner_id, id, date, 'a', now() FROM ${original}
       WHERE id = '${original === 'sales_invoices' ? invoiceId : billId}'`;

    it.each([
      ['sales_credit_notes', 'sales_invoices'],
      ['purchase_debit_notes', 'purchase_bills'],
    ])(
      '%s: rejects a non-VOID note carrying voided_on',
      async (table, orig) => {
        await expect(
          inTx(async (tx) => {
            await tx.$executeRawUnsafe(insertNote(table, orig, 'note-ck-1'));
            await tx.$executeRawUnsafe(
              `UPDATE ${table} SET voided_on = date WHERE id = 'note-ck-1'`,
            );
          }),
        ).rejects.toThrow(new RegExp(`${table}_voided_on_iff_void`));
      },
    );

    it('migration pre-check aborts with a clear message when violating rows exist', async () => {
      const sql = readFileSync(join(__dirname, MIGRATION), 'utf8');
      const precheck = /DO \$\$[\s\S]*?END \$\$;/.exec(sql)![0];
      await expect(
        inTx(async (tx) => {
          await tx.$executeRawUnsafe(
            'ALTER TABLE purchase_debit_notes DROP CONSTRAINT purchase_debit_notes_voided_on_iff_void',
          );
          await tx.$executeRawUnsafe(
            insertNote('purchase_debit_notes', 'purchase_bills', 'note-ck-2'),
          );
          await tx.$executeRawUnsafe(
            `UPDATE purchase_debit_notes SET voided_on = date WHERE id = 'note-ck-2'`,
          );
          await tx.$executeRawUnsafe(precheck);
        }),
      ).rejects.toThrow(
        /note voided_on check aborted[\s\S]*purchase_debit_notes id note-ck-2: status DRAFT/,
      );
    });
  });

  describe('foreign keys (ON DELETE RESTRICT)', () => {
    const ghost = '00000000-0000-0000-0000-000000000000';

    it.each([
      [
        'journal_lines.account_id',
        (ctx: { draftId: string }) =>
          `INSERT INTO journal_lines (id, journal_entry_id, line_no, account_id, debit, credit)
           VALUES (gen_random_uuid()::text, '${ctx.draftId}', 9, '${ghost}', 1, 0)`,
        /journal_lines_account_id_fkey/,
      ],
      [
        'journal_entries.period_id',
        (ctx: { draftId: string }) =>
          `UPDATE journal_entries SET period_id = '${ghost}' WHERE id = '${ctx.draftId}'`,
        /journal_entries_period_id_fkey/,
      ],
      [
        'sales_invoices.partner_id',
        () =>
          `UPDATE sales_invoices SET partner_id = '${ghost}' WHERE id = '${invoiceId}'`,
        /sales_invoices_partner_id_fkey/,
      ],
      [
        'sales_invoices.journal_entry_id',
        () =>
          // POSTED so the journal-link CHECK is satisfied and the FK is what fires.
          `UPDATE sales_invoices SET status = 'POSTED', journal_entry_id = '${ghost}' WHERE id = '${invoiceId}'`,
        /sales_invoices_journal_entry_id_fkey/,
      ],
      [
        'purchase_bills.partner_id',
        () =>
          `UPDATE purchase_bills SET partner_id = '${ghost}' WHERE id = '${billId}'`,
        /purchase_bills_partner_id_fkey/,
      ],
      [
        'payments.cash_account_id',
        () =>
          `UPDATE payments SET cash_account_id = '${ghost}' WHERE id = '${paymentId}'`,
        /payments_cash_account_id_fkey/,
      ],
      [
        'payments.partner_id',
        () =>
          `UPDATE payments SET partner_id = '${ghost}' WHERE id = '${paymentId}'`,
        /payments_partner_id_fkey/,
      ],
      [
        'payment_allocations.sales_invoice_id',
        () =>
          `INSERT INTO payment_allocations (id, payment_id, sales_invoice_id, amount)
           VALUES (gen_random_uuid()::text, '${paymentId}', '${ghost}', 1)`,
        /payment_allocations_sales_invoice_id_fkey/,
      ],
      [
        'sales_invoice_lines.account_id',
        () =>
          `INSERT INTO sales_invoice_lines (id, sales_invoice_id, line_no, description, account_id, quantity, unit_price, amount, tax_code_ids)
           VALUES (gen_random_uuid()::text, '${invoiceId}', 7, 'x', '${ghost}', 1, 1, 1, '{}')`,
        /sales_invoice_lines_account_id_fkey/,
      ],
      [
        'journal_entries.reversal_of_id',
        (ctx: { draftId: string }) =>
          `UPDATE journal_entries SET reversal_of_id = '${ghost}' WHERE id = '${ctx.draftId}'`,
        /journal_entries_reversal_of_id_fkey/,
      ],
      [
        'journal_entries.reversed_by_id',
        (ctx: { draftId: string }) =>
          `UPDATE journal_entries SET reversed_by_id = '${ghost}' WHERE id = '${ctx.draftId}'`,
        /journal_entries_reversed_by_id_fkey/,
      ],
      [
        'year_end_closings.closing_entry_id',
        () =>
          `INSERT INTO year_end_closings (fiscal_year, status, closing_entry_id, net_income, closed_at, closed_by, updated_at)
           VALUES (2097, 'CLOSED', '${ghost}', 0, now(), 'x', now())`,
        /year_end_closings_closing_entry_id_fkey/,
      ],
      [
        'tax_codes.tax_account_id',
        () =>
          `INSERT INTO tax_codes (id, code, name, kind, rate, tax_account_id, updated_at)
           VALUES (gen_random_uuid()::text, 'GHOST', 'g', 'PPN_OUTPUT', 0.11, '${ghost}', now())`,
        /tax_codes_tax_account_id_fkey/,
      ],
    ])('rejects an orphan %s', async (_label, sql, err) => {
      const draft = await app.get(JournalService).createDraft({
        date: new Date('2026-02-10'),
        description: 'fk probe',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: '1' },
          { accountId: acc['4-1000'], credit: '1' },
        ],
      });
      await expect(runSql(sql({ draftId: draft.id }))).rejects.toThrow(err);
    });

    it('rejects hard-deleting a journal entry a year-end closing points at', async () => {
      // Posted entries are undeletable by trigger already; a DRAFT is not, so
      // it isolates the RESTRICT of the closing link itself.
      const draft = await app.get(JournalService).createDraft({
        date: new Date('2026-02-10'),
        description: 'closing-link probe',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: '1' },
          { accountId: acc['4-1000'], credit: '1' },
        ],
      });
      await expect(
        inTx(async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO year_end_closings (fiscal_year, status, closing_entry_id, net_income, closed_at, closed_by, updated_at)
             VALUES (2095, 'CLOSED', '${draft.id}', 0, now(), 'x', now())`,
          );
          await tx.$executeRawUnsafe(
            `DELETE FROM journal_lines WHERE journal_entry_id = '${draft.id}'`,
          );
          await tx.$executeRawUnsafe(
            `DELETE FROM journal_entries WHERE id = '${draft.id}'`,
          );
        }),
      ).rejects.toThrow(/year_end_closings_closing_entry_id_fkey/);
    });

    it('link-FK migration pre-check aborts with a clear message when orphans exist', async () => {
      const sql = readFileSync(
        join(
          __dirname,
          '../prisma/migrations/20260927000000_journal_link_fks/migration.sql',
        ),
        'utf8',
      );
      const precheck = /DO \$\$[\s\S]*?END \$\$;/.exec(sql)![0];
      // Manufacture the orphans the FKs now forbid (replica mode skips FK
      // triggers; superuser-only, test DB), then run the migration's pre-check.
      // The tx rolls back, so nothing persists.
      await expect(
        inTx(async (tx) => {
          await tx.$executeRawUnsafe(
            'SET LOCAL session_replication_role = replica',
          );
          await tx.$executeRawUnsafe(
            // 21 rows: the reported count must be the true count, not the
            // 20-id display cap.
            `INSERT INTO year_end_closings (fiscal_year, status, closing_entry_id, net_income, closed_at, closed_by, updated_at)
             SELECT 2000 + g, 'CLOSED', '${ghost}', 0, now(), 'x', now() FROM generate_series(1, 21) g`,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO journal_entries (id, date, description, source_type, status, reversal_of_id, reversed_by_id, created_by, updated_at)
             VALUES ('dbi-orphan-link', '2026-02-10', 'orphan', 'MANUAL', 'DRAFT', '${ghost}', '${ghost}', 'a', now())`,
          );
          await tx.$executeRawUnsafe(precheck);
        }),
      ).rejects.toThrow(
        /journal_link_fks migration aborted.*21 year_end_closings\.closing_entry_id orphans.*1 journal_entries\.reversal_of_id orphans.*1 journal_entries\.reversed_by_id orphans/,
      );
    });

    it('rejects hard-deleting a referenced account or a journal entry with lines', async () => {
      const draft = await app.get(JournalService).createDraft({
        date: new Date('2026-02-10'),
        description: 'restrict probe',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: '1' },
          { accountId: acc['4-1000'], credit: '1' },
        ],
      });
      await expect(
        runSql(`DELETE FROM accounts WHERE id = '${acc['1-1000']}'`),
      ).rejects.toThrow(/foreign key/i);
      // Drafts are mutable, but lines no longer cascade away with the entry.
      await expect(
        runSql(`DELETE FROM journal_entries WHERE id = '${draft.id}'`),
      ).rejects.toThrow(/journal_lines_journal_entry_id_fkey/);
    });
  });

  describe('legitimate paths still work', () => {
    it('direct post, draft create → post, reversal, draft soft-delete', async () => {
      const je = await postEntry('1-1100', '4-1000');
      expect(je.status).toBe('POSTED');
      const journal = app.get(JournalService);
      const draft = await journal.createDraft({
        date: new Date('2026-02-12'),
        description: 'draft ok',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: '10' },
          { accountId: acc['4-1000'], credit: '10' },
        ],
      });
      const posted = await journal.postDraft(draft.id, 'p');
      expect(posted.status).toBe('POSTED');
      const rev = await journal.reverse(je.id, 'p');
      expect(rev.status).toBe('POSTED');
      const orig = await prisma.client.journalEntry.findFirst({
        where: { id: je.id },
      });
      expect(orig!.status).toBe('REVERSED');
      expect(orig!.reversedById).toBe(rev.id);
      const toDelete = await journal.createDraft({
        date: new Date('2026-02-12'),
        description: 'draft to delete',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: '10' },
          { accountId: acc['4-1000'], credit: '10' },
        ],
      });
      await journal.deleteDraft(toDelete.id, 'a');
    });
  });
});
