import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PreviewJournalEntryDto } from './preview-journal-entry.dto';

const U = '00000000-0000-4000-8000-000000000000';
const errorsFor = (body: object) =>
  validateSync(plainToInstance(PreviewJournalEntryDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((e) => e.property);

const sale = {
  nature: 'SALE',
  lines: [{ accountId: U, amount: '1', taxCodeIds: [] }],
};
const payment = {
  nature: 'PAYMENT',
  direction: 'RECEIPT',
  cashAccountId: U,
  allocations: [{ salesInvoiceId: U, amount: '1' }],
};

describe('PreviewJournalEntryDto foreign-nature fields (iteration-5)', () => {
  it('accepts the documented SALE / PURCHASE / PAYMENT shapes', () => {
    expect(errorsFor(sale)).toEqual([]);
    expect(errorsFor({ ...sale, settlementAccountId: U })).toEqual([]);
    expect(errorsFor({ ...sale, nature: 'PURCHASE' })).toEqual([]);
    expect(errorsFor(payment)).toEqual([]);
  });

  it.each([
    ['direction', { direction: 'RECEIPT' }],
    ['cashAccountId', { cashAccountId: U }],
    ['allocations', { allocations: payment.allocations }],
    ['allocations', { allocations: null }],
  ])('SALE/PURCHASE reject the PAYMENT field %s', (property, extra) => {
    expect(errorsFor({ ...sale, ...extra })).toContain(property);
    expect(errorsFor({ ...sale, nature: 'PURCHASE', ...extra })).toContain(
      property,
    );
  });

  it.each([
    ['lines', { lines: sale.lines }],
    ['lines', { lines: [] }],
    ['settlementAccountId', { settlementAccountId: U }],
  ])('PAYMENT rejects the SALE/PURCHASE field %s', (property, extra) => {
    expect(errorsFor({ ...payment, ...extra })).toContain(property);
  });

  it('a foreign field is still shape-validated (no unvalidated junk)', () => {
    const junk = [{ salesInvoiceId: U, amount: '1', memo: 'x' }];
    expect(errorsFor({ ...sale, allocations: junk })).toContain('allocations');
  });

  it('still requires the fields of its own nature', () => {
    expect(errorsFor({ nature: 'SALE' })).toContain('lines');
    expect(errorsFor({ nature: 'PAYMENT' })).toEqual(
      expect.arrayContaining(['direction', 'cashAccountId', 'allocations']),
    );
  });
});
