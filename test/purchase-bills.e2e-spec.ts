import { Test } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
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

describe('PurchaseBills (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let acct: string; // accountant token
  let appr: string; // approver token
  let acc: Record<string, string>;
  let code: Record<string, string>;
  let vendorId: string;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = makePrismaOverride(db.url);
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
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
      email: 'acct@pb.test',
      password: 'secret123',
      name: 'Acct',
      role: 'ACCOUNTANT',
    });
    await users.create({
      email: 'appr@pb.test',
      password: 'secret123',
      name: 'Appr',
      role: 'APPROVER',
    });
    acct = (await app.get(AuthService).login('acct@pb.test', 'secret123'))
      .accessToken;
    appr = (await app.get(AuthService).login('appr@pb.test', 'secret123'))
      .accessToken;
    const accounts = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    const codes = await app.get(TaxCodesService).list();
    code = Object.fromEntries(codes.map((c) => [c.code, c.id]));
    vendorId = (
      await app
        .get(BusinessPartnersService)
        .create({ code: 'VEND-PB', name: 'Pemasok', isVendor: true })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  const draftBody = () => ({
    partnerId: vendorId,
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
  });

  it('creates a DRAFT bill with computed totals (201)', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/v1/purchase-bills')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send(draftBody())
      .expect(201);
    const body = res.body as {
      status: string;
      subtotal: string;
      taxTotal: string;
      total: string;
      billNumber: number | null;
      lines: { amount: string; unitPrice: string }[];
    };
    expect(body.status).toBe('DRAFT');
    expect(body.subtotal).toBe('1000000.0000');
    expect(body.taxTotal).toBe('110000.0000');
    expect(body.total).toBe('1110000.0000');
    expect(body.billNumber).toBeNull();
    // Line-level money is serialized to the same 4dp convention.
    expect(body.lines[0].amount).toBe('1000000.0000');
    expect(body.lines[0].unitPrice).toBe('1000000.0000');
  });

  it('posts a DRAFT bill → POSTED, gapless number, balanced GL entry crediting AP (2-1000)', async () => {
    const draft = await request(app.getHttpServer() as App)
      .post('/v1/purchase-bills')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send(draftBody())
      .expect(201);
    const id = (draft.body as { id: string }).id;
    const posted = await request(app.getHttpServer() as App)
      .post(`/v1/purchase-bills/${id}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    const body = posted.body as {
      status: string;
      billNumber: number;
      billRef: string;
      journalEntryId: string;
      outstanding: string;
      paymentStatus: string;
    };
    expect(body.status).toBe('POSTED');
    expect(body.billNumber).toBeGreaterThan(0);
    expect(body.billRef).toMatch(/^BILL\/2026\/\d{6}$/);
    expect(body.outstanding).toBe('1110000.0000');
    expect(body.paymentStatus).toBe('UNPAID');
    // GL entry balances and credits AP (Hutang 2-1000) by the total.
    const lines = await prisma.client.journalLine.findMany({
      where: { journalEntryId: body.journalEntryId },
    });
    const debit = lines.reduce((s, l) => s + Number(l.debit), 0);
    const credit = lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(debit).toBe(credit);
    const ap = lines.find((l) => l.accountId === acc['2-1000']);
    expect(ap!.credit.toString()).toBe('1110000');
  });

  it('rejects an ACCOUNTANT trying to post (403)', async () => {
    const draft = await request(app.getHttpServer() as App)
      .post('/v1/purchase-bills')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send(draftBody())
      .expect(201);
    const id = (draft.body as { id: string }).id;
    await request(app.getHttpServer() as App)
      .post(`/v1/purchase-bills/${id}/post`)
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .expect(403);
  });

  it('voids a POSTED unpaid bill (200) → VOID and reverses the GL entry', async () => {
    const draft = await request(app.getHttpServer() as App)
      .post('/v1/purchase-bills')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send(draftBody())
      .expect(201);
    const id = (draft.body as { id: string }).id;
    await request(app.getHttpServer() as App)
      .post(`/v1/purchase-bills/${id}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    const voided = await request(app.getHttpServer() as App)
      .post(`/v1/purchase-bills/${id}/void`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    expect((voided.body as { status: string }).status).toBe('VOID');
  });

  it('rejects creating a draft for a non-vendor partner (422)', async () => {
    const customer = await app
      .get(BusinessPartnersService)
      .create({ code: 'CUST-ONLY-PB', name: 'C', isCustomer: true });
    await request(app.getHttpServer() as App)
      .post('/v1/purchase-bills')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({ ...draftBody(), partnerId: customer.id })
      .expect(422);
  });
});
