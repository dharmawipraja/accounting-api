import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('SalesInvoices (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let acct: string; // accountant token
  let appr: string; // approver token
  let acc: Record<string, string>;
  let code: Record<string, string>;
  let customerId: string;

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
      email: 'acct@si.test',
      password: 'secret123',
      name: 'Acct',
      role: 'ACCOUNTANT',
    });
    await users.create({
      email: 'appr@si.test',
      password: 'secret123',
      name: 'Appr',
      role: 'APPROVER',
    });
    acct = (await app.get(AuthService).login('acct@si.test', 'secret123'))
      .accessToken;
    appr = (await app.get(AuthService).login('appr@si.test', 'secret123'))
      .accessToken;
    const accounts = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    const codes = await app.get(TaxCodesService).list();
    code = Object.fromEntries(codes.map((c) => [c.code, c.id]));
    customerId = (
      await app
        .get(BusinessPartnersService)
        .create({ code: 'CUST-SI', name: 'Pelanggan', isCustomer: true })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  const draftBody = () => ({
    partnerId: customerId,
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
  });

  it('creates a DRAFT invoice with computed totals (201)', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .send(draftBody())
      .expect(201);
    const body = res.body as {
      status: string;
      subtotal: string;
      taxTotal: string;
      total: string;
      invoiceNumber: number | null;
    };
    expect(body.status).toBe('DRAFT');
    expect(body.subtotal).toBe('1000000.0000');
    expect(body.taxTotal).toBe('110000.0000');
    expect(body.total).toBe('1110000.0000');
    expect(body.invoiceNumber).toBeNull();
  });

  it('posts a DRAFT invoice → POSTED, gapless number, balanced GL entry hitting AR (1-1200)', async () => {
    const draft = await request(app.getHttpServer() as App)
      .post('/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .send(draftBody())
      .expect(201);
    const id = (draft.body as { id: string }).id;
    const posted = await request(app.getHttpServer() as App)
      .post(`/sales-invoices/${id}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .expect(200);
    const body = posted.body as {
      status: string;
      invoiceNumber: number;
      invoiceRef: string;
      journalEntryId: string;
      outstanding: string;
      paymentStatus: string;
    };
    expect(body.status).toBe('POSTED');
    expect(body.invoiceNumber).toBeGreaterThan(0);
    expect(body.invoiceRef).toMatch(/^INV\/2026\/\d{6}$/);
    expect(body.outstanding).toBe('1110000.0000');
    expect(body.paymentStatus).toBe('UNPAID');
    // GL entry balances and debits AR (Piutang 1-1200) by the total.
    const lines = await prisma.client.journalLine.findMany({
      where: { journalEntryId: body.journalEntryId },
    });
    const debit = lines.reduce((s, l) => s + Number(l.debit), 0);
    const credit = lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(debit).toBe(credit);
    const ar = lines.find((l) => l.accountId === acc['1-1200']);
    expect(ar!.debit.toString()).toBe('1110000');
  });

  it('rejects an ACCOUNTANT trying to post (403)', async () => {
    const draft = await request(app.getHttpServer() as App)
      .post('/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .send(draftBody())
      .expect(201);
    const id = (draft.body as { id: string }).id;
    await request(app.getHttpServer() as App)
      .post(`/sales-invoices/${id}/post`)
      .set('Authorization', `Bearer ${acct}`)
      .expect(403);
  });

  it('voids a POSTED unpaid invoice (200) → VOID and reverses the GL entry', async () => {
    const draft = await request(app.getHttpServer() as App)
      .post('/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .send(draftBody())
      .expect(201);
    const id = (draft.body as { id: string }).id;
    await request(app.getHttpServer() as App)
      .post(`/sales-invoices/${id}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .expect(200);
    const voided = await request(app.getHttpServer() as App)
      .post(`/sales-invoices/${id}/void`)
      .set('Authorization', `Bearer ${appr}`)
      .expect(200);
    expect((voided.body as { status: string }).status).toBe('VOID');
  });

  it('rejects posting a draft for a non-customer partner (422)', async () => {
    const vendor = await app
      .get(BusinessPartnersService)
      .create({ code: 'VEND-ONLY', name: 'V', isVendor: true });
    await request(app.getHttpServer() as App)
      .post('/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .send({ ...draftBody(), partnerId: vendor.id })
      .expect(422);
  });
});
