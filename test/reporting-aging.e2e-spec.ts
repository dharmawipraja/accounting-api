import * as request from 'supertest';
import { type App } from 'supertest/types';
import { INestApplication } from '@nestjs/common';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { BalancesService } from '../src/ledger/balances/balances.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { SalesInvoicesService } from '../src/invoicing/sales-invoices.service';
import { PurchaseBillsService } from '../src/invoicing/purchase-bills.service';
import { AgingService } from '../src/reporting/aging.service';
import { PaymentsService } from '../src/invoicing/payments.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';

describe('Reporting AR/AP aging (e2e)', () => {
  let app: INestApplication;
  let cleanup: () => Promise<void>;
  let viewerToken: string;
  let acc: Record<string, string>;
  let code: Record<string, string>;
  let firstInvoiceRef: string;
  let secondInvoiceRef: string;
  let acctUserId: string;
  let apprUserId: string;

  beforeAll(async () => {
    ({ app, cleanup } = await bootstrapTestApp());

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

  afterAll(() => cleanup());

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

  // R-1: bucketOf() '1-30' branch — invoice due yesterday (1 day past due) lands in '1-30'.
  it("AR aging: invoice 1 day past due lands in '1-30' bucket", async () => {
    const customer = await app.get(BusinessPartnersService).create({
      code: 'CUST-AGING-130',
      name: 'Pelanggan 1-30',
      isCustomer: true,
    });
    const invoices = app.get(SalesInvoicesService);
    // Due 2026-04-14; asOf 2026-04-15 → 1 day past due → '1-30'.
    const draft = await invoices.createDraft({
      partnerId: customer.id,
      date: new Date('2026-04-01'),
      dueDate: new Date('2026-04-14'),
      description: 'Invoice 1-30 bucket test',
      lines: [
        {
          description: 'Jasa',
          accountId: acc['4-1000'],
          quantity: '1',
          unitPrice: '200000',
          taxCodeIds: [],
        },
      ],
      createdBy: acctUserId,
    });
    const inv = await invoices.post(draft.id, apprUserId);

    const res = await get('/v1/reports/ar-aging?asOf=2026-04-15').expect(200);
    const body = res.body as {
      partners: { documents: { ref: string | null; bucket: string }[] }[];
    };
    const doc = body.partners
      .flatMap((p) => p.documents)
      .find((d) => d.ref === inv.invoiceRef);
    expect(doc).toBeDefined();
    expect(doc!.bucket).toBe('1-30');
  });

  // R-1: bucketOf() '61-90' branch — invoice 61 days past due.
  it("AR aging: invoice 61 days past due lands in '61-90' bucket", async () => {
    const customer = await app.get(BusinessPartnersService).create({
      code: 'CUST-AGING-6190',
      name: 'Pelanggan 61-90',
      isCustomer: true,
    });
    const invoices = app.get(SalesInvoicesService);
    // Due 2026-01-13; asOf 2026-03-15 → 61 days past due → '61-90'.
    const draft = await invoices.createDraft({
      partnerId: customer.id,
      date: new Date('2026-01-01'),
      dueDate: new Date('2026-01-13'),
      description: 'Invoice 61-90 bucket test',
      lines: [
        {
          description: 'Jasa',
          accountId: acc['4-1000'],
          quantity: '1',
          unitPrice: '300000',
          taxCodeIds: [],
        },
      ],
      createdBy: acctUserId,
    });
    const inv = await invoices.post(draft.id, apprUserId);

    const res = await get('/v1/reports/ar-aging?asOf=2026-03-15').expect(200);
    const body = res.body as {
      partners: { documents: { ref: string | null; bucket: string }[] }[];
    };
    const doc = body.partners
      .flatMap((p) => p.documents)
      .find((d) => d.ref === inv.invoiceRef);
    expect(doc).toBeDefined();
    expect(doc!.bucket).toBe('61-90');
  });

  // R-1: bucketOf() '>90' branch — invoice > 90 days past due.
  // Due 2026-02-01; asOf 2026-05-15 → 103 days past due → '>90'.
  // Uses a later asOf to avoid needing 2025 periods.
  it("AR aging: invoice > 90 days past due lands in '>90' bucket", async () => {
    const customer = await app.get(BusinessPartnersService).create({
      code: 'CUST-AGING-GT90',
      name: 'Pelanggan >90',
      isCustomer: true,
    });
    const invoices = app.get(SalesInvoicesService);
    const draft = await invoices.createDraft({
      partnerId: customer.id,
      date: new Date('2026-01-15'),
      dueDate: new Date('2026-02-01'),
      description: 'Invoice >90 bucket test',
      lines: [
        {
          description: 'Jasa',
          accountId: acc['4-1000'],
          quantity: '1',
          unitPrice: '400000',
          taxCodeIds: [],
        },
      ],
      createdBy: acctUserId,
    });
    const inv = await invoices.post(draft.id, apprUserId);

    // 2026-05-15 − 2026-02-01 = 103 days past due → '>90'.
    const res = await get('/v1/reports/ar-aging?asOf=2026-05-15').expect(200);
    const body = res.body as {
      partners: { documents: { ref: string | null; bucket: string }[] }[];
    };
    const doc = body.partners
      .flatMap((p) => p.documents)
      .find((d) => d.ref === inv.invoiceRef);
    expect(doc).toBeDefined();
    expect(doc!.bucket).toBe('>90');
  });

  // R-2: outstanding.isZero() skip — a fully-paid invoice must not appear in the aging report.
  it('AR aging: fully-paid invoice does not appear in the report (outstanding skip)', async () => {
    const customer = await app.get(BusinessPartnersService).create({
      code: 'CUST-AGING-PAID',
      name: 'Pelanggan Lunas',
      isCustomer: true,
    });
    const invoices = app.get(SalesInvoicesService);
    // Invoice of 500,000 (no tax), due 2026-01-31.
    const draft = await invoices.createDraft({
      partnerId: customer.id,
      date: new Date('2026-01-10'),
      dueDate: new Date('2026-01-31'),
      description: 'Invoice fully paid',
      lines: [
        {
          description: 'Jasa',
          accountId: acc['4-1000'],
          quantity: '1',
          unitPrice: '500000',
          taxCodeIds: [],
        },
      ],
      createdBy: acctUserId,
    });
    const inv = await invoices.post(draft.id, apprUserId);

    // Full receipt of 500,000 — pays the invoice completely.
    const payments = app.get(PaymentsService);
    const draftPay = await payments.createDraft({
      direction: 'RECEIPT',
      partnerId: customer.id,
      date: new Date('2026-02-01'),
      cashAccountId: acc['1-1000'],
      allocations: [{ salesInvoiceId: inv.id, amount: '500000' }],
      createdBy: acctUserId,
    });
    await payments.post(draftPay.id, apprUserId);

    // asOf 2026-03-15: payment is before asOf, so outstanding = 500,000 − 500,000 = 0 → skipped.
    const res = await get('/v1/reports/ar-aging?asOf=2026-03-15').expect(200);
    const body = res.body as {
      partners: { documents: { ref: string | null }[] }[];
    };
    const doc = body.partners
      .flatMap((p) => p.documents)
      .find((d) => d.ref === inv.invoiceRef);
    expect(doc).toBeUndefined();
  });

  it('caps documents at maxDocs and flags truncation', async () => {
    const aging = app.get(AgingService);
    // asOf 2026-07-01: both seeded invoices are on the books and outstanding.
    const full = await aging.aging('AR', new Date('2026-07-01'));
    expect(full.truncated).toBe(false);
    const outstandingDocs = full.partners.flatMap((p) => p.documents);
    expect(outstandingDocs.length).toBeGreaterThanOrEqual(2);

    const capped = await aging.aging('AR', new Date('2026-07-01'), 1);
    expect(capped.truncated).toBe(true);
    expect(capped.partners.flatMap((p) => p.documents)).toHaveLength(1);
  });
});
