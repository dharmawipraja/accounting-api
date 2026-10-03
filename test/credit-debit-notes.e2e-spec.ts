import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { BalancesService } from '../src/ledger/balances/balances.service';
import { CompanyService } from '../src/company/company.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { SalesInvoicesService } from '../src/invoicing/sales-invoices.service';
import { PurchaseBillsService } from '../src/invoicing/purchase-bills.service';
import { PaymentsService } from '../src/invoicing/payments.service';
import {
  NoteKindKey,
  NoteRow,
  NotesService,
} from '../src/invoicing/notes.service';
import { AgingService } from '../src/reporting/aging.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import {
  ConflictDomainError,
  DomainError,
  NotFoundDomainError,
  SegregationOfDutiesError,
  ValidationFailedError,
} from '../src/common/errors/domain-errors';
import { Money } from '../src/common/money/money';
import { bootstrapTestApp } from './e2e-helpers';
import { expectAgingPrefilterEquivalent } from './aging-prefilter-equivalence';

/**
 * Sales credit notes (nota retur penjualan) and purchase debit notes (nota
 * retur pembelian), each linked to ONE posted invoice / bill: priced from the
 * original lines (copied price/tax codes, pro-rated discounts), mirrored
 * journal, settlement first settles the original (creditedTotal), the excess
 * is partner credit on the advance account (applied like a payment advance),
 * over-return guarded under the original's lock, void rules. Throughout:
 * AR/AP aging == control on every checked date, and each advance account ==
 * the posted payments' + notes' unapplied amounts.
 */
