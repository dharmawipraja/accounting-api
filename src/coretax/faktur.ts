import { Decimal } from 'decimal.js';
import { renderXmlDocument, XmlNode } from './xml';
import { NPWP_FORMAT } from '../common/validators/npwp';

/**
 * Pure core of the Coretax "Faktur Pajak Keluaran" XML import file
 * (`TaxInvoiceBulk`, DJP template v1.4 — the format the DJP Excel→XML
 * converter v1.6 still emits). Element names and order follow DJP's official
 * sample `Sample Faktur PK Template v.1.4.xml`; codes/values follow the
 * converter's Excel template v1.6.1 reference sheets. Sources and the
 * verified-vs-assumed list: docs/api/frontend-guide.md § Coretax.
 */

/** One `GoodService` element, values already formatted. */
export interface FakturGoodService {
  opt: string;
  code: string;
  name: string;
  unit: string;
  price: string;
  qty: string;
  totalDiscount: string;
  taxBase: string;
  otherTaxBase: string;
  vatRate: string;
  vat: string;
  stlgRate: string;
  stlg: string;
}

/** One `TaxInvoice` element, values already formatted. */
export interface FakturTaxInvoice {
  taxInvoiceDate: string;
  taxInvoiceOpt: string;
  trxCode: string;
  addInfo: string;
  customDoc: string;
  customDocMonthYear: string;
  refDesc: string;
  facilityStamp: string;
  sellerIdtku: string;
  buyerTin: string;
  buyerDocument: string;
  buyerCountry: string;
  buyerDocumentNumber: string;
  buyerName: string;
  buyerAdress: string;
  buyerEmail: string;
  buyerIdtku: string;
  goods: FakturGoodService[];
}

const ROOT_ATTRIBUTES =
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="TaxInvoice.xsd"';

/** Render the whole import file (element order = DJP's sample). */
export function renderTaxInvoiceBulk(
  sellerTin: string,
  invoices: FakturTaxInvoice[],
): string {
  const invoiceNode = (t: FakturTaxInvoice): XmlNode => [
    'TaxInvoice',
    [
      ['TaxInvoiceDate', t.taxInvoiceDate],
      ['TaxInvoiceOpt', t.taxInvoiceOpt],
      ['TrxCode', t.trxCode],
      ['AddInfo', t.addInfo],
      ['CustomDoc', t.customDoc],
      ['CustomDocMonthYear', t.customDocMonthYear],
      ['RefDesc', t.refDesc],
      ['FacilityStamp', t.facilityStamp],
      ['SellerIDTKU', t.sellerIdtku],
      ['BuyerTin', t.buyerTin],
      ['BuyerDocument', t.buyerDocument],
      ['BuyerCountry', t.buyerCountry],
      ['BuyerDocumentNumber', t.buyerDocumentNumber],
      ['BuyerName', t.buyerName],
      // [sic] — DJP's element name.
      ['BuyerAdress', t.buyerAdress],
      ['BuyerEmail', t.buyerEmail],
      ['BuyerIDTKU', t.buyerIdtku],
      [
        'ListOfGoodService',
        t.goods.map(
          (g): XmlNode => [
            'GoodService',
            [
              ['Opt', g.opt],
              ['Code', g.code],
              ['Name', g.name],
              ['Unit', g.unit],
              ['Price', g.price],
              ['Qty', g.qty],
              ['TotalDiscount', g.totalDiscount],
              ['TaxBase', g.taxBase],
              ['OtherTaxBase', g.otherTaxBase],
              ['VATRate', g.vatRate],
              ['VAT', g.vat],
              ['STLGRate', g.stlgRate],
              ['STLG', g.stlg],
            ],
          ],
        ),
      ],
    ],
  ];
  return renderXmlDocument('TaxInvoiceBulk', ROOT_ATTRIBUTES, [
    ['TIN', sellerTin],
    ['ListOfTaxInvoice', invoices.map(invoiceNode)],
  ]);
}

// ---------------------------------------------------------------------------
// Amounts.

type Num = Decimal.Value;

