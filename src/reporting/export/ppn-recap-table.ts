// src/reporting/export/ppn-recap-table.ts
// Pure mapper (like tables.ts): Rekap PPN Masa → ReportTable.
import type { PpnRecap } from '../ppn-recap.service';
import { Cell, m, ReportTable, Row } from './render';

const bold = (cells: Cell[]): Row => ({ cells, bold: true });
const NET_LABEL = {
  KURANG_BAYAR: 'Kurang Bayar',
  LEBIH_BAYAR: 'Lebih Bayar',
  NIHIL: 'Nihil',
} as const;

type F = PpnRecap['fakturs'];

export function ppnRecapTable(r: PpnRecap): ReportTable {
  const total = (label: string, t: PpnRecap['ppnKeluaran']) =>
    bold([label, '', '', '', '', '', m(t.dpp), m(t.dppNilaiLain), m(t.ppn)]);
  const line = (label: string, v: string) =>
    bold([label, '', '', '', '', '', '', '', m(v)]);
  const invoice = (d: F['keluaran'][number]): Row => ({
    cells: [
      d.invoiceRef ?? '',
      d.date,
      d.partnerName,
      d.npwp ?? d.buyerDocumentNumber ?? '',
      d.trxCode,
      d.taxInvoiceNumber ?? '',
      m(d.dpp),
      m(d.dppNilaiLain),
      m(d.ppn),
    ],
  });
  const bill = (d: F['masukan'][number]): Row => ({
    cells: [
      d.billRef ?? '',
      d.date,
      d.partnerName,
      d.npwp ?? '',
      '',
      d.vendorInvoiceNo ?? '',
      m(d.dpp),
      m(d.dppNilaiLain),
      m(d.ppn),
    ],
  });
  const note = (d: F['returKeluaran'][number]): Row => ({
    cells: [
      d.ref ?? '',
      d.cancellation ? `${d.date} (batal ${d.voidedOn})` : d.date,
      d.partnerName,
      d.npwp ?? '',
      d.originalRef ?? '',
      d.returNumber ?? '',
      m(d.dpp),
      m(d.dppNilaiLain),
      m(d.ppn),
    ],
  });
  const f = r.fakturs;
  return {
    title: ['Rekap PPN Masa', `Masa ${r.period} (${r.from} s.d. ${r.to})`],
    header: [
      'Ref',
      'Tanggal',
      'Mitra',
      'NPWP/NIK',
      'Kode Trx / Ref Asal',
      'NSFP / No. Faktur / Retur',
      'DPP',
      'DPP Nilai Lain',
      'PPN',
    ],
    rows: [
      bold(['PPN Keluaran']),
      ...f.keluaran.map(invoice),
      total('Total PPN Keluaran', r.ppnKeluaran),
      bold(['Faktur Batal']),
      ...f.batalKeluaran.map(invoice),
      total('Total Faktur Batal', r.batalKeluaran),
      bold(['Retur PPN Keluaran']),
      ...f.returKeluaran.map(note),
      total('Total Retur PPN Keluaran', r.returKeluaran),
      line('PPN Keluaran Bersih', r.ppnKeluaranNet),
      bold(['PPN Masukan']),
      ...f.masukan.map(bill),
      total('Total PPN Masukan', r.ppnMasukan),
      bold(['Tagihan Batal']),
      ...f.batalMasukan.map(bill),
      total('Total Tagihan Batal', r.batalMasukan),
      bold(['Retur PPN Masukan']),
      ...f.returMasukan.map(note),
      total('Total Retur PPN Masukan', r.returMasukan),
      line('PPN Masukan Bersih', r.ppnMasukanNet),
      line('Kurang/(Lebih) Bayar', r.net),
    ],
    notes: [
      `Status: ${NET_LABEL[r.netStatus]}`,
      `Sesuai buku besar: ${r.ledger.ties ? 'ya' : 'TIDAK'}`,
      ...r.warnings,
    ],
  };
}
