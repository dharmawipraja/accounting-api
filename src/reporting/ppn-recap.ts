// src/reporting/ppn-recap.ts
// Pure core of the monthly PPN recap (rekap PPN Masa, SPT Masa PPN): masa
// parsing, the per-document DPP / DPP Nilai Lain (the Coretax faktur math of
// src/coretax/faktur.ts, so the numbers match the exported XML), section
// totals, the net sign, and the tie-out of the documents to the ledger.
import { Decimal } from 'decimal.js';
import { Money } from '../common/money/money';
import { FISCAL_YEAR_MAX, FISCAL_YEAR_MIN } from '../common/dto/limits';
import { goodServiceAmounts, statutoryVatRate } from '../coretax/faktur';

/** `YYYY-MM` → the masa's first and last day (UTC dates); null when the
 *  format or the year (FISCAL_YEAR_MIN..MAX) is invalid. */
export function parseMasa(period: string): { from: Date; to: Date } | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (year < FISCAL_YEAR_MIN || year > FISCAL_YEAR_MAX) return null;
  return {
    from: new Date(Date.UTC(year, month - 1, 1)),
    to: new Date(Date.UTC(year, month, 0)),
  };
}

export interface PpnCode {
  id: string;
  code: string;
  kind: 'PPN_OUTPUT' | 'PPN_INPUT';
  rate: string;
  dppNilaiLain: boolean;
  coretaxVatRate: string | null;
}

export interface PpnLineInput {
  quantity: string;
  unitPrice: string;
  discountAmount: string;
  amount: string;
  taxCodeIds: string[];
}

export interface PpnBase {
  dpp: string;
  dppNilaiLain: string;
  /** Σ faktur VAT (per-line 2 dp, as in the XML); null when a code's
   *  Coretax presentation is inconsistent (the export would 422). */
  fakturPpn: string | null;
  nilaiLain: boolean;
}

/** DPP, DPP Nilai Lain and faktur VAT of the lines carrying a PPN code of
 *  `kind` (first such code per line, as the Coretax export does); null when
 *  no line does — the document is not part of the recap. */
export function documentPpnBase(
  lines: readonly PpnLineInput[],
  codes: ReadonlyMap<string, PpnCode>,
  kind: PpnCode['kind'],
): PpnBase | null {
  let dpp = new Decimal(0);
  let other = new Decimal(0);
  let vat: Decimal | null = new Decimal(0);
  let nilaiLain = false;
  let any = false;
  for (const l of lines) {
    const code = l.taxCodeIds
      .map((id) => codes.get(id))
      .find((c) => c?.kind === kind);
    if (!code) continue;
    any = true;
    nilaiLain ||= code.dppNilaiLain;
    const rate = statutoryVatRate(code);
    const a = goodServiceAmounts(
      l,
      'vatRate' in rate ? rate.vatRate : new Decimal(0),
      code.dppNilaiLain,
    );
    dpp = dpp.plus(a.taxBase);
    other = other.plus(a.otherTaxBase);
    vat = vat && 'vatRate' in rate ? vat.plus(a.vat) : null;
  }
  if (!any) return null;
  const s = (d: Decimal) => Money.of(d.toFixed()).toString();
  return {
    dpp: s(dpp),
    dppNilaiLain: s(other),
    fakturPpn: vat && s(vat),
    nilaiLain,
  };
}

/** Kode transaksi as the export derives it: the override, else 04 with DPP
 *  Nilai Lain, else 01. */
export const fakturTrxCode = (override: string | null, nilaiLain: boolean) =>
  override ?? (nilaiLain ? '04' : '01');

export interface Amounts {
  dpp: string;
  dppNilaiLain: string;
  ppn: string;
}

export interface Totals extends Amounts {
  count: number;
}

export const totals = (rows: readonly Amounts[]): Totals => {
  const sum = (k: keyof Amounts) =>
    Money.sum(rows.map((r) => Money.of(r[k]))).toString();
  return {
    count: rows.length,
    dpp: sum('dpp'),
    dppNilaiLain: sum('dppNilaiLain'),
    ppn: sum('ppn'),
  };
};

/** A retur note row: a note dated in the masa reduces PPN; its cancellation
 *  (void) in the masa restores it — the row's amounts flip sign. */
