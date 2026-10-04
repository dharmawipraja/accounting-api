import {
  documentPpnBase,
  fakturTrxCode,
  ledgerTieOut,
  netPpn,
  netResult,
  parseMasa,
  PpnCode,
  PpnLedgerRow,
  signedNote,
  totals,
} from './ppn-recap';

const OUT12: PpnCode = {
  id: 'out',
  code: 'PPN-OUT-11',
  kind: 'PPN_OUTPUT',
  rate: '0.11',
  dppNilaiLain: true,
  coretaxVatRate: '12',
};
const OUT11: PpnCode = {
  ...OUT12,
  id: 'out11',
  dppNilaiLain: false,
  coretaxVatRate: null,
};
const IN11: PpnCode = { ...OUT11, id: 'in', kind: 'PPN_INPUT' };
const codes = new Map([OUT12, OUT11, IN11].map((c) => [c.id, c]));
const line = (amount: string, taxCodeIds: string[], discountAmount = '0') => ({
  quantity: '1',
  unitPrice: amount,
  discountAmount,
  amount,
  taxCodeIds,
});

describe('parseMasa', () => {
  it('gives the calendar month bounds (leap February, December)', () => {
    const iso = (p: string) => {
      const r = parseMasa(p)!;
      return [
        r.from.toISOString().slice(0, 10),
        r.to.toISOString().slice(0, 10),
      ];
    };
    expect(iso('2028-02')).toEqual(['2028-02-01', '2028-02-29']);
    expect(iso('2026-12')).toEqual(['2026-12-01', '2026-12-31']);
  });
  it.each([
    '2026-13',
    '2026-00',
    '2026-1',
    '26-01',
    '1999-12',
    '2101-01',
    '2026-01-01',
    '',
  ])('rejects %p', (p) => expect(parseMasa(p)).toBeNull());
});

describe('documentPpnBase', () => {
  it('uses the Coretax faktur math: DPP Nilai Lain 11/12, VAT 12% per line', () => {
    // Same numbers as the Coretax export e2e: 90,000 → 82,500 → 9,900 and
    // 25,000 → 22,916.67 → 2,750; a non-PPN line is ignored.
    const b = documentPpnBase(
      [
        line('90000', ['out'], '10000'),
        line('25000', ['out']),
        line('7000', []),
      ],
      codes,
      'PPN_OUTPUT',
    );
    expect(b).toEqual({
      dpp: '115000.0000',
      dppNilaiLain: '105416.6700',
      fakturPpn: '12650.0000',
      nilaiLain: true,
    });
  });
  it('without DPP Nilai Lain the other base is the DPP', () => {
    expect(
      documentPpnBase([line('1000', ['out11'])], codes, 'PPN_OUTPUT'),
    ).toMatchObject({
      dpp: '1000.0000',
      dppNilaiLain: '1000.0000',
      fakturPpn: '110.0000',
      nilaiLain: false,
    });
  });
  it('only counts codes of the requested kind; none → null', () => {
    expect(
      documentPpnBase([line('1000', ['in'])], codes, 'PPN_OUTPUT'),
    ).toBeNull();
    expect(
      documentPpnBase([line('1000', ['in'])], codes, 'PPN_INPUT')?.dpp,
    ).toBe('1000.0000');
  });
  it('an inconsistent Coretax presentation keeps the bases but no faktur VAT', () => {
    const bad = new Map([['x', { ...OUT12, id: 'x', coretaxVatRate: '11' }]]);
    expect(
      documentPpnBase([line('1200', ['x'])], bad, 'PPN_OUTPUT'),
    ).toMatchObject({
      dpp: '1200.0000',
      dppNilaiLain: '1100.0000',
      fakturPpn: null,
    });
  });
});

describe('fakturTrxCode', () => {
  it('override, else 04 with DPP Nilai Lain, else 01', () => {
    expect(fakturTrxCode('07', true)).toBe('07');
    expect(fakturTrxCode(null, true)).toBe('04');
    expect(fakturTrxCode(null, false)).toBe('01');
  });
});

describe('totals / signedNote / netPpn / netResult', () => {
  const a = (ppn: string) => ({ dpp: '100', dppNilaiLain: '90', ppn });
  it('a retur cancellation flips the sign; net = faktur − batal − retur', () => {
    const retur = totals([
      signedNote({ ...a('11'), cancellation: false }),
      signedNote({ ...a('4'), cancellation: true }),
    ]);
    expect(retur).toEqual({
      count: 2,
      dpp: '0.0000',
      dppNilaiLain: '0.0000',
      ppn: '7.0000',
    });
    expect(netPpn(totals([a('110'), a('55')]), totals([a('55')]), retur)).toBe(
      '103.0000',
    );
  });
  it('positive net is kurang bayar, negative lebih bayar, zero nihil', () => {
    expect(netResult('100', '40')).toEqual({
      net: '60.0000',
      netStatus: 'KURANG_BAYAR',
    });
    expect(netResult('40', '100')).toEqual({
      net: '-60.0000',
      netStatus: 'LEBIH_BAYAR',
    });
    expect(netResult('5', '5.0000')).toEqual({
      net: '0.0000',
      netStatus: 'NIHIL',
    });
  });
});

describe('ledgerTieOut', () => {
  const row = (p: Partial<PpnLedgerRow>): PpnLedgerRow => ({
    journalEntryId: 'je',
    entryRef: null,
    date: '2026-03-01',
    sourceType: p.origin ?? 'MANUAL',
    origin: 'MANUAL',
    accountCode: '2-1100',
    accountId: 'OUT',
    debit: '0',
    credit: '0',
    ...p,
  });
  it('splits document movements (incl. void reversals) from manual ones', () => {
    const r = ledgerTieOut(
      [
        row({ origin: 'SALES_INVOICE', credit: '1100' }),
        row({ origin: 'SALES_INVOICE', sourceType: 'REVERSAL', debit: '300' }),
        row({ origin: 'SALES_CREDIT_NOTE', debit: '110' }),
        row({ origin: 'PURCHASE_BILL', accountId: 'IN', debit: '500' }),
        row({ origin: 'PURCHASE_DEBIT_NOTE', accountId: 'IN', credit: '50' }),
        row({ journalEntryId: 'm1', entryRef: 'JE-1', credit: '25' }),
        row({
          journalEntryId: 'm2',
          accountId: 'IN',
          debit: '7',
          accountCode: '1-1400',
        }),
        // A sales document on an Input account is not a Masukan movement.
        row({
          journalEntryId: 'odd',
          origin: 'SALES_INVOICE',
          accountId: 'IN',
          debit: '1',
        }),
        row({ accountId: 'OTHER', credit: '999' }), // not a PPN account
      ],
      new Set(['OUT']),
      new Set(['IN']),
    );
    expect(r.ppnKeluaran).toBe('690.0000');
    expect(r.ppnMasukan).toBe('450.0000');
    expect(r.unreconciledManualEntries).toMatchObject({
      ppnKeluaran: '25.0000',
      ppnMasukan: '8.0000',
    });
    expect(
      r.unreconciledManualEntries.entries.map((e) => [
        e.journalEntryId,
        e.side,
        e.amount,
      ]),
    ).toEqual([
      ['m1', 'KELUARAN', '25.0000'],
      ['m2', 'MASUKAN', '7.0000'],
      ['odd', 'MASUKAN', '1.0000'],
    ]);
  });
});
