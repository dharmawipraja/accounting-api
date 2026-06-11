import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { BalancesService } from '../src/ledger/balances/balances.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Payments (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let acct: string; // accountant token
  let appr: string; // approver token
  let acc: Record<string, string>;
  let code: Record<string, string>;

  const server = () => app.getHttpServer() as App;

  /** Create + post a sales invoice (total 1,110,000) for a partner; returns its id. */
  const makePostedInvoice = async (partnerId: string): Promise<string> => {
    const draft = await request(server())
      .post('/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
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
      .post(`/sales-invoices/${id}/post`)
      .set('Authorization', `Bearer ${appr}`)
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
    db = await startTestDb();
    prisma = makePrismaOverride(db.url);
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
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
    const accounts = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    const codes = await app.get(TaxCodesService).list();
    code = Object.fromEntries(codes.map((c) => [c.code, c.id]));
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  it('partial then full receipt: PARTIAL→PAID, GL debits Kas / credits AR', async () => {
    const customerId = await newCustomer('CUST-PAY-1');
    const invoiceId = await makePostedInvoice(customerId);

    // First receipt: allocate 600000.
    const r1 = await request(server())
      .post('/payments')
      .set('Authorization', `Bearer ${acct}`)
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
      .post(`/payments/${p1.id}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .expect(200);
    const posted1Body = posted1.body as {
      status: string;
      ref: string;
      journalEntryId: string;
    };
    expect(posted1Body.status).toBe('POSTED');

    let inv = await request(server())
      .get(`/sales-invoices/${invoiceId}`)
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
      .post('/payments')
      .set('Authorization', `Bearer ${acct}`)
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
      .post(`/payments/${p2.id}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .expect(200);

    inv = await request(server())
      .get(`/sales-invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${acct}`)
      .expect(200);
    expect((inv.body as { paymentStatus: string }).paymentStatus).toBe('PAID');
    expect((inv.body as { outstanding: string }).outstanding).toBe('0.0000');
  });

  it('rejects a zero allocation amount (422)', async () => {
    const customerId = await newCustomer('CUST-PAY-ZERO');
    const invoiceId = await makePostedInvoice(customerId);
    await request(server())
      .post('/payments')
      .set('Authorization', `Bearer ${acct}`)
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
      .post('/payments')
      .set('Authorization', `Bearer ${acct}`)
      .send({
        direction: 'RECEIPT',
        partnerId: customerId,
        date: '2026-02-15',
        cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: invoiceId, amount: '2000000' }],
      })
      .expect(422);
  });

  it('voiding a receipt restores invoice outstanding; the invoice can then be voided', async () => {
    const customerId = await newCustomer('CUST-PAY-VOID');
    const invoiceId = await makePostedInvoice(customerId);

    // Fully pay the invoice.
    const r = await request(server())
      .post('/payments')
      .set('Authorization', `Bearer ${acct}`)
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
      .post(`/payments/${paymentId}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .expect(200);

    let inv = await request(server())
      .get(`/sales-invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${acct}`)
      .expect(200);
    expect((inv.body as { paymentStatus: string }).paymentStatus).toBe('PAID');

    // Void the payment → invoice restored to UNPAID, outstanding == total.
    await request(server())
      .post(`/payments/${paymentId}/void`)
      .set('Authorization', `Bearer ${appr}`)
      .expect(200);

    inv = await request(server())
      .get(`/sales-invoices/${invoiceId}`)
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
      .post(`/sales-invoices/${invoiceId}/void`)
      .set('Authorization', `Bearer ${appr}`)
      .expect(200);
  });

  it('concurrent post of two full-outstanding payments settles exactly once (one 200, one 409)', async () => {
    const customerId = await newCustomer('CUST-PAY-RACE');
    const invoiceId = await makePostedInvoice(customerId); // total 1,110,000
    const draft = async (): Promise<string> => {
      const res = await request(server())
        .post('/payments')
        .set('Authorization', `Bearer ${acct}`)
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
        .post(`/payments/${p1}/post`)
        .set('Authorization', `Bearer ${appr}`),
      request(server())
        .post(`/payments/${p2}/post`)
        .set('Authorization', `Bearer ${appr}`),
    ]);
    const codes = results.map((r) =>
      r.status === 'fulfilled' ? r.value.status : 0,
    );
    expect(codes.filter((c) => c === 200)).toHaveLength(1); // exactly one settled
    expect(codes.some((c) => c === 409)).toBe(true); // the other rejected under the FOR UPDATE re-check
    // The invoice is paid exactly once — no double-settlement, no negative outstanding.
    const inv = await request(server())
      .get(`/sales-invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${appr}`)
      .expect(200);
    const body = inv.body as { paymentStatus: string; outstanding: string };
    expect(body.paymentStatus).toBe('PAID');
    expect(body.outstanding).toBe('0.0000');
  });

  it('reconciliation invariant: AR control GL balance == Σ all posted invoice outstanding', async () => {
    const customerId = await newCustomer('CUST-RECON');
    const invoiceId = await makePostedInvoice(customerId);

    // Partial receipt of 400000 → this invoice outstanding 710000.
    const r = await request(server())
      .post('/payments')
      .set('Authorization', `Bearer ${acct}`)
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
      .post(`/payments/${paymentId}/post`)
      .set('Authorization', `Bearer ${appr}`)
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
});