describe('Credit / debit notes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let notes: NotesService;
  let invoices: SalesInvoicesService;
  let bills: PurchaseBillsService;
  let payments: PaymentsService;
  let acc: Record<string, string>;
  let role: Record<string, string>;
  let tax: Record<string, string>;
  let acct: string;
  let appr: string;
  let n = 0;

  const server = () => app.getHttpServer() as App;
  const m4 = (v: unknown) => Money.of(String(v)).toPersistence();

  const partner = async (kind: 'isCustomer' | 'isVendor') =>
    (
      await app.get(BusinessPartnersService).create({
        code: `NOTE-${++n}`,
        name: `Note partner ${n}`,
        [kind]: true,
      })
    ).id;

  type Line = {
    accountId?: string;
    quantity: string;
    unitPrice: string;
    discountPercent?: string;
    discountAmount?: string;
    taxCodeIds?: string[];
  };
  const docLines = (lines: Line[], account: string) =>
    lines.map((l, i) => ({
      description: `Line ${i + 1}`,
      accountId: l.accountId ?? account,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discountPercent: l.discountPercent,
      discountAmount: l.discountAmount,
      taxCodeIds: l.taxCodeIds ?? [],
    }));

  const postedInvoice = async (
    partnerId: string,
    date: string,
    lines: Line[],
  ) => {
    const d = await invoices.createDraft({
      partnerId,
      date: new Date(date),
      lines: docLines(lines, acc['4-1000']),
      createdBy: 'creator',
    });
    return invoices.post(d.id, 'poster');
  };

  const postedBill = async (partnerId: string, date: string, lines: Line[]) => {
    const d = await bills.createDraft({
      partnerId,
      date: new Date(date),
      lines: docLines(lines, acc['5-2000']),
      createdBy: 'creator',
    });
    return bills.post(d.id, 'poster');
  };

  const pay = async (
    direction: 'RECEIPT' | 'DISBURSEMENT',
    partnerId: string,
    date: string,
    alloc: { salesInvoiceId?: string; purchaseBillId?: string; amount: string },
  ) => {
    const d = await payments.createDraft({
      direction,
      partnerId,
      date: new Date(date),
      cashAccountId: acc['1-1000'],
      allocations: [alloc],
      createdBy: 'creator',
    });
    return payments.post(d.id, 'poster');
  };

  const draftNote = (
    key: NoteKindKey,
    originalId: string,
    date: string,
    lines: { originalLineId: string; quantity: string }[],
  ) =>
    notes.createDraft(key, {
      originalId,
      date: new Date(date),
      lines,
      createdBy: 'creator',
    });

  const postedNote = async (
    key: NoteKindKey,
    originalId: string,
    date: string,
    lines: { originalLineId: string; quantity: string }[],
  ) =>
    notes.post(
      key,
      (await draftNote(key, originalId, date, lines)).id,
      'poster',
    );

  /** Journal lines, order-independent. */
  const linesOf = async (journalEntryId: string) =>
    (await prisma.client.journalLine.findMany({ where: { journalEntryId } }))
      .map((l) => ({
        accountId: l.accountId,
        debit: m4(l.debit),
        credit: m4(l.credit),
      }))
      .sort((a, b) =>
        `${a.accountId}${a.debit}${a.credit}`.localeCompare(
          `${b.accountId}${b.debit}${b.credit}`,
        ),
      );
  const jl = (accountId: string, debit: string, credit: string) => ({
    accountId,
    debit: m4(debit),
    credit: m4(credit),
  });
  const sorted = (xs: ReturnType<typeof jl>[]) =>
    [...xs].sort((a, b) =>
      `${a.accountId}${a.debit}${a.credit}`.localeCompare(
        `${b.accountId}${b.debit}${b.credit}`,
      ),
    );

  const balance = async (accountId: string, asOf: string) =>
    m4(
      (await app.get(BalancesService).accountBalance(accountId, new Date(asOf)))
        .balance,
    );

  /** AR/AP aging == control on each date; each advance account == the
   *  posted payments' + notes' unapplied amounts (current state). */
  const expectTies = async (dates: string[]) => {
    const aging = app.get(AgingService);
    for (const asOf of dates)
      for (const [kind, r] of [
        ['AR', 'AR_CONTROL'],
        ['AP', 'AP_CONTROL'],
      ] as const) {
        const report = await aging.aging(kind, new Date(asOf));
        expect({ asOf, kind, total: report.totalOutstanding }).toEqual({
          asOf,
          kind,
          total: await balance(role[r], asOf),
        });
      }
    for (const [dir, noteTable, r] of [
      ['RECEIPT', 'sales_credit_notes', 'CUSTOMER_ADVANCE'],
      ['DISBURSEMENT', 'purchase_debit_notes', 'VENDOR_ADVANCE'],
    ] as const) {
      const [{ s }] = await prisma.client.$queryRawUnsafe<{ s: string }[]>(
        `SELECT ((SELECT COALESCE(SUM(unapplied_amount), 0) FROM payments
                  WHERE status = 'POSTED' AND deleted_at IS NULL
                    AND direction::text = $1)
               + (SELECT COALESCE(SUM(unapplied_amount), 0) FROM ${noteTable}
                  WHERE status = 'POSTED' AND deleted_at IS NULL))::text AS s`,
        dir,
      );
      expect({ r, bal: await balance(role[r], '2026-12-31') }).toEqual({
        r,
        bal: m4(s),
      });
    }
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

  const outstanding = async (kind: 'invoice' | 'bill', id: string) => {
    const row =
      kind === 'invoice'
        ? invoices.present(await invoices.getById(id))
        : bills.present(await bills.getById(id));
    return {
      creditedTotal: row.creditedTotal as unknown as string,
      outstanding: row.outstanding,
      paymentStatus: row.paymentStatus,
    };
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
    tax = Object.fromEntries(
      (await prisma.client.taxCode.findMany()).map((t) => [t.code, t.id]),
    );
    notes = app.get(NotesService);
    invoices = app.get(SalesInvoicesService);
    bills = app.get(PurchaseBillsService);
    payments = app.get(PaymentsService);
    const users = app.get(UsersService);
    for (const [email, r] of [
      ['acct@notes.test', 'ACCOUNTANT'],
      ['appr@notes.test', 'APPROVER'],
    ] as const)
      await users.create({ email, password: 'secret123', name: r, role: r });
    acct = (await app.get(AuthService).login('acct@notes.test', 'secret123'))
      .accessToken;
    appr = (await app.get(AuthService).login('appr@notes.test', 'secret123'))
      .accessToken;
  }, 120_000);

  afterAll(() => cleanup());

  it('partial then full return of a sales invoice with % and fixed discounts, PPN and PPh 23', async () => {
    const c = await partner('isCustomer');
    const taxes = [tax['PPN-OUT-11'], tax['PPH23-PRE']];
    // L1: 10 × 100 000 − 10% = 900 000; L2: 4 × 50 000 − 20 000 = 180 000.
    // DPP 1 080 000, PPN 118 800, PPh 21 600 → total 1 177 200.
    const inv = await postedInvoice(c, '2026-03-01', [
      {
        quantity: '10',
        unitPrice: '100000',
        discountPercent: '10',
        taxCodeIds: taxes,
      },
      {
        quantity: '4',
        unitPrice: '50000',
        discountAmount: '20000',
        taxCodeIds: taxes,
      },
    ]);
    expect(m4(inv.total)).toBe('1177200.0000');
    const [l1, l2] = inv.lines!;

    // Return 3 of L1 (same 10%) and 1 of L2 (20 000 × 1/4 = 5 000):
    // DPP 270 000 + 45 000 = 315 000; PPN 34 650; PPh 6 300 → 343 350.
    const cn1 = await postedNote('SALES', inv.id, '2026-03-05', [
      { originalLineId: l1.id, quantity: '3' },
      { originalLineId: l2.id, quantity: '1' },
    ]);
    expect(notes.present(cn1)).toMatchObject({
      status: 'POSTED',
      ref: 'CN/2026/000001',
      partnerId: c,
      originalId: inv.id,
      subtotal: '315000.0000',
      discountTotal: '35000.0000',
      taxTotal: '34650.0000',
      withholdingTotal: '6300.0000',
      total: '343350.0000',
      creditedAmount: '343350.0000',
      unappliedAmount: '0.0000',
      lines: [
        {
          originalLineId: l1.id,
          accountId: acc['4-1000'],
          quantity: '3.0000',
          unitPrice: '100000.0000',
          discountPercent: '10.0000',
          discountAmount: '30000.0000',
          amount: '270000.0000',
          taxCodeIds: taxes,
        },
        {
          originalLineId: l2.id,
          quantity: '1.0000',
          unitPrice: '50000.0000',
          discountPercent: null,
          discountAmount: '5000.0000',
          amount: '45000.0000',
        },
      ],
    });
    // Mirror of the invoice journal for the returned part.
    expect(await linesOf(cn1.journalEntryId!)).toEqual(
      sorted([
        jl(acc['4-1000'], '270000', '0'),
        jl(acc['4-1000'], '45000', '0'),
        jl(acc['2-1100'], '34650', '0'),
        jl(acc['1-1500'], '0', '6300'),
        jl(role.AR_CONTROL, '0', '343350'),
      ]),
    );
    const je = await prisma.client.journalEntry.findUniqueOrThrow({
      where: { id: cn1.journalEntryId! },
    });
    expect(je).toMatchObject({
      sourceType: 'SALES_CREDIT_NOTE',
      sourceId: cn1.id,
    });
    expect(await outstanding('invoice', inv.id)).toEqual({
      creditedTotal: '343350.0000',
      outstanding: '833850.0000',
      paymentStatus: 'PARTIAL',
    });

    // Over-return: only 7 of L1 remain.
    await expectDomain(
      draftNote('SALES', inv.id, '2026-03-06', [
        { originalLineId: l1.id, quantity: '7.0001' },
      ]),
      ValidationFailedError,
      /exceeds the quantity still returnable/,
    );

    // The rest: 7 × 100 000 − 10% = 630 000; 3 × 50 000 − 15 000 = 135 000;
    // DPP 765 000, PPN 84 150, PPh 15 300 → 833 850 (notes sum = invoice total).
    const cn2 = await postedNote('SALES', inv.id, '2026-03-06', [
      { originalLineId: l1.id, quantity: '7' },
      { originalLineId: l2.id, quantity: '3' },
    ]);
    expect(notes.present(cn2)).toMatchObject({
      ref: 'CN/2026/000002',
      total: '833850.0000',
      creditedAmount: '833850.0000',
      unappliedAmount: '0.0000',
    });
    expect(await outstanding('invoice', inv.id)).toEqual({
      creditedTotal: '1177200.0000',
      outstanding: '0.0000',
      paymentStatus: 'PAID',
    });
    // Fully returned: nothing left on any line.
    await expectDomain(
      draftNote('SALES', inv.id, '2026-03-07', [
        { originalLineId: l2.id, quantity: '0.0001' },
      ]),
      ValidationFailedError,
      /exceeds the quantity still returnable/,
    );
    // A credited invoice is settled: no payment may be allocated to it.
    await expectDomain(
      pay('RECEIPT', c, '2026-03-08', { salesInvoiceId: inv.id, amount: '1' }),
      ValidationFailedError,
      /exceeds the document outstanding/,
    );
    await expectTies(['2026-03-04', '2026-03-05', '2026-03-06', '2026-03-31']);
  });

  it('input rules: posted original, own lines once, positive quantity, date on/after the original', async () => {
    const c = await partner('isCustomer');
    const inv = await postedInvoice(c, '2026-03-10', [
      { quantity: '2', unitPrice: '1000' },
    ]);
    const other = await postedInvoice(c, '2026-03-10', [
      { quantity: '2', unitPrice: '1000' },
    ]);
    const line = inv.lines![0].id;
    const draftInv = await invoices.createDraft({
      partnerId: c,
      date: new Date('2026-03-10'),
      lines: docLines([{ quantity: '1', unitPrice: '1' }], acc['4-1000']),
      createdBy: 'creator',
    });
    await expectDomain(
      draftNote('SALES', draftInv.id, '2026-03-11', [
        { originalLineId: line, quantity: '1' },
      ]),
      ValidationFailedError,
      /only return a POSTED invoice/,
    );
    await expectDomain(
      draftNote('SALES', randomUUID(), '2026-03-11', []),
      NotFoundDomainError,
      /Sales invoice not found/,
    );
    await expectDomain(
      draftNote('SALES', inv.id, '2026-03-11', [
        { originalLineId: other.lines![0].id, quantity: '1' },
      ]),
      ValidationFailedError,
      /does not belong to the invoice/,
    );
    await expectDomain(
      draftNote('SALES', inv.id, '2026-03-11', [
        { originalLineId: line, quantity: '1' },
        { originalLineId: line, quantity: '1' },
      ]),
      ValidationFailedError,
      /at most once per note/,
    );
    await expectDomain(
      draftNote('SALES', inv.id, '2026-03-11', [
        { originalLineId: line, quantity: '0' },
      ]),
      ValidationFailedError,
      /must be positive/,
    );
    await expectDomain(
      draftNote('SALES', inv.id, '2026-03-09', [
        { originalLineId: line, quantity: '1' },
      ]),
      ValidationFailedError,
      /before the date of the document it returns/,
    );
    // A bill is not a sales credit note's original.
    const v = await partner('isVendor');
    const bill = await postedBill(v, '2026-03-10', [
      { quantity: '1', unitPrice: '1000' },
    ]);
    await expectDomain(
      draftNote('SALES', bill.id, '2026-03-11', [
        { originalLineId: bill.lines![0].id, quantity: '1' },
      ]),
      NotFoundDomainError,
    );
  });

  it('drafts count toward the returnable quantity; editing a draft re-checks it', async () => {
    const c = await partner('isCustomer');
    const inv = await postedInvoice(c, '2026-03-12', [
      { quantity: '10', unitPrice: '1000' },
    ]);
    const line = inv.lines![0].id;
    const a = await draftNote('SALES', inv.id, '2026-03-12', [
      { originalLineId: line, quantity: '6' },
    ]);
    const err = await expectDomain(
      draftNote('SALES', inv.id, '2026-03-12', [
        { originalLineId: line, quantity: '5' },
      ]),
      ValidationFailedError,
      /exceeds the quantity still returnable/,
    );
    expect(err.details).toMatchObject({
      originalLineId: line,
      quantity: '5.0000',
      returnable: '4.0000',
    });
    // Editing A within its own share is fine (A itself is not double-counted).
    const edited = await notes.update('SALES', a.id, {
      lines: [{ originalLineId: line, quantity: '10' }],
    });
    expect(notes.present(edited)).toMatchObject({ total: '10000.0000' });
    // A date-only edit keeps the lines (and their original links).
    const redated = await notes.update('SALES', a.id, {
      date: new Date('2026-03-13'),
      description: 'Retur',
    });
    expect(redated.lines![0]).toMatchObject({ originalLineId: line });
    await notes.deleteDraft('SALES', a.id, 'creator');
    await expectDomain(
      notes.post('SALES', a.id, 'poster'),
      NotFoundDomainError,
    );
    const b = await postedNote('SALES', inv.id, '2026-03-13', [
      { originalLineId: line, quantity: '5' },
    ]);
    expect(m4(b.creditedAmount)).toBe('5000.0000');
  });

  it('concurrent note creates on one original cannot over-return (original FOR UPDATE)', async () => {
    const c = await partner('isCustomer');
    const inv = await postedInvoice(c, '2026-03-14', [
      { quantity: '5', unitPrice: '1000' },
    ]);
    const line = inv.lines![0].id;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = prisma.client.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM sales_invoices WHERE id = ${inv.id} FOR UPDATE`;
        locked();
        await gate;
      },
      { maxWait: 5000, timeout: 20000 },
    );
    await isLocked;
    const settle = (p: Promise<NoteRow>) =>
      p.then(
        (v) => ({ ok: true as const, v }),
        (err: unknown) => ({ ok: false as const, err }),
      );
    const x = settle(
      draftNote('SALES', inv.id, '2026-03-14', [
        { originalLineId: line, quantity: '3' },
      ]),
    );
    const y = settle(
      draftNote('SALES', inv.id, '2026-03-14', [
        { originalLineId: line, quantity: '3' },
      ]),
    );
    // Both creates must be parked on the original's row lock before release.
    for (let i = 0; ; i++) {
      const [{ w }] = await prisma.client.$queryRaw<{ w: number }[]>`
        SELECT count(*)::int AS w FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE '%AS outstanding%FOR UPDATE%'`;
      if (w >= 2) break;
      if (i > 200) throw new Error('expected 2 lock waiters');
      await new Promise((r) => setTimeout(r, 50));
    }
    release();
    await holder;
    const results = await Promise.all([x, y]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok)!;
    expect(!loser.ok && loser.err).toBeInstanceOf(ValidationFailedError);
    expect(
      await prisma.client.salesCreditNote.count({
        where: { originalId: inv.id },
      }),
    ).toBe(1);
  });

  it('a note post racing a payment on the same invoice never over-settles it', async () => {
    for (let i = 0; i < 3; i++) {
      const c = await partner('isCustomer');
      const inv = await postedInvoice(c, '2026-03-15', [
        { quantity: '1', unitPrice: '100000', taxCodeIds: [tax['PPN-OUT-11']] },
      ]);
      const note = await draftNote('SALES', inv.id, '2026-03-16', [
        { originalLineId: inv.lines![0].id, quantity: '1' },
      ]);
      const p = await payments.createDraft({
        direction: 'RECEIPT',
        partnerId: c,
        date: new Date('2026-03-16'),
        cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: inv.id, amount: '111000' }],
        createdBy: 'creator',
      });
      const [np, pp] = await Promise.allSettled([
        notes.post('SALES', note.id, 'poster'),
        payments.post(p.id, 'poster'),
      ]);
      expect(np.status).toBe('fulfilled');
      const posted = await notes.getById('SALES', note.id);
      const fresh = await invoices.getById(inv.id);
      if (pp.status === 'fulfilled') {
        // Payment first: the note's whole settlement became partner credit.
        expect(m4(posted.creditedAmount)).toBe('0.0000');
        expect(m4(posted.unappliedAmount)).toBe('111000.0000');
      } else {
        expect(pp.reason).toBeInstanceOf(ConflictDomainError);
        expect(m4(posted.creditedAmount)).toBe('111000.0000');
      }
      expect(
        Money.of(fresh.amountPaid.toString())
          .add(Money.of(fresh.creditedTotal.toString()))
          .toPersistence(),
      ).toBe('111000.0000');
    }
    await expectTies(['2026-03-15', '2026-03-16', '2026-03-31']);
  });

  it('returning a paid invoice: the excess is partner credit on Uang Muka Pelanggan, applied and reversed like an advance', async () => {
    const c = await partner('isCustomer');
    const inv = await postedInvoice(c, '2026-04-01', [
      { quantity: '1', unitPrice: '100000', taxCodeIds: [tax['PPN-OUT-11']] },
    ]);
    await pay('RECEIPT', c, '2026-04-02', {
      salesInvoiceId: inv.id,
      amount: '100000',
    });
    // Outstanding 11 000: the full return (111 000) settles it, 100 000 is excess.
    const cn = await postedNote('SALES', inv.id, '2026-04-03', [
      { originalLineId: inv.lines![0].id, quantity: '1' },
    ]);
    expect(notes.present(cn)).toMatchObject({
      total: '111000.0000',
      creditedAmount: '11000.0000',
      unappliedAmount: '100000.0000',
    });
    expect(await linesOf(cn.journalEntryId!)).toEqual(
      sorted([
        jl(acc['4-1000'], '100000', '0'),
        jl(acc['2-1100'], '11000', '0'),
        jl(role.AR_CONTROL, '0', '11000'),
        jl(role.CUSTOMER_ADVANCE, '0', '100000'),
      ]),
    );
    expect(await outstanding('invoice', inv.id)).toMatchObject({
      outstanding: '0.0000',
      paymentStatus: 'PAID',
    });
    await expectTies(['2026-04-02', '2026-04-03']);

    // Apply 60 000 of the credit to another invoice (SoD: not by its creator).
    const inv2 = await postedInvoice(c, '2026-04-04', [
      { quantity: '1', unitPrice: '200000' },
    ]);
    const alloc = [{ salesInvoiceId: inv2.id, amount: '60000' }];
    await expectDomain(
      notes.apply('SALES', cn.id, new Date('2026-04-05'), alloc, 'creator'),
      SegregationOfDutiesError,
    );
    await expectDomain(
      notes.apply('SALES', cn.id, new Date('2026-04-02'), alloc, 'poster'),
      ValidationFailedError,
      /before the credit note date/,
    );
    await expectDomain(
      notes.apply(
        'SALES',
        cn.id,
        new Date('2026-04-05'),
        [{ salesInvoiceId: inv2.id, amount: '100000.0001' }],
        'poster',
      ),
      ValidationFailedError,
      /exceeds the credit note unapplied amount/,
    );
    const applied = await notes.apply(
      'SALES',
      cn.id,
      new Date('2026-04-05'),
      alloc,
      'poster',
    );
    expect(notes.present(applied)).toMatchObject({
      unappliedAmount: '40000.0000',
      applications: [
        {
          salesCreditNoteId: cn.id,
          paymentId: null,
          salesInvoiceId: inv2.id,
          amount: '60000.0000',
          reversedOn: null,
        },
      ],
    });
    const app1 = applied.applications![0];
    expect(await linesOf(app1.journalEntryId)).toEqual(
      sorted([
        jl(role.CUSTOMER_ADVANCE, '60000', '0'),
        jl(role.AR_CONTROL, '0', '60000'),
      ]),
    );
    expect(m4((await invoices.getById(inv2.id)).amountPaid)).toBe('60000.0000');
    await expectTies(['2026-04-04', '2026-04-05', '2026-04-30']);

    // Void: refused while the application is live, then after its reversal.
    await expectDomain(
      notes.void('SALES', cn.id, 'poster'),
      ValidationFailedError,
      /Reverse this credit note's applications/,
    );
    const reversed = await notes.reverseApplication(
      'SALES',
      cn.id,
      app1.id,
      'poster',
      new Date('2026-04-06'),
    );
    expect(m4(reversed.unappliedAmount)).toBe('100000.0000');
    await expectDomain(
      notes.void('SALES', cn.id, 'poster', new Date('2026-04-05')),
      ValidationFailedError,
      /reversal date of an application of this credit note/,
    );
    const voided = await notes.void(
      'SALES',
      cn.id,
      'poster',
      new Date('2026-04-06'),
    );
    expect(notes.present(voided)).toMatchObject({
      status: 'VOID',
      voidedOn: new Date('2026-04-06'),
      creditedAmount: '11000.0000',
      unappliedAmount: '0.0000',
    });
    expect(await outstanding('invoice', inv.id)).toEqual({
      creditedTotal: '0.0000',
      outstanding: '11000.0000',
      paymentStatus: 'PARTIAL',
    });
    // As of the days the note was live its credit still counts; afterwards not.
    await expectTies(['2026-04-03', '2026-04-05', '2026-04-06', '2026-04-30']);
  });

  it('void rules: original blocked by live notes; note void dates; only POSTED notes', async () => {
    const c = await partner('isCustomer');
    const inv = await postedInvoice(c, '2026-05-01', [
      { quantity: '2', unitPrice: '50000' },
    ]);
    const line = inv.lines![0].id;
    const draft = await draftNote('SALES', inv.id, '2026-05-02', [
      { originalLineId: line, quantity: '1' },
    ]);
    await expectDomain(
      invoices.void(inv.id, 'poster'),
      ValidationFailedError,
      /with live credit notes/,
    );
    await expectDomain(
      notes.void('SALES', draft.id, 'poster'),
      ValidationFailedError,
      /Only a POSTED credit note can be voided/,
    );
    const posted = await notes.post('SALES', draft.id, 'poster');
    await expectDomain(
      invoices.void(inv.id, 'poster'),
      ValidationFailedError,
      /with live credit notes/,
    );
    await expectDomain(
      notes.void('SALES', posted.id, 'poster', new Date('2026-05-01')),
      ValidationFailedError,
      /before the document date/,
    );
    await expectDomain(
      notes.void('SALES', posted.id, 'poster', new Date('2099-01-01')),
      ValidationFailedError,
      /in the future/,
    );
    const voided = await notes.void('SALES', posted.id, 'poster');
    expect(voided.status).toBe('VOID');
    await expectDomain(
      notes.void('SALES', posted.id, 'poster'),
      ValidationFailedError,
    );
    // The voided note's quantity is returnable again.
    const again = await postedNote('SALES', inv.id, '2026-05-03', [
      { originalLineId: line, quantity: '2' },
    ]);
    await notes.void('SALES', again.id, 'poster', new Date('2026-05-04'));
    // No live note left: the invoice voids — on/after the date the later-voided
    // note's credit ended (else aging would drop it while AR still had it).
    await expectDomain(
      invoices.void(inv.id, 'poster', new Date('2026-05-03')),
      ValidationFailedError,
      /void date of a payment allocated/,
    );
    const invVoided = await invoices.void(
      inv.id,
      'poster',
      new Date('2026-05-04'),
    );
    expect(invVoided.status).toBe('VOID');
    await expectTies([
      '2026-05-01',
      '2026-05-02',
      '2026-05-03',
      '2026-05-04',
      '2026-05-31',
    ]);
  });

  it('purchase debit note: mirror of the bill (PPN Masukan, PPh 23), excess to Uang Muka Pembelian, applied to another bill', async () => {
    const v = await partner('isVendor');
    const taxes = [tax['PPN-IN-11'], tax['PPH23-PAY']];
    // 2 × 500 000 − 100 000 = 900 000; PPN 99 000; PPh 18 000 → 981 000.
    const bill = await postedBill(v, '2026-06-01', [
      {
        quantity: '2',
        unitPrice: '500000',
        discountAmount: '100000',
        taxCodeIds: taxes,
      },
    ]);
    expect(m4(bill.total)).toBe('981000.0000');
    await pay('DISBURSEMENT', v, '2026-06-02', {
      purchaseBillId: bill.id,
      amount: '981000',
    });
    // Return 1: 500 000 − 50 000 = 450 000; PPN 49 500; PPh 9 000 → 490 500,
    // all excess (the bill is paid).
    const dn = await postedNote('PURCHASE', bill.id, '2026-06-03', [
      { originalLineId: bill.lines![0].id, quantity: '1' },
    ]);
    expect(notes.present(dn)).toMatchObject({
      ref: 'DN/2026/000001',
      discountTotal: '50000.0000',
      total: '490500.0000',
      creditedAmount: '0.0000',
      unappliedAmount: '490500.0000',
    });
    expect(await linesOf(dn.journalEntryId!)).toEqual(
      sorted([
        jl(acc['5-2000'], '0', '450000'),
        jl(acc['1-1400'], '0', '49500'),
        jl(acc['2-1200'], '9000', '0'),
        jl(role.VENDOR_ADVANCE, '490500', '0'),
      ]),
    );
    expect(await outstanding('bill', bill.id)).toMatchObject({
      creditedTotal: '0.0000',
      outstanding: '0.0000',
    });
    const bill2 = await postedBill(v, '2026-06-04', [
      { quantity: '1', unitPrice: '300000' },
    ]);
    const applied = await notes.apply(
      'PURCHASE',
      dn.id,
      new Date('2026-06-05'),
      [{ purchaseBillId: bill2.id, amount: '300000' }],
      'poster',
    );
    expect(m4(applied.unappliedAmount)).toBe('190500.0000');
    expect(await linesOf(applied.applications![0].journalEntryId)).toEqual(
      sorted([
        jl(role.AP_CONTROL, '300000', '0'),
        jl(role.VENDOR_ADVANCE, '0', '300000'),
      ]),
    );
    expect(await outstanding('bill', bill2.id)).toMatchObject({
      outstanding: '0.0000',
      paymentStatus: 'PAID',
    });
    // A debit note's credit only applies to bills.
    await expectDomain(
      notes.apply(
        'PURCHASE',
        dn.id,
        new Date('2026-06-05'),
        [{ salesInvoiceId: randomUUID(), amount: '1' }],
        'poster',
      ),
      ValidationFailedError,
      /must reference a purchase bill/,
    );
    await expectTies(['2026-06-02', '2026-06-03', '2026-06-05', '2026-06-30']);
  });

  it('purchase debit note on an unpaid bill reduces AP; a partner with open note credit cannot be deleted', async () => {
    const v = await partner('isVendor');
    const bill = await postedBill(v, '2026-06-10', [
      { quantity: '4', unitPrice: '25000' },
    ]);
    const dn = await postedNote('PURCHASE', bill.id, '2026-06-11', [
      { originalLineId: bill.lines![0].id, quantity: '4' },
    ]);
    expect(await linesOf(dn.journalEntryId!)).toEqual(
      sorted([
        jl(acc['5-2000'], '0', '100000'),
        jl(role.AP_CONTROL, '100000', '0'),
      ]),
    );
    expect(await outstanding('bill', bill.id)).toEqual({
      creditedTotal: '100000.0000',
      outstanding: '0.0000',
      paymentStatus: 'PAID',
    });
    await expectTies(['2026-06-10', '2026-06-11']);

    const c = await partner('isCustomer');
    const inv = await postedInvoice(c, '2026-06-10', [
      { quantity: '1', unitPrice: '1000' },
    ]);
    await pay('RECEIPT', c, '2026-06-10', {
      salesInvoiceId: inv.id,
      amount: '1000',
    });
    await postedNote('SALES', inv.id, '2026-06-11', [
      { originalLineId: inv.lines![0].id, quantity: '1' },
    ]);
    await expectDomain(
      app.get(BusinessPartnersService).softDelete(c, 'admin'),
      ValidationFailedError,
      /open items/,
    );
  });

  describe('HTTP', () => {
    const auth = (r: request.Test, token: string, key = randomUUID()) =>
      r.set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key);

    it('create (idempotent) → PATCH → post (APPROVER) → list / journal filter → apply → reverse → void; purchase mirror', async () => {
      const c = await partner('isCustomer');
      const inv = await postedInvoice(c, '2026-07-01', [
        { quantity: '3', unitPrice: '10000' },
      ]);
      const line = inv.lines![0].id;
      const body = {
        originalId: inv.id,
        date: '2026-07-02',
        description: 'Retur barang',
        lines: [{ originalLineId: line, quantity: '1' }],
      };
      // Idempotency-Key is required on create.
      await request(server())
        .post('/v1/sales-credit-notes')
        .set('Authorization', `Bearer ${acct}`)
        .send(body)
        .expect(422);
      await auth(request(server()).post('/v1/sales-credit-notes'), acct)
        .send({ ...body, lines: [{ originalLineId: line, quantity: '-1' }] })
        .expect(400);
      const key = randomUUID();
      const created = await auth(
        request(server()).post('/v1/sales-credit-notes'),
        acct,
        key,
      )
        .send(body)
        .expect(201);
      const id = (created.body as { id: string }).id;
      expect(created.body).toMatchObject({
        status: 'DRAFT',
        ref: null,
        originalId: inv.id,
        partnerId: c,
        total: '10000.0000',
        lines: [{ originalLineId: line, unitPrice: '10000.0000' }],
      });
      // Replay: same response, no second note.
      const replay = await auth(
        request(server()).post('/v1/sales-credit-notes'),
        acct,
        key,
      )
        .send(body)
        .expect(201);
      expect((replay.body as { id: string }).id).toBe(id);
      expect(
        await prisma.client.salesCreditNote.count({
          where: { originalId: inv.id },
        }),
      ).toBe(1);
      await auth(request(server()).patch(`/v1/sales-credit-notes/${id}`), acct)
        .send({ lines: [{ originalLineId: line, quantity: '3' }] })
        .expect(200);
      // ACCOUNTANT may not post.
      await auth(
        request(server()).post(`/v1/sales-credit-notes/${id}/post`),
        acct,
      ).expect(403);
      const posted = await auth(
        request(server()).post(`/v1/sales-credit-notes/${id}/post`),
        appr,
      ).expect(200);
      expect(posted.body).toMatchObject({
        status: 'POSTED',
        total: '30000.0000',
        creditedAmount: '30000.0000',
        unappliedAmount: '0.0000',
        applications: [],
      });
      const invBody = (
        await request(server())
          .get(`/v1/sales-invoices/${inv.id}`)
          .set('Authorization', `Bearer ${acct}`)
          .expect(200)
      ).body as Record<string, unknown>;
      expect(invBody).toMatchObject({
        creditedTotal: '30000.0000',
        outstanding: '0.0000',
      });
      const list = (
        await request(server())
          .get(`/v1/sales-credit-notes?partnerId=${c}&status=POSTED`)
          .set('Authorization', `Bearer ${acct}`)
          .expect(200)
      ).body as { data: { id: string; total: string }[]; total: number };
      expect(list).toMatchObject({
        total: 1,
        data: [{ id, total: '30000.0000' }],
      });
      const journal = (
        await request(server())
          .get('/v1/ledger/journal-entries?sourceType=SALES_CREDIT_NOTE')
          .set('Authorization', `Bearer ${acct}`)
          .expect(200)
      ).body as { data: { sourceId: string; sourceType: string }[] };
      expect(journal.data.map((e) => e.sourceId)).toContain(id);
      // ACCOUNTANT may not void; APPROVER may.
      await auth(
        request(server()).post(`/v1/sales-credit-notes/${id}/void`),
        acct,
      ).expect(403);
      await auth(
        request(server()).post(`/v1/sales-credit-notes/${id}/void`),
        appr,
      )
        .send({ date: '2026-07-03' })
        .expect(200);

      // Purchase side: excess credit applied and reversed over HTTP.
      const v = await partner('isVendor');
      const bill = await postedBill(v, '2026-07-01', [
        { quantity: '2', unitPrice: '10000' },
      ]);
      await pay('DISBURSEMENT', v, '2026-07-01', {
        purchaseBillId: bill.id,
        amount: '20000',
      });
      const bill2 = await postedBill(v, '2026-07-01', [
        { quantity: '1', unitPrice: '5000' },
      ]);
      const dn = (
        await auth(request(server()).post('/v1/purchase-debit-notes'), acct)
          .send({
            originalId: bill.id,
            date: '2026-07-02',
            lines: [{ originalLineId: bill.lines![0].id, quantity: '2' }],
          })
          .expect(201)
      ).body as { id: string };
      await auth(
        request(server()).post(`/v1/purchase-debit-notes/${dn.id}/post`),
        appr,
      ).expect(200);
      const applied = await auth(
        request(server()).post(`/v1/purchase-debit-notes/${dn.id}/apply`),
        appr,
      )
        .send({
          date: '2026-07-03',
          allocations: [{ purchaseBillId: bill2.id, amount: '5000' }],
        })
        .expect(200);
      expect(applied.body).toMatchObject({
        unappliedAmount: '15000.0000',
        applications: [
          {
            purchaseDebitNoteId: dn.id,
            purchaseBillId: bill2.id,
            amount: '5000.0000',
          },
        ],
      });
      const appId = (applied.body as { applications: { id: string }[] })
        .applications[0].id;
      await auth(
        request(server()).post(
          `/v1/purchase-debit-notes/${dn.id}/applications/${randomUUID()}/reverse`,
        ),
        appr,
      ).expect(404);
      await auth(
        request(server()).post(
          `/v1/purchase-debit-notes/${dn.id}/applications/${appId}/reverse`,
        ),
        appr,
      )
        .send({})
        .expect(200);
      // Not before the application's reversal (2026-07-03): 422, then on it.
      await auth(
        request(server()).post(`/v1/purchase-debit-notes/${dn.id}/void`),
        appr,
      ).expect(422);
      await auth(
        request(server()).post(`/v1/purchase-debit-notes/${dn.id}/void`),
        appr,
      )
        .send({ date: '2026-07-03' })
        .expect(200);

      // A draft is deleted (soft) by DELETE.
      const d = (
        await auth(request(server()).post('/v1/purchase-debit-notes'), acct)
          .send({
            originalId: bill.id,
            date: '2026-07-04',
            lines: [{ originalLineId: bill.lines![0].id, quantity: '1' }],
          })
          .expect(201)
      ).body as { id: string };
      await request(server())
        .delete(`/v1/purchase-debit-notes/${d.id}`)
        .set('Authorization', `Bearer ${acct}`)
        .expect(204);
      await request(server())
        .get(`/v1/purchase-debit-notes/${d.id}`)
        .set('Authorization', `Bearer ${acct}`)
        .expect(404);
      await expectTies([
        '2026-07-01',
        '2026-07-02',
        '2026-07-03',
        '2026-07-31',
      ]);
    });
  });
  it('aging pre-filter is equivalent to the exact as-of computation over this history', async () => {
    await expectAgingPrefilterEquivalent(app);
  }, 120_000);
});
