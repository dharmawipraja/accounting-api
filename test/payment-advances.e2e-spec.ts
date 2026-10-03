import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { BalancesService } from '../src/ledger/balances/balances.service';
import { CompanyService } from '../src/company/company.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { SalesInvoicesService } from '../src/invoicing/sales-invoices.service';
import { PurchaseBillsService } from '../src/invoicing/purchase-bills.service';
import { PaymentsService } from '../src/invoicing/payments.service';
import { AgingService } from '../src/reporting/aging.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import {
  DomainError,
  SegregationOfDutiesError,
  ValidationFailedError,
} from '../src/common/errors/domain-errors';
import { Money } from '../src/common/money/money';
import { bootstrapTestApp } from './e2e-helpers';

/**
 * Customer/vendor advances: a payment's unallocated part posts to Uang Muka
 * Pelanggan (2-1300, CUSTOMER_ADVANCE) / Uang Muka Pembelian (1-1600,
 * VENDOR_ADVANCE), is applied to documents later (own journal per
 * application), applications are reversible, and a payment with live
 * applications cannot be voided. Throughout, AR/AP aging == control, and the
 * advance account == the posted payments' unapplied amounts.
 */
describe('Payment advances (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let payments: PaymentsService;
  let invoices: SalesInvoicesService;
  let bills: PurchaseBillsService;
  let acc: Record<string, string>;
  let role: Record<string, string>;
  let acct: string;
  let appr: string;
  let n = 0;

  const server = () => app.getHttpServer() as App;

  const partner = async (kind: 'isCustomer' | 'isVendor') =>
    (
      await app.get(BusinessPartnersService).create({
        code: `ADV-${++n}`,
        name: `Advance partner ${n}`,
        [kind]: true,
      })
    ).id;

  const postedInvoice = async (
    partnerId: string,
    amount: string,
    date: string,
  ) => {
    const d = await invoices.createDraft({
      partnerId,
      date: new Date(date),
      description: 'adv invoice',
      lines: [
        {
          description: 'Jasa',
          accountId: acc['4-1000'],
          quantity: '1',
          unitPrice: amount,
          taxCodeIds: [],
        },
      ],
      createdBy: 'creator',
    });
    return (await invoices.post(d.id, 'poster')).id;
  };

  const postedBill = async (
    partnerId: string,
    amount: string,
    date: string,
  ) => {
    const d = await bills.createDraft({
      partnerId,
      date: new Date(date),
      description: 'adv bill',
      lines: [
        {
          description: 'Sewa',
          accountId: acc['5-2000'],
          quantity: '1',
          unitPrice: amount,
          taxCodeIds: [],
        },
      ],
      createdBy: 'creator',
    });
    return (await bills.post(d.id, 'poster')).id;
  };

  const postedPayment = async (args: {
    direction: 'RECEIPT' | 'DISBURSEMENT';
    partnerId: string;
    date: string;
    amount?: string;
    allocations?: {
      salesInvoiceId?: string;
      purchaseBillId?: string;
      amount: string;
    }[];
  }) => {
    const d = await payments.createDraft({
      direction: args.direction,
      partnerId: args.partnerId,
      date: new Date(args.date),
      cashAccountId: acc['1-1000'],
      amount: args.amount,
      allocations: args.allocations ?? [],
      createdBy: 'creator',
    });
    return payments.post(d.id, 'poster');
  };

  const linesOf = async (journalEntryId: string) =>
    (
      await prisma.client.journalLine.findMany({
        where: { journalEntryId },
        orderBy: { lineNo: 'asc' },
      })
    ).map((l) => ({
      accountId: l.accountId,
      debit: Money.of(l.debit.toString()).toPersistence(),
      credit: Money.of(l.credit.toString()).toPersistence(),
    }));

  const balance = async (accountId: string, asOf: string) =>
    Money.of(
      (await app.get(BalancesService).accountBalance(accountId, new Date(asOf)))
        .balance,
    ).toPersistence();

  /** Every subledger ties to its control on each date: AR/AP aging == the
   *  control balance, and each advance account == the sum of the posted
   *  payments' unapplied amounts (current date only — unapplied is a
   *  current-state column). */
  const expectTies = async (dates: string[]) => {
    const aging = app.get(AgingService);
    for (const asOf of dates) {
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
    }
    for (const [dir, r] of [
      ['RECEIPT', 'CUSTOMER_ADVANCE'],
      ['DISBURSEMENT', 'VENDOR_ADVANCE'],
    ] as const) {
      const [{ s }] = await prisma.client.$queryRaw<{ s: string }[]>`
        SELECT COALESCE(SUM(unapplied_amount), 0)::text AS s FROM payments
        WHERE status = 'POSTED' AND deleted_at IS NULL
          AND direction::text = ${dir}`;
      expect({ r, bal: await balance(role[r], '2026-12-31') }).toEqual({
        r,
        bal: Money.of(s).toPersistence(),
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
    invoices = app.get(SalesInvoicesService);
    bills = app.get(PurchaseBillsService);
    const users = app.get(UsersService);
    for (const [email, r] of [
      ['acct@adv.test', 'ACCOUNTANT'],
      ['appr@adv.test', 'APPROVER'],
    ] as const)
      await users.create({ email, password: 'secret123', name: r, role: r });
    acct = (await app.get(AuthService).login('acct@adv.test', 'secret123'))
      .accessToken;
    appr = (await app.get(AuthService).login('appr@adv.test', 'secret123'))
      .accessToken;
  }, 120_000);

  afterAll(() => cleanup());

  it('seeds the advance accounts by role (2-1300 liability, 1-1600 asset)', () => {
    expect(role.CUSTOMER_ADVANCE).toBe(acc['2-1300']);
    expect(role.VENDOR_ADVANCE).toBe(acc['1-1600']);
  });

  it('overpaying an invoice: allocate the outstanding, the rest credits Uang Muka Pelanggan', async () => {
    const c = await partner('isCustomer');
    const inv = await postedInvoice(c, '1000000', '2026-02-01');
    const p = await postedPayment({
      direction: 'RECEIPT',
      partnerId: c,
      date: '2026-02-05',
      amount: '1500000',
      allocations: [{ salesInvoiceId: inv, amount: '1000000' }],
    });
    expect(payments.present(p)).toMatchObject({
      amount: '1500000.0000',
      unappliedAmount: '500000.0000',
      applications: [],
    });
    expect(await linesOf(p.journalEntryId!)).toEqual([
      { accountId: acc['1-1000'], debit: '1500000.0000', credit: '0.0000' },
      { accountId: acc['1-1200'], debit: '0.0000', credit: '1000000.0000' },
      { accountId: acc['2-1300'], debit: '0.0000', credit: '500000.0000' },
    ]);
    const after = await invoices.getById(inv);
    expect(Money.of(after.amountPaid.toString()).toPersistence()).toBe(
      '1000000.0000',
    );
    // allocations may still not exceed the document outstanding
    await expectDomain(
      payments.createDraft({
        direction: 'RECEIPT',
        partnerId: c,
        date: new Date('2026-02-06'),
        cashAccountId: acc['1-1000'],
        amount: '10',
        allocations: [{ salesInvoiceId: inv, amount: '1' }],
        createdBy: 'creator',
      }),
      ValidationFailedError,
      /exceeds the document outstanding/,
    );
    await expectTies(['2026-02-04', '2026-02-05', '2026-02-28']);
  });

  it('fully allocated payments without `amount` post exactly as before (2 lines, unapplied 0)', async () => {
    const c = await partner('isCustomer');
    const inv = await postedInvoice(c, '400000', '2026-02-01');
    const p = await postedPayment({
      direction: 'RECEIPT',
      partnerId: c,
      date: '2026-02-05',
      allocations: [{ salesInvoiceId: inv, amount: '400000' }],
    });
    expect(payments.present(p)).toMatchObject({
      amount: '400000.0000',
      unappliedAmount: '0.0000',
    });
    expect(await linesOf(p.journalEntryId!)).toEqual([
      { accountId: acc['1-1000'], debit: '400000.0000', credit: '0.0000' },
      { accountId: acc['1-1200'], debit: '0.0000', credit: '400000.0000' },
    ]);
  });

  it('create-time rules: allocations > amount, no amount and no allocations', async () => {
    const c = await partner('isCustomer');
    const inv = await postedInvoice(c, '400000', '2026-02-01');
    const base = {
      direction: 'RECEIPT' as const,
      partnerId: c,
      date: new Date('2026-02-05'),
      cashAccountId: acc['1-1000'],
      createdBy: 'creator',
    };
    const e = await expectDomain(
      payments.createDraft({
        ...base,
        amount: '100',
        allocations: [{ salesInvoiceId: inv, amount: '200' }],
      }),
      ValidationFailedError,
      /Allocations exceed the payment amount/,
    );
    expect(e.details).toEqual({ amount: '100.0000', allocated: '200.0000' });
    await expectDomain(
      payments.createDraft({ ...base, allocations: [] }),
      ValidationFailedError,
      /positive amount or at least one allocation/,
    );
    await expectDomain(
      payments.createDraft({ ...base, amount: '0', allocations: [] }),
      ValidationFailedError,
      /positive amount or at least one allocation/,
    );
  });

  it('vendor advance: zero allocations → Dr Uang Muka Pembelian; apply later → Dr AP / Cr advance; over-apply 422', async () => {
    const v = await partner('isVendor');
    const p = await postedPayment({
      direction: 'DISBURSEMENT',
      partnerId: v,
      date: '2026-03-01',
      amount: '300000',
    });
    expect(await linesOf(p.journalEntryId!)).toEqual([
      { accountId: acc['1-1600'], debit: '300000.0000', credit: '0.0000' },
      { accountId: acc['1-1000'], debit: '0.0000', credit: '300000.0000' },
    ]);
    const bill = await postedBill(v, '250000', '2026-03-10');
    await expectTies(['2026-03-05', '2026-03-10']);

    const applied = await payments.apply(
      p.id,
      new Date('2026-03-12'),
      [{ purchaseBillId: bill, amount: '250000' }],
      'applier',
    );
    expect(payments.present(applied)).toMatchObject({
      unappliedAmount: '50000.0000',
      applications: [
        {
          purchaseBillId: bill,
          amount: '250000.0000',
          createdBy: 'applier',
          reversedOn: null,
        },
      ],
    });
    const je = await prisma.client.journalEntry.findUniqueOrThrow({
      where: { id: applied.applications[0].journalEntryId },
    });
    expect(je).toMatchObject({
      sourceType: 'PAYMENT',
      sourceId: p.id,
      status: 'POSTED',
      createdBy: 'creator',
      postedBy: 'applier',
    });
    expect(je.date.toISOString().slice(0, 10)).toBe('2026-03-12');
    expect(await linesOf(je.id)).toEqual([
      { accountId: acc['2-1000'], debit: '250000.0000', credit: '0.0000' },
      { accountId: acc['1-1600'], debit: '0.0000', credit: '250000.0000' },
    ]);
    const b = await bills.getById(bill);
    expect(Money.of(b.amountPaid.toString()).toPersistence()).toBe(
      '250000.0000',
    );

    // Over-apply: only 50,000 left.
    const bill2 = await postedBill(v, '100000', '2026-03-10');
    const e = await expectDomain(
      payments.apply(
        p.id,
        new Date('2026-03-12'),
        [{ purchaseBillId: bill2, amount: '60000' }],
        'applier',
      ),
      ValidationFailedError,
      /exceeds the payment unapplied amount/,
    );
    expect(e.details).toEqual({
      id: p.id,
      unappliedAmount: '50000.0000',
      requested: '60000.0000',
    });
    await expectTies(['2026-03-11', '2026-03-12', '2026-03-31']);
  });

  it('apply guards: DRAFT payment, date before payment/document, other partner, wrong side, SoD', async () => {
    const c = await partner('isCustomer');
    const other = await partner('isCustomer');
    const inv = await postedInvoice(c, '100000', '2026-04-10');
    const otherInv = await postedInvoice(other, '100000', '2026-04-01');
    const draft = await payments.createDraft({
      direction: 'RECEIPT',
      partnerId: c,
      date: new Date('2026-04-01'),
      cashAccountId: acc['1-1000'],
      amount: '500000',
      allocations: [],
      createdBy: 'creator',
    });
    const apply = (date: string, a: object, id = draft.id, by = 'applier') =>
      payments.apply(id, new Date(date), [{ amount: '1000', ...a }], by);
    await expectDomain(
      apply('2026-04-15', { salesInvoiceId: inv }),
      ValidationFailedError,
      /Only a POSTED payment can be applied/,
    );
    const p = await payments.post(draft.id, 'poster');
    await expectDomain(
      apply('2026-03-31', { salesInvoiceId: inv }, p.id),
      ValidationFailedError,
      /before the payment date/,
    );
    await expectDomain(
      apply('2026-04-05', { salesInvoiceId: inv }, p.id),
      ValidationFailedError,
      /Payment date cannot be before the date of a document/,
    );
    await expectDomain(
      apply('2026-04-15', { salesInvoiceId: otherInv }, p.id),
      ValidationFailedError,
      /belongs to another partner/,
    );
    await expectDomain(
      apply('2026-04-15', { purchaseBillId: randomUUID() }, p.id),
      ValidationFailedError,
      /must reference a sales invoice/,
    );
    // SoD (on by default): the payment's creator may not apply it.
    await expectDomain(
      apply('2026-04-15', { salesInvoiceId: inv }, p.id, 'creator'),
      SegregationOfDutiesError,
    );
    const fresh = await payments.getById(p.id);
    expect(fresh.applications).toHaveLength(0);
    expect(Money.of(fresh.unappliedAmount.toString()).toPersistence()).toBe(
      '500000.0000',
    );
  });

  it('reverse an application; void refuses while one is live, then honours the reversal date', async () => {
    const c = await partner('isCustomer');
    const p = await postedPayment({
      direction: 'RECEIPT',
      partnerId: c,
      date: '2026-05-01',
      amount: '800000',
    });
    const inv1 = await postedInvoice(c, '300000', '2026-05-02');
    const inv2 = await postedInvoice(c, '500000', '2026-05-03');
    const applied = await payments.apply(
      p.id,
      new Date('2026-05-10'),
      [
        { salesInvoiceId: inv2, amount: '500000' },
        { salesInvoiceId: inv1, amount: '300000' },
      ],
      'applier',
    );
    expect(applied.applications).toHaveLength(2);
    expect(Money.of(applied.unappliedAmount.toString()).isZero()).toBe(true);
    await expectTies(['2026-05-05', '2026-05-10']);

    // Void with live applications → 422 HAS_APPLICATIONS.
    const e = await expectDomain(
      payments.void(p.id, 'voider'),
      ValidationFailedError,
    );
    expect(e.details).toEqual({
      id: p.id,
      reason: 'HAS_APPLICATIONS',
      applications: 2,
    });

    const [a1, a2] = applied.applications;
    const after = await payments.reverseApplication(
      p.id,
      a1.id,
      'reverser',
      new Date('2026-05-20'),
    );
    const reversed = after.applications.find((a) => a.id === a1.id)!;
    expect(reversed.reversedOn!.toISOString().slice(0, 10)).toBe('2026-05-20');
    expect(reversed.reversedBy).toBe('reverser');
    expect(Money.of(after.unappliedAmount.toString()).toPersistence()).toBe(
      Money.of(a1.amount.toString()).toPersistence(),
    );
    const je = await prisma.client.journalEntry.findUniqueOrThrow({
      where: { id: a1.journalEntryId },
    });
    expect(je.status).toBe('REVERSED');
    const docAfter = await invoices.getById(a1.salesInvoiceId!);
    expect(Money.of(docAfter.amountPaid.toString()).isZero()).toBe(true);
    // twice → 422
    await expectDomain(
      payments.reverseApplication(p.id, a1.id, 'reverser'),
      ValidationFailedError,
      /already reversed/,
    );
    await expectTies(['2026-05-15', '2026-05-20', '2026-05-31']);

    await payments.reverseApplication(p.id, a2.id, 'reverser');
    // The payment's own date is before a1's reversal date → 422.
    const e2 = await expectDomain(
      payments.void(p.id, 'voider'),
      ValidationFailedError,
      /reversal date of an application/,
    );
    expect(e2.details).toMatchObject({ applicationReversedOn: '2026-05-20' });
    const voided = await payments.void(p.id, 'voider', new Date('2026-05-20'));
    expect(voided.status).toBe('VOID');
    expect(Money.of(voided.unappliedAmount.toString()).isZero()).toBe(true);
    // An invoice whose application was reversed on 05-20 may not be voided
    // before that date (the as-of aging still had it paid until then).
    await expectDomain(
      invoices.void(a1.salesInvoiceId!, 'voider', new Date('2026-05-15')),
      ValidationFailedError,
      /Void date cannot be before the void date of a payment/,
    );
    await expectTies(['2026-05-10', '2026-05-19', '2026-05-20', '2026-06-30']);
  });

  it(`concurrent applies over the same advance: exactly one wins, the other 422; unapplied never negative (5x)`, async () => {
    for (let i = 0; i < 5; i++) {
      const c = await partner('isCustomer');
      const p = await postedPayment({
        direction: 'RECEIPT',
        partnerId: c,
        date: '2026-06-01',
        amount: '1000000',
      });
      const invA = await postedInvoice(c, '700000', '2026-06-02');
      const invB = await postedInvoice(c, '700000', '2026-06-02');

      // Hold the payment row so both applies queue on it, then release.
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
      const settle = (inv: string) =>
        payments
          .apply(
            p.id,
            new Date('2026-06-05'),
            [{ salesInvoiceId: inv, amount: '700000' }],
            'applier',
          )
          .then(
            () => null,
            (e: unknown) => e,
          );
      const racing = Promise.all([settle(invA), settle(invB)]);
      for (let k = 0; k < 100; k++) {
        const [{ w }] = await prisma.client.$queryRaw<{ w: number }[]>`
          SELECT count(*)::int AS w FROM pg_locks WHERE NOT granted`;
        if (w >= 2) break;
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
      expect(Money.of(fresh.unappliedAmount.toString()).toPersistence()).toBe(
        '300000.0000',
      );
    }
    await expectTies(['2026-06-04', '2026-06-05', '2026-06-30']);
  }, 120_000);

  it('a partner with an unapplied advance cannot be deleted (422 OPEN_ITEMS)', async () => {
    const c = await partner('isCustomer');
    await postedPayment({
      direction: 'RECEIPT',
      partnerId: c,
      date: '2026-07-01',
      amount: '1000',
    });
    const e = await expectDomain(
      app.get(BusinessPartnersService).softDelete(c, 'deleter'),
      ValidationFailedError,
    );
    expect(e.details).toMatchObject({
      reason: 'OPEN_ITEMS',
      unappliedPayments: 1,
    });
  });

  it('advance accounts are document-only: a MANUAL journal on 2-1300 is a 422', async () => {
    await expectDomain(
      app.get(PostingService).post(
        {
          date: new Date('2026-07-01'),
          description: 'manual advance',
          sourceType: 'MANUAL',
          createdBy: 'creator',
          lines: [
            { accountId: acc['1-1000'], debit: '1' },
            { accountId: acc['2-1300'], credit: '1' },
          ],
        },
        'poster',
      ),
      ValidationFailedError,
      /advance accounts can only be posted/,
    );
  });

  describe('HTTP', () => {
    it('create (no allocations) → post → list ?unapplied=true → apply → reverse; roles and DTO', async () => {
      const c = await partner('isCustomer');
      const inv = await postedInvoice(c, '200000', '2026-08-01');
      const created = await request(server())
        .post('/v1/payments')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          direction: 'RECEIPT',
          partnerId: c,
          date: '2026-08-02',
          cashAccountId: acc['1-1000'],
          amount: '250000',
        })
        .expect(201);
      const id = (created.body as { id: string }).id;
      expect(created.body).toMatchObject({
        amount: '250000.0000',
        unappliedAmount: '250000.0000',
        allocations: [],
        applications: [],
      });
      await request(server())
        .post(`/v1/payments/${id}/post`)
        .set('Authorization', `Bearer ${appr}`)
        .set('Idempotency-Key', randomUUID())
        .expect(200);

      const list = async (unapplied: string) =>
        (
          (
            await request(server())
              .get(`/v1/payments?partnerId=${c}&unapplied=${unapplied}`)
              .set('Authorization', `Bearer ${acct}`)
              .expect(200)
          ).body as { data: { id: string; unappliedAmount: string }[] }
        ).data;
      expect(await list('true')).toEqual([
        expect.objectContaining({ id, unappliedAmount: '250000.0000' }),
      ]);
      expect(await list('false')).toEqual([]);
      await request(server())
        .get('/v1/payments?unapplied=yes')
        .set('Authorization', `Bearer ${acct}`)
        .expect(400);

      const applyBody = {
        date: '2026-08-03',
        allocations: [{ salesInvoiceId: inv, amount: '200000' }],
      };
      // ACCOUNTANT may not apply (same roles as post)
      await request(server())
        .post(`/v1/payments/${id}/apply`)
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', randomUUID())
        .send(applyBody)
        .expect(403);
      // Idempotency-Key is required
      await request(server())
        .post(`/v1/payments/${id}/apply`)
        .set('Authorization', `Bearer ${appr}`)
        .send(applyBody)
        .expect(422);
      await request(server())
        .post(`/v1/payments/${id}/apply`)
        .set('Authorization', `Bearer ${appr}`)
        .set('Idempotency-Key', randomUUID())
        .send({ date: '2026-08-03', allocations: [] })
        .expect(400);
      const key = randomUUID();
      const applied = await request(server())
        .post(`/v1/payments/${id}/apply`)
        .set('Authorization', `Bearer ${appr}`)
        .set('Idempotency-Key', key)
        .send(applyBody)
        .expect(200);
      expect(applied.body).toMatchObject({
        unappliedAmount: '50000.0000',
        applications: [{ salesInvoiceId: inv, amount: '200000.0000' }],
      });
      // replay with the same key: no second application
      await request(server())
        .post(`/v1/payments/${id}/apply`)
        .set('Authorization', `Bearer ${appr}`)
        .set('Idempotency-Key', key)
        .send(applyBody)
        .expect(200);
      expect(await list('true')).toEqual([
        expect.objectContaining({ id, unappliedAmount: '50000.0000' }),
      ]);
      const appId = (applied.body as { applications: { id: string }[] })
        .applications[0].id;
      await request(server())
        .post(`/v1/payments/${id}/applications/${randomUUID()}/reverse`)
        .set('Authorization', `Bearer ${appr}`)
        .set('Idempotency-Key', randomUUID())
        .expect(404);
      const reversed = await request(server())
        .post(`/v1/payments/${id}/applications/${appId}/reverse`)
        .set('Authorization', `Bearer ${appr}`)
        .set('Idempotency-Key', randomUUID())
        .send({})
        .expect(200);
      expect(reversed.body).toMatchObject({
        unappliedAmount: '250000.0000',
        applications: [{ id: appId }],
      });
      expect(
        (reversed.body as { applications: { reversedOn: string | null }[] })
          .applications[0].reversedOn,
      ).toMatch(/^2026-08-03/);
    });
  });
});
