// Pure mapper: partner statement → ReportTable (see render.ts, tables.ts).
// Kept in its own file so the shared tables.ts stays untouched.
import type { PartnerStatementResponseDto } from '../dto/partner-statement.dto';
import { m, ReportTable, Row } from './render';

const TYPE_LABELS: Record<string, string> = {
  INVOICE: 'Faktur Penjualan',
  INVOICE_VOID: 'Pembatalan Faktur Penjualan',
  BILL: 'Tagihan Pembelian',
  BILL_VOID: 'Pembatalan Tagihan Pembelian',
  PAYMENT: 'Pembayaran',
  PAYMENT_VOID: 'Pembatalan Pembayaran',
  OPENING_CREDIT: 'Kredit Saldo Awal',
  OPENING_CREDIT_VOID: 'Pembatalan Kredit Saldo Awal',
  CREDIT_NOTE: 'Nota Retur Penjualan',
  CREDIT_NOTE_VOID: 'Pembatalan Nota Retur Penjualan',
  DEBIT_NOTE: 'Nota Retur Pembelian',
  DEBIT_NOTE_VOID: 'Pembatalan Nota Retur Pembelian',
  CREDIT_APPLICATION: 'Penerapan Kredit',
  CREDIT_APPLICATION_REVERSAL: 'Pembatalan Penerapan Kredit',
  REFUND: 'Pengembalian Dana',
  REFUND_REVERSAL: 'Pembatalan Pengembalian Dana',
};

export function partnerStatementTable(
  r: PartnerStatementResponseDto,
): ReportTable {
  const pad = (label: string, bal: string, cred: string, net: string): Row => ({
    cells: ['', '', '', label, '', '', m(bal), '', m(cred), m(net)],
    bold: true,
  });
  return {
    title: [
      r.side === 'customer' ? 'Kartu Piutang' : 'Kartu Hutang',
      `${r.partner.code} — ${r.partner.name}`,
      `${r.from} s.d. ${r.to}`,
    ],
    header: [
      'Tanggal',
      'Jenis',
      'Ref',
      'Keterangan',
      'Debit',
      'Kredit',
      'Saldo',
      'Perubahan Kredit',
      'Kredit Belum Diterapkan',
      'Saldo Bersih',
    ],
    rows: [
      pad(
        'Saldo Awal',
        r.openingBalance,
        r.openingUnappliedCredit,
        r.openingNetBalance,
      ),
      ...r.lines.map((l) => ({
        cells: [
          l.date,
          TYPE_LABELS[l.type] ?? l.type,
          l.ref ?? '',
          [
            l.documentRef && l.documentRef !== l.ref ? l.documentRef : '',
            l.description ?? '',
          ]
            .filter(Boolean)
            .join(' — '),
          m(l.debit),
          m(l.credit),
          m(l.balance),
          m(l.unappliedCreditChange),
          m(l.unappliedCredit),
          m(l.netBalance),
        ],
      })),
      {
        cells: ['', '', '', 'Total', m(r.totalDebit), m(r.totalCredit)],
        bold: true,
      },
      pad('Saldo Akhir', r.closingBalance, r.unappliedCredit, r.netBalance),
    ],
    notes: [
      r.side === 'customer'
        ? 'Saldo = piutang (faktur terbuka); Saldo Bersih = Saldo − kredit belum diterapkan (uang muka / kelebihan nota retur).'
        : 'Saldo = utang (tagihan terbuka); Saldo Bersih = Saldo − kredit belum diterapkan (uang muka pembelian / kelebihan nota retur).',
    ],
  };
}
