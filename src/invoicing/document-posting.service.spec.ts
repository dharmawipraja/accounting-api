import { PrismaService } from '../common/prisma/prisma.service';
import { PostingService } from '../ledger/posting/posting.service';
import { TaxService } from '../tax/tax.service';
import {
  DocumentPostingService,
  DraftChangedError,
} from './document-posting.service';
import { ValidationFailedError } from '../common/errors/domain-errors';

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
      resolvePostableAccounts: jest.fn().mockResolvedValue(new Map()),
    };
    const docNumber = {
      next: jest.fn().mockResolvedValue(42),
      buildRef: jest.fn().mockReturnValue('INV/2026/000042'),
    };
    const prisma = {
      transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
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
    table: 'sales_invoices' as const,
    notDraftMessage: 'Invoice is no longer a draft',
    verifyLockedInTx: jest.fn().mockResolvedValue(undefined),
  };

  it('prepares before the transaction, locks before numbering, threads period/fy, and finalizes', async () => {
    const { svc, tx, entry, tax, posting, docNumber, prisma } = build();
    // $queryRaw is the internal FOR UPDATE lock — return a DRAFT row
    const txWithLock = {
      ...tx,
      $queryRaw: jest.fn().mockResolvedValue([{ status: 'DRAFT' }]),
    };
    (prisma.transaction as jest.Mock).mockImplementation(
      (cb: (t: unknown) => unknown) => cb(txWithLock),
    );
    const finalize = jest.fn().mockResolvedValue(undefined);

    await svc.post(params, finalize);

    // tax + prepare run OUTSIDE the tx, before it opens; the tax is then
    // re-derived through the tx (after verify, before a number is consumed)
    expect(tax.calculate).toHaveBeenCalledTimes(2);
    expect(tax.calculate.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.transaction.mock.invocationCallOrder[0],
    );
    expect(tax.calculate).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      txWithLock,
    );
    expect(params.verifyLockedInTx.mock.invocationCallOrder[0]).toBeLessThan(
      tax.calculate.mock.invocationCallOrder[1],
    );
    expect(tax.calculate.mock.invocationCallOrder[1]).toBeLessThan(
      docNumber.next.mock.invocationCallOrder[0],
    );
    expect(posting.preparePosting).toHaveBeenCalledTimes(1);
    expect(posting.preparePosting.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.transaction.mock.invocationCallOrder[0],
    );
    // lock-before-number: $queryRaw (FOR UPDATE) must precede docNumber.next
    expect(txWithLock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      docNumber.next.mock.invocationCallOrder[0],
    );
    // the locked row is verified against the prepared content after the lock,
    // before a number is consumed
    const verify = params.verifyLockedInTx;
    expect(verify).toHaveBeenCalledWith(txWithLock);
    expect(txWithLock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      verify.mock.invocationCallOrder[0],
    );
    expect(verify.mock.invocationCallOrder[0]).toBeLessThan(
      docNumber.next.mock.invocationCallOrder[0],
    );
    // every line account (free lines included) is postable-checked in the tx,
    // with the source type's policy, before a number is consumed
    expect(posting.resolvePostableAccounts).toHaveBeenCalledWith(
      [],
      expect.anything(),
      txWithLock,
    );
    expect(
      posting.resolvePostableAccounts.mock.invocationCallOrder[0],
    ).toBeLessThan(docNumber.next.mock.invocationCallOrder[0]);
    // preparePosting token is passed directly to the write (2-arg token form)
    expect(posting.createPostedEntryInTx).toHaveBeenCalledWith(
      txWithLock,
      expect.objectContaining({ periodId: 'p1', fiscalYear: 2026 }),
    );
    // finalize receives the assigned number/ref/entry + computed totals
    const expectedTotals: Record<string, string> = {
      subtotal: '1000.0000',
      total: '1000.0000',
    };
    expect(finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        tx: txWithLock,
        number: 42,
        ref: 'INV/2026/000042',
        entry,
        fiscalYear: 2026,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        totals: expect.objectContaining(expectedTotals),
      }),
    );
  });

  it('throws (consuming no number) when the row is no longer DRAFT', async () => {
    const { svc, docNumber, prisma, tx } = build();
    const txWithLock = {
      ...tx,
      // FOR UPDATE lock re-reads the row as already POSTED (lost the race)
      $queryRaw: jest.fn().mockResolvedValue([{ status: 'POSTED' }]),
    };
    (prisma.transaction as jest.Mock).mockImplementation(
      (cb: (t: unknown) => unknown) => cb(txWithLock),
    );
    const finalize = jest.fn().mockResolvedValue(undefined);

    const err = await svc.post(params, finalize).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ValidationFailedError);
    expect((err as Error).message).toBe('Invoice is no longer a draft');
    // lock failed before numbering: no document number consumed, nothing finalized
    expect(docNumber.next).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });

  it('throws when the row is gone (deleted or never existed)', async () => {
    const { svc, docNumber, prisma, tx } = build();
    const txWithLock = {
      ...tx,
      // FOR UPDATE lock finds no row (soft-deleted / missing)
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    (prisma.transaction as jest.Mock).mockImplementation(
      (cb: (t: unknown) => unknown) => cb(txWithLock),
    );
    const finalize = jest.fn().mockResolvedValue(undefined);

    await expect(svc.post(params, finalize)).rejects.toThrow(
      ValidationFailedError,
    );
    expect(docNumber.next).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
  });
  it('in-tx tax result differs from the pre-tx one → DraftChangedError, no number consumed', async () => {
    const { svc, tax, docNumber, prisma, posting } = build();
    const txWithLock = {
      $queryRaw: jest.fn().mockResolvedValue([{ status: 'DRAFT' }]),
    };
    (prisma.transaction as jest.Mock).mockImplementation(
      (cb: (t: unknown) => unknown) => cb(txWithLock),
    );
    const pre = (await tax.calculate()) as Record<string, unknown>;
    tax.calculate.mockReset();
    tax.calculate
      .mockResolvedValueOnce(pre)
      .mockResolvedValueOnce({ ...pre, subtotal: '1100.0000' });
    await expect(svc.post(params, jest.fn())).rejects.toBeInstanceOf(
      DraftChangedError,
    );
    expect(docNumber.next).not.toHaveBeenCalled();
    expect(posting.createPostedEntryInTx).not.toHaveBeenCalled();
  });
});
