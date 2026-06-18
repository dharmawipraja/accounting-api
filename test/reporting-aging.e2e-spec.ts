import { Test } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { BalancesService } from '../src/ledger/balances/balances.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { SalesInvoicesService } from '../src/invoicing/sales-invoices.service';
import { PurchaseBillsService } from '../src/invoicing/purchase-bills.service';
import { PaymentsService } from '../src/invoicing/payments.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Reporting AR/AP aging (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let viewerToken: string;
  let acc: Record<string, string>;
  let code: Record<string, string>;
  let firstInvoiceRef: string;
  let secondInvoiceRef: string;
  let acctUserId: string;
  let apprUserId: string;

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

    await app.get(CompanyService).seedIfEmpty();
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    await app.get(AccountsService).seedIfEmpty();
    await app.get(TaxCodesService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);

    const users = app.get(UsersService);
    const acctUser = await users.create({
      email: 'acct@aging.test',
      password: 'secret123',
      name: 'Acct',
      role: 'ACCOUNTANT',
    });
    const apprUser = await users.create({
      email: 'appr@aging.test',
      password: 'secret123',
      name: 'Appr',
      role: 'APPROVER',
    });
    await users.create({
      email: 'view@aging.test',
      password: 'secret123',
      name: 'Viewer',
      role: 'VIEWER',
    });
    acctUserId = acctUser.id;
    apprUserId = apprUser.id;
    const auth = app.get(AuthService);
    viewerToken = (await auth.login('view@aging.test', 'secret123'))
      .accessToken;

    const { data: accounts } = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    const { data: codes } = await app.get(TaxCodesService).list();
    code = Object.fromEntries(codes.map((c) => [c.code, c.id]));

    const customer = await app.get(BusinessPartnersService).create({
      code: 'CUST-AGING-1',
      name: 'Pelanggan Aging',
      isCustomer: true,
    });

    const invoices = app.get(SalesInvoicesService);
    // First invoice: dated 2026-01-10, due 2026-02-09, total 1,110,000.
    const draft1 = await invoices.createDraft({
      partnerId: customer.id,
      date: new Date('2026-01-10'),
      dueDate: new Date('2026-02-09'),
      description: 'Invoice satu',
      lines: [
        {
          description: 'Jasa konsultasi',
          accountId: acc['4-1000'],
          quantity: '1',
          unitPrice: '1000000',
          taxCodeIds: [code['PPN-OUT-11']],
        },
      ],
      createdBy: acctUser.id,
    });
    const inv1 = await invoices.post(draft1.id, apprUser.id);
    firstInvoiceRef = inv1.invoiceRef!;

    // Second invoice: dated 2026-06-01 (after the asOf), due 2026-07-01.
    const draft2 = await invoices.createDraft({
      partnerId: customer.id,
      date: new Date('2026-06-01'),
      dueDate: new Date('2026-07-01'),
      description: 'Invoice dua',
      lines: [
        {
          description: 'Jasa konsultasi lanjutan',
          accountId: acc['4-1000'],
          quantity: '1',
          unitPrice: '1000000',
          taxCodeIds: [code['PPN-OUT-11']],
        },
      ],
      createdBy: acctUser.id,
    });
    const inv2 = await invoices.post(draft2.id, apprUser.id);
    secondInvoiceRef = inv2.invoiceRef!;

    // A receipt of 500,000 dated 2026-02-15, allocated to the first invoice.
    const payments = app.get(PaymentsService);
    const draftPay = await payments.createDraft({
      direction: 'RECEIPT',
      partnerId: customer.id,
      date: new Date('2026-02-15'),
      cashAccountId: acc['1-1000'],
      allocations: [{ salesInvoiceId: inv1.id, amount: '500000' }],
      createdBy: acctUser.id,
    });
    await payments.post(draftPay.id, apprUser.id);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  const get = (url: string) =>
    request(app.getHttpServer() as App)
      .get(url)
      .set('Authorization', `Bearer ${viewerToken}`);

  it('AR aging: first invoice outstanding 610,000 in the 31-60 bucket; second (future-dated) absent; ties to the AR control', async () => {
    const res = await get('/v1/reports/ar-aging?asOf=2026-03-15').expect(200);
    const body = res.body as {
      partners: {
        documents: {
          ref: string | null;
          outstanding: string;
          bucket: string;
        }[];
      }[];
      totalOutstanding: string;
    };

    const docs = body.partners.flatMap((p) => p.documents);
    const first = docs.find((d) => d.ref === firstInvoiceRef);
    expect(first).toBeDefined();
    // 1,110,000 − 500,000 (the receipt dated before asOf) = 610,000.
    expect(first!.outstanding).toBe('610000.0000');
    // Due 2026-02-09; asOf 2026-03-15 → 34 days past due → '31-60'.
    expect(first!.bucket).toBe('31-60');

    // The second invoice is dated 2026-06-01 (> asOf) → not yet on the books.
    const second = docs.find((d) => d.ref === secondInvoiceRef);
    expect(second).toBeUndefined();

    // The subledger ties to the AR control account balance as of the same day.
    const arControl = await app
      .get(BalancesService)
      .accountBalance(acc['1-1200'], new Date('2026-03-15'));
    expect(body.totalOutstanding).toBe(Number(arControl.balance).toFixed(4));
  });

  it('AP aging: a partially-paid bill ages into 31-60 and ties to the AP control (2-1000)', async () => {
    const vendor = await app.get(BusinessPartnersService).create({
      code: 'VEND-AGING-1',
      name: 'Pemasok Aging',
      isVendor: true,
    });
    const bills = app.get(PurchaseBillsService);
    // Bill dated 2026-01-12, due 2026-02-11, total 1,110,000 (1,000,000 + 11% PPN Masukan).
    const draft = await bills.createDraft({
      partnerId: vendor.id,
      date: new Date('2026-01-12'),
      dueDate: new Date('2026-02-11'),
      description: 'Tagihan jasa',
      lines: [
        {
          description: 'Jasa vendor',
          accountId: acc['5-2000'],
          quantity: '1',
          unitPrice: '1000000',
          taxCodeIds: [code['PPN-IN-11']],
        },
      ],
      createdBy: acctUserId,
    });
    const bill = await bills.post(draft.id, apprUserId);

    // A disbursement of 400,000 dated 2026-02-20, allocated to the bill.
    const payments = app.get(PaymentsService);
    const draftPay = await payments.createDraft({
      direction: 'DISBURSEMENT',
      partnerId: vendor.id,
      date: new Date('2026-02-20'),
      cashAccountId: acc['1-1000'],
      allocations: [{ purchaseBillId: bill.id, amount: '400000' }],
      createdBy: acctUserId,
    });
    await payments.post(draftPay.id, apprUserId);

    const res = await get('/v1/reports/ap-aging?asOf=2026-03-15').expect(200);
    const body = res.body as {
      partners: {
        documents: {
          ref: string | null;
          outstanding: string;
          bucket: string;
        }[];
      }[];
      totalOutstanding: string;
    };
    const doc = body.partners
      .flatMap((p) => p.documents)
      .find((d) => d.ref === bill.billRef);
    expect(doc).toBeDefined();
    expect(doc!.outstanding).toBe('710000.0000'); // 1,110,000 − 400,000
    expect(doc!.bucket).toBe('31-60'); // due 2026-02-11; asOf 2026-03-15 → 32 days

    const apControl = await app
      .get(BalancesService)
      .accountBalance(acc['2-1000'], new Date('2026-03-15'));
    expect(body.totalOutstanding).toBe(Number(apControl.balance).toFixed(4));
  });
});
