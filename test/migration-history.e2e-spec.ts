import { execSync } from 'node:child_process';
import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { CompanyService } from '../src/company/company.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { SalesInvoicesService } from '../src/invoicing/sales-invoices.service';
import { PurchaseBillsService } from '../src/invoicing/purchase-bills.service';
import { PaymentsService } from '../src/invoicing/payments.service';
import { JournalService } from '../src/ledger/journal/journal.service';
import { YearEndCloseService } from '../src/close/year-end-close.service';
import { TestDb } from './testcontainers';
import { bootstrapTestApp } from './e2e-helpers';

/**
 * Review focus 4: the journal-link FK migration must apply to a database that
 * already carries real posted history (reversals, voided documents/payments,
 * a year closed → reopened → re-closed), not only to an empty schema.
 *
 * Every e2e container is migrated to head, so the migration under test is
 * rolled back first (its only effect is the three FKs: drop them + forget the
 * _prisma_migrations row), history is written through the app services, and
 * `prisma migrate deploy` then re-applies it on top of that history.
 */
const MIGRATION = '20260927000000_journal_link_fks';
const FKS = [
  ['year_end_closings', 'year_end_closings_closing_entry_id_fkey'],
  ['journal_entries', 'journal_entries_reversal_of_id_fkey'],
  ['journal_entries', 'journal_entries_reversed_by_id_fkey'],
] as const;

describe('Migration 20260927000000_journal_link_fks on a DB with posted history (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let db: TestDb;
  let cleanup: () => Promise<void>;

  const presentFks = async () =>
    (
      await prisma.client.$queryRaw<{ conname: string; del: string }[]>`
        SELECT conname, confdeltype::text AS del FROM pg_constraint
        WHERE contype = 'f' AND conname IN (
          'year_end_closings_closing_entry_id_fkey',
          'journal_entries_reversal_of_id_fkey',
          'journal_entries_reversed_by_id_fkey')
        ORDER BY conname`
    ).map((r) => `${r.conname}:${r.del}`);

  beforeAll(async () => {
    ({ app, prisma, db, cleanup } = await bootstrapTestApp({ pipe: false }));
  }, 120_000);

  afterAll(() => cleanup());

  it('applies cleanly after reversals, voids and close → reopen → re-close', async () => {
    // 1) Roll the migration back to "the migration before this one".
    for (const [table, fk] of FKS)
      await prisma.client.$executeRawUnsafe(
        `ALTER TABLE "${table}" DROP CONSTRAINT "${fk}"`,
      );
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM _prisma_migrations WHERE migration_name = '${MIGRATION}'`,
    );
    expect(await presentFks()).toEqual([]);

    // 2) Real history through the app.
    await app.get(CompanyService).seedIfEmpty();
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    await app.get(AccountsService).seedIfEmpty();
    await app.get(TaxCodesService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const { data: accounts } = await app.get(AccountsService).list();
    const acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    const partners = app.get(BusinessPartnersService);
    const customer = await partners.create({
      code: 'MIG-C',
      name: 'Migration customer',
      isCustomer: true,
    });
    const vendor = await partners.create({
      code: 'MIG-V',
      name: 'Migration vendor',
      isVendor: true,
    });

    // Manual entry + generic reversal.
    const je = await app.get(PostingService).post(
      {
        date: new Date('2026-03-02'),
        description: 'manual',
        sourceType: 'MANUAL',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: '5000000' },
          { accountId: acc['3-1000'], credit: '5000000' },
        ],
      },
      'p',
    );
    await app.get(JournalService).reverse(je.id, 'p', new Date('2026-03-05'));
    await app.get(PostingService).post(
      {
        date: new Date('2026-03-06'),
        description: 'manual kept',
        sourceType: 'MANUAL',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: '750000' },
          { accountId: acc['4-1000'], credit: '750000' },
        ],
      },
      'p',
    );

    // Invoice + payment, payment voided later, then the invoice voided.
    const invoices = app.get(SalesInvoicesService);
    const inv = await invoices.post(
      (
        await invoices.createDraft({
          partnerId: customer.id,
          date: new Date('2026-04-01'),
          description: 'inv',
          lines: [
            {
              description: 'Jasa',
              accountId: acc['4-1000'],
              quantity: '1',
              unitPrice: '1000000',
              taxCodeIds: [],
            },
          ],
          createdBy: 'a',
        })
      ).id,
      'p',
    );
    const payments = app.get(PaymentsService);
    const pay = await payments.post(
      (
        await payments.createDraft({
          direction: 'RECEIPT',
          partnerId: customer.id,
          date: new Date('2026-04-03'),
          cashAccountId: acc['1-1000'],
          allocations: [{ salesInvoiceId: inv.id, amount: '400000' }],
          createdBy: 'a',
        })
      ).id,
      'p',
    );
    await payments.void(pay.id, 'p', new Date('2026-04-10'));
    await invoices.void(inv.id, 'p', new Date('2026-04-12'));

    // A voided bill too.
    const bills = app.get(PurchaseBillsService);
    const bill = await bills.post(
      (
        await bills.createDraft({
          partnerId: vendor.id,
          date: new Date('2026-05-01'),
          description: 'bill',
          lines: [
            {
              description: 'Beban',
              accountId: acc['5-2000'],
              quantity: '1',
              unitPrice: '300000',
              taxCodeIds: [],
            },
          ],
          createdBy: 'a',
        })
      ).id,
      'p',
    );
    await bills.void(bill.id, 'p');

    // Year closed → reopened (closing entry reversed) → re-closed.
    const close = app.get(YearEndCloseService);
    const first = await close.close(2026, 'admin');
    await close.reopen(2026, 'admin');
    const second = await close.close(2026, 'admin');
    expect(first.closingEntryId).not.toBeNull();
    expect(second.closingEntryId).not.toBeNull();
    expect(second.closingEntryId).not.toBe(first.closingEntryId);

    const [links] = await prisma.client.$queryRaw<
      { reversals: number; reversed: number; closings: number }[]
    >`
      SELECT
        (SELECT count(*)::int FROM journal_entries WHERE reversal_of_id IS NOT NULL) AS reversals,
        (SELECT count(*)::int FROM journal_entries WHERE reversed_by_id IS NOT NULL) AS reversed,
        (SELECT count(*)::int FROM year_end_closings WHERE closing_entry_id IS NOT NULL) AS closings`;
    // Generic reversal + payment void + invoice void + bill void + reopen.
    expect(links).toEqual({ reversals: 5, reversed: 5, closings: 1 });

    // 3) Re-apply the migration on top of that history.
    const out = execSync('npx prisma migrate deploy', {
      env: { ...process.env, DATABASE_URL: db.url },
      encoding: 'utf8',
    });
    expect(out).toContain(MIGRATION);
    expect(out).toMatch(/successfully applied/i);
    expect(await presentFks()).toEqual([
      'journal_entries_reversal_of_id_fkey:r',
      'journal_entries_reversed_by_id_fkey:r',
      'year_end_closings_closing_entry_id_fkey:r',
    ]);

    // The app keeps working under the FKs: reopen reverses the new closing entry.
    const reopened = await close.reopen(2026, 'admin');
    expect(reopened.status).toBe('OPEN');
  }, 180_000);
});
