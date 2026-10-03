import { readFileSync } from 'fs';
import { join } from 'path';
import { Decimal } from 'decimal.js';
import {
  assembleTaxInvoice,
  CoretaxInvoice,
  CoretaxSeller,
  CoretaxVatCode,
  coretaxNumber,
  goodServiceAmounts,
  isFakturTransitionAllowed,
  renderTaxInvoiceBulk,
  sellerProblems,
  statutoryVatRate,
} from './faktur';
import { escapeXmlText, renderXmlDocument } from './xml';

describe('Coretax XML writer', () => {
  it('reproduces DJP’s official sample byte for byte (golden file)', () => {
    // src/coretax/fixtures/djp-sample-faktur-pk-v1.4.xml is DJP's
    // "Sample Faktur PK Template v.1.4.xml" (pajak.go.id, unmodified).
    const golden = readFileSync(
      join(__dirname, 'fixtures/djp-sample-faktur-pk-v1.4.xml'),
      'utf8',
    );
    const xml = renderTaxInvoiceBulk('1091031210912281', [
      {
        taxInvoiceDate: '2025-02-02',
        taxInvoiceOpt: 'Normal',
        trxCode: '07',
        addInfo: 'TD.00502',
        customDoc: '00004092893220241216000270',
        customDocMonthYear: '122024',
        refDesc: '',
        facilityStamp: 'TD.01102',
        sellerIdtku: '1091031210912281000000',
        buyerTin: '1091031210912281',
        buyerDocument: 'TIN',
        buyerCountry: 'IND',
        buyerDocumentNumber: '',
        buyerName: '',
        buyerAdress: '',
        buyerEmail: 'someemail@gmail.com',
        buyerIdtku: '1091031210912281000000',
        goods: [
          {
            opt: 'A',
            code: '000000',
            name: 'Barang',
            unit: 'UM.0001',
            price: '15000',
            qty: '200',
            totalDiscount: '100000',
            taxBase: '2900000',
            otherTaxBase: '2900000',
            vatRate: '11',
            vat: '319000',
            stlgRate: '20',
            stlg: '580000',
          },
        ],
      },
    ]);
    expect(xml).toBe(golden);
  });

  it('escapes markup in every text value and drops XML-invalid characters', () => {
    expect(escapeXmlText(`a&b<c>d"e'f\u0001g`)).toBe(
      'a&amp;b&lt;c&gt;d&quot;e&apos;fg',
    );
    const xml = renderXmlDocument('R', 'a="1"', [
      ['Name', '</Name><Evil>x</Evil>'],
    ]);
    expect(xml).toContain(
      '<Name>&lt;/Name&gt;&lt;Evil&gt;x&lt;/Evil&gt;</Name>',
    );
    expect(xml).not.toContain('<Evil>');
  });

  it('refuses an invalid element name', () => {
    expect(() => renderXmlDocument('R', '', [['a b', 'x']])).toThrow(
      'Invalid XML element name',
    );
  });
});

