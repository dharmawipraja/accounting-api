import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
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
    it('rejects an ISO-shaped impossible day at the DTO boundary (400)', async () => {
      await createInvoice({ date: '2026-02-30' }).expect(400);
      await createInvoice({ dueDate: '2026-04-31' }).expect(400);
    });

    it('rejects a timestamp for a business date (400): only YYYY-MM-DD names a day unambiguously', async () => {
      await createInvoice({ date: '2026-06-30T17:30:00.000Z' }).expect(400);
      await createInvoice({ date: '2026-07-01T00:30+07:00' }).expect(400);
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

    it('a free line on an account deactivated after drafting → post 422 INVALID_ACCOUNT (same as PATCH), stays DRAFT', async () => {
      const free = await prisma.client.account.create({
        data: {
          code: '4-9811',
          name: 'Revenue free-line',
          type: 'REVENUE',
          subtype: 'REVENUE',
          normalBalance: 'CREDIT',
          isPostable: true,
        },
      });
      const draft = await createInvoice({
        lines: [
          line('4-1000', '1000000', ['PPN-OUT-11']),
          { ...line('4-1000', '0'), accountId: free.id }, // free item
        ],
      }).expect(201);
      const id = (draft.body as { id: string }).id;
      await prisma.client.account.update({
        where: { id: free.id },
        data: { isActive: false },
      });
      const patch = await send('patch', `/v1/sales-invoices/${id}`, acct, {
        description: 'still a draft',
      }).expect(422);
      expect(codeOf(patch)).toBe('INVALID_ACCOUNT');
      const post = await postDoc('sales-invoices', id).expect(422);
      expect(codeOf(post)).toBe('INVALID_ACCOUNT');
      expect(detailsOf(post)).toEqual({ accountId: free.id });
      expect(
        (await prisma.client.salesInvoice.findFirst({ where: { id } }))!.status,
      ).toBe('DRAFT');
    });

    it('a free bill line on a soft-deleted account → post 422 INVALID_ACCOUNT', async () => {
      const free = await prisma.client.account.create({
        data: {
          code: '5-9811',
          name: 'Expense free-line',
          type: 'EXPENSE',
          subtype: 'OPERATING_EXPENSE',
          normalBalance: 'DEBIT',
          isPostable: true,
        },
      });
      const draft = await createBill({
        lines: [
          line('5-2000', '500000'),
          { ...line('5-2000', '0'), accountId: free.id },
        ],
      }).expect(201);
      const id = (draft.body as { id: string }).id;
      await prisma.client.account.update({
        where: { id: free.id },
        data: { deletedAt: new Date() },
      });
      const post = await postDoc('purchase-bills', id).expect(422);
      expect(codeOf(post)).toBe('INVALID_ACCOUNT');
      expect(detailsOf(post)).toEqual({ accountId: free.id });
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

  describe('sales lines exclude contra-revenue accounts', () => {
    let contraId: string;
    const contraDetails = () => ({
      accountId: contraId,
      reason: 'CONTRA_REVENUE',
    });

    beforeAll(async () => {
      const parent = await prisma.client.account.findFirstOrThrow({
        where: { code: '4-0000' },
      });
      contraId = (
        await prisma.client.account.create({
          data: {
            code: '4-8100',
            name: 'Retur Penjualan',
            type: 'REVENUE',
            subtype: 'REVENUE',
            normalBalance: 'DEBIT',
            parentId: parent.id,
          },
        })
      ).id;
    });

    const contraLine = () => ({
      description: 'retur',
      accountId: contraId,
      quantity: '1',
      unitPrice: '1000',
      taxCodeIds: [],
    });

    it('rejects a contra-revenue line on create (422 CONTRA_REVENUE)', async () => {
      const res = await createInvoice({
        lines: [line('4-1000', '1000000'), contraLine()],
      }).expect(422);
      expect(codeOf(res)).toBe('VALIDATION_FAILED');
      expect(detailsOf(res)).toEqual(contraDetails());
    });

    it('rejects it on update (422)', async () => {
      const id = ((await createInvoice().expect(201)).body as { id: string })
        .id;
      const res = await send('patch', `/v1/sales-invoices/${id}`, acct, {
        lines: [contraLine()],
      }).expect(422);
      expect(detailsOf(res)).toEqual(contraDetails());
    });

    it('rejects posting a stored draft that carries one (422, stays DRAFT)', async () => {
      const id = ((await createInvoice().expect(201)).body as { id: string })
        .id;
      await prisma.client.salesInvoiceLine.updateMany({
        where: { salesInvoiceId: id },
        data: { accountId: contraId },
      });
      const res = await postDoc('sales-invoices', id).expect(422);
      expect(detailsOf(res)).toEqual(contraDetails());
      expect(
        (await prisma.client.salesInvoice.findFirst({ where: { id } }))!.status,
      ).toBe('DRAFT');
    });

    it('rejects it in the SALE preview (422)', async () => {
      const res = await request(server())
        .post('/v1/journal-entries/preview')
        .set('Authorization', `Bearer ${acct}`)
        .send({
          nature: 'SALE',
          lines: [{ accountId: contraId, amount: '1000', taxCodeIds: [] }],
        })
        .expect(422);
      expect(detailsOf(res)).toEqual(contraDetails());
    });
  });

  describe('purchase lines exclude contra-expense accounts', () => {
    let contraId: string;
    const contraDetails = () => ({
      accountId: contraId,
      reason: 'CONTRA_EXPENSE',
    });

    beforeAll(async () => {
      const parent = await prisma.client.account.findFirstOrThrow({
        where: { code: '5-0000' },
      });
      contraId = (
        await prisma.client.account.create({
          data: {
            code: '5-8100',
            name: 'Potongan Pembelian',
            type: 'EXPENSE',
            subtype: 'OPERATING_EXPENSE',
            normalBalance: 'CREDIT',
            parentId: parent.id,
          },
        })
      ).id;
    });

    const contraLine = () => ({
      description: 'potongan',
      accountId: contraId,
      quantity: '1',
      unitPrice: '1000',
      taxCodeIds: [],
    });

    it('rejects a contra-expense line on create (422 CONTRA_EXPENSE)', async () => {
      const res = await createBill({
        lines: [line('5-2000', '500000'), contraLine()],
      }).expect(422);
      expect(codeOf(res)).toBe('VALIDATION_FAILED');
      expect(detailsOf(res)).toEqual(contraDetails());
    });

    it('rejects posting a stored draft that carries one (422, stays DRAFT)', async () => {
      const id = ((await createBill().expect(201)).body as { id: string }).id;
      await prisma.client.purchaseBillLine.updateMany({
        where: { purchaseBillId: id },
        data: { accountId: contraId },
      });
      const res = await postDoc('purchase-bills', id).expect(422);
      expect(detailsOf(res)).toEqual(contraDetails());
      expect(
        (await prisma.client.purchaseBill.findFirst({ where: { id } }))!.status,
      ).toBe('DRAFT');
    });

    it('rejects it in the PURCHASE preview (422)', async () => {
      const res = await request(server())
        .post('/v1/journal-entries/preview')
        .set('Authorization', `Bearer ${acct}`)
        .send({
          nature: 'PURCHASE',
          lines: [{ accountId: contraId, amount: '1000', taxCodeIds: [] }],
        })
        .expect(422);
      expect(detailsOf(res)).toEqual(contraDetails());
    });
  });

  /** Audit3 iteration-2 Task 13: invoicing & tax fixes. */
  describe('iteration-2 invoicing/tax fixes', () => {
    let admin: string;
    const idOf = (r: request.Response) => (r.body as { id: string }).id;
    const newPartner = async (flags: object) =>
      (
        await app.get(BusinessPartnersService).create({
          code: `P-${randomUUID().slice(0, 8)}`,
          name: 'X',
          ...flags,
        })
      ).id;
    const deletePartner = (id: string) =>
      request(server())
        .delete(`/v1/partners/${id}`)
        .set('Authorization', `Bearer ${admin}`);

    beforeAll(async () => {
      await app.get(UsersService).create({
        email: 'admin@rules.test',
        password: 'secret123',
        name: 'Admin',
        role: 'ADMIN',
      });
      admin = (
        await app.get(AuthService).login('admin@rules.test', 'secret123')
      ).accessToken;
    });

    describe('tax-line accounts re-validated inside the post tx', () => {
      it('rejects posting a draft whose tax account drifted to a non-tax subtype (422)', async () => {
        const draft = await createInvoice().expect(201);
        await prisma.client.account.update({
          where: { id: acc['2-1100'] },
          data: { subtype: 'CURRENT_LIABILITY' },
        });
        try {
          const res = await postDoc('sales-invoices', idOf(draft)).expect(422);
          expect(detailsOf(res)).toMatchObject({
            taxAccountId: acc['2-1100'],
            reason: 'SUBTYPE',
          });
        } finally {
          await prisma.client.account.update({
            where: { id: acc['2-1100'] },
            data: { subtype: 'TAX_PAYABLE' },
          });
        }
      });
    });

    describe('tax-account detection includes soft-deleted tax codes', () => {
      it('rejects a bill line on the account of a soft-deleted tax code (422 TAX_ACCOUNT)', async () => {
        const a = await app.get(AccountsService).create({
          code: '1-1460',
          name: 'PPN Masukan Lama',
          type: 'ASSET',
          subtype: 'TAX_RECEIVABLE',
          normalBalance: 'DEBIT',
          parentCode: '1-0000',
        });
        const tc = await app.get(TaxCodesService).create({
          code: 'PPN-IN-OLD',
          name: 'Old input',
          kind: 'PPN_INPUT',
          rate: '0.1',
          taxAccountId: a.id,
        });
        await app.get(TaxCodesService).softDelete(tc.id, 'test');
        const res = await createBill({
          lines: [
            {
              description: 'x',
              accountId: a.id,
              quantity: '1',
              unitPrice: '1000',
              taxCodeIds: [],
            },
          ],
        }).expect(422);
        expect(detailsOf(res)).toEqual({
          accountId: a.id,
          reason: 'TAX_ACCOUNT',
        });
      });
    });

    describe('partner soft-delete refuses open items', () => {
      it('refuses a partner with a draft document (422)', async () => {
        const pid = await newPartner({ isCustomer: true });
        await createInvoice({ partnerId: pid }).expect(201);
        const res = await deletePartner(pid).expect(422);
        expect(codeOf(res)).toBe('VALIDATION_FAILED');
        expect(detailsOf(res)).toMatchObject({ id: pid, reason: 'OPEN_ITEMS' });
      });

      it('refuses a partner with a POSTED document still outstanding (422)', async () => {
        const pid = await newPartner({ isCustomer: true });
        const d = await createInvoice({ partnerId: pid }).expect(201);
        await postDoc('sales-invoices', idOf(d)).expect(200);
        const res = await deletePartner(pid).expect(422);
        expect(codeOf(res)).toBe('VALIDATION_FAILED');
        expect(detailsOf(res)).toEqual({
          id: pid,
          reason: 'OPEN_ITEMS',
          draftDocuments: 0,
          outstandingDocuments: 1,
          draftPayments: 0,
          unappliedPayments: 0,
        });
      });

      it('refuses a partner with a draft payment (422)', async () => {
        const pid = await newPartner({ isCustomer: true });
        const d = await createInvoice({ partnerId: pid }).expect(201);
        await postDoc('sales-invoices', idOf(d)).expect(200);
        await send('post', '/v1/payments', acct, {
          direction: 'RECEIPT',
          partnerId: pid,
          date: '2026-03-10',
          cashAccountId: acc['1-1000'],
          allocations: [{ salesInvoiceId: idOf(d), amount: '1000' }],
        }).expect(201);
        // Void the invoice (a draft payment does not count as paid): only
        // the draft payment is left open.
        await send('post', `/v1/sales-invoices/${idOf(d)}/void`, appr).expect(
          200,
        );
        await deletePartner(pid).expect(422);
      });

      it('deletes a partner whose documents are all voided (204)', async () => {
        const pid = await newPartner({ isCustomer: true });
        const d = await createInvoice({ partnerId: pid }).expect(201);
        await postDoc('sales-invoices', idOf(d)).expect(200);
        await send('post', `/v1/sales-invoices/${idOf(d)}/void`, appr).expect(
          200,
        );
        await deletePartner(pid).expect(204);
      });

      /** Hold the partner row FOR UPDATE (what softDelete takes first) in a
       *  separate tx, start the create, wait until it is blocked on that row,
       *  then tombstone the partner and commit: a create that reads the
       *  partner FOR SHARE in its own tx must now see it gone (422). Without
       *  the lock the create never waits and inserts a draft for a partner
       *  that is deleted a moment later. */
      async function raceCreateAgainstDelete(
        pid: string,
        create: () => request.Test,
      ): Promise<request.Response> {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        let locked!: () => void;
        const isLocked = new Promise<void>((r) => (locked = r));
        const holder = prisma.client.$transaction(
          async (tx) => {
            await tx.$queryRaw`
              SELECT id FROM business_partners WHERE id = ${pid} FOR UPDATE`;
            locked();
            await gate;
            await tx.$executeRaw`
              UPDATE business_partners
              SET deleted_at = now(), code = code || '#deleted'
              WHERE id = ${pid}`;
          },
          { maxWait: 5000, timeout: 20000 },
        );
        await isLocked;
        const pending = create().then((r) => r);
        // Poll for a blocked lock request on business_partners (bounded: a
        // create that takes no lock never shows up and just runs through).
        for (let i = 0; i < 60; i++) {
          const [{ n }] = await prisma.client.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_locks l
            JOIN pg_class c ON c.oid = l.relation
            WHERE NOT l.granted AND c.relname = 'business_partners'`;
          const [{ w }] = await prisma.client.$queryRaw<{ w: number }[]>`
            SELECT count(*)::int AS w FROM pg_locks
            WHERE NOT granted AND locktype = 'transactionid'`;
          if (n + w > 0) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        release();
        await holder;
        return pending;
      }

      it('a draft invoice create racing a partner delete is refused once the delete commits (422)', async () => {
        const pid = await newPartner({ isCustomer: true });
        const res = await raceCreateAgainstDelete(pid, () =>
          createInvoice({ partnerId: pid }),
        );
        expect(res.status).toBe(422);
        expect(detailsOf(res)).toEqual({ partnerId: pid });
        expect(
          await prisma.client.salesInvoice.count({ where: { partnerId: pid } }),
        ).toBe(0);
      });

      it('a draft bill create racing a partner delete is refused once the delete commits (422)', async () => {
        const pid = await newPartner({ isVendor: true });
        const res = await raceCreateAgainstDelete(pid, () =>
          createBill({ partnerId: pid }),
        );
        expect(res.status).toBe(422);
        expect(detailsOf(res)).toEqual({ partnerId: pid });
      });

      it('a draft payment create racing a partner delete is refused once the delete commits (422)', async () => {
        const pid = await newPartner({ isCustomer: true });
        const d = await createInvoice({ partnerId: pid }).expect(201);
        await postDoc('sales-invoices', idOf(d)).expect(200);
        const res = await raceCreateAgainstDelete(pid, () =>
          send('post', '/v1/payments', acct, {
            direction: 'RECEIPT',
            partnerId: pid,
            date: '2026-03-10',
            cashAccountId: acc['1-1000'],
            allocations: [{ salesInvoiceId: idOf(d), amount: '1000' }],
          }),
        );
        expect(res.status).toBe(422);
        expect(detailsOf(res)).toEqual({ partnerId: pid });
        expect(
          await prisma.client.payment.count({ where: { partnerId: pid } }),
        ).toBe(0);
      });
    });

    describe('DTO caps', () => {
      it('rejects a PATCH with more than MAX_LINE_ITEMS lines (400)', async () => {
        const d = await createBill().expect(201);
        await send('patch', `/v1/purchase-bills/${idOf(d)}`, acct, {
          lines: Array.from({ length: 101 }, () => line('5-2000', '1')),
        }).expect(400);
      });

      it('rejects a line with more than 10 taxCodeIds on create and update (400)', async () => {
        const many = Array.from({ length: 11 }, () => randomUUID());
        const bad = { ...line('4-1000', '1000'), taxCodeIds: many };
        await createInvoice({ lines: [bad] }).expect(400);
        const d = await createInvoice().expect(201);
        await send('patch', `/v1/sales-invoices/${idOf(d)}`, acct, {
          lines: [bad],
        }).expect(400);
      });
    });

    describe('payment post re-checks the partner in-tx', () => {
      const draftReceipt = async (pid: string) => {
        const d = await createInvoice({ partnerId: pid }).expect(201);
        await postDoc('sales-invoices', idOf(d)).expect(200);
        const p = await send('post', '/v1/payments', acct, {
          direction: 'RECEIPT',
          partnerId: pid,
          date: '2026-03-10',
          cashAccountId: acc['1-1000'],
          allocations: [{ salesInvoiceId: idOf(d), amount: '1000' }],
        }).expect(201);
        return idOf(p);
      };

      it('rejects posting a payment whose partner was deactivated (422)', async () => {
        const pid = await newPartner({ isCustomer: true });
        const payId = await draftReceipt(pid);
        await app.get(BusinessPartnersService).deactivate(pid);
        const res = await postDoc('payments', payId).expect(422);
        expect(detailsOf(res)).toMatchObject({ partnerId: pid });
      });

      it('rejects posting a receipt whose partner is no longer a customer (422)', async () => {
        const pid = await newPartner({ isCustomer: true, isVendor: true });
        const payId = await draftReceipt(pid);
        // iter7: the PATCH itself now refuses to remove a role with open items
        // (this draft receipt) — 422 OPEN_ITEMS …
        await expect(
          app.get(BusinessPartnersService).update(pid, { isCustomer: false }),
        ).rejects.toMatchObject({ details: { reason: 'OPEN_ITEMS' } });
        // … so un-flag underneath it (legacy data / out-of-band change) to
        // prove the post-time in-tx re-check still holds.
        await prisma.client.businessPartner.update({
          where: { id: pid },
          data: { isCustomer: false },
        });
        const res = await postDoc('payments', payId).expect(422);
        expect(detailsOf(res)).toMatchObject({ partnerId: pid });
      });
    });

    describe('vendor invoice number is normalized', () => {
      it('trims on write and treats case/whitespace variants as the same number (409)', async () => {
        const a = await createBill({ vendorInvoiceNo: '  NV-900 ' }).expect(
          201,
        );
        expect((a.body as { vendorInvoiceNo: string }).vendorInvoiceNo).toBe(
          'NV-900',
        );
        const res = await createBill({ vendorInvoiceNo: 'nv-900' }).expect(409);
        expect(codeOf(res)).toBe('CONFLICT');
      });
    });

    describe('non-PKP company cannot credit PPN Input', () => {
      afterEach(() => app.get(CompanyService).update({ isPkp: true }));

      it('rejects a purchase bill with PPN Input when the company is not PKP (422)', async () => {
        await app.get(CompanyService).update({ isPkp: false });
        const res = await createBill({
          lines: [line('5-2000', '1000', ['PPN-IN-11'])],
        }).expect(422);
        expect(detailsOf(res)).toMatchObject({
          taxCodeId: code['PPN-IN-11'],
          kind: 'PPN_INPUT',
        });
      });
    });

    describe('PATCH clears nullable fields with explicit null', () => {
      it('clears dueDate and vendorInvoiceNo on a bill (200)', async () => {
        const d = await createBill({
          dueDate: '2026-03-31',
          vendorInvoiceNo: 'NV-CLR',
        }).expect(201);
        const res = await send('patch', `/v1/purchase-bills/${idOf(d)}`, acct, {
          dueDate: null,
          vendorInvoiceNo: null,
        }).expect(200);
        expect(res.body).toMatchObject({
          dueDate: null,
          vendorInvoiceNo: null,
        });
      });

      it('clears dueDate on an invoice and keeps it when omitted (200)', async () => {
        const d = await createInvoice({ dueDate: '2026-03-31' }).expect(201);
        const kept = await send(
          'patch',
          `/v1/sales-invoices/${idOf(d)}`,
          acct,
          {
            description: 'still due',
          },
        ).expect(200);
        expect((kept.body as { dueDate: string }).dueDate).toContain(
          '2026-03-31',
        );
        const res = await send('patch', `/v1/sales-invoices/${idOf(d)}`, acct, {
          dueDate: null,
        }).expect(200);
        expect((res.body as { dueDate: unknown }).dueDate).toBeNull();
      });

      it('clears the description on an invoice and a bill with null; omitted keeps it (200)', async () => {
        const inv = await createInvoice({ description: 'to clear' }).expect(
          201,
        );
        const kept = await send(
          'patch',
          `/v1/sales-invoices/${idOf(inv)}`,
          acct,
          { dueDate: '2026-03-31' },
        ).expect(200);
        expect((kept.body as { description: string }).description).toBe(
          'to clear',
        );
        const invRes = await send(
          'patch',
          `/v1/sales-invoices/${idOf(inv)}`,
          acct,
          { description: null },
        ).expect(200);
        expect(
          (invRes.body as { description: unknown }).description,
        ).toBeNull();

        const bill = await createBill({ description: 'to clear' }).expect(201);
        const billRes = await send(
          'patch',
          `/v1/purchase-bills/${idOf(bill)}`,
          acct,
          { description: null },
        ).expect(200);
        expect(
          (billRes.body as { description: unknown }).description,
        ).toBeNull();
      });
    });
  });
});
