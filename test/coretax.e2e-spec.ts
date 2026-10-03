import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { SalesInvoicesService } from '../src/invoicing/sales-invoices.service';
import { PurchaseBillsService } from '../src/invoicing/purchase-bills.service';
import { NotesService } from '../src/invoicing/notes.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';

type Problem = { invoiceId: string | null; field: string };
type ErrBody = { details: { problems: Problem[]; reason?: string } };

/** Coretax faktur keluaran export, NSFP / bukti potong / retur records. */
describe('Coretax (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let admin: string;
  let appr: string;
  let acct: string;
  let acc: Record<string, string>;
  let code: Record<string, string>;
  let invoices: SalesInvoicesService;
  let bills: PurchaseBillsService;
  let customerId: string;
  let vendorId: string;
  const server = () => app.getHttpServer() as App;
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());
    await app.get(AccountsService).seedIfEmpty();
    await app.get(TaxCodesService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const users = app.get(UsersService);
    const auth = app.get(AuthService);
    for (const [email, role] of [
      ['admin@ctx.test', 'ADMIN'],
      ['appr@ctx.test', 'APPROVER'],
      ['acct@ctx.test', 'ACCOUNTANT'],
    ] as const)
      await users.create({ email, password: 'secret123', name: role, role });
    admin = (await auth.login('admin@ctx.test', 'secret123')).accessToken;
    appr = (await auth.login('appr@ctx.test', 'secret123')).accessToken;
    acct = (await auth.login('acct@ctx.test', 'secret123')).accessToken;
    const { data: accounts } = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    const { data: codes } = await app.get(TaxCodesService).list();
    code = Object.fromEntries(codes.map((c) => [c.code, c.id]));
    invoices = app.get(SalesInvoicesService);
    bills = app.get(PurchaseBillsService);
    vendorId = (
      await app
        .get(BusinessPartnersService)
        .create({ code: 'CTX-V', name: 'Vendor', isVendor: true })
    ).id;
  }, 120_000);

  afterAll(() => cleanup());

  const postedInvoice = async (
    date: string,
    lines: object[],
    extra: object = {},
  ) => {
    const d = await invoices.createDraft({
      partnerId: customerId,
      date: new Date(date),
      lines: lines as never,
      createdBy: 'creator',
      ...extra,
    });
    return invoices.post(d.id, 'poster');
  };
  const exportXml = (q: string) =>
    request(server()).get(`/v1/tax/coretax/faktur-keluaran?${q}`).set(as(acct));

  it('normalizes and validates NPWP / NIK on partners', async () => {
    const res = await request(server())
      .post('/v1/partners')
      .set(as(acct))
      .send({
        code: 'CTX-C',
        name: 'PT A & B <Jaya>',
        npwp: '09.876.543.2-109.000',
        address: 'Jl. Sudirman 1, Jakarta',
        nitkuSuffix: '000001',
        isCustomer: true,
      })
      .expect(201);
    const body = res.body as {
      id: string;
      npwp: string;
      buyerDocumentType: string;
      country: string;
    };
    expect(body).toMatchObject({
      npwp: '0098765432109000', // legacy 15 digits → 0 + 15
      buyerDocumentType: 'TIN',
      country: 'IDN',
    });
    customerId = body.id;
    for (const bad of [
      { npwp: '12345' },
      { npwp: '01.234.567.8-901.00X' },
      { nitkuSuffix: '1' },
      { country: 'Indonesia' },
    ])
      await request(server())
        .patch(`/v1/partners/${customerId}`)
        .set(as(acct))
        .send(bad)
        .expect(400);
    // A NIK must be 16 digits — judged on the merged values.
    await request(server())
      .patch(`/v1/partners/${customerId}`)
      .set(as(acct))
      .send({ buyerDocumentType: 'NATIONAL_ID', buyerDocumentNumber: 'X1' })
      .expect(422);
  });

  let inv1: { id: string; taxTotal: { toString(): string } };
  let plainInv: { id: string };

  it('422 lists every missing master-data field instead of a file', async () => {
    inv1 = await postedInvoice('2026-03-05', [
      {
        description: 'Konsultasi',
        accountId: acc['4-1000'],
        quantity: '2',
        unitPrice: '50000',
        discountPercent: '10',
        taxCodeIds: [code['PPN-OUT-11']],
        coretaxItemType: 'B',
        coretaxUnitCode: 'UM.0030',
      },
      {
        description: 'Barang <A> & "B"',
        accountId: acc['4-1000'],
        quantity: '1',
        unitPrice: '30000',
        discountAmount: '5000',
        taxCodeIds: [code['PPN-OUT-11']],
      },
    ]);
    // No PPN: not a faktur, never exported.
    plainInv = await postedInvoice('2026-03-06', [
      {
        description: 'Non-PPN',
        accountId: acc['4-1000'],
        quantity: '1',
        unitPrice: '1000',
        taxCodeIds: [],
      },
    ]);
    const res = await exportXml('from=2026-03-01&to=2026-03-31').expect(422);
    const fields = (res.body as ErrBody).details.problems
      .map((p) => p.field)
      .sort();
    expect(fields).toEqual([
      'companySettings.npwp',
      'lines[2].coretaxItemType',
      'lines[2].coretaxUnitCode',
    ]);
  });

  it('exports POSTED PPN invoices as Coretax XML (DPP Nilai Lain, discounts, escaping)', async () => {
    await request(server())
      .patch('/v1/company/settings')
      .set(as(admin))
      .send({
        npwp: '0012345678901000',
        coretaxDefaultItemType: 'A',
        coretaxDefaultUnitCode: 'UM.0018',
      })
      .expect(200);
    const res = await exportXml('from=2026-03-01&to=2026-03-31').expect(200);
    expect(res.headers['content-type']).toMatch(/^application\/xml/);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="faktur-keluaran_2026-03-01_2026-03-31.xml"',
    );
    expect(res.headers['x-coretax-invoice-count']).toBe('1');
    const xml = res.text;
    expect(xml).toContain('<TIN>0012345678901000</TIN>');
    expect(xml).toContain('<TrxCode>04</TrxCode>');
    expect(xml).toContain('<SellerIDTKU>0012345678901000000000</SellerIDTKU>');
    expect(xml).toContain('<BuyerIDTKU>0098765432109000000001</BuyerIDTKU>');
    expect(xml).toContain('<BuyerName>PT A &amp; B &lt;Jaya&gt;</BuyerName>');
    expect(xml).toContain('<Name>Barang &lt;A&gt; &amp; &quot;B&quot;</Name>');
    expect(xml).not.toContain('Non-PPN');
    // Line 1: 2 × 50,000 − 10% = 90,000 → 11/12 = 82,500 → 12% = 9,900.
    // Line 2: 30,000 − 5,000 = 25,000 → 22,916.67 → 2,750.
    const goods = [...xml.matchAll(/<GoodService>([\s\S]*?)<\/GoodService>/g)];
    const tag = (s: string, t: string) =>
      new RegExp(`<${t}>([^<]*)</${t}>`).exec(s)?.[1];
    expect(
      goods.map((g) =>
        [
          'Opt',
          'Unit',
          'Price',
          'Qty',
          'TotalDiscount',
          'TaxBase',
          'OtherTaxBase',
          'VATRate',
          'VAT',
        ].map((t) => tag(g[1], t)),
      ),
    ).toEqual([
      ['B', 'UM.0030', '50000', '2', '10000', '90000', '82500', '12', '9900'],
      ['A', 'UM.0018', '30000', '1', '5000', '25000', '22916.67', '12', '2750'],
    ]);
    // …and the faktur VAT is exactly the posted PPN (11% of DPP 115,000).
    expect(Number(inv1.taxTotal.toString())).toBe(12650);
    // A GET never mutates.
    const row = await prisma.client.salesInvoice.findUniqueOrThrow({
      where: { id: inv1.id },
    });
    expect(row.taxInvoiceStatus).toBe('NONE');
  });

  it('refuses an invoice whose faktur VAT does not reconcile with the posted PPN', async () => {
    // Simulate a misconfigured presentation: 12% on full DPP vs 11% posted.
    await request(server())
      .patch(`/v1/tax/codes/${code['PPN-OUT-11']}`)
      .set(as(admin))
      .send({ dppNilaiLain: false })
      .expect(200);
    const res = await exportXml('from=2026-03-01&to=2026-03-31').expect(422);
    expect((res.body as ErrBody).details.problems[0]).toMatchObject({
      invoiceId: inv1.id,
      field: 'lines[1].taxCodeIds',
    });
    await request(server())
      .patch(`/v1/tax/codes/${code['PPN-OUT-11']}`)
      .set(as(admin))
      .send({ dppNilaiLain: true })
      .expect(200);
    // The Coretax fields belong to PPN Output codes only.
    await request(server())
      .patch(`/v1/tax/codes/${code['PPN-IN-11']}`)
      .set(as(admin))
      .send({ dppNilaiLain: true })
      .expect(422);
  });

  it('mark-exported: POSTED invoices only, all or nothing', async () => {
    const draft = await invoices.createDraft({
      partnerId: customerId,
      date: new Date('2026-03-07'),
      lines: [
        {
          description: 'D',
          accountId: acc['4-1000'],
          quantity: '1',
          unitPrice: '1',
          taxCodeIds: [],
        },
      ],
      createdBy: 'creator',
    });
    await request(server())
      .post('/v1/tax/coretax/faktur-keluaran/mark-exported')
      .set(as(appr))
      .send({ invoiceIds: [inv1.id, draft.id] })
      .expect(422);
    await request(server())
      .post('/v1/tax/coretax/faktur-keluaran/mark-exported')
      .set(as(acct))
      .send({ invoiceIds: [inv1.id] })
      .expect(403);
    const res = await request(server())
      .post('/v1/tax/coretax/faktur-keluaran/mark-exported')
      .set(as(appr))
      .send({ invoiceIds: [inv1.id] })
      .expect(200);
    expect(res.body).toEqual({ updated: 1 });
    const list = await request(server())
      .get('/v1/sales-invoices?taxInvoiceStatus=EXPORTED')
      .set(as(acct))
      .expect(200);
    expect(
      (list.body as { data: { id: string }[] }).data.map((d) => d.id),
    ).toEqual([inv1.id]);
    await exportXml('from=2026-03-01&to=2026-03-31&status=EXPORTED').expect(
      200,
    );
    await exportXml('from=2026-03-01&to=2026-03-31&status=NONE').expect(422);
  });

  it('records the NSFP on a POSTED invoice; financial fields stay immutable', async () => {
    const before = await prisma.client.salesInvoice.findUniqueOrThrow({
      where: { id: inv1.id },
      include: { lines: true },
    });
    await request(server())
      .patch(`/v1/sales-invoices/${inv1.id}/tax-invoice`)
      .set(as(appr))
      .send({ taxInvoiceNumber: '123' })
      .expect(400);
    await request(server())
      .patch(`/v1/sales-invoices/${inv1.id}/tax-invoice`)
      .set(as(appr))
      .send({ taxInvoiceNumber: '04002600000000001' })
      .expect(422); // APPROVED needs the date too
    const res = await request(server())
      .patch(`/v1/sales-invoices/${inv1.id}/tax-invoice`)
      .set(as(appr))
      .send({
        taxInvoiceNumber: '04002600000000001',
        taxInvoiceDate: '2026-03-05',
      })
      .expect(200);
    expect(res.body).toMatchObject({
      taxInvoiceNumber: '04002600000000001',
      taxInvoiceStatus: 'APPROVED',
      status: 'POSTED',
    });
    const after = await prisma.client.salesInvoice.findUniqueOrThrow({
      where: { id: inv1.id },
      include: { lines: true },
    });
    for (const k of [
      'subtotal',
      'taxTotal',
      'total',
      'journalEntryId',
      'date',
      'status',
    ] as const)
      expect(String(after[k])).toBe(String(before[k]));
    expect(after.lines).toEqual(before.lines);
    // The general edit still refuses a POSTED invoice.
    await request(server())
      .patch(`/v1/sales-invoices/${inv1.id}`)
      .set(as(acct))
      .send({ description: 'changed' })
      .expect(422);
    // trxCode is frozen once APPROVED; an APPROVED faktur is not re-exported.
    await request(server())
      .patch(`/v1/sales-invoices/${inv1.id}/tax-invoice`)
      .set(as(appr))
      .send({ trxCode: '01' })
      .expect(422);
    // APPROVED can only be CANCELLED — never back to NONE/EXPORTED, which
    // would put it in the default export again (duplicate upload to DJP).
    for (const status of ['NONE', 'EXPORTED'])
      await request(server())
        .patch(`/v1/sales-invoices/${inv1.id}/tax-invoice`)
        .set(as(appr))
        .send({ status })
        .expect(422);
    const none = await exportXml('from=2026-03-01&to=2026-03-31').expect(422);
    expect((none.body as ErrBody).details.reason).toBe('NOTHING_TO_EXPORT');
  });

  it('409 on an NSFP already on another invoice; 422 on a DRAFT; 403 for ACCOUNTANT', async () => {
    const other = await postedInvoice('2026-03-10', [
      {
        description: 'X',
        accountId: acc['4-1000'],
        quantity: '1',
        unitPrice: '1000',
        taxCodeIds: [code['PPN-OUT-11']],
      },
    ]);
    await request(server())
      .patch(`/v1/sales-invoices/${other.id}/tax-invoice`)
      .set(as(appr))
      .send({
        taxInvoiceNumber: '04002600000000001',
        taxInvoiceDate: '2026-03-10',
      })
      .expect(409);
    await request(server())
      .patch(`/v1/sales-invoices/${other.id}/tax-invoice`)
      .set(as(acct))
      .send({ status: 'EXPORTED' })
      .expect(403);
    const draft = await invoices.createDraft({
      partnerId: customerId,
      date: new Date('2026-03-11'),
      lines: [
        {
          description: 'D',
          accountId: acc['4-1000'],
          quantity: '1',
          unitPrice: '1',
          taxCodeIds: [],
        },
      ],
      createdBy: 'creator',
    });
    await request(server())
      .patch(`/v1/sales-invoices/${draft.id}/tax-invoice`)
      .set(as(appr))
      .send({ status: 'EXPORTED' })
      .expect(422);
  });

  it('withholding slip only on a document carrying the matching PPh kind', async () => {
    const withPph = await postedInvoice('2026-03-12', [
      {
        description: 'Jasa',
        accountId: acc['4-1000'],
        quantity: '1',
        unitPrice: '1000000',
        taxCodeIds: [code['PPN-OUT-11'], code['PPH23-PRE']],
      },
    ]);
    const res = await request(server())
      .patch(`/v1/sales-invoices/${withPph.id}/withholding-slip`)
      .set(as(appr))
      .send({ number: 'BP-0001', date: '2026-03-20' })
      .expect(200);
    expect(
      (res.body as { withholdingSlipNumber: string }).withholdingSlipNumber,
    ).toBe('BP-0001');
    const noPph = await request(server())
      .patch(`/v1/sales-invoices/${plainInv.id}/withholding-slip`)
      .set(as(appr))
      .send({ number: 'BP-0002', date: '2026-03-20' })
      .expect(422);
    expect((noPph.body as ErrBody).details.reason).toBe('NO_WITHHOLDING');
    await request(server())
      .patch(`/v1/sales-invoices/${withPph.id}/withholding-slip`)
      .set(as(appr))
      .send({ number: 'BP-0001', date: null })
      .expect(422);

    const bill = async (taxCodeIds: string[]) => {
      const d = await bills.createDraft({
        partnerId: vendorId,
        date: new Date('2026-03-12'),
        lines: [
          {
            description: 'Jasa',
            accountId: acc['5-2000'],
            quantity: '1',
            unitPrice: '1000000',
            taxCodeIds,
          },
        ],
        createdBy: 'creator',
      });
      return bills.post(d.id, 'poster');
    };
    const billPph = await bill([code['PPH23-PAY']]);
    const billRes = await request(server())
      .patch(`/v1/purchase-bills/${billPph.id}/withholding-slip`)
      .set(as(appr))
      .send({ number: '2600000012', date: '2026-03-31' })
      .expect(200);
    expect(billRes.body).toMatchObject({
      withholdingSlipNumber: '2600000012',
      total: '980000.0000',
    });
    await request(server())
      .patch(`/v1/purchase-bills/${(await bill([])).id}/withholding-slip`)
      .set(as(appr))
      .send({ number: '2600000013', date: '2026-03-31' })
      .expect(422);
  });

  it('records a retur reference on a POSTED credit note', async () => {
    const original = await invoices.getById(plainInv.id);
    const notes = app.get(NotesService);
    const draft = await notes.createDraft('SALES', {
      originalId: original.id,
      date: new Date('2026-03-15'),
      lines: [{ originalLineId: original.lines![0].id, quantity: '1' }],
      createdBy: 'creator',
    });
    await request(server())
      .patch(`/v1/sales-credit-notes/${draft.id}/retur-reference`)
      .set(as(appr))
      .send({ number: 'RET-1', date: '2026-03-16' })
      .expect(422);
    await notes.post('SALES', draft.id, 'poster');
    const res = await request(server())
      .patch(`/v1/sales-credit-notes/${draft.id}/retur-reference`)
      .set(as(appr))
      .send({ number: 'RET-1', date: '2026-03-16' })
      .expect(200);
    expect(res.body).toMatchObject({ returNumber: 'RET-1', status: 'POSTED' });
  });
});