/** Coretax number: at most 2 dp, commercial (half-up) rounding, '.' decimal
 *  separator, no thousands separator, no trailing zeros ('15000', '1234.5'). */
export function coretaxNumber(v: Num): string {
  return new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed();
}

/** What the export needs of a PPN Output tax code. */
export interface CoretaxVatCode {
  code: string;
  rate: Num; // engine rate, e.g. 0.11
  dppNilaiLain: boolean;
  coretaxVatRate: Num | null; // statutory %, e.g. 12
}

/** The statutory VATRate (percent) a code shows on the faktur, or an error
 *  when its presentation does not reproduce its engine rate exactly:
 *  rate × 100 must equal VATRate × (11/12 with DPP Nilai Lain, else 1). */
export function statutoryVatRate(
  c: CoretaxVatCode,
): { vatRate: Decimal } | { error: string } {
  const engine = new Decimal(c.rate).times(100);
  const vatRate =
    c.coretaxVatRate != null
      ? new Decimal(c.coretaxVatRate)
      : c.dppNilaiLain
        ? engine.times(12).div(11)
        : engine;
  const effective = c.dppNilaiLain ? vatRate.times(11).div(12) : vatRate;
  if (vatRate.decimalPlaces() > 2 || !effective.equals(engine))
    return {
      error: `Tax code ${c.code}: rate ${new Decimal(c.rate).toFixed()} is not VATRate ${vatRate.toDecimalPlaces(4).toFixed()}%${c.dppNilaiLain ? ' × 11/12 (DPP Nilai Lain)' : ''}; set coretaxVatRate / dppNilaiLain to match the rate`,
    };
  return { vatRate };
}

/** A posted invoice line as the export reads it (4dp money). */
export interface CoretaxLineAmounts {
  quantity: Num;
  unitPrice: Num;
  discountAmount: Num;
  amount: Num; // NET = DPP
}

/** Faktur amounts of one line: TaxBase = DPP (the posted net amount);
 *  OtherTaxBase = TaxBase × 11/12 with DPP Nilai Lain (PMK 131/2024), else
 *  TaxBase; VAT = OtherTaxBase × VATRate (the DJP template rule). */
export function goodServiceAmounts(
  l: CoretaxLineAmounts,
  vatRate: Decimal,
  dppNilaiLain: boolean,
): Pick<
  FakturGoodService,
  | 'price'
  | 'qty'
  | 'totalDiscount'
  | 'taxBase'
  | 'otherTaxBase'
  | 'vatRate'
  | 'vat'
> {
  const r2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const taxBase = r2(new Decimal(l.amount));
  const otherTaxBase = dppNilaiLain ? r2(taxBase.times(11).div(12)) : taxBase;
  const vat = r2(otherTaxBase.times(vatRate).div(100));
  return {
    price: coretaxNumber(l.unitPrice),
    qty: coretaxNumber(l.quantity),
    totalDiscount: coretaxNumber(l.discountAmount),
    taxBase: taxBase.toFixed(),
    otherTaxBase: otherTaxBase.toFixed(),
    vatRate: vatRate.toFixed(),
    vat: vat.toFixed(),
  };
}

/** Largest |Σ faktur VAT − posted PPN| explained by rounding alone: the
 *  engine rounds each code's total ONCE to whole rupiah (≤ 0.5 per code);
 *  the faktur rounds each line's TaxBase / OtherTaxBase / VAT to 2 dp
 *  (< 0.01 per line in VAT terms). Anything above is a real mismatch. */
export function vatTolerance(ppnCodes: number, lines: number): Decimal {
  return new Decimal(0.5).times(ppnCodes).plus(new Decimal(0.01).times(lines));
}

// ---------------------------------------------------------------------------
// Assembly (validation + mapping) of one invoice.

export type BuyerDocumentType = 'TIN' | 'NATIONAL_ID' | 'PASSPORT' | 'OTHER';

/** XML `BuyerDocument` values (DJP Excel template REF-General). */
const BUYER_DOCUMENT: Record<BuyerDocumentType, string> = {
  TIN: 'TIN',
  NATIONAL_ID: 'National ID',
  PASSPORT: 'Passport',
  OTHER: 'Other ID',
};

