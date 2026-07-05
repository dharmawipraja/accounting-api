import { toPreview, PreviewSourceLine } from './journal-preview.projection';

const accounts = new Map([
  ['a1', { id: 'a1', code: '1-1210', name: 'Piutang Usaha' }],
  ['a2', { id: 'a2', code: '4-1000', name: 'Pendapatan' }],
  ['a3', { id: 'a3', code: '2-1310', name: 'PPN Keluaran' }],
]);

describe('toPreview', () => {
  it('enriches, normalizes to 4dp, totals, and marks balanced', () => {
    const lines: PreviewSourceLine[] = [
      { accountId: 'a1', debit: '1110000' },
      { accountId: 'a2', credit: '1000000' },
      { accountId: 'a3', credit: '110000' },
    ];
    const out = toPreview(lines, accounts);
    expect(out.lines[0]).toEqual({
      accountId: 'a1',
      accountCode: '1-1210',
      accountName: 'Piutang Usaha',
      debit: '1110000.0000',
      credit: '0.0000', // inactive side is "0.0000", never null
    });
    expect(out.lines[1].credit).toBe('1000000.0000');
    expect(out.lines[1].debit).toBe('0.0000');
    expect(out.totalDebit).toBe('1110000.0000');
    expect(out.totalCredit).toBe('1110000.0000');
    expect(out.balanced).toBe(true);
  });

  it('reports balanced=false when debits != credits (defensive)', () => {
    const out = toPreview(
      [
        { accountId: 'a1', debit: '100' },
        { accountId: 'a2', credit: '90' },
      ],
      accounts,
    );
    expect(out.balanced).toBe(false);
  });

  it('throws if a line references an account absent from the map', () => {
    expect(() =>
      toPreview([{ accountId: 'missing', debit: '1' }], accounts),
    ).toThrow();
  });
});
