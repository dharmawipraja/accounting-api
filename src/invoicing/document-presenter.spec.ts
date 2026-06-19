import { Prisma } from '@prisma/client';
import {
  presentDocument,
  buildLineCreateData,
  documentMessages,
  partnerKind,
} from './document-presenter';
import { DocumentRow, DocumentLabels } from './document-descriptor';

const D = (v: string) => new Prisma.Decimal(v);

function row(
  total: string,
  amountPaid: string,
  lines?: DocumentRow['lines'],
): DocumentRow {
  return {
    id: 'd1',
    status: 'POSTED',
    partnerId: 'p1',
    date: new Date('2026-01-01T00:00:00Z'),
    dueDate: null,
    description: null,
    createdBy: 'u1',
    journalEntryId: 'je1',
    subtotal: D('900'),
    taxTotal: D('100'),
    withholdingTotal: D('0'),
    total: D(total),
    amountPaid: D(amountPaid),
    lines,
  };
}

const SALES: DocumentLabels = {
  noun: 'invoice',
  label: 'Sales invoice',
  article: 'an',
  partnerFlag: 'isCustomer',
};
const PURCHASE: DocumentLabels = {
  noun: 'bill',
  label: 'Purchase bill',
  article: 'a',
  partnerFlag: 'isVendor',
};

describe('presentDocument', () => {
  it('UNPAID when nothing is paid', () => {
    const out = presentDocument(row('1000', '0'));
    expect(out.outstanding).toBe('1000.0000');
    expect(out.paymentStatus).toBe('UNPAID');
    expect(out.total).toBe('1000.0000');
    expect(out.amountPaid).toBe('0.0000');
  });

  it('PARTIAL when 0 < paid < total', () => {
    const out = presentDocument(row('1000', '400'));
    expect(out.outstanding).toBe('600.0000');
    expect(out.paymentStatus).toBe('PARTIAL');
  });

  it('PAID when paid equals total', () => {
    const out = presentDocument(row('1000', '1000'));
    expect(out.outstanding).toBe('0.0000');
    expect(out.paymentStatus).toBe('PAID');
  });

  it('PAID (negative outstanding) when over-paid', () => {
    const out = presentDocument(row('1000', '1200'));
    expect(out.outstanding).toBe('-200.0000');
    expect(out.paymentStatus).toBe('PAID');
  });

  it('serializes nested line money fields to 4dp strings', () => {
    const out = presentDocument(
      row('1000', '0', [
        {
          lineNo: 1,
          description: 'x',
          accountId: 'a1',
          quantity: D('2'),
          unitPrice: D('500'),
          amount: D('1000'),
          taxCodeIds: [],
        },
      ]),
    );
    expect(out.lines).toEqual([
      {
        lineNo: 1,
        description: 'x',
        accountId: 'a1',
        quantity: '2.0000',
        unitPrice: '500.0000',
        amount: '1000.0000',
        taxCodeIds: [],
      },
    ]);
  });
});

describe('buildLineCreateData', () => {
  it('maps quantity*unitPrice to a 4dp amount and assigns 1-based lineNo', () => {
    expect(
      buildLineCreateData([
        {
          description: 'x',
          accountId: 'a1',
          quantity: '3',
          unitPrice: '1000.5',
          taxCodeIds: ['t1'],
        },
      ]),
    ).toEqual([
      {
        lineNo: 1,
        description: 'x',
        accountId: 'a1',
        quantity: '3',
        unitPrice: '1000.5',
        amount: '3001.5000',
        taxCodeIds: ['t1'],
      },
    ]);
  });
});

describe('partnerKind', () => {
  it('maps the partner flag to a noun', () => {
    expect(partnerKind('isCustomer')).toBe('customer');
    expect(partnerKind('isVendor')).toBe('vendor');
  });
});

describe('documentMessages parity', () => {
  it('reproduces every sales-invoice string byte-for-byte', () => {
    const m = documentMessages(SALES);
    expect(m.partnerInactive).toBe('Partner is not an active customer');
    expect(m.notFound).toBe('Sales invoice not found');
    expect(m.onlyDraftEdit).toBe('Only a DRAFT invoice can be edited');
    expect(m.notADraft).toBe('Invoice is not a draft');
    expect(m.noLongerDraft).toBe('Invoice is no longer a draft');
    expect(m.onlyPostedVoid).toBe('Only a POSTED invoice can be voided');
    expect(m.voidWithPaymentsFirst).toBe(
      'Cannot void an invoice with payments; void the payments first',
    );
    expect(m.voidWithPayments).toBe('Cannot void an invoice with payments');
    expect(m.alreadyReversed).toBe(
      'Invoice journal entry was already reversed',
    );
    expect(m.notPosted).toBe('Invoice is not posted');
    expect(m.defaultDescription('abc')).toBe('Sales invoice abc');
  });

  it('reproduces every purchase-bill string byte-for-byte', () => {
    const m = documentMessages(PURCHASE);
    expect(m.partnerInactive).toBe('Partner is not an active vendor');
    expect(m.notFound).toBe('Purchase bill not found');
    expect(m.onlyDraftEdit).toBe('Only a DRAFT bill can be edited');
    expect(m.notADraft).toBe('Bill is not a draft');
    expect(m.noLongerDraft).toBe('Bill is no longer a draft');
    expect(m.onlyPostedVoid).toBe('Only a POSTED bill can be voided');
    expect(m.voidWithPaymentsFirst).toBe(
      'Cannot void a bill with payments; void the payments first',
    );
    expect(m.voidWithPayments).toBe('Cannot void a bill with payments');
    expect(m.alreadyReversed).toBe('Bill journal entry was already reversed');
    expect(m.notPosted).toBe('Bill is not posted');
    expect(m.defaultDescription('abc')).toBe('Purchase bill abc');
  });
});
