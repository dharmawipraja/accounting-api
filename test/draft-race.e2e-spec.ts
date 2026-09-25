import { INestApplication } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { CompanyService } from '../src/company/company.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { SalesInvoicesService } from '../src/invoicing/sales-invoices.service';
import { PurchaseBillsService } from '../src/invoicing/purchase-bills.service';
import { TaxedDocumentService } from '../src/invoicing/taxed-document.service';
import { PaymentsService } from '../src/invoicing/payments.service';
import { JournalService } from '../src/ledger/journal/journal.service';
import { Money } from '../src/common/money/money';
import {
  ConflictDomainError,
  NotFoundDomainError,
  ValidationFailedError,
} from '../src/common/errors/domain-errors';
import { bootstrapTestApp } from './e2e-helpers';

/**
 * Draft edit/delete vs post races (audit #5). Every draft mutation must
 * serialize with posting on the header row lock, and posting must derive its
 * journal entry from the lines read AFTER that lock. Invariants (never timing):
 *  - a POSTED document's stored lines/totals equal its journal entry;
 *  - a document/entry is never both POSTED and soft-deleted;
 *  - losers get a clean domain error (422/409), never a 500.
 */
describe('Draft edit/delete vs post race (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let invoices: SalesInvoicesService;
  let bills: PurchaseBillsService;
  let payments: PaymentsService;
  let journal: JournalService;
  let acc: Record<string, string>;
  let arControlId: string;
  let code: Record<string, string>;
  let customerId: string;
  let vendorId: string;

  const ITER = 20;

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp({ pipe: false }));
    await app.get(CompanyService).seedIfEmpty();
    await app.get(AccountsService).seedIfEmpty();
    await app.get(TaxCodesService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const { data: accounts } = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    arControlId = accounts.find((a) => a.role === 'AR_CONTROL')!.id;
    const { data: codes } = await app.get(TaxCodesService).list();
    code = Object.fromEntries(codes.map((c) => [c.code, c.id]));
    const partners = app.get(BusinessPartnersService);
    customerId = (
      await partners.create({
        code: 'CUST-RACE',
        name: 'Race customer',
        isCustomer: true,
      })
    ).id;
    vendorId = (
      await partners.create({
        code: 'VEND-RACE',
        name: 'Race vendor',
        isVendor: true,
      })
    ).id;
    invoices = app.get(SalesInvoicesService);
    bills = app.get(PurchaseBillsService);
    payments = app.get(PaymentsService);
    journal = app.get(JournalService);
  }, 120_000);

  afterAll(() => cleanup());

  afterEach(() => jest.restoreAllMocks());

  const line = (unitPrice: string, description = 'Jasa') => ({
    description,
    accountId: acc['4-1000'],
    quantity: '1',
    unitPrice,
    taxCodeIds: [code['PPN-OUT-11']],
  });

  const newInvoiceDraft = () =>
    invoices.createDraft({
      partnerId: customerId,
      date: new Date('2026-03-10'),
      description: 'race',
      lines: [line('1000000')],
      createdBy: 'creator',
    });

  const editedLines = () => [line('2000000', 'A'), line('500000', 'B')];

  /** Settle a promise, failing the test on anything but a clean domain error.
   *  404 is clean too: a delete that commits before the post's first read
   *  leaves the post a NotFound. */
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

  /** A POSTED invoice's stored lines/totals must equal its journal entry. */
  async function assertInvoiceConsistent(id: string): Promise<string> {
    const inv = await invoices.getById(id);
    const lineSum = (inv.lines ?? []).reduce(
      (s, l) => s.add(Money.of(l.amount.toString())),
      Money.zero(),
    );
    expect(lineSum.toPersistence()).toBe(
      Money.of(inv.subtotal.toString()).toPersistence(),
    );
    if (inv.status !== 'POSTED') return inv.status;
    const je = await prisma.client.journalEntry.findUniqueOrThrow({
      where: { id: inv.journalEntryId! },
      include: { lines: true },
    });
    const ar = je.lines
      .filter((l) => l.accountId === arControlId)
      .reduce(
        (s, l) =>
          s
            .add(Money.of(l.debit.toString()))
            .subtract(Money.of(l.credit.toString())),
        Money.zero(),
      );
    // AR control delta == invoice total.
    expect(ar.toPersistence()).toBe(
      Money.of(inv.total.toString()).toPersistence(),
    );
    const revenue = je.lines
      .filter((l) => l.accountId === acc['4-1000'])
      .reduce(
        (s, l) =>
          s
            .add(Money.of(l.credit.toString()))
            .subtract(Money.of(l.debit.toString())),
        Money.zero(),
      );
    // Revenue credited == sum of the stored lines.
    expect(revenue.toPersistence()).toBe(lineSum.toPersistence());
    return inv.status;
  }

  /** Raw read (bypasses the soft-delete extension) of status + deleted_at. */
  async function rawState(
    table: 'sales_invoices' | 'purchase_bills' | 'payments' | 'journal_entries',
    id: string,
  ): Promise<{ status: string; deleted: boolean }> {
    const rows = await prisma.client.$queryRaw<
      { status: string; deleted_at: Date | null }[]
    >(
      Prisma.sql`SELECT status::text AS status, deleted_at FROM ${Prisma.raw(table)} WHERE id = ${id}`,
    );
    return { status: rows[0].status, deleted: rows[0].deleted_at !== null };
  }

  describe('deterministic interleavings', () => {
    it('an edit committing between the post pre-read and its row lock is what gets posted', async () => {
      const draft = await newInvoiceDraft();
      const posting = app.get(PostingService);
      const original = posting.preparePosting.bind(posting);
      let edited = false;
      jest
        .spyOn(posting, 'preparePosting')
        .mockImplementation(async (input, postedBy) => {
          if (!edited && input.sourceId === draft.id) {
            edited = true;
            // The post has already read the draft; an edit commits now.
            await invoices.update(draft.id, { lines: editedLines() });
          }
          return original(input, postedBy);
        });
      const res = await settle(invoices.post(draft.id, 'poster'));
      expect(edited).toBe(true);
      // The post restarts from the fresh read and posts the edited lines.
      expect(res.ok).toBe(true);
      expect(await assertInvoiceConsistent(draft.id)).toBe('POSTED');
      expect((await invoices.getById(draft.id)).lines).toHaveLength(2);
    });

    it('a draft edited before every post attempt ends in a clean 409, still a consistent DRAFT', async () => {
      const draft = await newInvoiceDraft();
      const posting = app.get(PostingService);
      const original = posting.preparePosting.bind(posting);
      let edits = 0;
      jest
        .spyOn(posting, 'preparePosting')
        .mockImplementation(async (input, postedBy) => {
          if (input.sourceId === draft.id) {
            edits++;
            await invoices.update(draft.id, {
              lines: [line(String(1000000 + edits))],
            });
          }
          return original(input, postedBy);
        });
      await expect(invoices.post(draft.id, 'poster')).rejects.toBeInstanceOf(
        ConflictDomainError,
      );
      expect(edits).toBe(3);
      expect(await assertInvoiceConsistent(draft.id)).toBe('DRAFT');
    });

    it('a post committing between the edit pre-read and its write rejects the edit', async () => {
      const draft = await newInvoiceDraft();
      const docs = app.get(TaxedDocumentService);
      const original = docs.getById.bind(docs);
      jest.spyOn(docs, 'getById').mockImplementationOnce(async (spec, id) => {
        const row = await original(spec, id);
        // The edit has read the DRAFT; a post commits before it writes.
        await invoices.post(draft.id, 'poster');
        return row;
      });
      const res = await settle(
        invoices.update(draft.id, { lines: editedLines() }),
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.err).toBeInstanceOf(ValidationFailedError);
        expect((res.err as Error).message).toBe(
          'Only a DRAFT invoice can be edited',
        );
      }
      expect(await assertInvoiceConsistent(draft.id)).toBe('POSTED');
    });
  });

  describe(`concurrent races (${ITER}x on fresh drafts)`, () => {
    it('invoice update vs post: POSTED lines/totals always match the JE', async () => {
      for (let i = 0; i < ITER; i++) {
        const draft = await newInvoiceDraft();
        const [upd, post] = await Promise.all([
          settle(invoices.update(draft.id, { lines: editedLines() })),
          settle(invoices.post(draft.id, 'poster')),
        ]);
        // Both can succeed (edit then post); never both fail.
        expect(upd.ok || post.ok).toBe(true);
        const status = await assertInvoiceConsistent(draft.id);
        if (post.ok) expect(status).toBe('POSTED');
        // An edit that lost the race is the clean onlyDraftEdit 422.
        if (!upd.ok)
          expect((upd.err as Error).message).toBe(
            'Only a DRAFT invoice can be edited',
          );
      }
    }, 120_000);

    it('bill delete vs post: never POSTED and deleted', async () => {
      for (let i = 0; i < ITER; i++) {
        const draft = await bills.createDraft({
          partnerId: vendorId,
          date: new Date('2026-03-11'),
          description: 'race bill',
          lines: [
            {
              description: 'Beban',
              accountId: acc['5-2000'],
              quantity: '1',
              unitPrice: '100000',
              taxCodeIds: [],
            },
          ],
          createdBy: 'creator',
        });
        const [del, post] = await Promise.all([
          settle(bills.deleteDraft(draft.id, 'deleter')),
          settle(bills.post(draft.id, 'poster')),
        ]);
        expect(del.ok !== post.ok).toBe(true);
        const s = await rawState('purchase_bills', draft.id);
        expect(s.status === 'POSTED' && s.deleted).toBe(false);
        expect(s.status === 'POSTED').toBe(post.ok);
        expect(s.deleted).toBe(del.ok);
      }
    }, 120_000);

    it('manual JE draft delete vs post: never POSTED and deleted', async () => {
      for (let i = 0; i < ITER; i++) {
        const draft = await journal.createDraft({
          date: new Date('2026-03-12'),
          description: 'race je',
          lines: [
            { accountId: acc['1-1000'], debit: '100.0000' },
            { accountId: acc['3-1000'], credit: '100.0000' },
          ],
          createdBy: 'creator',
        });
        const [del, post] = await Promise.all([
          settle(journal.deleteDraft(draft.id, 'deleter')),
          settle(journal.postDraft(draft.id, 'poster')),
        ]);
        expect(del.ok !== post.ok).toBe(true);
        const s = await rawState('journal_entries', draft.id);
        expect(s.status === 'POSTED' && s.deleted).toBe(false);
        expect(s.status === 'POSTED').toBe(post.ok);
      }
    }, 120_000);

    it('payment delete vs post: never POSTED and deleted', async () => {
      // One posted invoice with enough outstanding for every draft payment.
      const inv = await invoices.createDraft({
        partnerId: customerId,
        date: new Date('2026-03-01'),
        description: 'pay target',
        lines: [line('10000000')],
        createdBy: 'creator',
      });
      await invoices.post(inv.id, 'poster');
      for (let i = 0; i < ITER; i++) {
        const draft = await payments.createDraft({
          direction: 'RECEIPT',
          partnerId: customerId,
          date: new Date('2026-03-15'),
          cashAccountId: acc['1-1000'],
          allocations: [{ salesInvoiceId: inv.id, amount: '1000.0000' }],
          createdBy: 'creator',
        });
        const [del, post] = await Promise.all([
          settle(payments.deleteDraft(draft.id, 'deleter')),
          settle(payments.post(draft.id, 'poster')),
        ]);
        expect(del.ok !== post.ok).toBe(true);
        const s = await rawState('payments', draft.id);
        expect(s.status === 'POSTED' && s.deleted).toBe(false);
        expect(s.status === 'POSTED').toBe(post.ok);
      }
      // amount_paid equals the sum of POSTED payment allocations.
      const after = await invoices.getById(inv.id);
      const posted = await prisma.client.paymentAllocation.findMany({
        where: { salesInvoiceId: inv.id, payment: { status: 'POSTED' } },
      });
      const sum = posted.reduce(
        (s, a) => s.add(Money.of(a.amount.toString())),
        Money.zero(),
      );
      expect(Money.of(after.amountPaid.toString()).toPersistence()).toBe(
        sum.toPersistence(),
      );
    }, 120_000);
  });
});
