import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { SalesInvoicesService } from '../src/invoicing/sales-invoices.service';
import { PurchaseBillsService } from '../src/invoicing/purchase-bills.service';
import { PaymentsService } from '../src/invoicing/payments.service';
import { NotesService } from '../src/invoicing/notes.service';
import { AgingService } from '../src/reporting/aging.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { Money } from '../src/common/money/money';
import { bootstrapTestApp } from './e2e-helpers';
import { readXlsx } from './xlsx-read';
import type { PartnerStatementResponseDto } from '../src/reporting/dto/partner-statement.dto';
import type { AgingReportDto } from '../src/reporting/dto/report-response.dto';

type Side = 'customer' | 'vendor';

/**
 * Partner statement (kartu piutang / hutang) + per-partner aging. Across a
 * history with backdated payments, voids (incl. after `to`), notes with
 * excess, credit applications, refunds and their reversals, at every probed
 * date: closingBalance == the partner's AR/AP aging total == the partner's
 * share of the control account (journal lines of its documents / payments /
 * notes / applications and their reversals), and unappliedCredit == its share
 * of the advance account.
 */
describe('Partner statement (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let payments: PaymentsService;
  let notes: NotesService;
  let invoices: SalesInvoicesService;
  let bills: PurchaseBillsService;
  let partners: BusinessPartnersService;
  let acc: Record<string, string>;
  let role: Record<string, string>;
  let token: string;
  let n = 0;

  const m4 = (v: { toString(): string } | string) =>
    Money.of(v.toString()).toPersistence();
  const get = (url: string) =>
    request(app.getHttpServer() as App)
      .get(url)
      .set('Authorization', `Bearer ${token}`);

  const partner = async (flags: { isCustomer?: boolean; isVendor?: boolean }) =>
    (
      await partners.create({
        code: `PS-${++n}`,
        name: `Statement partner ${n}`,
        ...flags,
      })
    ).id;

  const line = (accountId: string, amount: string) => ({
    description: 'x',
    accountId,
    quantity: '1',
    unitPrice: amount,
    taxCodeIds: [],
  });
  const invoice = async (partnerId: string, amount: string, date: string) =>
    invoices.post(
      (
        await invoices.createDraft({
          partnerId,
          date: new Date(date),
          lines: [line(acc['4-1000'], amount)],
          createdBy: 'creator',
        })
      ).id,
      'poster',
    );
  const bill = async (partnerId: string, amount: string, date: string) =>
    bills.post(
      (
        await bills.createDraft({
          partnerId,
          date: new Date(date),
          lines: [line(acc['5-2000'], amount)],
          createdBy: 'creator',
        })
      ).id,
      'poster',
    );
  const pay = async (
    direction: 'RECEIPT' | 'DISBURSEMENT',
    partnerId: string,
    amount: string,
    date: string,
    allocations: {
      salesInvoiceId?: string;
      purchaseBillId?: string;
      amount: string;
    }[] = [],
    opening = false,
  ) =>
    payments.post(
      (
        await payments.createDraft({
          direction,
          partnerId,
          date: new Date(date),
          ...(opening ? { opening: true } : { cashAccountId: acc['1-1000'] }),
          amount,
          allocations,
          createdBy: 'creator',
        })
      ).id,
      'poster',
    );
  const note = async (
    key: 'SALES' | 'PURCHASE',
    original: { id: string; lines?: { id: string }[] },
    date: string,
  ) =>
    notes.post(
      key,
      (
        await notes.createDraft(key, {
          originalId: original.id,
          date: new Date(date),
          lines: [{ originalLineId: original.lines![0].id, quantity: '1' }],
          createdBy: 'creator',
        })
      ).id,
      'poster',
    );

  const statement = async (
    partnerId: string,
    side: Side,
    from: string,
    to: string,
  ) =>
    (
      await get(
        `/v1/reports/partner-statement?partnerId=${partnerId}&side=${side}&from=${from}&to=${to}`,
      ).expect(200)
    ).body as PartnerStatementResponseDto;

  /** The partner's share of the control / advance account as of `asOf`,
   *  derived independently from the journal: lines of every journal entry of
   *  its documents, payments, notes and credit applications/refunds, plus
   *  their reversals. Sign: what the partner owes us (customer) / we owe
   *  them (vendor); credit = its unapplied credit. */
  const journalShare = async (partnerId: string, side: Side, asOf: string) => {
    const c = side === 'customer';
    const docs = c ? 'sales_invoices' : 'purchase_bills';
    const nts = c ? 'sales_credit_notes' : 'purchase_debit_notes';
    const noteCol = c ? 'sales_credit_note_id' : 'purchase_debit_note_id';
    const dir = c ? 'RECEIPT' : 'DISBURSEMENT';
    const control = role[c ? 'AR_CONTROL' : 'AP_CONTROL'];
    const advance = role[c ? 'CUSTOMER_ADVANCE' : 'VENDOR_ADVANCE'];
    const sign = c ? '' : '-';
    const [r] = await prisma.client.$queryRawUnsafe<
      { control: string; advance: string }[]
    >(
      `WITH src AS (
         SELECT journal_entry_id AS id FROM ${docs} WHERE partner_id = $1
         UNION SELECT journal_entry_id FROM payments
           WHERE partner_id = $1 AND direction::text = '${dir}'
         UNION SELECT journal_entry_id FROM ${nts} WHERE partner_id = $1
         UNION SELECT ap.journal_entry_id FROM payment_applications ap
           LEFT JOIN payments p ON p.id = ap.payment_id
           LEFT JOIN ${nts} n ON n.id = ap.${noteCol}
           WHERE (p.partner_id = $1 AND p.direction::text = '${dir}') OR n.partner_id = $1
       ), jes AS (
         SELECT je.id FROM journal_entries je
         WHERE je.posted_at IS NOT NULL AND je.deleted_at IS NULL
           AND je.date <= $2::date
           AND (je.id IN (SELECT id FROM src) OR je.reversal_of_id IN (SELECT id FROM src))
       )
       SELECT (${sign}COALESCE(SUM(debit - credit) FILTER (WHERE account_id = $3), 0))::text AS control,
              (${sign}COALESCE(SUM(credit - debit) FILTER (WHERE account_id = $4), 0))::text AS advance
       FROM journal_lines WHERE journal_entry_id IN (SELECT id FROM jes)`,
      partnerId,
      asOf,
      control,
      advance,
    );
    return { control: m4(r.control), advance: m4(r.advance) };
  };

  /** Statement from `from` to `asOf` ties to aging, control and advance. */
  const expectTie = async (
    partnerId: string,
    side: Side,
    asOf: string,
    from = '2026-01-01',
  ) => {
    const s = await statement(partnerId, side, from, asOf);
    const aging = await app
      .get(AgingService)
      .aging(
        side === 'customer' ? 'AR' : 'AP',
        new Date(asOf),
        undefined,
        undefined,
        undefined,
        partnerId,
      );
    const share = await journalShare(partnerId, side, asOf);
    expect({
      asOf,
      closing: s.closingBalance,
      credit: s.unappliedCredit,
    }).toEqual({
      asOf,
      closing: aging.totalOutstanding,
      credit: share.advance,
    });
    expect({ asOf, closing: s.closingBalance }).toEqual({
      asOf,
      closing: share.control,
    });
    // closing = opening + movements (both columns), net = balance − credit
    const last = s.lines[s.lines.length - 1];
    if (last)
      expect([last.balance, last.unappliedCredit, last.netBalance]).toEqual([
        s.closingBalance,
        s.unappliedCredit,
        s.netBalance,
      ]);
    expect(
      Money.of(s.netBalance).equals(
        Money.of(s.closingBalance).subtract(Money.of(s.unappliedCredit)),
      ),
    ).toBe(true);
    return s;
  };

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());
    await app.get(CompanyService).seedIfEmpty();
    await app.get(AccountsService).seedIfEmpty();
    await app.get(TaxCodesService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const { data: accounts } = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    role = Object.fromEntries(
      accounts.filter((a) => a.role).map((a) => [a.role!, a.id]),
    );
    payments = app.get(PaymentsService);
    notes = app.get(NotesService);
    invoices = app.get(SalesInvoicesService);
    bills = app.get(PurchaseBillsService);
    partners = app.get(BusinessPartnersService);
    await app.get(UsersService).create({
      email: 'view@ps.test',
      password: 'secret123',
      name: 'Viewer',
      role: 'VIEWER',
    });
    token = (await app.get(AuthService).login('view@ps.test', 'secret123'))
      .accessToken;
  }, 120_000);

  afterAll(() => cleanup());

  let cust: string;
  let inv4Id: string;

  it('customer: full history ties to aging, AR control and the advance account at every date', async () => {
    cust = (
      await partners.create({
        code: 'PS/1 "x"',
        name: 'Toko Statement',
        isCustomer: true,
      })
    ).id;
    const noise = await partner({ isCustomer: true });
    await invoice(noise, '777000', '2026-02-01');

    await pay('RECEIPT', cust, '50000', '2026-01-02', [], true); // opening credit
    const inv1 = await invoice(cust, '1000000', '2026-02-01');
    const inv2 = await invoice(cust, '500000', '2026-02-05');
    const p1 = await pay('RECEIPT', cust, '1200000', '2026-02-10', [
      { salesInvoiceId: inv1.id, amount: '800000' },
    ]); // 400k advance
    await payments.apply(
      p1.id,
      new Date('2026-02-12'),
      [{ salesInvoiceId: inv2.id, amount: '300000' }],
      'poster',
    );
    // inv2 outstanding 200k: the note credits 200k, excess 300k is credit.
    const cn = await note('SALES', inv2, '2026-02-15');
    expect(m4(cn.creditedAmount)).toBe('200000.0000');
    const refunded = await payments.refund(
      p1.id,
      {
        date: new Date('2026-02-20'),
        amount: '100000',
        cashAccountId: acc['1-1100'],
      },
      'poster',
    );
    const refundId = refunded.applications.find((a) => a.cashAccountId)!.id;
    await payments.reverseRefund(
      p1.id,
      refundId,
      'poster',
      new Date('2026-03-05'),
    );
    const inv3 = await invoice(cust, '300000', '2026-03-01');
    await notes.apply(
      'SALES',
      cn.id,
      new Date('2026-03-02'),
      [{ salesInvoiceId: inv3.id, amount: '300000' }],
      'poster',
    );
    // Backdated receipt (dated 02-03, posted now), voided on 04-15.
    const back = await pay('RECEIPT', cust, '200000', '2026-02-03', [
      { salesInvoiceId: inv1.id, amount: '200000' },
    ]);
    await payments.void(back.id, 'voider', new Date('2026-04-15'));
    // An advance-only receipt voided a few days later.
    const p3 = await pay('RECEIPT', cust, '100000', '2026-04-20');
    await payments.void(p3.id, 'voider', new Date('2026-04-25'));
    // inv4 voided AFTER the 05-31 statement end.
    const inv4 = await invoice(cust, '250000', '2026-04-01');
    inv4Id = inv4.id;
    await invoices.void(inv4.id, 'voider', new Date('2026-06-15'));

    for (const asOf of [
      '2026-01-01',
      '2026-01-31',
      '2026-02-01',
      '2026-02-03',
      '2026-02-11',
      '2026-02-12',
      '2026-02-15',
      '2026-02-20',
      '2026-03-01',
      '2026-03-05',
      '2026-04-14',
      '2026-04-15',
      '2026-04-22',
      '2026-05-31',
      '2026-06-15',
      '2026-09-30',
    ])
      await expectTie(cust, 'customer', asOf);

    const full = await expectTie(cust, 'customer', '2026-09-30');
    expect(full.partner).toEqual({
      id: cust,
      code: 'PS/1 "x"',
      name: 'Toko Statement',
    });
    expect(full.openingBalance).toBe('0.0000');
    // 1,000,000 + 500,000 + 300,000 + 250,000 − 250,000 (void) − 800,000
    // − 300,000 (adv) − 200,000 (note) − 300,000 (note excess) = 200,000
    // (inv1's remaining 200k: the backdated payment was voided).
    expect(full.closingBalance).toBe('200000.0000');
    // credit: 50k opening + 400k advance − 300k applied + 300k note excess
    // − 300k applied (refund reversed, p3 voided) = 150k
    expect(full.unappliedCredit).toBe('150000.0000');
    expect(full.netBalance).toBe('50000.0000');
    expect(full.lines.map((l) => [l.date, l.type])).toEqual([
      ['2026-01-02', 'OPENING_CREDIT'],
      ['2026-02-01', 'INVOICE'],
      ['2026-02-03', 'PAYMENT'],
      ['2026-02-05', 'INVOICE'],
      ['2026-02-10', 'PAYMENT'],
      ['2026-02-12', 'CREDIT_APPLICATION'],
      ['2026-02-15', 'CREDIT_NOTE'],
      ['2026-02-20', 'REFUND'],
      ['2026-03-01', 'INVOICE'],
      ['2026-03-02', 'CREDIT_APPLICATION'],
      ['2026-03-05', 'REFUND_REVERSAL'],
      ['2026-04-01', 'INVOICE'],
      ['2026-04-15', 'PAYMENT_VOID'],
      ['2026-04-20', 'PAYMENT'],
      ['2026-04-25', 'PAYMENT_VOID'],
      ['2026-06-15', 'INVOICE_VOID'],
    ]);
    const p1Line = full.lines[4];
    expect(p1Line).toMatchObject({
      paymentId: p1.id,
      ref: p1.ref,
      debit: '0.0000',
      credit: '800000.0000',
      unappliedCreditChange: '400000.0000',
    });
    const cnApply = full.lines[9];
    expect(cnApply).toMatchObject({
      noteId: cn.id,
      documentId: inv3.id,
      ref: cn.ref,
      documentRef: inv3.invoiceRef,
      credit: '300000.0000',
      unappliedCreditChange: '-300000.0000',
    });
    expect(full.lines[6]).toMatchObject({
      type: 'CREDIT_NOTE',
      documentId: inv2.id,
      credit: '200000.0000',
      unappliedCreditChange: '300000.0000',
    });
    // Totals: closing = opening + debit − credit.
    expect(
      Money.of(full.totalDebit)
        .subtract(Money.of(full.totalCredit))
        .toPersistence(),
    ).toBe('200000.0000');
  });

  it('a window opens at the earlier closing; void after `to` stays open as of `to`', async () => {
    const feb = await statement(cust, 'customer', '2026-01-01', '2026-02-11');
    const rest = await statement(cust, 'customer', '2026-02-12', '2026-09-30');
    expect([
      rest.openingBalance,
      rest.openingUnappliedCredit,
      rest.openingNetBalance,
    ]).toEqual([feb.closingBalance, feb.unappliedCredit, feb.netBalance]);
    // As of 02-11 the backdated receipt (02-03, voided 04-15) is live.
    expect(feb.closingBalance).toBe('500000.0000');

    const may = await expectTie(cust, 'customer', '2026-05-31');
    expect(may.lines.some((l) => l.documentId === inv4Id)).toBe(true);
    expect(may.lines.some((l) => l.type === 'INVOICE_VOID')).toBe(false);
    const aging = (
      await get(
        `/v1/reports/ar-aging?asOf=2026-05-31&partnerId=${cust}`,
      ).expect(200)
    ).body as AgingReportDto;
    expect(aging.partners.map((p) => p.partnerId)).toEqual([cust]);
    expect(aging.totalOutstanding).toBe(may.closingBalance);
    expect(aging.partners[0].documents.map((d) => d.outstanding)).toContain(
      '250000.0000',
    );
    const june = await statement(cust, 'customer', '2026-06-01', '2026-06-30');
    expect(june.lines).toEqual([
      expect.objectContaining({
        date: '2026-06-15',
        type: 'INVOICE_VOID',
        documentId: inv4Id,
        credit: '250000.0000',
        balance: '200000.0000',
      }),
    ]);
  });

  it('per-partner aging: totals cover that partner only; composes with afterPartnerId; unknown partner 422', async () => {
    const all = (await get('/v1/reports/ar-aging?asOf=2026-09-30').expect(200))
      .body as AgingReportDto;
    const one = (
      await get(
        `/v1/reports/ar-aging?asOf=2026-09-30&partnerId=${cust}`,
      ).expect(200)
    ).body as AgingReportDto;
    expect(all.partners.length).toBeGreaterThan(1);
    expect(one.partners).toEqual(
      all.partners.filter((p) => p.partnerId === cust),
    );
    expect(one.totalOutstanding).toBe('200000.0000');
    expect(one.documentCount).toBe(1);
    const after = (
      await get(
        `/v1/reports/ar-aging?asOf=2026-09-30&partnerId=${cust}&afterPartnerId=${cust}`,
      ).expect(200)
    ).body as AgingReportDto;
    expect(after.partners).toEqual([]);
    expect(after.totalOutstanding).toBe('200000.0000');
    await get(
      '/v1/reports/ap-aging?partnerId=00000000-0000-4000-8000-000000000000',
    ).expect(422);
  });

  it('vendor: bills, disbursements, debit note excess, application, refund, bill void tie to AP and the vendor advance', async () => {
    const v = await partner({ isVendor: true });
    const b1 = await bill(v, '900000', '2026-03-01');
    const b2 = await bill(v, '400000', '2026-03-03');
    const d1 = await pay('DISBURSEMENT', v, '1000000', '2026-03-05', [
      { purchaseBillId: b1.id, amount: '600000' },
    ]); // 400k prepayment
    await payments.apply(
      d1.id,
      new Date('2026-03-06'),
      [{ purchaseBillId: b2.id, amount: '400000' }],
      'poster',
    );
    // b1 outstanding 300k: whole-bill debit note credits 300k, 600k excess.
    const dn = await note('PURCHASE', b1, '2026-03-10');
    await notes.refund(
      'PURCHASE',
      dn.id,
      {
        date: new Date('2026-03-12'),
        amount: '200000',
        cashAccountId: acc['1-1000'],
      },
      'poster',
    );
    const b3 = await bill(v, '150000', '2026-03-15');
    const b4 = await bill(v, '80000', '2026-03-20');
    await bills.void(b4.id, 'voider', new Date('2026-04-02'));
    await notes.apply(
      'PURCHASE',
      dn.id,
      new Date('2026-03-16'),
      [{ purchaseBillId: b3.id, amount: '100000' }],
      'poster',
    );
    for (const asOf of [
      '2026-03-01',
      '2026-03-05',
      '2026-03-06',
      '2026-03-10',
      '2026-03-12',
      '2026-03-16',
      '2026-03-31',
      '2026-04-02',
      '2026-09-30',
    ])
      await expectTie(v, 'vendor', asOf);
    const s = await statement(v, 'vendor', '2026-03-01', '2026-09-30');
    // AP: 900 + 400 + 150 + 80 − 80 − 600 − 400 − 300 − 100 = 50k (b3 rest)
    expect(s.closingBalance).toBe('50000.0000');
    // credit: 400 − 400 + 600 − 200 − 100 = 300k
    expect(s.unappliedCredit).toBe('300000.0000');
    expect(s.lines[0]).toMatchObject({
      type: 'BILL',
      credit: '900000.0000',
      debit: '0.0000',
      balance: '900000.0000',
    });
    expect(s.lines.find((l) => l.type === 'PAYMENT')).toMatchObject({
      debit: '600000.0000',
      unappliedCreditChange: '400000.0000',
    });
    expect(s.lines.find((l) => l.type === 'BILL_VOID')).toMatchObject({
      date: '2026-04-02',
      debit: '80000.0000',
    });
    expect(s.lines.find((l) => l.type === 'REFUND')).toMatchObject({
      noteId: dn.id,
      ref: dn.ref,
      unappliedCreditChange: '-200000.0000',
    });
  });

  it('CSV / XLSX export: sanitized filename, Saldo Awal / Saldo Akhir tie to JSON', async () => {
    const url = `/v1/reports/partner-statement?partnerId=${cust}&side=customer&from=2026-02-12&to=2026-05-31`;
    const json = (await get(url).expect(200))
      .body as PartnerStatementResponseDto;
    const name = 'partner-statement-PS_1__x_-2026-02-12_2026-05-31';
    const csv = await get(`${url}&format=csv`).expect(200);
    expect(csv.headers['content-disposition']).toBe(
      `attachment; filename="${name}.csv"`,
    );
    expect(csv.text).toContain('Kartu Piutang');
    expect(csv.text).toContain(`Saldo Awal,,,${json.openingBalance}`);
    expect(csv.text).toContain(
      `Saldo Akhir,,,${json.closingBalance},,${json.unappliedCredit},${json.netBalance}`,
    );
    const xlsx = await get(`${url}&format=xlsx`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(xlsx.headers['content-disposition']).toBe(
      `attachment; filename="${name}.xlsx"`,
    );
    const rows = readXlsx(xlsx.body as Buffer).rows;
    const closing = rows.find((r) => r[3] === 'Saldo Akhir')!;
    expect([closing[6], closing[8], closing[9]].map(Number)).toEqual(
      [json.closingBalance, json.unappliedCredit, json.netBalance].map(Number),
    );
    expect(rows.filter((r) => r[1] === 'Penerapan Kredit').length).toBe(
      json.lines.filter((l) => l.type === 'CREDIT_APPLICATION').length,
    );
  });

  it('partner rules: 404 unknown / soft-deleted, 422 wrong side, historical role allowed, span + date validation', async () => {
    const base = '/v1/reports/partner-statement';
    const q = (
      id: string,
      side = 'customer',
      from = '2026-01-01',
      to = '2026-06-30',
    ) => `${base}?partnerId=${id}&side=${side}&from=${from}&to=${to}`;
    await get(q('00000000-0000-4000-8000-000000000000')).expect(404);
    await get(q(cust, 'vendor')).expect(422);
    await get(q(cust, 'both')).expect(400);
    await get(q(cust, 'customer', '2025-01-01', '2026-06-30')).expect(422);
    await get(q(cust, 'customer', '2026-06-30', '2026-01-01')).expect(422);
    await get(q(cust, 'customer', '2026-1-1', '2026-06-30')).expect(400);

    // Historical vendor: vendor role cleared after its only bill was paid.
    const both = await partner({ isCustomer: true, isVendor: true });
    const b = await bill(both, '1000', '2026-05-01');
    await pay('DISBURSEMENT', both, '1000', '2026-05-02', [
      { purchaseBillId: b.id, amount: '1000' },
    ]);
    await partners.update(both, { isVendor: false });
    const hist = (await get(q(both, 'vendor')).expect(200))
      .body as PartnerStatementResponseDto;
    expect(hist.lines.map((l) => l.type)).toEqual(['BILL', 'PAYMENT']);
    expect(hist.closingBalance).toBe('0.0000');

    // Soft-deleted partner → 404.
    const gone = await partner({ isCustomer: true });
    await partners.softDelete(gone, 'x');
    await get(q(gone)).expect(404);
  });
});
