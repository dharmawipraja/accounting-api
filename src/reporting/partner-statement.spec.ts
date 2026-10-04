import {
  runStatement,
  safeFilePart,
  StatementEvent,
} from './partner-statement';
import { partnerStatementTable } from './export/partner-statement-table';
import { toCsv } from './export/render';

const ev = (
  type: string,
  docDelta: string,
  creditDelta = '0',
  date = '2026-03-01',
): StatementEvent => ({
  date,
  type,
  ref: `${type}-1`,
  documentRef: null,
  description: null,
  docDelta,
  creditDelta,
  documentId: null,
  paymentId: null,
  noteId: null,
  applicationId: null,
});

describe('runStatement', () => {
  const events = [
    ev('INVOICE', '1000'),
    ev('PAYMENT', '-600', '150'), // 600 allocated + 150 advance
    ev('CREDIT_APPLICATION', '-100', '-100'),
    ev('REFUND', '0', '-50'),
    ev('INVOICE_VOID', '-0'),
  ];

  it('customer: debit increases AR; running balance, credit and net', () => {
    const r = runStatement(
      'customer',
      { docBalance: '200', unappliedCredit: '10' },
      events,
    );
    expect(r.openingNetBalance).toBe('190.0000');
    expect(
      r.lines.map((l) => [
        l.debit,
        l.credit,
        l.balance,
        l.unappliedCredit,
        l.netBalance,
      ]),
    ).toEqual([
      ['1000.0000', '0.0000', '1200.0000', '10.0000', '1190.0000'],
      ['0.0000', '600.0000', '600.0000', '160.0000', '440.0000'],
      ['0.0000', '100.0000', '500.0000', '60.0000', '440.0000'],
      ['0.0000', '0.0000', '500.0000', '10.0000', '490.0000'],
      ['0.0000', '0.0000', '500.0000', '10.0000', '490.0000'],
    ]);
    expect(r.lines[3].unappliedCreditChange).toBe('-50.0000');
    expect(r).toMatchObject({
      totalDebit: '1000.0000',
      totalCredit: '700.0000',
      closingBalance: '500.0000',
      unappliedCredit: '10.0000',
      netBalance: '490.0000',
    });
  });

  it('vendor: credit increases AP (mirror columns, same balances)', () => {
    const c = runStatement(
      'customer',
      { docBalance: '0', unappliedCredit: '0' },
      events,
    );
    const v = runStatement(
      'vendor',
      { docBalance: '0', unappliedCredit: '0' },
      events,
    );
    expect(v.lines.map((l) => [l.debit, l.credit])).toEqual(
      c.lines.map((l) => [l.credit, l.debit]),
    );
    expect(v.lines.map((l) => l.balance)).toEqual(
      c.lines.map((l) => l.balance),
    );
    expect([v.totalDebit, v.totalCredit]).toEqual(['700.0000', '1000.0000']);
  });

  it('closing = opening + movements; empty range keeps the opening', () => {
    const r = runStatement(
      'customer',
      { docBalance: '5', unappliedCredit: '2' },
      [],
    );
    expect([r.closingBalance, r.unappliedCredit, r.netBalance]).toEqual([
      '5.0000',
      '2.0000',
      '3.0000',
    ]);
    expect(r.lines).toEqual([]);
  });
});

describe('safeFilePart', () => {
  it('keeps [A-Za-z0-9_-], replaces everything else', () => {
    expect(safeFilePart('C-001_x')).toBe('C-001_x');
    expect(safeFilePart('a/b"c;d\r\n.é ')).toBe('a_b_c_d_____');
  });
});

describe('partnerStatementTable', () => {
  it('Kartu Piutang with Saldo Awal / Saldo Akhir and Indonesian types', () => {
    const r = runStatement(
      'customer',
      { docBalance: '0', unappliedCredit: '0' },
      [{ ...ev('INVOICE', '1000'), documentRef: 'INV-1', ref: 'INV-1' }],
    );
    const t = partnerStatementTable({
      partner: { id: 'p', code: 'C-1', name: 'Toko' },
      side: 'customer',
      from: '2026-03-01',
      to: '2026-03-31',
      ...r,
    });
    expect(t.title[0]).toBe('Kartu Piutang');
    expect(t.rows[0].cells[3]).toBe('Saldo Awal');
    expect(t.rows[1].cells.slice(0, 3)).toEqual([
      '2026-03-01',
      'Faktur Penjualan',
      'INV-1',
    ]);
    expect(t.rows[t.rows.length - 1].cells[3]).toBe('Saldo Akhir');
    expect(toCsv(t)).toContain('Saldo Akhir');
  });
});
