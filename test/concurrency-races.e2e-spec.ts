import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { CompanyService } from '../src/company/company.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { SalesInvoicesService } from '../src/invoicing/sales-invoices.service';
import { PaymentsService } from '../src/invoicing/payments.service';
import { JournalService } from '../src/ledger/journal/journal.service';
import { BalancesService } from '../src/ledger/balances/balances.service';
import { AgingService } from '../src/reporting/aging.service';
import {
  ConflictDomainError,
  NotFoundDomainError,
  ValidationFailedError,
} from '../src/common/errors/domain-errors';
import { Money } from '../src/common/money/money';
import { bootstrapTestApp } from './e2e-helpers';

/**
 * AUDIT3-11: real concurrency against Postgres for the remaining money races.
 * Each race is repeated on fresh rows; assertions are invariants, never timing:
 *  - a loser gets a clean domain error (422/409/404), never a 500;
 *  - reversal: exactly one reversal per original;
 *  - void vs payment: never both; AR aging == AR control afterwards;
 *  - concurrent document posting: gapless numbers 1..N.
 */
describe('Concurrency races (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let invoices: SalesInvoicesService;
  let payments: PaymentsService;
  let journal: JournalService;
  let acc: Record<string, string>;
  let arControlId: string;
  let customerId: string;

  const ITER = 10;

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp({ pipe: false }));
    await app.get(CompanyService).seedIfEmpty();
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    await app.get(AccountsService).seedIfEmpty();
    await app.get(TaxCodesService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    await app.get(PeriodsService).generatePeriods(2027);
    const { data: accounts } = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    arControlId = accounts.find((a) => a.role === 'AR_CONTROL')!.id;
    customerId = (
      await app.get(BusinessPartnersService).create({
        code: 'CUST-CONC',
        name: 'Concurrency customer',
        isCustomer: true,
      })
    ).id;
    invoices = app.get(SalesInvoicesService);
    payments = app.get(PaymentsService);
    journal = app.get(JournalService);
  }, 120_000);

  afterAll(() => cleanup());

  /** Settle a promise, failing the test on anything but a clean domain error
   *  (anything else would surface as a 500). */
  const settle = async <T>(
    p: Promise<T>,
  ): Promise<{ ok: true; v: T } | { ok: false; err: unknown }> => {
    try {
      return { ok: true, v: await p };
    } catch (err) {
      if (
        !(err instanceof ValidationFailedError) &&
        !(err instanceof ConflictDomainError) &&
        !(err instanceof NotFoundDomainError)
      )
        throw err;
      return { ok: false, err };
    }
  };

  const invoiceDraft = (date: string, unitPrice = '1000000') =>
    invoices.createDraft({
      partnerId: customerId,
      date: new Date(date),
      description: 'race invoice',
      lines: [
        {
          description: 'Jasa',
          accountId: acc['4-1000'],
          quantity: '1',
          unitPrice,
          taxCodeIds: [],
        },
      ],
      createdBy: 'creator',
    });

  it(`concurrent reversal of the same MANUAL entry: exactly one reversal (${ITER}x)`, async () => {
    const posting = app.get(PostingService);
    for (let i = 0; i < ITER; i++) {
      const je = await posting.post(
        {
          date: new Date('2026-04-10'),
          description: `reverse race ${i}`,
          sourceType: 'MANUAL',
          createdBy: 'creator',
          lines: [
            { accountId: acc['1-1000'], debit: '1000.0000' },
            { accountId: acc['3-1000'], credit: '1000.0000' },
          ],
        },
        'poster',
      );
      const results = await Promise.all([
        settle(journal.reverse(je.id, 'r1')),
        settle(journal.reverse(je.id, 'r2')),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const loser = results.find((r) => !r.ok) as { ok: false; err: unknown };
      // 422 "already reversed"/"only a POSTED entry" or a retryable 409.
      expect(
        loser.err instanceof ValidationFailedError ||
          loser.err instanceof ConflictDomainError,
      ).toBe(true);
      expect(
        await prisma.client.journalEntry.count({
          where: { reversalOfId: je.id },
        }),
      ).toBe(1);
      const orig = await prisma.client.journalEntry.findFirstOrThrow({
        where: { id: je.id },
      });
      expect(orig.status).toBe('REVERSED');
      const winner = results.find((r) => r.ok) as {
        ok: true;
        v: { id: string };
      };
      expect(orig.reversedById).toBe(winner.v.id);
    }
  }, 120_000);

  it(`invoice void vs payment post on the same invoice: never both; AR aging == AR control (${ITER}x)`, async () => {
    for (let i = 0; i < ITER; i++) {
      const draft = await invoiceDraft('2026-05-04');
      const inv = await invoices.post(draft.id, 'poster');
      const pay = await payments.createDraft({
        direction: 'RECEIPT',
        partnerId: customerId,
        date: new Date('2026-05-06'),
        cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: inv.id, amount: '400000' }],
        createdBy: 'creator',
      });
      // The void path is shorter than the payment post, so stagger the void
      // start across iterations to land on both sides of the race.
      const stagger = (i % 5) * 10;
      const [voidRes, postRes] = await Promise.all([
        settle(
          new Promise((r) => setTimeout(r, stagger)).then(() =>
            invoices.void(inv.id, 'voider', new Date('2026-05-08')),
          ),
        ),
        settle(payments.post(pay.id, 'poster')),
      ]);
      // Exactly one wins: a void after the payment is refused (payments
      // first), a payment after the void targets a VOID invoice.
      expect(voidRes.ok !== postRes.ok).toBe(true);
      const after = await invoices.getById(inv.id);
      expect(after.status).toBe(voidRes.ok ? 'VOID' : 'POSTED');
      expect(Money.of(after.amountPaid.toString()).toPersistence()).toBe(
        postRes.ok ? '400000.0000' : '0.0000',
      );
    }
    const aging = app.get(AgingService);
    const balances = app.get(BalancesService);
    for (const asOf of ['2026-05-05', '2026-05-07', '2026-05-31']) {
      const report = await aging.aging('AR', new Date(asOf));
      const control = await balances.accountBalance(
        arControlId,
        new Date(asOf),
      );
      expect({ asOf, total: report.totalOutstanding }).toEqual({
        asOf,
        total: Number(control.balance).toFixed(4),
      });
    }
  }, 180_000);

  it('concurrent posting of N invoice drafts: gapless invoice and entry numbers 1..N', async () => {
    const N = 10;
    // FY2027 is used only by this test, so its sequences start at 1.
    const drafts = await Promise.all(
      Array.from({ length: N }, () => invoiceDraft('2027-02-15', '50000')),
    );
    const results = await Promise.all(
      drafts.map((d) => settle(invoices.post(d.id, 'poster'))),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const posted = await prisma.client.salesInvoice.findMany({
      where: { fiscalYear: 2027, status: 'POSTED' },
      select: { invoiceNumber: true },
    });
    expect(posted.map((p) => p.invoiceNumber).sort((a, b) => a! - b!)).toEqual(
      Array.from({ length: N }, (_, k) => k + 1),
    );
    const entries = await prisma.client.journalEntry.findMany({
      where: { fiscalYear: 2027 },
      select: { entryNumber: true },
    });
    expect(entries.map((e) => e.entryNumber).sort((a, b) => a! - b!)).toEqual(
      Array.from({ length: N }, (_, k) => k + 1),
    );
  }, 120_000);
});
