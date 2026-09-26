import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { BalancesService } from '../src/ledger/balances/balances.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';

describe('Payments (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let acct: string; // accountant token
  let appr: string; // approver token
  let acc: Record<string, string>;
  let code: Record<string, string>;

  const server = () => app.getHttpServer() as App;

  /** Create + post a sales invoice (total 1,110,000) for a partner; returns its id. */
  const makePostedInvoice = async (partnerId: string): Promise<string> => {
    const draft = await request(server())
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        partnerId,
        date: '2026-02-10',
        description: 'Jual jasa',
        lines: [
          {
            description: 'Jasa konsultasi',
            accountId: acc['4-1000'],
            quantity: '1',
            unitPrice: '1000000',
            taxCodeIds: [code['PPN-OUT-11']],
          },
        ],
      })
      .expect(201);
    const id = (draft.body as { id: string }).id;
    await request(server())
      .post(`/v1/sales-invoices/${id}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    return id;
  };

  const newCustomer = async (codeStr: string): Promise<string> =>
    (
      await app
        .get(BusinessPartnersService)
        .create({ code: codeStr, name: 'Pelanggan', isCustomer: true })
    ).id;

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());
    await app.get(AccountsService).seedIfEmpty();
    await app.get(TaxCodesService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const users = app.get(UsersService);
    await users.create({
      email: 'acct@pay.test',
      password: 'secret123',
      name: 'Acct',
      role: 'ACCOUNTANT',
    });
    await users.create({
      email: 'appr@pay.test',
      password: 'secret123',
      name: 'Appr',
      role: 'APPROVER',
    });
    acct = (await app.get(AuthService).login('acct@pay.test', 'secret123'))
      .accessToken;
    appr = (await app.get(AuthService).login('appr@pay.test', 'secret123'))
      .accessToken;
    const { data: accounts } = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    const { data: codes } = await app.get(TaxCodesService).list();
    code = Object.fromEntries(codes.map((c) => [c.code, c.id]));
  }, 120_000);

  afterAll(() => cleanup());

  it('rejects more than 100 allocations with 400', async () => {
    const customerId = await newCustomer('CUST-PAY-CAP');
    await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: customerId,
        date: '2026-02-15',
        cashAccountId: acc['1-1000'],
        allocations: Array.from({ length: 101 }, () => ({
          salesInvoiceId: randomUUID(),
          amount: '1',
        })),
      })
      .expect(400);
  });

  it('partial then full receipt: PARTIAL→PAID, GL debits Kas / credits AR', async () => {
    const customerId = await newCustomer('CUST-PAY-1');
    const invoiceId = await makePostedInvoice(customerId);

    // First receipt: allocate 600000.
    const r1 = await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: customerId,
        date: '2026-02-15',
        cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: invoiceId, amount: '600000' }],
      })
      .expect(201);
    const p1 = r1.body as { id: string; amount: string };
    expect(p1.amount).toBe('600000.0000');
    const posted1 = await request(server())
      .post(`/v1/payments/${p1.id}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    const posted1Body = posted1.body as {
      status: string;
      ref: string;
      journalEntryId: string;
    };
    expect(posted1Body.status).toBe('POSTED');

    let inv = await request(server())
      .get(`/v1/sales-invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${acct}`)
      .expect(200);
    expect((inv.body as { paymentStatus: string }).paymentStatus).toBe(
      'PARTIAL',
    );
    expect((inv.body as { outstanding: string }).outstanding).toBe(
      '510000.0000',
    );

    // The first payment's GL entry debits Kas (1-1000) and credits AR (1-1200) by 600000.
    const lines = await prisma.client.journalLine.findMany({
      where: { journalEntryId: posted1Body.journalEntryId },
    });
    const debit = lines.reduce((s, l) => s + Number(l.debit), 0);
    const credit = lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(debit).toBe(credit);
    const kas = lines.find((l) => l.accountId === acc['1-1000']);
    const ar = lines.find((l) => l.accountId === acc['1-1200']);
    expect(kas!.debit.toString()).toBe('600000');
    expect(ar!.credit.toString()).toBe('600000');

    // Second receipt: allocate the remaining 510000 → PAID.
    const r2 = await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: customerId,
        date: '2026-02-20',
        cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: invoiceId, amount: '510000' }],
      })
      .expect(201);
    const p2 = r2.body as { id: string };
    await request(server())
      .post(`/v1/payments/${p2.id}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);

    inv = await request(server())
      .get(`/v1/sales-invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${acct}`)
      .expect(200);
    expect((inv.body as { paymentStatus: string }).paymentStatus).toBe('PAID');
    expect((inv.body as { outstanding: string }).outstanding).toBe('0.0000');
  });

  it('rejects a zero allocation amount (422)', async () => {
    const customerId = await newCustomer('CUST-PAY-ZERO');
    const invoiceId = await makePostedInvoice(customerId);
    await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: customerId,
        date: '2026-02-15',
        cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: invoiceId, amount: '0' }],
      })
      .expect(422);
  });

  it('rejects over-allocation beyond the invoice outstanding (422)', async () => {
    const customerId = await newCustomer('CUST-PAY-OVER');
    const invoiceId = await makePostedInvoice(customerId);
    await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: customerId,
        date: '2026-02-15',
        cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: invoiceId, amount: '2000000' }],
      })
      .expect(422);
  });

  it('FIN-M1: rejects two allocations to the same invoice exceeding outstanding (422 at draft)', async () => {
    const customerId = await newCustomer('CUST-PAY-CUMUL');
    const invoiceId = await makePostedInvoice(customerId); // total 1,110,000
    await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: customerId,
        date: '2026-02-15',
        cashAccountId: acc['1-1000'],
        allocations: [
          { salesInvoiceId: invoiceId, amount: '600000' },
          { salesInvoiceId: invoiceId, amount: '600000' }, // 1,200,000 > 1,110,000
        ],
      })
      .expect(422);
  });

  it('voiding a receipt restores invoice outstanding; the invoice can then be voided', async () => {
    const customerId = await newCustomer('CUST-PAY-VOID');
    const invoiceId = await makePostedInvoice(customerId);

    // Fully pay the invoice.
    const r = await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: customerId,
        date: '2026-02-15',
        cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: invoiceId, amount: '1110000' }],
      })
      .expect(201);
    const paymentId = (r.body as { id: string }).id;
    await request(server())
      .post(`/v1/payments/${paymentId}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);

    let inv = await request(server())
      .get(`/v1/sales-invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${acct}`)
      .expect(200);
    expect((inv.body as { paymentStatus: string }).paymentStatus).toBe('PAID');

    // Void the payment → invoice restored to UNPAID, outstanding == total.
    await request(server())
      .post(`/v1/payments/${paymentId}/void`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);

    inv = await request(server())
      .get(`/v1/sales-invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${acct}`)
      .expect(200);
    expect((inv.body as { paymentStatus: string }).paymentStatus).toBe(
      'UNPAID',
    );
    expect(
      (inv.body as { outstanding: string; total: string }).outstanding,
    ).toBe((inv.body as { total: string }).total);

    // The now-unpaid invoice can be voided.
    await request(server())
      .post(`/v1/sales-invoices/${invoiceId}/void`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
  });

  it('FIN-M3: void cannot drive amountPaid negative (conflict on underflow)', async () => {
    const customerId = await newCustomer('CUST-UNDERFLOW');
    const invoiceId = await makePostedInvoice(customerId); // total 1,110,000
    const r = await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: customerId,
        date: '2026-02-15',
        cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: invoiceId, amount: '1110000' }],
      })
      .expect(201);
    const paymentId = (r.body as { id: string }).id;
    await request(server())
      .post(`/v1/payments/${paymentId}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    // Manufacture the otherwise-impossible state: amountPaid below the allocation.
    await prisma.client.salesInvoice.update({
      where: { id: invoiceId },
      data: { amountPaid: '500000' },
    });
    try {
      await request(server())
        .post(`/v1/payments/${paymentId}/void`)
        .set('Authorization', `Bearer ${appr}`)
        .set('Idempotency-Key', randomUUID())
        .expect(409);
      const inv = await prisma.client.salesInvoice.findFirst({
        where: { id: invoiceId },
      });
      expect(inv!.amountPaid.toString()).toBe('500000'); // unchanged; tx rolled back
    } finally {
      // Restore the true posted value so the cross-suite AR reconciliation invariant holds.
      await prisma.client.salesInvoice.update({
        where: { id: invoiceId },
        data: { amountPaid: '1110000' },
      });
    }
  });

  it('concurrent post of two full-outstanding payments settles exactly once (one 200, one 409)', async () => {
    const customerId = await newCustomer('CUST-PAY-RACE');
    const invoiceId = await makePostedInvoice(customerId); // total 1,110,000
    const draft = async (): Promise<string> => {
      const res = await request(server())
        .post('/v1/payments')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          direction: 'RECEIPT',
          partnerId: customerId,
          date: '2026-02-15',
          cashAccountId: acc['1-1000'],
          allocations: [{ salesInvoiceId: invoiceId, amount: '1110000' }],
        })
        .expect(201);
      return (res.body as { id: string }).id;
    };
    const p1 = await draft();
    const p2 = await draft();
    const results = await Promise.allSettled([
      request(server())
        .post(`/v1/payments/${p1}/post`)
        .set('Authorization', `Bearer ${appr}`)
        .set('Idempotency-Key', randomUUID()),
      request(server())
        .post(`/v1/payments/${p2}/post`)
        .set('Authorization', `Bearer ${appr}`)
        .set('Idempotency-Key', randomUUID()),
    ]);
    const codes = results.map((r) =>
      r.status === 'fulfilled' ? r.value.status : 0,
    );
    // Exactly one request settled (HTTP 200); the other was rejected with a 409
    // conflict by the over-allocation FOR UPDATE re-check.
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(1);
    // Definitive no-double-settle invariant, independent of HTTP/lock-wait timing:
    // exactly one of the two payments is POSTED in the ledger; the loser stayed DRAFT.
    const postedCount = await prisma.client.payment.count({
      where: { id: { in: [p1, p2] }, status: 'POSTED' },
    });
    expect(postedCount).toBe(1);
    // The invoice is paid exactly once — no double-settlement, no negative outstanding.
    const inv = await request(server())
      .get(`/v1/sales-invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${appr}`)
      .expect(200);
    const body = inv.body as { paymentStatus: string; outstanding: string };
    expect(body.paymentStatus).toBe('PAID');
    expect(body.outstanding).toBe('0.0000');
  });

  describe('search (?q=)', () => {
    it('matches a payment by description and by partner name, composing with direction', async () => {
      const customerId = await newCustomer('PAY-SEARCH');
      const invoiceId = await makePostedInvoice(customerId);
      await request(server())
        .post('/v1/payments')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          direction: 'RECEIPT',
          partnerId: customerId,
          date: '2026-02-15',
          cashAccountId: acc['1-1000'],
          description: 'Pelunasan termin satu',
          allocations: [{ salesInvoiceId: invoiceId, amount: '600000' }],
        })
        .expect(201);
      const res = await request(server())
        .get('/v1/payments?q=termin&direction=RECEIPT')
        .set('Authorization', `Bearer ${acct}`)
        .expect(200);
      expect(
        (res.body as { data: { description: string }[] }).data.some((p) =>
          p.description?.includes('termin'),
        ),
      ).toBe(true);
    });

    it('matches a payment by partner code, composing with direction', async () => {
      const customerId = await newCustomer('PAYCODE-ZED');
      const invoiceId = await makePostedInvoice(customerId);
      await request(server())
        .post('/v1/payments')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          direction: 'RECEIPT',
          partnerId: customerId,
          date: '2026-02-15',
          cashAccountId: acc['1-1000'],
          description: 'Pelunasan',
          allocations: [{ salesInvoiceId: invoiceId, amount: '600000' }],
        })
        .expect(201);
      const res = await request(server())
        .get('/v1/payments?q=paycode-zed&direction=RECEIPT')
        .set('Authorization', `Bearer ${acct}`)
        .expect(200);
      expect((res.body as { total: number }).total).toBeGreaterThanOrEqual(1);
    });
  });

  it('FIN-M2: rejects post when the allocated document no longer belongs to the payment partner', async () => {
    const customerA = await newCustomer('CUST-OWNER-A');
    const customerB = await newCustomer('CUST-OWNER-B');
    const invoiceId = await makePostedInvoice(customerA);
    const draft = await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: customerA,
        date: '2026-02-15',
        cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: invoiceId, amount: '600000' }],
      })
      .expect(201);
    const paymentId = (draft.body as { id: string }).id;
    // Manufacture the otherwise-impossible state: reassign the invoice to B.
    await prisma.client.salesInvoice.update({
      where: { id: invoiceId },
      data: { partnerId: customerB },
    });
    await request(server())
      .post(`/v1/payments/${paymentId}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(422);
  });

  // ── Guard-branch coverage (I-13 through I-25, I-28, I-29, I-31, I-32) ──────

  it('I-13: create payment with no allocations → 400 (DTO @ArrayMinSize(1) shadows service guard at :57)', async () => {
    // allocations.length === 0: the DTO enforces @ArrayMinSize(1) before the service
    // guard at :57 can fire, so the server returns 400 from the ValidationPipe.
    const customerId = await newCustomer('CUST-NO-ALLOC');
    await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', 'pay-empty-alloc')
      .send({
        direction: 'RECEIPT',
        partnerId: customerId,
        date: '2026-01-15',
        cashAccountId: acc['1-1000'],
        allocations: [],
      })
      .expect(400); // DTO-level; service guard at :57 is shadowed by @ArrayMinSize(1)
  });

  it('I-14: create payment for an inactive partner → 422 (!partner.isActive)', async () => {
    // !partner.isActive guard in createDraft().
    const p = await app
      .get(BusinessPartnersService)
      .create({ code: 'CUST-INACT-PAY', name: 'InactPay', isCustomer: true });
    await app.get(BusinessPartnersService).deactivate(p.id);
    const customerId = await newCustomer('CUST-FOR-INV-INACT');
    const invoiceId = await makePostedInvoice(customerId);
    const res = await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: p.id,
        date: '2026-01-15',
        cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: invoiceId, amount: '500000' }],
      })
      .expect(422);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('I-15: create RECEIPT payment for a vendor-only partner → 422 (!partner[partnerFlag])', async () => {
    // !partner[target.partnerFlag] guard: RECEIPT requires isCustomer; using a vendor-only partner.
    const vendorOnly = await app
      .get(BusinessPartnersService)
      .create({ code: 'VEND-ONLY-PAY', name: 'VendOnlyPay', isVendor: true });
    const realCustomer = await newCustomer('CUST-FOR-ROLE-TEST');
    const invoiceId = await makePostedInvoice(realCustomer);
    const res = await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: vendorOnly.id,
        date: '2026-01-15',
        cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: invoiceId, amount: '500000' }],
      })
      .expect(422);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('I-16: create payment with a non-existent cash account UUID → 422 (!cash guard in createDraft)', async () => {
    // !cash || !cash.isPostable || !cash.isActive guard in createDraft().
    // cashAccountId must pass @IsUUID() DTO validation, so use a well-formed but non-existent UUID.
    const customerId = await newCustomer('CUST-BAD-CASH');
    const invoiceId = await makePostedInvoice(customerId);
    const res = await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: customerId,
        date: '2026-01-15',
        cashAccountId: '00000000-0000-0000-0000-000000000000', // valid UUID, no such account
        allocations: [{ salesInvoiceId: invoiceId, amount: '500000' }],
      })
      .expect(422);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('I-17: create payment with a zero allocation amount → 422 (amt.isZero() guard in createDraft)', async () => {
    // amt.isZero() || amt.isNegative() guard at :90 in createDraft().
    // @IsMoneyString() rejects negatives at the DTO level (400), but '0' passes DTO and hits service.
    const customerId = await newCustomer('CUST-ZERO-AMT');
    const invoiceId = await makePostedInvoice(customerId);
    const res = await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: customerId,
        date: '2026-01-15',
        cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: invoiceId, amount: '0' }],
      })
      .expect(422);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('I-18: create payment allocated to a DRAFT invoice → 422 (targetRow.status !== POSTED)', async () => {
    // targetRow.status !== POSTED guard in createDraft(): the invoice was never posted.
    const customerId = await newCustomer('CUST-DRAFT-INV');
    const draftInv = await request(server())
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        partnerId: customerId,
        date: '2026-02-10',
        description: 'Draft only',
        lines: [
          {
            description: 'Line',
            accountId: acc['4-1000'],
            quantity: '1',
            unitPrice: '500000',
            taxCodeIds: [code['PPN-OUT-11']],
          },
        ],
      })
      .expect(201);
    const draftInvoiceId = (draftInv.body as { id: string }).id;
    const res = await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: customerId,
        date: '2026-01-15',
        cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: draftInvoiceId, amount: '500000' }],
      })
      .expect(422);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('I-19: GET /payments/:nonexistent → 404 (!p guard in getById)', async () => {
    // if (!p) NotFoundDomainError guard in getById().
    const res = await request(server())
      .get('/v1/payments/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${acct}`)
      .expect(404);
    expect((res.body as { code: string }).code).toBe('NOT_FOUND');
  });

  it('I-22: POST /post on an already-posted payment → 422 (status !== DRAFT guard in post())', async () => {
    // payment.status !== DRAFT guard in post(): post an already-posted payment.
    const customerId = await newCustomer('CUST-DBL-POST-PAY');
    const invoiceId = await makePostedInvoice(customerId);
    const r = await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: customerId,
        date: '2026-02-15',
        cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: invoiceId, amount: '500000' }],
      })
      .expect(201);
    const paymentId = (r.body as { id: string }).id;
    await request(server())
      .post(`/v1/payments/${paymentId}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    const res = await request(server())
      .post(`/v1/payments/${paymentId}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(422);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('I-24: void a DRAFT payment → 422 (payment.status !== POSTED guard in void())', async () => {
    // status !== POSTED guard in void(): only posted payments can be voided.
    const customerId = await newCustomer('CUST-VOID-DRAFT-PAY');
    const invoiceId = await makePostedInvoice(customerId);
    const r = await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: customerId,
        date: '2026-02-15',
        cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: invoiceId, amount: '500000' }],
      })
      .expect(201);
    const paymentId = (r.body as { id: string }).id;
    const res = await request(server())
      .post(`/v1/payments/${paymentId}/void`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(422);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('I-28: void a RECEIPT payment → 200; salesInvoice.amountPaid decremented back to 0 (RECEIPT decrement arm)', async () => {
    // sign === -1 decrement arm in RECEIPT applyPaid() hit via unwindInTx on void.
    const customerId = await newCustomer('CUST-RCPT-VOID-UNWIND');
    const invoiceId = await makePostedInvoice(customerId);
    const r = await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: customerId,
        date: '2026-02-15',
        cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: invoiceId, amount: '1110000' }],
      })
      .expect(201);
    const paymentId = (r.body as { id: string }).id;
    await request(server())
      .post(`/v1/payments/${paymentId}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    await request(server())
      .post(`/v1/payments/${paymentId}/void`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    // amountPaid on the invoice must be back at 0 after void unwind.
    const inv = await request(server())
      .get(`/v1/sales-invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${acct}`)
      .expect(200);
    expect(
      (inv.body as { outstanding: string; total: string }).outstanding,
    ).toBe((inv.body as { total: string }).total);
  });

  it('refuses to void a payment whose partner is soft-deleted (422 PARTNER_DELETED) — would reopen a balance on a deleted partner', async () => {
    const customerId = await newCustomer('CUST-VOID-DELETED');
    const invoiceId = await makePostedInvoice(customerId);
    const r = await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: customerId,
        date: '2026-02-15',
        cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: invoiceId, amount: '1110000' }],
      })
      .expect(201);
    const paymentId = (r.body as { id: string }).id;
    await request(server())
      .post(`/v1/payments/${paymentId}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    // Fully paid → no open items → the partner can be deleted.
    await app.get(BusinessPartnersService).softDelete(customerId, 'test');
    const res = await request(server())
      .post(`/v1/payments/${paymentId}/void`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(422);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: {
        id: paymentId,
        partnerId: customerId,
        reason: 'PARTNER_DELETED',
      },
    });
    const inv = await request(server())
      .get(`/v1/sales-invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${acct}`)
      .expect(200);
    expect((inv.body as { outstanding: string }).outstanding).toBe('0.0000');
    const pay = await request(server())
      .get(`/v1/payments/${paymentId}`)
      .set('Authorization', `Bearer ${acct}`)
      .expect(200);
    expect((pay.body as { status: string }).status).toBe('POSTED');
  });

  it('I-29: void a DISBURSEMENT payment → 200; purchaseBill.amountPaid decremented back to 0 (DISBURSEMENT decrement arm)', async () => {
    // sign === -1 decrement arm in DISBURSEMENT applyPaid() via unwindInTx on void.
    const vendor = await app
      .get(BusinessPartnersService)
      .create({ code: 'VEND-DSB-VOID', name: 'VendDsbVoid', isVendor: true });
    const bill = await request(server())
      .post('/v1/purchase-bills')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        partnerId: vendor.id,
        date: '2026-02-10',
        description: 'Beli jasa',
        lines: [
          {
            description: 'Beli jasa',
            accountId: acc['5-2000'],
            quantity: '1',
            unitPrice: '1000000',
            taxCodeIds: [code['PPN-IN-11']],
          },
        ],
      })
      .expect(201);
    const billId = (bill.body as { id: string }).id;
    await request(server())
      .post(`/v1/purchase-bills/${billId}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    const dsb = await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'DISBURSEMENT',
        partnerId: vendor.id,
        date: '2026-02-15',
        cashAccountId: acc['1-1000'],
        allocations: [{ purchaseBillId: billId, amount: '1110000' }],
      })
      .expect(201);
    const dsbId = (dsb.body as { id: string }).id;
    await request(server())
      .post(`/v1/payments/${dsbId}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    await request(server())
      .post(`/v1/payments/${dsbId}/void`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    // Bill amountPaid must be back at 0 after void unwind.
    const billRes = await request(server())
      .get(`/v1/purchase-bills/${billId}`)
      .set('Authorization', `Bearer ${acct}`)
      .expect(200);
    expect(
      (billRes.body as { outstanding: string; total: string }).outstanding,
    ).toBe((billRes.body as { total: string }).total);
  });

  it('I-31: allocation supplying purchaseBillId on a RECEIPT → 422 (otherId set guard in loadTarget)', async () => {
    // !id || target.otherId(alloc) guard in loadTarget(): wrong document type for direction.
    const customerId = await newCustomer('CUST-WRONG-TYPE');
    const vendor = await app
      .get(BusinessPartnersService)
      .create({ code: 'VEND-WRONG-TYPE', name: 'VendWrong', isVendor: true });
    // Create a posted bill (wrong type for RECEIPT).
    const bill = await request(server())
      .post('/v1/purchase-bills')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        partnerId: vendor.id,
        date: '2026-02-10',
        description: 'Beli',
        lines: [
          {
            description: 'Beli',
            accountId: acc['5-2000'],
            quantity: '1',
            unitPrice: '500000',
            taxCodeIds: [code['PPN-IN-11']],
          },
        ],
      })
      .expect(201);
    const billId = (bill.body as { id: string }).id;
    await request(server())
      .post(`/v1/purchase-bills/${billId}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    // RECEIPT allocation but supplies purchaseBillId (wrong type).
    const res = await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: customerId,
        date: '2026-01-15',
        cashAccountId: acc['1-1000'],
        allocations: [{ purchaseBillId: billId, amount: '500000' }],
      })
      .expect(422);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('I-32: allocating to a non-existent invoice id → 404 (!row guard in loadTarget)', async () => {
    // if (!row) NotFoundDomainError guard in loadTarget().
    const customerId = await newCustomer('CUST-NOTEXIST-INV');
    const res = await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: customerId,
        date: '2026-01-15',
        cashAccountId: acc['1-1000'],
        allocations: [
          {
            salesInvoiceId: '00000000-0000-0000-0000-000000000000',
            amount: '500000',
          },
        ],
      })
      .expect(404);
    expect((res.body as { code: string }).code).toBe('NOT_FOUND');
  });

  it('reconciliation invariant: AR control GL balance == Σ all posted invoice outstanding', async () => {
    const customerId = await newCustomer('CUST-RECON');
    const invoiceId = await makePostedInvoice(customerId);

    // Partial receipt of 400000 → this invoice outstanding 710000.
    const r = await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: customerId,
        date: '2026-02-15',
        cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: invoiceId, amount: '400000' }],
      })
      .expect(201);
    const paymentId = (r.body as { id: string }).id;
    await request(server())
      .post(`/v1/payments/${paymentId}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);

    // This dedicated customer's invoice outstanding is exactly 710,000.
    const myInvoices = await prisma.client.salesInvoice.findMany({
      where: { partnerId: customerId, status: 'POSTED' },
    });
    let myOutstanding = 0;
    for (const i of myInvoices) {
      myOutstanding += Number(i.total) - Number(i.amountPaid);
    }
    expect(myOutstanding.toFixed(4)).toBe('710000.0000');

    // The AR control invariant: the GL balance of AR (1-1200) equals Σ of EVERY
    // posted invoice's outstanding across all customers (the subledger reconciles
    // to the control account). VOID invoices are excluded since their journal was
    // reversed (net-zero AR impact).
    const allPosted = await prisma.client.salesInvoice.findMany({
      where: { status: 'POSTED' },
    });
    let totalOutstanding = 0;
    for (const i of allPosted) {
      totalOutstanding += Number(i.total) - Number(i.amountPaid);
    }
    const arBalance = await app
      .get(BalancesService)
      .accountBalance(acc['1-1200'], new Date('2026-12-31'));
    expect(arBalance.balance).toBe(totalOutstanding.toFixed(4));
  });
  it('voids a payment on a later body date: reversal on that date, allocations unwound, voidedOn stored', async () => {
    const customerId = await newCustomer('CUST-PAY-VOID-DATE');
    const invoiceId = await makePostedInvoice(customerId);
    const r = await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: customerId,
        date: '2026-02-15',
        cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: invoiceId, amount: '400000' }],
      })
      .expect(201);
    const paymentId = (r.body as { id: string }).id;
    const posted = await request(server())
      .post(`/v1/payments/${paymentId}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    const jeId = (posted.body as { journalEntryId: string }).journalEntryId;

    // A void date before the payment date is rejected.
    const early = await request(server())
      .post(`/v1/payments/${paymentId}/void`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .send({ date: '2026-02-14' })
      .expect(422);
    expect((early.body as { code: string }).code).toBe('VALIDATION_FAILED');

    const res = await request(server())
      .post(`/v1/payments/${paymentId}/void`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .send({ date: '2026-03-03' })
      .expect(200);
    const body = res.body as { status: string; voidedOn: string };
    expect(body.status).toBe('VOID');
    expect(body.voidedOn.slice(0, 10)).toBe('2026-03-03');
    const rev = await prisma.client.journalEntry.findFirst({
      where: { reversalOfId: jeId },
    });
    expect(rev!.date.toISOString().slice(0, 10)).toBe('2026-03-03');
    const inv = await request(server())
      .get(`/v1/sales-invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${acct}`)
      .expect(200);
    expect((inv.body as { amountPaid: string }).amountPaid).toBe('0.0000');
  });

  it('no-body payment void stores voidedOn = payment date', async () => {
    const customerId = await newCustomer('CUST-PAY-VOID-NOBODY');
    const invoiceId = await makePostedInvoice(customerId);
    const r = await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: customerId,
        date: '2026-02-16',
        cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: invoiceId, amount: '100000' }],
      })
      .expect(201);
    const paymentId = (r.body as { id: string }).id;
    await request(server())
      .post(`/v1/payments/${paymentId}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    const res = await request(server())
      .post(`/v1/payments/${paymentId}/void`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    expect((res.body as { voidedOn: string }).voidedOn.slice(0, 10)).toBe(
      '2026-02-16',
    );
  });

  describe('cashAccountId must be a CASH-role account', () => {
    const createWithCash = async (
      partnerCode: string,
      cashAccountId: string,
      status: number,
    ) => {
      const customerId = await newCustomer(partnerCode);
      const invoiceId = await makePostedInvoice(customerId);
      return request(server())
        .post('/v1/payments')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          direction: 'RECEIPT',
          partnerId: customerId,
          date: '2026-02-20',
          cashAccountId,
          allocations: [{ salesInvoiceId: invoiceId, amount: '100000' }],
        })
        .expect(status);
    };

    it('rejects AR control as the cash account with 422 {accountId, role}', async () => {
      const res = await createWithCash('CUST-CASH-AR', acc['1-1200'], 422);
      const body = res.body as { code: string; details: unknown };
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.details).toEqual({
        accountId: acc['1-1200'],
        role: 'AR_CONTROL',
      });
    });

    it('rejects a role-less expense account as the cash account with 422', async () => {
      const res = await createWithCash('CUST-CASH-EXP', acc['5-2000'], 422);
      const body = res.body as { code: string; details: unknown };
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.details).toEqual({ accountId: acc['5-2000'], role: null });
    });

    it('accepts Bank (a second CASH-role account) as the cash account (201)', async () => {
      await createWithCash('CUST-CASH-BANK', acc['1-1100'], 201);
    });

    it('rejects posting a pre-existing draft whose cash account is not CASH (422, stays DRAFT)', async () => {
      const res = await createWithCash('CUST-CASH-LEGACY', acc['1-1000'], 201);
      const id = (res.body as { id: string }).id;
      // Simulate a draft written before the guard existed.
      await prisma.client.payment.update({
        where: { id },
        data: { cashAccountId: acc['1-1200'] },
      });
      const post = await request(server())
        .post(`/v1/payments/${id}/post`)
        .set('Authorization', `Bearer ${appr}`)
        .set('Idempotency-Key', randomUUID())
        .expect(422);
      const body = post.body as { code: string; details: unknown };
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.details).toEqual({
        accountId: acc['1-1200'],
        role: 'AR_CONTROL',
      });
      const still = await prisma.client.payment.findUnique({ where: { id } });
      expect(still!.status).toBe('DRAFT');
    });

    it('preview rejects a non-CASH cash account the same way a create does (422)', async () => {
      const res = await request(server())
        .post('/v1/journal-entries/preview')
        .set('Authorization', `Bearer ${acct}`)
        .send({
          nature: 'PAYMENT',
          direction: 'RECEIPT',
          cashAccountId: acc['1-1200'],
          allocations: [{ salesInvoiceId: randomUUID(), amount: '1000' }],
        })
        .expect(422);
      const body = res.body as { code: string; details: unknown };
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.details).toEqual({
        accountId: acc['1-1200'],
        role: 'AR_CONTROL',
      });
    });
  });
  it('concurrent posts allocating [A,B] and [B,A] never deadlock (targets locked in id order)', async () => {
    const customerId = await newCustomer('CUST-PAY-LOCKORDER');
    const a = await makePostedInvoice(customerId);
    const b = await makePostedInvoice(customerId);
    const draft = async (first: string, second: string): Promise<string> =>
      (
        (
          await request(server())
            .post('/v1/payments')
            .set('Authorization', `Bearer ${acct}`)
            .set('Idempotency-Key', randomUUID())
            .send({
              direction: 'RECEIPT',
              partnerId: customerId,
              date: '2026-02-15',
              cashAccountId: acc['1-1000'],
              allocations: [
                { salesInvoiceId: first, amount: '1000' },
                { salesInvoiceId: second, amount: '1000' },
              ],
            })
            .expect(201)
        ).body as { id: string }
      ).id;
    const post = (id: string) =>
      request(server())
        .post(`/v1/payments/${id}/post`)
        .set('Authorization', `Bearer ${appr}`)
        .set('Idempotency-Key', randomUUID());

    const statuses: number[] = [];
    for (let round = 0; round < 8; round++) {
      const [p1, p2] = [await draft(a, b), await draft(b, a)];
      const results = await Promise.all([post(p1), post(p2)]);
      statuses.push(...results.map((r) => r.status));
    }
    // Opposite input orders lock identically, so the two posts queue rather
    // than deadlock: every post succeeds (no 500, no retryable 409).
    expect(statuses.every((st) => st === 200)).toBe(true);
    const inv = await prisma.client.salesInvoice.findMany({
      where: { id: { in: [a, b] } },
      select: { amountPaid: true },
    });
    for (const i of inv) expect(i.amountPaid.toString()).toBe('16000');
  });

  describe('backdated payment vs a later-voided payment (aging == control for past dates)', () => {
    // A VOID payment still counts as live on [its date, its voidedOn) in the
    // as-of aging. A new payment dated inside that window would push the
    // document's as-of paid total past its total for those days, so aging
    // would drop the document while AR control still carried the difference.
    const createPay = (
      partnerId: string,
      invoiceId: string,
      date: string,
      amount: string,
    ) =>
      request(server())
        .post('/v1/payments')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          direction: 'RECEIPT',
          partnerId,
          date,
          cashAccountId: acc['1-1000'],
          allocations: [{ salesInvoiceId: invoiceId, amount }],
        });
    const postPay = (id: string) =>
      request(server())
        .post(`/v1/payments/${id}/post`)
        .set('Authorization', `Bearer ${appr}`)
        .set('Idempotency-Key', randomUUID());
    const voidPay = (id: string, date: string) =>
      request(server())
        .post(`/v1/payments/${id}/void`)
        .set('Authorization', `Bearer ${appr}`)
        .set('Idempotency-Key', randomUUID())
        .send({ date })
        .expect(200);
    const postedPayment = async (
      partnerId: string,
      invoiceId: string,
      date: string,
      amount: string,
    ) => {
      const r = await createPay(partnerId, invoiceId, date, amount).expect(201);
      const id = (r.body as { id: string }).id;
      await postPay(id).expect(200);
      return id;
    };

    it('full: rejects a new payment dated before the void date (422), accepts one dated on it', async () => {
      const customerId = await newCustomer('CUST-PAY-BACKVOID-1');
      const invoiceId = await makePostedInvoice(customerId); // 1,110,000 @ 02-10
      const p1 = await postedPayment(
        customerId,
        invoiceId,
        '2026-02-20',
        '1110000',
      );
      await voidPay(p1, '2026-03-10');

      const early = await createPay(
        customerId,
        invoiceId,
        '2026-03-05',
        '1110000',
      ).expect(422);
      const body = early.body as {
        code: string;
        details: Record<string, unknown>;
      };
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.details).toEqual({
        documentId: invoiceId,
        paymentDate: '2026-03-05',
        conflictingVoidedOn: '2026-03-10',
      });

      await postedPayment(customerId, invoiceId, '2026-03-10', '1110000');
    });

    it('partial: accepts a backdated payment that still fits beside the voided one, rejects one that does not', async () => {
      const customerId = await newCustomer('CUST-PAY-BACKVOID-2');
      const invoiceId = await makePostedInvoice(customerId);
      const p1 = await postedPayment(
        customerId,
        invoiceId,
        '2026-02-20',
        '600000',
      );
      await voidPay(p1, '2026-03-10');
      // 600,000 (void, live until 03-10) + 510,000 = 1,110,000 ≤ total → OK.
      await postedPayment(customerId, invoiceId, '2026-03-05', '510000');
      // Another 1 dated 03-05 would make 1,110,001 live on 03-05..03-09.
      const over = await createPay(
        customerId,
        invoiceId,
        '2026-03-05',
        '1',
      ).expect(422);
      expect(
        (over.body as { details: { conflictingVoidedOn: string } }).details
          .conflictingVoidedOn,
      ).toBe('2026-03-10');
      // Dated on the void day the voided payment no longer counts → OK.
      await postedPayment(customerId, invoiceId, '2026-03-10', '600000');
    });

    it('re-checks at post: a draft that became unsafe after a later void + payment is rejected (422), stays DRAFT', async () => {
      const customerId = await newCustomer('CUST-PAY-BACKVOID-3');
      const invoiceId = await makePostedInvoice(customerId);
      const p1 = await postedPayment(
        customerId,
        invoiceId,
        '2026-02-20',
        '600000',
      );
      // Draft dated 03-05 for 510,000: fine while P1 is posted (600k + 510k).
      const draft = await createPay(
        customerId,
        invoiceId,
        '2026-03-05',
        '510000',
      ).expect(201);
      const draftId = (draft.body as { id: string }).id;
      await voidPay(p1, '2026-03-10');
      // 510,000 @ 03-07: live 03-07 = 600k (void) + 510k = 1.11M → OK.
      await postedPayment(customerId, invoiceId, '2026-03-07', '510000');
      // Posting the draft now would make 03-07 carry 1.62M against 1.11M.
      const res = await postPay(draftId).expect(422);
      expect(
        (res.body as { details: Record<string, unknown> }).details,
      ).toEqual({
        documentId: invoiceId,
        paymentDate: '2026-03-05',
        conflictingVoidedOn: '2026-03-10',
      });
      const row = await prisma.client.payment.findFirst({
        where: { id: draftId },
      });
      expect(row!.status).toBe('DRAFT');
    });

    it('a document with a same-day-voided payment (never live) is unaffected', async () => {
      const customerId = await newCustomer('CUST-PAY-BACKVOID-4');
      const invoiceId = await makePostedInvoice(customerId);
      const p1 = await postedPayment(
        customerId,
        invoiceId,
        '2026-02-20',
        '1110000',
      );
      await voidPay(p1, '2026-02-20');
      await postedPayment(customerId, invoiceId, '2026-02-15', '1110000');
    });
  });
});
