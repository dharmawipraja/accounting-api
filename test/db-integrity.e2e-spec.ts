import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { JournalService } from '../src/ledger/journal/journal.service';
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
    ])('rejects UPDATE of a posted entry (%s)', async (_label, set) => {
      const je = await postEntry();
      await expect(
        runSql(`UPDATE journal_entries SET ${set} WHERE id = '${je.id}'`),
      ).rejects.toThrow(/immutable|journal_entries_posted_complete/i);
    });

    it('rejects DELETE of a posted entry', async () => {
      const je = await postEntry();
      await expect(
        runSql(`DELETE FROM journal_entries WHERE id = '${je.id}'`),
      ).rejects.toThrow(/immutable/i);
    });

    it('rejects INSERTing extra lines into an existing posted entry (later tx)', async () => {
      const je = await postEntry();
      await expect(
        runSql(
          `INSERT INTO journal_lines (id, journal_entry_id, line_no, account_id, debit, credit)
           VALUES (gen_random_uuid()::text, '${je.id}', 3, '${acc['1-1000']}', 5, 0),
                  (gen_random_uuid()::text, '${je.id}', 4, '${acc['4-1000']}', 0, 5)`,
        ),
      ).rejects.toThrow(/immutable/i);
    });

    it.each([
      'journal_lines',
      'journal_entries',
      'sales_invoices',
      'purchase_bills',
      'payments',
      'payment_allocations',
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
          `UPDATE sales_invoices SET journal_entry_id = '${ghost}' WHERE id = '${invoiceId}'`,
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