export interface CoretaxSeller {
  npwp: string | null;
  nitkuSuffix: string;
  isPkp: boolean;
  defaultItemType: 'A' | 'B' | null;
  defaultItemCode: string;
  defaultUnitCode: string | null;
}

export interface CoretaxBuyer {
  name: string;
  npwp: string | null;
  buyerDocumentType: BuyerDocumentType;
  buyerDocumentNumber: string | null;
  nitkuSuffix: string;
  country: string;
  address: string | null;
  email: string | null;
}

export interface CoretaxInvoiceLine extends CoretaxLineAmounts {
  lineNo: number;
  description: string;
  taxCodeIds: string[];
  coretaxItemType: 'A' | 'B' | null;
  coretaxItemCode: string | null;
  coretaxUnitCode: string | null;
}

export interface CoretaxInvoice {
  id: string;
  invoiceRef: string | null;
  date: Date;
  trxCode: string | null;
  taxTotal: Num; // posted PPN (the PPN bucket of the engine)
  buyer: CoretaxBuyer;
  lines: CoretaxInvoiceLine[];
}

export interface CoretaxProblem {
  invoiceId: string | null;
  invoiceRef: string | null;
  field: string;
  message: string;
}

/** Seller master data every file needs. */
export function sellerProblems(s: CoretaxSeller): CoretaxProblem[] {
  const p = (field: string, message: string): CoretaxProblem => ({
    invoiceId: null,
    invoiceRef: null,
    field,
    message,
  });
  const out: CoretaxProblem[] = [];
  if (!s.isPkp)
    out.push(p('companySettings.isPkp', 'Only a PKP company issues faktur'));
  if (!s.npwp || !NPWP_FORMAT.test(s.npwp))
    out.push(p('companySettings.npwp', 'Seller NPWP (16 digits) is required'));
  return out;
}

/**
 * Map one posted invoice to a `TaxInvoice`, or list what is missing / wrong.
 * Only lines carrying a PPN Output code are faktur lines; an invoice with
 * none returns `{ skip: true }` (nothing to report to Coretax).
 * `vatCodes` = the PPN Output codes by id (other kinds are absent).
 */