describe('Coretax amounts', () => {
  it('formats numbers with 2 dp max, half-up, no separators, no trailing zeros', () => {
    expect(coretaxNumber('15000.0000')).toBe('15000');
    expect(coretaxNumber('1234.5000')).toBe('1234.5');
    expect(coretaxNumber('0.005')).toBe('0.01');
    expect(coretaxNumber('12345678901234.5678')).toBe('12345678901234.57');
  });

  it('PPN 12% on DPP Nilai Lain 11/12 reproduces the engine’s 11% of DPP', () => {
    const code = {
      code: 'PPN-OUT-11',
      rate: '0.11',
      dppNilaiLain: true,
      coretaxVatRate: '12',
    };
    const r = statutoryVatRate(code);
    expect(r).toEqual({ vatRate: new Decimal(12) });
    // DJP Excel template sample: DPP 120,000,000 → DPP NL 110,000,000 → PPN 13,200,000.
    expect(
      goodServiceAmounts(
        {
          quantity: '10',
          unitPrice: '12000000',
          discountAmount: '0',
          amount: '120000000',
        },
        new Decimal(12),
        true,
      ),
    ).toEqual({
      price: '12000000',
      qty: '10',
      totalDiscount: '0',
      taxBase: '120000000',
      otherTaxBase: '110000000',
      vatRate: '12',
      vat: '13200000',
    });
    // Without coretaxVatRate the statutory rate is derived (0.11 × 12/11).
    expect(statutoryVatRate({ ...code, coretaxVatRate: null })).toEqual({
      vatRate: new Decimal(12),
    });
  });

  it('regular PPN (luxury goods, full DPP): OtherTaxBase = TaxBase', () => {
    const r = statutoryVatRate({
      code: 'PPN-12',
      rate: '0.12',
      dppNilaiLain: false,
      coretaxVatRate: null,
    });
    expect(r).toEqual({ vatRate: new Decimal(12) });
    const a = goodServiceAmounts(
      {
        quantity: '3',
        unitPrice: '1000',
        discountAmount: '100',
        amount: '2900',
      },
      new Decimal(12),
      false,
    );
    expect(a).toMatchObject({
      taxBase: '2900',
      otherTaxBase: '2900',
      vat: '348',
      totalDiscount: '100',
    });
  });

  it('refuses a code whose presentation does not reproduce its rate', () => {
    const r = statutoryVatRate({
      code: 'BAD',
      rate: '0.12',
      dppNilaiLain: true,
      coretaxVatRate: '12',
    });
    expect('error' in r && r.error).toContain('Tax code BAD');
  });
});

