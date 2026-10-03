import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { BalancesService } from '../src/ledger/balances/balances.service';
import { JournalService } from '../src/ledger/journal/journal.service';
import { CompanyService } from '../src/company/company.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { SalesInvoicesService } from '../src/invoicing/sales-invoices.service';
import { PurchaseBillsService } from '../src/invoicing/purchase-bills.service';
import { PaymentsService } from '../src/invoicing/payments.service';
import { NotesService } from '../src/invoicing/notes.service';
import { CashFlowService } from '../src/reporting/cash-flow.service';
import { AgingService } from '../src/reporting/aging.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import {
  DomainError,
  NotFoundDomainError,
  SegregationOfDutiesError,
  ValidationFailedError,
} from '../src/common/errors/domain-errors';
import { Money } from '../src/common/money/money';
import { bootstrapTestApp } from './e2e-helpers';

/**
 * Refunds of unapplied credit (payment advances, credit/debit note excess)
 * in cash, and opening (go-live) customer/vendor credit. Throughout: AR/AP
 * aging == control, each advance account == Σ unapplied over posted payments
 * AND notes, and the cash-flow report reconciles.
 */
describe('Credit refunds + opening credit (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let payments: PaymentsService;
  let notes: NotesService;
  let invoices: SalesInvoicesService;
  let bills: PurchaseBillsService;
  let acc: Record<string, string>;
  let role: Record<string, string>;
  let acct: string;
  let appr: string;
  let n = 0;

  const server = () => app.getHttpServer() as App;
  const m4 = (v: { toString(): string } | string) =>
    Money.of(v.toString()).toPersistence();

  const partner = async (kind: 'isCustomer' | 'isVendor') =>
    (
      await app.get(BusinessPartnersService).create({
        code: `RF-${++n}`,
        name: `Refund partner ${n}`,
        [kind]: true,
      })
    ).id;

  const line = (accountId: string, amount: string) => ({
    description: 'x',
    accountId,
    quantity: '1',
    unitPrice: amount,
    taxCodeIds: [],
  });

  const postedInvoice = async (
    partnerId: string,
    amount: string,
    date: string,
  ) => {
    const d = await invoices.createDraft({
      partnerId,
      date: new Date(date),
      lines: [line(acc['4-1000'], amount)],
      createdBy: 'creator',
    });
    return invoices.post(d.id, 'poster');
  };

  const postedBill = async (
    partnerId: string,
    amount: string,
    date: string,
  ) => {
    const d = await bills.createDraft({
      partnerId,
      date: new Date(date),
      lines: [line(acc['5-2000'], amount)],
      createdBy: 'creator',
    });
    return bills.post(d.id, 'poster');
  };

  const advance = async (
    direction: 'RECEIPT' | 'DISBURSEMENT',
    partnerId: string,
    amount: string,
    date: string,
    allocations: {
      salesInvoiceId?: string;
      purchaseBillId?: string;
      amount: string;
    }[] = [],
  ) => {
    const d = await payments.createDraft({
      direction,
      partnerId,
      date: new Date(date),
      cashAccountId: acc['1-1000'],
      amount,
      allocations,
      createdBy: 'creator',
    });
    return payments.post(d.id, 'poster');
  };

  const openingCredit = async (
    direction: 'RECEIPT' | 'DISBURSEMENT',
    partnerId: string,
    amount: string,
    date: string,
  ) => {
    const d = await payments.createDraft({
      direction,
      partnerId,
      date: new Date(date),
      opening: true,
      amount,
      allocations: [],
      createdBy: 'creator',
    });
    return payments.post(d.id, 'poster');
  };

  const refund = (
    id: string,
    amount: string,
    date: string,
    by = 'poster',
    cashAccountId = acc['1-1100'],
  ) => payments.refund(id, { date: new Date(date), amount, cashAccountId }, by);

  /** Journal lines, order-independent. */
  const linesOf = async (journalEntryId: string) =>
    (await prisma.client.journalLine.findMany({ where: { journalEntryId } }))
      .map((l) => ({
        accountId: l.accountId,
        debit: m4(l.debit),
        credit: m4(l.credit),
      }))
      .sort((a, b) =>
        `${a.accountId}${a.debit}`.localeCompare(`${b.accountId}${b.debit}`),
      );
  const jl = (accountId: string, debit: string, credit: string) => ({
    accountId,
    debit: m4(debit),
    credit: m4(credit),
  });
  const sorted = (ls: ReturnType<typeof jl>[]) =>
    [...ls].sort((a, b) =>
      `${a.accountId}${a.debit}`.localeCompare(`${b.accountId}${b.debit}`),
    );

  const balance = async (accountId: string, asOf: string) =>
    m4(
      (await app.get(BalancesService).accountBalance(accountId, new Date(asOf)))
        .balance,
    );

  /** AR/AP aging == control; each advance account == Σ unapplied of the
   *  POSTED payments and notes on its side; cash flow reconciles. */
  const expectTies = async (asOf = '2026-09-30') => {
    const aging = app.get(AgingService);
    for (const [kind, r] of [
      ['AR', 'AR_CONTROL'],
      ['AP', 'AP_CONTROL'],
    ] as const)
      expect({
        kind,
        total: (await aging.aging(kind, new Date(asOf))).totalOutstanding,
      }).toEqual({
        kind,
        total: await balance(role[r], asOf),
      });
    for (const [dir, notesTable, r] of [
      ['RECEIPT', 'sales_credit_notes', 'CUSTOMER_ADVANCE'],
      ['DISBURSEMENT', 'purchase_debit_notes', 'VENDOR_ADVANCE'],
    ] as const) {
      const [{ s }] = await prisma.client.$queryRawUnsafe<{ s: string }[]>(
        `SELECT (
           (SELECT COALESCE(SUM(unapplied_amount), 0) FROM payments
             WHERE status = 'POSTED' AND deleted_at IS NULL AND direction::text = $1)
         + (SELECT COALESCE(SUM(unapplied_amount), 0) FROM ${notesTable}
             WHERE status = 'POSTED' AND deleted_at IS NULL))::text AS s`,
        dir,
      );
      expect({ r, bal: await balance(role[r], asOf) }).toEqual({
        r,
        bal: m4(s),
      });
    }
    const cf = await app
      .get(CashFlowService)
      .generate(new Date('2026-01-01'), new Date(asOf));
    expect(cf.reconciles).toBe(true);
  };

  const expectDomain = async (
    p: Promise<unknown>,
    type: new (...a: never[]) => DomainError,
    message?: string | RegExp,
  ) => {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(type);
    if (message) expect((err as Error).message).toMatch(message);
    return err as DomainError;
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
    const users = app.get(UsersService);
    for (const [email, r] of [
      ['acct@rf.test', 'ACCOUNTANT'],
      ['appr@rf.test', 'APPROVER'],
    ] as const)
      await users.create({ email, password: 'secret123', name: r, role: r });
    acct = (await app.get(AuthService).login('acct@rf.test', 'secret123'))
      .accessToken;
    appr = (await app.get(AuthService).login('appr@rf.test', 'secret123'))
      .accessToken;
  }, 120_000);

  afterAll(() => cleanup());

  it('customer advance: partial then full refund (Dr Uang Muka Pelanggan / Cr bank); fully refunded holder is no longer an open item', async () => {
    const c = await partner('isCustomer');
    const p = await advance('RECEIPT', c, '1000000', '2026-02-01');
    const after1 = await refund(p.id, '400000', '2026-02-10');
    const shown = payments.present(after1) as unknown as {
      unappliedAmount: string;
      applications: unknown[];
      refunds: { id: string; amount: string; cashAccountId: string }[];
    };
    expect(shown.unappliedAmount).toBe('600000.0000');
    expect(shown.applications).toEqual([]);
    expect(shown.refunds).toEqual([
      expect.objectContaining({
        amount: '400000.0000',
        cashAccountId: acc['1-1100'],
        paymentId: p.id,
        date: new Date('2026-02-10'),
        reversedOn: null,
      }),
    ]);
    const r1 = after1.applications[0];
    expect(await linesOf(r1.journalEntryId)).toEqual(
      sorted([
        jl(role.CUSTOMER_ADVANCE, '400000', '0'),
        jl(acc['1-1100'], '0', '400000'),
      ]),
    );
    const je = await prisma.client.journalEntry.findUniqueOrThrow({
      where: { id: r1.journalEntryId },
    });
    expect(je).toMatchObject({
      sourceType: 'PAYMENT',
      sourceId: p.id,
      createdBy: 'creator',
      postedBy: 'poster',
      status: 'POSTED',
    });
    await expectTies();

    // Still has credit → partner is not deletable (open item).
    const partners = app.get(BusinessPartnersService);
    await expectDomain(partners.softDelete(c, 'x'), ValidationFailedError);
    const after2 = await refund(p.id, '600000', '2026-02-11');
    expect(m4(after2.unappliedAmount)).toBe('0.0000');
    await expectTies();
    // Fully refunded: no open items left, the partner may be deleted.
    await partners.softDelete(c, 'x');
  });

  it('refund guards: over-refund, draft/void holder, date before holder, future date, non-CASH account, zero, SoD', async () => {
    const c = await partner('isCustomer');
    const p = await advance('RECEIPT', c, '500000', '2026-03-01');
    const e = await expectDomain(
      refund(p.id, '500000.0001', '2026-03-02'),
      ValidationFailedError,
      /Refund exceeds the payment unapplied amount/,
    );
    expect(e.details).toEqual({
      id: p.id,
      unappliedAmount: '500000.0000',
      requested: '500000.0001',
    });
    const before = await expectDomain(
      refund(p.id, '1', '2026-02-28'),
      ValidationFailedError,
      /Refund date cannot be before the payment date/,
    );
    expect(before.details).toMatchObject({ paymentDate: '2026-03-01' });
    await expectDomain(
      refund(p.id, '1', '2099-01-01'),
      ValidationFailedError,
      /Refund date cannot be in the future/,
    );
    await expectDomain(
      refund(p.id, '1', '2026-03-02', 'poster', acc['1-1200']),
      ValidationFailedError,
      /CASH-role/,
    );
    await expectDomain(
      refund(p.id, '0', '2026-03-02'),
      ValidationFailedError,
      /must be positive/,
    );
    // SoD: the holder's creator cannot refund it (like posting / applying).
    await expectDomain(
      refund(p.id, '1', '2026-03-02', 'creator'),
      SegregationOfDutiesError,
    );
    const draft = await payments.createDraft({
      direction: 'RECEIPT',
      partnerId: c,
      date: new Date('2026-03-01'),
      cashAccountId: acc['1-1000'],
      amount: '100',
      allocations: [],
      createdBy: 'creator',
    });
    await expectDomain(
      refund(draft.id, '1', '2026-03-02'),
      ValidationFailedError,
      /Only a POSTED payment can be refunded/,
    );
    // An inactive partner cannot be refunded (same rule as apply).
    await app.get(BusinessPartnersService).deactivate(c);
    await expectDomain(
      refund(p.id, '1', '2026-03-02'),
      ValidationFailedError,
      /Partner is inactive/,
    );
    await app.get(BusinessPartnersService).update(c, { isActive: true });
    expect(m4((await payments.getById(p.id)).unappliedAmount)).toBe(
      '500000.0000',
    );
    await expectTies();
  });

  it('reverse a refund: journal reversed, credit restored; routes do not cross; void blocked while a refund is live', async () => {
    const c = await partner('isCustomer');
    const p = await advance('RECEIPT', c, '300000', '2026-04-01');
    const inv = await postedInvoice(c, '100000', '2026-04-01');
    await payments.apply(
      p.id,
      new Date('2026-04-02'),
      [{ salesInvoiceId: inv.id, amount: '100000' }],
      'poster',
    );
    const afterRefund = await refund(p.id, '150000', '2026-04-03');
    const app1 = afterRefund.applications.find((a) => !a.cashAccountId)!;
    const r = afterRefund.applications.find((a) => a.cashAccountId)!;
    expect(m4(afterRefund.unappliedAmount)).toBe('50000.0000');

    // Void refused while an application or refund is live.
    const hv = await expectDomain(
      payments.void(p.id, 'voider', new Date('2026-04-05')),
      ValidationFailedError,
      /applications and refunds before voiding/,
    );
    expect(hv.details).toMatchObject({
      reason: 'HAS_APPLICATIONS',
      applications: 2,
    });
    // The routes do not cross: an application id is not a refund and back.
    await expectDomain(
      payments.reverseRefund(p.id, app1.id, 'poster'),
      NotFoundDomainError,
      /Payment refund not found/,
    );
    await expectDomain(
      payments.reverseApplication(p.id, r.id, 'poster'),
      NotFoundDomainError,
      /Payment application not found/,
    );
    await expectDomain(
      payments.reverseRefund(p.id, r.id, 'poster', new Date('2099-01-01')),
      ValidationFailedError,
      /Reversal date cannot be in the future/,
    );

    const reversed = await payments.reverseRefund(
      p.id,
      r.id,
      'poster',
      new Date('2026-04-04'),
    );
    expect(m4(reversed.unappliedAmount)).toBe('200000.0000');
    const row = reversed.applications.find((a) => a.id === r.id)!;
    expect(row.reversedOn).toEqual(new Date('2026-04-04'));
    const original = await prisma.client.journalEntry.findUniqueOrThrow({
      where: { id: r.journalEntryId },
      include: { reversal: true },
    });
    expect(original.status).toBe('REVERSED');
    expect(original.reversal!.date).toEqual(new Date('2026-04-04'));
    expect(await linesOf(original.reversal!.id)).toEqual(
      sorted([
        jl(role.CUSTOMER_ADVANCE, '0', '150000'),
        jl(acc['1-1100'], '150000', '0'),
      ]),
    );
    // The invoice the application settled is untouched by the refund reversal.
    expect(m4((await invoices.getById(inv.id)).amountPaid)).toBe('100000.0000');
    await expectDomain(
      payments.reverseRefund(p.id, r.id, 'poster'),
      ValidationFailedError,
      /Payment refund was already reversed/,
    );
    await expectTies();

    // Reverse the application too; then the void must not predate the refund
    // reversal (2026-04-04).
    await payments.reverseApplication(p.id, app1.id, 'poster');
    await expectDomain(
      payments.void(p.id, 'voider', new Date('2026-04-03')),
      ValidationFailedError,
      /Void date cannot be before the reversal date/,
    );
    const voided = await payments.void(p.id, 'voider', new Date('2026-04-04'));
    expect(voided.status).toBe('VOID');
    await expectTies();
  });

  it('vendor advance: refund received is Dr bank / Cr Uang Muka Pembelian', async () => {
    const v = await partner('isVendor');
    const p = await advance('DISBURSEMENT', v, '800000', '2026-05-01');
    const after = await refund(p.id, '800000', '2026-05-05');
    expect(m4(after.unappliedAmount)).toBe('0.0000');
    expect(await linesOf(after.applications[0].journalEntryId)).toEqual(
      sorted([
        jl(acc['1-1100'], '800000', '0'),
        jl(role.VENDOR_ADVANCE, '0', '800000'),
      ]),
    );
    await expectTies();
  });

  it('credit-note excess and debit-note excess are refundable; note void blocked while a refund is live', async () => {
    // Customer: fully paid invoice, then fully returned → 100 000 excess.
    const c = await partner('isCustomer');
    const inv = await postedInvoice(c, '100000', '2026-05-10');
    await advance('RECEIPT', c, '100000', '2026-05-11', [
      { salesInvoiceId: inv.id, amount: '100000' },
    ]);
    const cn = await notes.post(
      'SALES',
      (
        await notes.createDraft('SALES', {
          originalId: inv.id,
          date: new Date('2026-05-12'),
          lines: [{ originalLineId: inv.lines![0].id, quantity: '1' }],
          createdBy: 'creator',
        })
      ).id,
      'poster',
    );
    expect(m4(cn.unappliedAmount)).toBe('100000.0000');
    await expectDomain(
      notes.refund(
        'SALES',
        cn.id,
        {
          date: new Date('2026-05-13'),
          amount: '100000.01',
          cashAccountId: acc['1-1000'],
        },
        'poster',
      ),
      ValidationFailedError,
      /Refund exceeds the credit note unapplied amount/,
    );
    const refunded = await notes.refund(
      'SALES',
      cn.id,
      {
        date: new Date('2026-05-13'),
        amount: '60000',
        cashAccountId: acc['1-1000'],
      },
      'poster',
    );
    const shown = notes.present(refunded) as unknown as {
      unappliedAmount: string;
      refunds: {
        id: string;
        journalEntryId: string;
        salesCreditNoteId: string;
      }[];
      applications: unknown[];
    };
    expect(shown.unappliedAmount).toBe('40000.0000');
    expect(shown.applications).toEqual([]);
    expect(shown.refunds).toHaveLength(1);
    expect(shown.refunds[0].salesCreditNoteId).toBe(cn.id);
    expect(await linesOf(shown.refunds[0].journalEntryId)).toEqual(
      sorted([
        jl(role.CUSTOMER_ADVANCE, '60000', '0'),
        jl(acc['1-1000'], '0', '60000'),
      ]),
    );
    const je = await prisma.client.journalEntry.findUniqueOrThrow({
      where: { id: shown.refunds[0].journalEntryId },
    });
    expect(je.sourceType).toBe('SALES_CREDIT_NOTE');
    await expectDomain(
      notes.void('SALES', cn.id, 'voider', new Date('2026-05-14')),
      ValidationFailedError,
      /applications and refunds before voiding/,
    );
    await expectTies();
    const back = await notes.reverseRefund(
      'SALES',
      cn.id,
      shown.refunds[0].id,
      'poster',
    );
    expect(m4(back.unappliedAmount)).toBe('100000.0000');
    await expectTies();

    // Vendor: fully paid bill, fully returned → refund the excess in cash.
    const v = await partner('isVendor');
    const bill = await postedBill(v, '250000', '2026-05-10');
    await advance('DISBURSEMENT', v, '250000', '2026-05-11', [
      { purchaseBillId: bill.id, amount: '250000' },
    ]);
    const dn = await notes.post(
      'PURCHASE',
      (
        await notes.createDraft('PURCHASE', {
          originalId: bill.id,
          date: new Date('2026-05-12'),
          lines: [{ originalLineId: bill.lines![0].id, quantity: '1' }],
          createdBy: 'creator',
        })
      ).id,
      'poster',
    );
    const dnRefunded = await notes.refund(
      'PURCHASE',
      dn.id,
      {
        date: new Date('2026-05-15'),
        amount: '250000',
        cashAccountId: acc['1-1100'],
      },
      'poster',
    );
    expect(m4(dnRefunded.unappliedAmount)).toBe('0.0000');
    expect(await linesOf(dnRefunded.applications![0].journalEntryId)).toEqual(
      sorted([
        jl(acc['1-1100'], '250000', '0'),
        jl(role.VENDOR_ADVANCE, '0', '250000'),
      ]),
    );
    await expectTies();
  });

  it('concurrent apply + refund over the same credit: exactly one wins, the other 422; unapplied never negative (3x)', async () => {
    for (let i = 0; i < 3; i++) {
      const c = await partner('isCustomer');
      const p = await advance('RECEIPT', c, '1000000', '2026-06-01');
      const inv = await postedInvoice(c, '700000', '2026-06-01');
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      const holder = prisma.client.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM payments WHERE id = ${p.id} FOR UPDATE`;
          locked();
          await gate;
        },
        { maxWait: 5000, timeout: 20000 },
      );
      await isLocked;
      const settle = (x: Promise<unknown>) =>
        x.then(
          () => null,
          (e: unknown) => e,
        );
      const racing = Promise.all([
        settle(
          payments.apply(
            p.id,
            new Date('2026-06-02'),
            [{ salesInvoiceId: inv.id, amount: '700000' }],
            'poster',
          ),
        ),
        settle(refund(p.id, '700000', '2026-06-02')),
      ]);
      // Both must be parked on the payment row lock before release; THROW on
      // timeout so the test can never pass without racing.
      for (let k = 0; ; k++) {
        const [{ w }] = await prisma.client.$queryRaw<{ w: number }[]>`
          SELECT count(*)::int AS w FROM pg_locks WHERE NOT granted`;
        if (w >= 2) break;
        if (k > 200) {
          release();
          throw new Error('timed out waiting for 2 lock waiters');
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      release();
      await holder;
      const results = await racing;
      expect(results.filter((r) => r === null)).toHaveLength(1);
      const loser = results.find((r) => r !== null);
      expect(loser).toBeInstanceOf(ValidationFailedError);
      expect((loser as Error).message).toMatch(
        /exceeds the payment unapplied amount/,
      );
      const fresh = await payments.getById(p.id);
      expect(fresh.applications).toHaveLength(1);
      expect(m4(fresh.unappliedAmount)).toBe('300000.0000');
    }
    await expectTies();
  }, 120_000);

  it('cash flow: a refund is an operating outflow on the advance account and the report reconciles', async () => {
    const c = await partner('isCustomer');
    const p = await advance('RECEIPT', c, '900000', '2026-07-01');
    await refund(p.id, '900000', '2026-07-02');
    const cf = await app
      .get(CashFlowService)
      .generate(new Date('2026-07-02'), new Date('2026-07-02'));
    expect(cf.reconciles).toBe(true);
    expect(cf.operating.adjustments).toEqual([
      expect.objectContaining({ code: '2-1300', amount: '-900000.0000' }),
    ]);
    expect(cf.netChange).toBe('-900000.0000');
  });

  it('opening credit: Dr Saldo Awal / Cr Uang Muka Pelanggan (no cash), then apply + refund; excluded from cash flow', async () => {
    const c = await partner('isCustomer');
    const p = await openingCredit('RECEIPT', c, '500000', '2026-08-01');
    expect(payments.present(p)).toMatchObject({
      opening: true,
      cashAccountId: role.OPENING_BALANCE_EQUITY,
      amount: '500000.0000',
      unappliedAmount: '500000.0000',
      status: 'POSTED',
    });
    expect(await linesOf(p.journalEntryId!)).toEqual(
      sorted([
        jl(role.OPENING_BALANCE_EQUITY, '500000', '0'),
        jl(role.CUSTOMER_ADVANCE, '0', '500000'),
      ]),
    );
    // Not a cash flow: nothing in the report for the day, still reconciles.
    const cf = await app
      .get(CashFlowService)
      .generate(new Date('2026-08-01'), new Date('2026-08-01'));
    expect(cf).toMatchObject({
      reconciles: true,
      netChange: '0.0000',
      operating: { adjustments: [] },
      financing: { lines: [] },
    });
    const inv = await postedInvoice(c, '300000', '2026-08-02');
    await payments.apply(
      p.id,
      new Date('2026-08-03'),
      [{ salesInvoiceId: inv.id, amount: '300000' }],
      'poster',
    );
    const after = await refund(p.id, '200000', '2026-08-04');
    expect(m4(after.unappliedAmount)).toBe('0.0000');
    expect(m4((await invoices.getById(inv.id)).amountPaid)).toBe('300000.0000');
    await expectTies();
  });

  it('vendor opening credit is Dr Uang Muka Pembelian / Cr Saldo Awal; refundable', async () => {
    const v = await partner('isVendor');
    const p = await openingCredit('DISBURSEMENT', v, '120000', '2026-08-01');
    expect(await linesOf(p.journalEntryId!)).toEqual(
      sorted([
        jl(role.VENDOR_ADVANCE, '120000', '0'),
        jl(role.OPENING_BALANCE_EQUITY, '0', '120000'),
      ]),
    );
    await refund(p.id, '120000', '2026-08-05');
    // Void of the opening credit itself after reversing the refund.
    const r = (await payments.getById(p.id)).applications[0];
    await payments.reverseRefund(p.id, r.id, 'poster');
    const voided = await payments.void(p.id, 'voider', new Date('2026-08-05'));
    expect(voided.status).toBe('VOID');
    await expectTies();
  });

  it('opening credit shape: no cash account, no allocations, amount required', async () => {
    const c = await partner('isCustomer');
    const base = {
      direction: 'RECEIPT' as const,
      partnerId: c,
      date: new Date('2026-08-01'),
      opening: true,
      createdBy: 'creator',
    };
    for (const bad of [
      { amount: '1', cashAccountId: acc['1-1000'], allocations: [] },
      {
        amount: '1',
        allocations: [{ salesInvoiceId: randomUUID(), amount: '1' }],
      },
      { allocations: [] },
    ]) {
      const e = await expectDomain(
        payments.createDraft({ ...base, ...bad }),
        ValidationFailedError,
      );
      expect(e.details).toMatchObject({ reason: 'OPENING_CREDIT_SHAPE' });
    }
    await expectDomain(
      payments.createDraft({
        ...base,
        opening: false,
        amount: '1',
        allocations: [],
      }),
      ValidationFailedError,
      /cashAccountId is required/,
    );
  });

  it('an OPENING entry may not touch the advance accounts (422 ADVANCE_IN_OPENING)', async () => {
    for (const r of ['CUSTOMER_ADVANCE', 'VENDOR_ADVANCE'] as const) {
      const e = await expectDomain(
        app
          .get(JournalService)
          .postOpeningBalances(
            new Date('2026-01-01'),
            [{ accountId: role[r], debit: '1000' }],
            'admin',
          ),
        ValidationFailedError,
        /opening credit/,
      );
      expect(e.details).toEqual({
        accountId: role[r],
        role: r,
        reason: 'ADVANCE_IN_OPENING',
      });
    }
  });

  describe('HTTP', () => {
    it('opening credit create → post → refund → reverse refund; roles, DTO, idempotency', async () => {
      const c = await partner('isCustomer');
      // opening with a cashAccountId is refused
      await request(server())
        .post('/v1/payments')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          direction: 'RECEIPT',
          partnerId: c,
          date: '2026-08-10',
          opening: true,
          cashAccountId: acc['1-1000'],
          amount: '50000',
        })
        .expect(422);
      // a normal payment still needs cashAccountId (DTO)
      await request(server())
        .post('/v1/payments')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          direction: 'RECEIPT',
          partnerId: c,
          date: '2026-08-10',
          amount: '1',
        })
        .expect(400);
      const created = await request(server())
        .post('/v1/payments')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          direction: 'RECEIPT',
          partnerId: c,
          date: '2026-08-10',
          opening: true,
          amount: '50000',
        })
        .expect(201);
      const id = (created.body as { id: string }).id;
      expect(created.body).toMatchObject({
        opening: true,
        unappliedAmount: '50000.0000',
        applications: [],
        refunds: [],
      });
      await request(server())
        .post(`/v1/payments/${id}/post`)
        .set('Authorization', `Bearer ${appr}`)
        .set('Idempotency-Key', randomUUID())
        .expect(200);

      const body = {
        date: '2026-08-11',
        amount: '20000',
        cashAccountId: acc['1-1100'],
        description: 'Kembalikan deposit',
      };
      await request(server())
        .post(`/v1/payments/${id}/refunds`)
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', randomUUID())
        .send(body)
        .expect(403);
      await request(server())
        .post(`/v1/payments/${id}/refunds`)
        .set('Authorization', `Bearer ${appr}`)
        .send(body)
        .expect(422); // Idempotency-Key required
      await request(server())
        .post(`/v1/payments/${id}/refunds`)
        .set('Authorization', `Bearer ${appr}`)
        .set('Idempotency-Key', randomUUID())
        .send({ ...body, cashAccountId: 'nope' })
        .expect(400);
      const refunded = await request(server())
        .post(`/v1/payments/${id}/refunds`)
        .set('Authorization', `Bearer ${appr}`)
        .set('Idempotency-Key', randomUUID())
        .send(body)
        .expect(200);
      const rb = refunded.body as {
        unappliedAmount: string;
        applications: unknown[];
        refunds: { id: string; amount: string; journalEntryId: string }[];
      };
      expect(rb.unappliedAmount).toBe('30000.0000');
      expect(rb.applications).toEqual([]);
      expect(rb.refunds).toEqual([
        expect.objectContaining({
          amount: '20000.0000',
          cashAccountId: acc['1-1100'],
          date: '2026-08-11T00:00:00.000Z',
        }),
      ]);
      const je = await prisma.client.journalEntry.findUniqueOrThrow({
        where: { id: rb.refunds[0].journalEntryId },
      });
      expect(je.description).toBe('Kembalikan deposit');
      const reversed = await request(server())
        .post(`/v1/payments/${id}/refunds/${rb.refunds[0].id}/reverse`)
        .set('Authorization', `Bearer ${appr}`)
        .set('Idempotency-Key', randomUUID())
        .send({ date: '2026-08-12' })
        .expect(200);
      expect(reversed.body).toMatchObject({
        unappliedAmount: '50000.0000',
        refunds: [
          expect.objectContaining({ reversedOn: '2026-08-12T00:00:00.000Z' }),
        ],
      });
      await expectTies();
    });

    it('note refunds route: POST /v1/sales-credit-notes/:id/refunds', async () => {
      const c = await partner('isCustomer');
      const inv = await postedInvoice(c, '40000', '2026-08-15');
      await advance('RECEIPT', c, '40000', '2026-08-15', [
        { salesInvoiceId: inv.id, amount: '40000' },
      ]);
      const cn = await notes.post(
        'SALES',
        (
          await notes.createDraft('SALES', {
            originalId: inv.id,
            date: new Date('2026-08-16'),
            lines: [{ originalLineId: inv.lines![0].id, quantity: '1' }],
            createdBy: 'creator',
          })
        ).id,
        'poster',
      );
      const res = await request(server())
        .post(`/v1/sales-credit-notes/${cn.id}/refunds`)
        .set('Authorization', `Bearer ${appr}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          date: '2026-08-17',
          amount: '40000',
          cashAccountId: acc['1-1000'],
        })
        .expect(200);
      const b = res.body as {
        unappliedAmount: string;
        refunds: { id: string }[];
      };
      expect(b.unappliedAmount).toBe('0.0000');
      await request(server())
        .post(
          `/v1/sales-credit-notes/${cn.id}/refunds/${b.refunds[0].id}/reverse`,
        )
        .set('Authorization', `Bearer ${appr}`)
        .set('Idempotency-Key', randomUUID())
        .expect(200);
      await expectTies();
    });
  });

  it('DB CHECKs: a refund row has exactly one target (cash account XOR document)', async () => {
    const c = await partner('isCustomer');
    const p = await advance('RECEIPT', c, '1000', '2026-09-01');
    const inv = await postedInvoice(c, '1000', '2026-09-01');
    const after = await refund(p.id, '10', '2026-09-02');
    const r = after.applications[0];
    await expect(
      prisma.client.$executeRaw`
        UPDATE payment_applications SET sales_invoice_id = ${inv.id} WHERE id = ${r.id}`,
    ).rejects.toThrow(/payment_applications_one_target/);
    await expect(
      prisma.client.$executeRaw`
        UPDATE payment_applications SET cash_account_id = NULL WHERE id = ${r.id}`,
    ).rejects.toThrow(/payment_applications_one_target/);
  });
});