export function signedNote<T extends Amounts & { cancellation: boolean }>(
  r: T,
): T {
  if (!r.cancellation) return r;
  const neg = (v: string) => Money.zero().subtract(Money.of(v)).toString();
  return {
    ...r,
    dpp: neg(r.dpp),
    dppNilaiLain: neg(r.dppNilaiLain),
    ppn: neg(r.ppn),
  };
}

/** faktur − batal − retur (retur rows already signed). */
export function netPpn(faktur: Totals, batal: Totals, retur: Totals): string {
  return Money.of(faktur.ppn)
    .subtract(Money.of(batal.ppn))
    .subtract(Money.of(retur.ppn))
    .toString();
}

export type NetStatus = 'KURANG_BAYAR' | 'LEBIH_BAYAR' | 'NIHIL';

/** Keluaran − Masukan: positive = kurang bayar (payable), negative = lebih
 *  bayar (overpaid — compensated / refunded per the SPT). */
export function netResult(keluaranNet: string, masukanNet: string) {
  const net = Money.of(keluaranNet).subtract(Money.of(masukanNet));
  const status: NetStatus = net.isZero()
    ? 'NIHIL'
    : net.isNegative()
      ? 'LEBIH_BAYAR'
      : 'KURANG_BAYAR';
  return { net: net.toString(), netStatus: status };
}

/** One (entry, account) movement on a PPN account in the masa. `origin` is
 *  the entry's source type, or for a REVERSAL the reversed entry's. */
export interface PpnLedgerRow {
  journalEntryId: string;
  entryRef: string | null;
  date: string;
  sourceType: string;
  origin: string;
  accountCode: string;
  accountId: string;
  debit: string;
  credit: string;
}

const KELUARAN_SOURCES = new Set(['SALES_INVOICE', 'SALES_CREDIT_NOTE']);
const MASUKAN_SOURCES = new Set(['PURCHASE_BILL', 'PURCHASE_DEBIT_NOTE']);

export interface UnreconciledEntry {
  journalEntryId: string;
  entryRef: string | null;
  date: string;
  sourceType: string;
  accountCode: string;
  side: 'KELUARAN' | 'MASUKAN';
  amount: string;
}

/** Splits the masa's PPN-account movements into the document part (must
 *  equal the recap) and everything else (manual journals, opening balances…:
 *  listed, never folded into the recap). Keluaran = credit − debit on PPN
 *  Output accounts; Masukan = debit − credit on PPN Input accounts. An
 *  account shared by both kinds is read as Keluaran.
 *  ponytail: shared-account charts would need per-line kind tagging. */
export function ledgerTieOut(
  rows: readonly PpnLedgerRow[],
  outputAccounts: ReadonlySet<string>,
  inputAccounts: ReadonlySet<string>,
) {
  let keluaran = Money.zero();
  let masukan = Money.zero();
  let otherK = Money.zero();
  let otherM = Money.zero();
  const entries: UnreconciledEntry[] = [];
  for (const r of rows) {
    const isOut = outputAccounts.has(r.accountId);
    if (!isOut && !inputAccounts.has(r.accountId)) continue;
    const amt = isOut
      ? Money.of(r.credit).subtract(Money.of(r.debit))
      : Money.of(r.debit).subtract(Money.of(r.credit));
    if (isOut && KELUARAN_SOURCES.has(r.origin)) keluaran = keluaran.add(amt);
    else if (!isOut && MASUKAN_SOURCES.has(r.origin))
      masukan = masukan.add(amt);
    else {
      if (isOut) otherK = otherK.add(amt);
      else otherM = otherM.add(amt);
      entries.push({
        journalEntryId: r.journalEntryId,
        entryRef: r.entryRef,
        date: r.date,
        sourceType: r.sourceType,
        accountCode: r.accountCode,
        side: isOut ? 'KELUARAN' : 'MASUKAN',
        amount: amt.toString(),
      });
    }
  }
  return {
    ppnKeluaran: keluaran.toString(),
    ppnMasukan: masukan.toString(),
    unreconciledManualEntries: {
      ppnKeluaran: otherK.toString(),
      ppnMasukan: otherM.toString(),
      entries,
    },
  };
}