describe('assembleTaxInvoice', () => {
  const seller: CoretaxSeller = {
    npwp: '0012345678901000',
    nitkuSuffix: '000000',
    isPkp: true,
    defaultItemType: 'A',
    defaultItemCode: '000000',
    defaultUnitCode: 'UM.0018',
  };
  const codes = new Map<string, CoretaxVatCode>([
    [
      'ppn',
      {
        code: 'PPN-OUT-11',
        rate: '0.11',
        dppNilaiLain: true,
        coretaxVatRate: '12',
      },
    ],
    [
      'lux',
      {
        code: 'PPN-12',
        rate: '0.12',
        dppNilaiLain: false,
        coretaxVatRate: null,
      },
    ],
  ]);
  const line = (o: Partial<CoretaxInvoice['lines'][0]> = {}) => ({
    lineNo: 1,
    description: 'Jasa <konsultasi> & co',
    quantity: '2',
    unitPrice: '500000',
    discountAmount: '100000',
    amount: '900000',
    taxCodeIds: ['ppn'],
    coretaxItemType: 'B' as const,
    coretaxItemCode: null,
    coretaxUnitCode: null,
    ...o,
  });
  const inv = (o: Partial<CoretaxInvoice> = {}): CoretaxInvoice => ({
    id: 'inv-1',
    invoiceRef: 'INV/2026/000001',
    date: new Date('2026-02-10T00:00:00Z'),
    trxCode: null,
    taxTotal: '99000',
    buyer: {
      name: 'PT Pembeli',
      npwp: '0098765432109000',
      buyerDocumentType: 'TIN',
      buyerDocumentNumber: null,
      nitkuSuffix: '000001',
      country: 'IDN',
      address: 'Jl. Sudirman 1',
      email: null,
    },
    lines: [line()],
    ...o,
  });

  it('maps a DPP Nilai Lain invoice to TrxCode 04 with reconciled VAT', () => {
    const r = assembleTaxInvoice(inv(), seller, codes);
    expect(r).toMatchObject({
      problems: [],
      taxInvoice: {
        taxInvoiceDate: '2026-02-10',
        trxCode: '04',
        refDesc: 'INV/2026/000001',
        sellerIdtku: '0012345678901000000000',
        buyerTin: '0098765432109000',
        buyerIdtku: '0098765432109000000001',
        buyerDocument: 'TIN',
        buyerDocumentNumber: '',
        goods: [
          {
            opt: 'B',
            code: '000000',
            unit: 'UM.0018',
            taxBase: '900000',
            otherTaxBase: '825000',
            vatRate: '12',
            vat: '99000',
          },
        ],
      },
    });
  });

  it('a non-TIN buyer gets the zero TIN and IDTKU', () => {
    const r = assembleTaxInvoice(
      inv({
        buyer: {
          ...inv().buyer,
          npwp: null,
          buyerDocumentType: 'NATIONAL_ID',
          buyerDocumentNumber: '3174061502560010',
        },
      }),
      seller,
      codes,
    );
    expect(r).toMatchObject({
      taxInvoice: {
        buyerTin: '0000000000000000',
        buyerDocument: 'National ID',
        buyerDocumentNumber: '3174061502560010',
        buyerIdtku: '000000',
      },
    });
  });

  it('skips an invoice without PPN Output lines', () => {
    expect(
      assembleTaxInvoice(
        inv({ lines: [line({ taxCodeIds: [] })] }),
        seller,
        codes,
      ),
    ).toEqual({ skip: true });
  });

  it('lists every missing field instead of producing a faktur', () => {
    const r = assembleTaxInvoice(
      inv({
        buyer: { ...inv().buyer, npwp: null, address: null },
        lines: [line({ coretaxItemType: null })],
      }),
      { ...seller, defaultItemType: null, defaultUnitCode: null },
      codes,
    );
    expect('problems' in r && r.problems.map((p) => p.field).sort()).toEqual([
      'lines[1].coretaxItemType',
      'lines[1].coretaxUnitCode',
      'partner.address',
      'partner.npwp',
    ]);
  });

  it('refuses mixed DPP Nilai Lain / regular lines without a trxCode', () => {
    const r = assembleTaxInvoice(
      inv({
        lines: [line(), line({ lineNo: 2, taxCodeIds: ['lux'] })],
        taxTotal: '207000',
      }),
      seller,
      codes,
    );
    expect('problems' in r && r.problems.map((p) => p.field)).toEqual([
      'trxCode',
    ]);
    const ok = assembleTaxInvoice(
      inv({
        trxCode: '01',
        lines: [line(), line({ lineNo: 2, taxCodeIds: ['lux'] })],
        taxTotal: '207000',
      }),
      seller,
      codes,
    );
    expect(ok).toMatchObject({ taxInvoice: { trxCode: '01' } });
  });

  it('refuses a faktur whose VAT does not reconcile with the posted PPN', () => {
    const r = assembleTaxInvoice(inv({ taxTotal: '98998' }), seller, codes);
    expect('problems' in r && r.problems[0].field).toBe('taxTotal');
    // Within rupiah rounding: accepted.
    expect(
      assembleTaxInvoice(inv({ taxTotal: '99000.4' }), seller, codes),
    ).toMatchObject({ problems: [] });
  });

  it('seller problems: PKP and 16-digit NPWP', () => {
    expect(sellerProblems(seller)).toEqual([]);
    expect(
      sellerProblems({ ...seller, isPkp: false, npwp: null }).map(
        (p) => p.field,
      ),
    ).toEqual(['companySettings.isPkp', 'companySettings.npwp']);
  });
});

describe('faktur status transitions', () => {
  it('allows the DJP lifecycle and refuses going back from APPROVED/CANCELLED', () => {
    const ok = isFakturTransitionAllowed;
    expect(ok('NONE', 'EXPORTED')).toBe(true);
    expect(ok('NONE', 'APPROVED')).toBe(true);
    expect(ok('EXPORTED', 'NONE')).toBe(true);
    expect(ok('EXPORTED', 'APPROVED')).toBe(true);
    expect(ok('APPROVED', 'CANCELLED')).toBe(true);
    expect(ok('APPROVED', 'APPROVED')).toBe(true); // replacement NSFP
    expect(ok('NONE', 'CANCELLED')).toBe(false);
    expect(ok('APPROVED', 'NONE')).toBe(false);
    expect(ok('APPROVED', 'EXPORTED')).toBe(false);
    expect(ok('CANCELLED', 'NONE')).toBe(false);
    expect(ok('CANCELLED', 'APPROVED')).toBe(false);
  });
});
