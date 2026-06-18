import { PrismaService } from '../common/prisma/prisma.service';
import { PostingService } from '../ledger/posting/posting.service';
import { TaxService } from '../tax/tax.service';
import { DocumentPostingService } from './document-posting.service';

describe('DocumentPostingService (orchestration)', () => {
  function build() {
    const tx = { __tx: true };
    const calc = {
      journalLines: [
        { accountId: 'ar', debit: '1000.0000' },
        { accountId: 'rev', credit: '1000.0000' },
      ],
      taxes: [],
      subtotal: '1000.0000',
      settlementAmount: '1000.0000',
    };
    const entry = { id: 'je1' };
    const tax = { calculate: jest.fn().mockResolvedValue(calc) };
    const posting = {
      preparePosting: jest
        .fn()
        .mockResolvedValue({ periodId: 'p1', fiscalYear: 2026 }),
      createPostedEntryInTx: jest.fn().mockResolvedValue(entry),
    };
    const docNumber = {
      next: jest.fn().mockResolvedValue(42),
      buildRef: jest.fn().mockReturnValue('INV/2026/000042'),
    };
    const prisma = {
      client: {
        $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
      },
    };
    const svc = new DocumentPostingService(
      prisma as unknown as PrismaService,
      posting as unknown as PostingService,
      tax as unknown as TaxService,
      // docNumber mock satisfies DocumentNumberService structurally — no cast needed
      docNumber,
    );
    return { svc, tx, entry, tax, posting, docNumber, prisma };
  }

  const params = {
    nature: 'SALE' as const,
    settlementAccountId: 'ar',
    date: new Date('2026-03-15'),
    description: 'INV-1',
    sourceType: 'SALES_INVOICE' as const,
    sourceId: 's1',
    createdBy: 'u1',
    postedBy: 'u2',
    documentType: 'INV',
    lines: [],
  };

  it('prepares before the transaction, locks before numbering, threads period/fy, and finalizes', async () => {
    const { svc, tx, entry, tax, posting, docNumber, prisma } = build();
    const lockDraft = jest.fn().mockResolvedValue(undefined);
    const finalize = jest.fn().mockResolvedValue(undefined);

    await svc.post(params, lockDraft, finalize);

    // tax + prepare run OUTSIDE the tx, before it opens
    expect(tax.calculate).toHaveBeenCalledTimes(1);
    expect(posting.preparePosting).toHaveBeenCalledTimes(1);
    expect(posting.preparePosting.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.client.$transaction.mock.invocationCallOrder[0],
    );
    // lock-before-number is the gapless invariant
    expect(lockDraft.mock.invocationCallOrder[0]).toBeLessThan(
      docNumber.next.mock.invocationCallOrder[0],
    );
    // period/fiscalYear from preparePosting are threaded into the posted-entry write
    expect(posting.createPostedEntryInTx).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ sourceType: 'SALES_INVOICE', sourceId: 's1' }),
      'u2',
      'p1',
      2026,
    );
    // finalize receives the assigned number/ref/entry + computed totals
    const expectedTotals: Record<string, string> = {
      subtotal: '1000.0000',
      total: '1000.0000',
    };
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        tx,
        number: 42,
        ref: 'INV/2026/000042',
        entry,
        fiscalYear: 2026,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        totals: expect.objectContaining(expectedTotals),
      }),
    );
  });
});
