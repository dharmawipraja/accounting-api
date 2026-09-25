import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { CompanyService } from '../src/company/company.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';

/** Audit3 Task 8 invoicing correctness rules: free lines, due dates, PKP,
 *  vendor-invoice uniqueness, payment-vs-document dates, contra-asset lines. */
describe('Invoicing rules (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let acct: string;
  let appr: string;
  let acc: Record<string, string>;
  let code: Record<string, string>;
  let customerId: string;
  let vendorId: string;
  let vendor2Id: string;

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());
    await app.get(AccountsService).seedIfEmpty();
    await app.get(TaxCodesService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const users = app.get(UsersService);
    for (const [email, role] of [
      ['acct@rules.test', 'ACCOUNTANT'],
      ['appr@rules.test', 'APPROVER'],
    ] as const)
      await users.create({ email, password: 'secret123', name: role, role });
    acct = (await app.get(AuthService).login('acct@rules.test', 'secret123'))
      .accessToken;
    appr = (await app.get(AuthService).login('appr@rules.test', 'secret123'))
      .accessToken;
    const { data: accounts } = await app
      .get(AccountsService)
      .list({ limit: 200 });
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    const { data: codes } = await app.get(TaxCodesService).list();
    code = Object.fromEntries(codes.map((c) => [c.code, c.id]));
    const partners = app.get(BusinessPartnersService);
    customerId = (
      await partners.create({
        code: 'CUST-R',
        name: 'Pelanggan',
        isCustomer: true,
      })
    ).id;
    vendorId = (
      await partners.create({ code: 'VEND-R', name: 'Pemasok', isVendor: true })
    ).id;
    vendor2Id = (
      await partners.create({
        code: 'VEND-R2',
        name: 'Pemasok 2',
        isVendor: true,
      })
    ).id;
  }, 120_000);

  afterAll(() => cleanup());

  const server = () => app.getHttpServer() as App;
  const send = (
    method: 'post' | 'patch',
    url: string,
    token: string,
    body?: object,
  ) =>
    request(server())
      [method](url)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send(body ?? {});
  const codeOf = (r: request.Response) => (r.body as { code: string }).code;
  const detailsOf = (r: request.Response) =>
    (r.body as { details: Record<string, unknown> }).details;

  const line = (
    accountCode: string,
    unitPrice: string,
    taxCodes: string[] = [],
  ) => ({
    description: `line ${accountCode}`,
    accountId: acc[accountCode],
    quantity: '1',
    unitPrice,
    taxCodeIds: taxCodes.map((c) => code[c]),
  });
  const invoiceBody = (over: object = {}) => ({
    partnerId: customerId,
    date: '2026-03-10',
    lines: [line('4-1000', '1000000', ['PPN-OUT-11'])],
    ...over,
  });
  const billBody = (over: object = {}) => ({
    partnerId: vendorId,
    date: '2026-03-10',
    lines: [line('5-2000', '500000')],
    ...over,
  });
  const createInvoice = (over: object = {}) =>
    send('post', '/v1/sales-invoices', acct, invoiceBody(over));
  const createBill = (over: object = {}) =>
    send('post', '/v1/purchase-bills', acct, billBody(over));
  const postDoc = (path: string, id: string) =>
    send('post', `/v1/${path}/${id}/post`, appr);

  describe('business date transformer', () => {
    it('stores the calendar day of an offset timestamp, not the UTC-shifted day', async () => {
      const res = await createInvoice({
        date: '2026-07-01T00:30+07:00',
      }).expect(201);
      expect((res.body as { date: string }).date.slice(0, 10)).toBe(
        '2026-07-01',
      );
    });
  });

  describe('zero-amount (free) lines', () => {
    it('posts a document with a free line; the zero line leaves no journal line', async () => {
      const draft = await createInvoice({
        lines: [
          line('4-1000', '1000000', ['PPN-OUT-11']),
          line('4-9000', '0', ['PPN-OUT-11']), // free item
        ],
      }).expect(201);
      const posted = await postDoc(
        'sales-invoices',
        (draft.body as { id: string }).id,
      ).expect(200);
      const body = posted.body as { total: string; journalEntryId: string };
      expect(body.total).toBe('1110000.0000');
      const jl = await prisma.client.journalLine.findMany({
        where: { journalEntryId: body.journalEntryId },
      });
      // revenue + PPN output + AR — no zero line for the free item.
      expect(jl).toHaveLength(3);
      expect(jl.some((l) => l.accountId === acc['4-9000'])).toBe(false);
    });

    it('rejects a document whose total is zero (422)', async () => {
      const res = await createInvoice({
        lines: [line('4-1000', '0', ['PPN-OUT-11'])],
      }).expect(422);
      expect(codeOf(res)).toBe('VALIDATION_FAILED');
    });

    it('rejects posting a stored zero-total draft (422) and leaves it DRAFT', async () => {
      const draft = await createInvoice().expect(201);
      const id = (draft.body as { id: string }).id;
      // A draft that became zero-valued outside the API (e.g. legacy data).
      await prisma.client.salesInvoiceLine.updateMany({
        where: { salesInvoiceId: id },
        data: { unitPrice: '0', amount: '0' },
      });
      const res = await postDoc('sales-invoices', id).expect(422);
      expect(codeOf(res)).toBe('VALIDATION_FAILED');
      expect(
        (await prisma.client.salesInvoice.findFirst({ where: { id } }))!.status,
      ).toBe('DRAFT');
    });

    it('preview drops the zero line exactly like posting', async () => {
      const res = await request(server())
        .post('/v1/journal-entries/preview')
        .set('Authorization', `Bearer ${acct}`)
        .send({
          nature: 'SALE',
          settlementAccountId: acc['1-1200'],
          lines: [
            { accountId: acc['4-1000'], amount: '1000', taxCodeIds: [] },
            { accountId: acc['4-9000'], amount: '0', taxCodeIds: [] },
          ],
        })
        .expect(200);
      const lines = (res.body as { lines: { accountId: string }[] }).lines;
      expect(lines.map((l) => l.accountId)).toEqual([
        acc['4-1000'],
        acc['1-1200'],
      ]);
    });
  });

  describe('dueDate >= date', () => {
    it('rejects an invoice due before its date on create (422)', async () => {
      const res = await createInvoice({ dueDate: '2026-03-09' }).expect(422);
      expect(codeOf(res)).toBe('VALIDATION_FAILED');
      expect(detailsOf(res)).toMatchObject({
        date: '2026-03-10',
        dueDate: '2026-03-09',
      });
    });

    it('accepts dueDate equal to date (201)', async () => {
      await createInvoice({ dueDate: '2026-03-10' }).expect(201);
    });

    it('rejects a bill update that moves the date past the stored dueDate (422)', async () => {
      const draft = await createBill({ dueDate: '2026-03-31' }).expect(201);
      const res = await send(
        'patch',
        `/v1/purchase-bills/${(draft.body as { id: string }).id}`,
        acct,
        { date: '2026-04-05' },
      ).expect(422);
      expect(codeOf(res)).toBe('VALIDATION_FAILED');
    });
  });

  describe('PPN Output requires a PKP company', () => {
    const setPkp = (isPkp: boolean) =>
      app.get(CompanyService).update({ isPkp });
    afterEach(() => setPkp(true));

    it('rejects a sales invoice with PPN Output when the company is not PKP (422)', async () => {
      await setPkp(false);
      const res = await createInvoice().expect(422);
      expect(codeOf(res)).toBe('VALIDATION_FAILED');
      expect(detailsOf(res)).toMatchObject({ taxCodeId: code['PPN-OUT-11'] });
    });

    it('still accepts a non-PPN sales invoice when not PKP (201)', async () => {
      await setPkp(false);
      await createInvoice({ lines: [line('4-1000', '1000')] }).expect(201);
    });

    it('rejects posting a PPN Output draft after PKP was switched off (422)', async () => {
      const draft = await createInvoice().expect(201);
      await setPkp(false);
      const res = await postDoc(
        'sales-invoices',
        (draft.body as { id: string }).id,
      ).expect(422);
      expect(codeOf(res)).toBe('VALIDATION_FAILED');
    });

    it('rejects PPN Output in /tax/calculate and the journal preview when not PKP (422)', async () => {
      await setPkp(false);
      const body = {
        nature: 'SALE',
        settlementAccountId: acc['1-1200'],
        lines: [
          {
            accountId: acc['4-1000'],
            amount: '1000',
            taxCodeIds: [code['PPN-OUT-11']],
          },
        ],
      };
      for (const url of ['/v1/tax/calculate', '/v1/journal-entries/preview']) {
        const res = await request(server())
          .post(url)
          .set('Authorization', `Bearer ${acct}`)
          .send(body)
          .expect(422);
        expect(codeOf(res)).toBe('VALIDATION_FAILED');
      }
    });
  });

  describe('vendorInvoiceNo is unique per vendor among live bills', () => {
    it('rejects a second live bill with the same vendor invoice number (409)', async () => {
      await createBill({ vendorInvoiceNo: 'VX-100' }).expect(201);
      const res = await createBill({ vendorInvoiceNo: 'VX-100' }).expect(409);
      expect(codeOf(res)).toBe('CONFLICT');
    });

    it('allows the same number from a different vendor (201)', async () => {
      await createBill({
        vendorInvoiceNo: 'VX-100',
        partnerId: vendor2Id,
      }).expect(201);
    });

    it('rejects an update that takes an already-used number (409)', async () => {
      await createBill({ vendorInvoiceNo: 'VX-200' }).expect(201);
      const other = await createBill({ vendorInvoiceNo: 'VX-201' }).expect(201);
      const res = await send(
        'patch',
        `/v1/purchase-bills/${(other.body as { id: string }).id}`,
        acct,
        { vendorInvoiceNo: 'VX-200' },
      ).expect(409);
      expect(codeOf(res)).toBe('CONFLICT');
    });

    it('frees the number once the bill is voided or its draft deleted', async () => {
      const a = await createBill({ vendorInvoiceNo: 'VX-300' }).expect(201);
      const aId = (a.body as { id: string }).id;
      await postDoc('purchase-bills', aId).expect(200);
      await send('post', `/v1/purchase-bills/${aId}/void`, appr).expect(200);
      const b = await createBill({ vendorInvoiceNo: 'VX-300' }).expect(201);
      await request(server())
        .delete(`/v1/purchase-bills/${(b.body as { id: string }).id}`)
        .set('Authorization', `Bearer ${acct}`)
        .expect(204);
      await createBill({ vendorInvoiceNo: 'VX-300' }).expect(201);
    });
  });

  describe('payment date >= allocated document date', () => {
    const postedInvoice = async (date: string) => {
      const d = await createInvoice({ date }).expect(201);
      const id = (d.body as { id: string }).id;
      await postDoc('sales-invoices', id).expect(200);
      return id;
    };
    const receipt = (date: string, invoiceId: string) =>
      send('post', '/v1/payments', acct, {
        direction: 'RECEIPT',
        partnerId: customerId,
        date,
        cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: invoiceId, amount: '1000' }],
      });

    it('rejects a payment dated before the invoice it allocates to (422)', async () => {
      const inv = await postedInvoice('2026-05-20');
      const res = await receipt('2026-05-19', inv).expect(422);
      expect(codeOf(res)).toBe('VALIDATION_FAILED');
      expect(detailsOf(res)).toEqual({
        paymentDate: '2026-05-19',
        documentId: inv,
        documentDate: '2026-05-20',
      });
    });

    it('accepts a same-day payment (201) and posts it (200)', async () => {
      const inv = await postedInvoice('2026-05-21');
      const p = await receipt('2026-05-21', inv).expect(201);
      await postDoc('payments', (p.body as { id: string }).id).expect(200);
    });

    it('re-checks at post, under the document lock (422)', async () => {
      const inv = await postedInvoice('2026-05-22');
      const p = await receipt('2026-05-22', inv).expect(201);
      const pid = (p.body as { id: string }).id;
      // Drift the stored draft behind the invoice (no API edit path exists).
      await prisma.client.payment.update({
        where: { id: pid },
        data: { date: new Date('2026-05-01') },
      });
      const res = await postDoc('payments', pid).expect(422);
      expect(detailsOf(res)).toMatchObject({
        documentId: inv,
        documentDate: '2026-05-22',
      });
    });
  });

  describe('purchase lines exclude contra-asset accounts', () => {
    it('rejects Akumulasi Penyusutan (ASSET, CREDIT normal) on a bill line (422)', async () => {
      const res = await createBill({
        lines: [line('1-2900', '1000')],
      }).expect(422);
      expect(codeOf(res)).toBe('VALIDATION_FAILED');
      expect(detailsOf(res)).toEqual({
        accountId: acc['1-2900'],
        reason: 'CONTRA_ASSET',
      });
    });

    it('still accepts a fixed-asset purchase line (201)', async () => {
      await createBill({ lines: [line('1-2000', '1000')] }).expect(201);
    });
  });
});
