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
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Idempotency (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let acct: string;
  let acc: Record<string, string>;
  let code: Record<string, string>;
  const server = () => app.getHttpServer() as App;

  const newCustomer = async (codeStr: string): Promise<string> =>
    (
      await app
        .get(BusinessPartnersService)
        .create({ code: codeStr, name: 'PT Idem', isCustomer: true })
    ).id;

  const invoiceBody = (partnerId: string, unitPrice = '1000000') => ({
    partnerId,
    date: '2026-02-10',
    description: 'Jasa',
    lines: [
      {
        description: 'Jasa konsultasi',
        accountId: acc['4-1000'],
        quantity: '1',
        unitPrice,
        taxCodeIds: [code['PPN-OUT-11']],
      },
    ],
  });

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
      email: 'acct@idem.test',
      password: 'secret123',
      name: 'Acct',
      role: 'ACCOUNTANT',
    });
    acct = (await app.get(AuthService).login('acct@idem.test', 'secret123'))
      .accessToken;
    acc = Object.fromEntries(
      (await app.get(AccountsService).list()).map((a) => [a.code, a.id]),
    );
    code = Object.fromEntries(
      (await app.get(TaxCodesService).list()).map((c) => [c.code, c.id]),
    );
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  it('replays the same key+body and creates exactly one invoice', async () => {
    const partnerId = await newCustomer('CUST-IDEM-1');
    const key = randomUUID();
    const body = invoiceBody(partnerId);
    const first = await request(server())
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const second = await request(server())
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect((second.body as { id: string }).id).toBe(
      (first.body as { id: string }).id,
    );
    const count = await prisma.client.salesInvoice.count({
      where: { partnerId },
    });
    expect(count).toBe(1);
  });

  it('rejects the same key with a different body (422)', async () => {
    const partnerId = await newCustomer('CUST-IDEM-2');
    const key = randomUUID();
    await request(server())
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', key)
      .send(invoiceBody(partnerId, '1000000'))
      .expect(201);
    await request(server())
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', key)
      .send(invoiceBody(partnerId, '2000000'))
      .expect(422);
  });

  it('requires the header (422 when missing)', async () => {
    const partnerId = await newCustomer('CUST-IDEM-3');
    await request(server())
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .send(invoiceBody(partnerId))
      .expect(422);
  });

  it('two concurrent identical requests create exactly one invoice', async () => {
    const partnerId = await newCustomer('CUST-IDEM-RACE');
    const key = randomUUID();
    const body = invoiceBody(partnerId);
    const send = () =>
      request(server())
        .post('/v1/sales-invoices')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', key)
        .send(body);
    const results = await Promise.allSettled([send(), send()]);
    const statuses = results.map((r) =>
      r.status === 'fulfilled' ? r.value.status : 0,
    );
    // One succeeds (201). The other replays (201) or is rejected in-flight (409).
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
    const count = await prisma.client.salesInvoice.count({
      where: { partnerId },
    });
    expect(count).toBe(1);
  });
});