export function assembleTaxInvoice(
  inv: CoretaxInvoice,
  seller: CoretaxSeller,
  vatCodes: Map<string, CoretaxVatCode>,
):
  | { skip: true }
  | { taxInvoice: FakturTaxInvoice; problems: [] }
  | { problems: CoretaxProblem[] } {
  const problems: CoretaxProblem[] = [];
  const p = (field: string, message: string) =>
    problems.push({
      invoiceId: inv.id,
      invoiceRef: inv.invoiceRef,
      field,
      message,
    });

  const ppnLines = inv.lines
    .map((l) => ({
      l,
      code: l.taxCodeIds
        .map((id) => vatCodes.get(id))
        .find((c): c is CoretaxVatCode => c !== undefined),
    }))
    .filter((x): x is { l: CoretaxInvoiceLine; code: CoretaxVatCode } =>
      Boolean(x.code),
    );
  if (ppnLines.length === 0) return { skip: true };

  // Buyer.
  const b = inv.buyer;
  const isTin = b.buyerDocumentType === 'TIN';
  if (isTin && (!b.npwp || !NPWP_FORMAT.test(b.npwp)))
    p(
      'partner.npwp',
      'Buyer NPWP (16 digits) is required for document type TIN',
    );
  if (!isTin && !b.buyerDocumentNumber?.trim())
    p(
      'partner.buyerDocumentNumber',
      `Buyer document number is required for document type ${b.buyerDocumentType}`,
    );
  if (
    b.buyerDocumentType === 'NATIONAL_ID' &&
    b.buyerDocumentNumber &&
    !NPWP_FORMAT.test(b.buyerDocumentNumber)
  )
    p('partner.buyerDocumentNumber', 'NIK must be 16 digits');
  if (!b.address?.trim()) p('partner.address', 'Buyer address is required');

  // Lines.
  const goods: FakturGoodService[] = [];
  const nilaiLain = new Set<boolean>();
  const codesUsed = new Set<string>();
  let vatSum = new Decimal(0);
  for (const { l, code } of ppnLines) {
    const rate = statutoryVatRate(code);
    if ('error' in rate) {
      p(`lines[${l.lineNo}].taxCodeIds`, rate.error);
      continue;
    }
    nilaiLain.add(code.dppNilaiLain);
    codesUsed.add(code.code);
    const opt = l.coretaxItemType ?? seller.defaultItemType;
    const unit = l.coretaxUnitCode ?? seller.defaultUnitCode;
    if (!opt)
      p(
        `lines[${l.lineNo}].coretaxItemType`,
        'Goods/service type (A/B) is required (line or company default)',
      );
    if (!unit)
      p(
        `lines[${l.lineNo}].coretaxUnitCode`,
        'Unit code (UM.xxxx) is required (line or company default)',
      );
    const amounts = goodServiceAmounts(l, rate.vatRate, code.dppNilaiLain);
    vatSum = vatSum.plus(amounts.vat);
    goods.push({
      opt: opt ?? '',
      code: l.coretaxItemCode ?? seller.defaultItemCode,
      name: l.description,
      unit: unit ?? '',
      ...amounts,
      stlgRate: '0',
      stlg: '0',
    });
  }

  // One faktur = one kode transaksi: 04 for DPP Nilai Lain, else 01.
  if (!inv.trxCode && nilaiLain.size > 1)
    p(
      'trxCode',
      'Invoice mixes DPP Nilai Lain and regular PPN lines; split it or set trxCode',
    );
  const trxCode = inv.trxCode ?? (nilaiLain.has(true) ? '04' : '01');

  // The faktur must report the PPN that was posted.
  if (problems.length === 0) {
    const diff = vatSum.minus(new Decimal(inv.taxTotal)).abs();
    if (diff.greaterThan(vatTolerance(codesUsed.size, goods.length)))
      p(
        'taxTotal',
        `Faktur VAT ${vatSum.toFixed()} does not reconcile with the posted PPN ${new Decimal(inv.taxTotal).toFixed()}`,
      );
  }
  if (problems.length > 0) return { problems };

  return {
    problems: [],
    taxInvoice: {
      taxInvoiceDate: inv.date.toISOString().slice(0, 10),
      taxInvoiceOpt: 'Normal',
      trxCode,
      addInfo: '',
      customDoc: '',
      customDocMonthYear: '',
      refDesc: inv.invoiceRef ?? '',
      facilityStamp: '',
      sellerIdtku: `${seller.npwp}${seller.nitkuSuffix}`,
      buyerTin: isTin ? b.npwp! : '0000000000000000',
      buyerDocument: BUYER_DOCUMENT[b.buyerDocumentType],
      buyerCountry: b.country,
      buyerDocumentNumber: isTin ? '' : b.buyerDocumentNumber!.trim(),
      buyerName: b.name,
      buyerAdress: b.address!.trim(),
      buyerEmail: b.email ?? '',
      buyerIdtku: isTin ? `${b.npwp}${b.nitkuSuffix}` : '000000',
      goods,
    },
  };
}

type FakturStatus = 'NONE' | 'EXPORTED' | 'APPROVED' | 'CANCELLED';

/** Allowed taxInvoiceStatus moves (a same-status write is always allowed —
 *  e.g. APPROVED→APPROVED records a replacement faktur's NSFP). An APPROVED
 *  faktur can only be cancelled at DJP: moving it back to NONE/EXPORTED would
 *  put it in the default export again → a duplicate upload. A CANCELLED
 *  faktur is final in Coretax; its replacement is a new invoice. */
export const FAKTUR_TRANSITIONS: Record<FakturStatus, readonly FakturStatus[]> =
  {
    NONE: ['EXPORTED', 'APPROVED'],
    EXPORTED: ['NONE', 'APPROVED'],
    APPROVED: ['CANCELLED'],
    CANCELLED: [],
  };

export function isFakturTransitionAllowed(
  from: FakturStatus,
  to: FakturStatus,
): boolean {
  return from === to || FAKTUR_TRANSITIONS[from].includes(to);
}
