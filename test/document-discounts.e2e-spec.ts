import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';

type Line = {
  discountPercent: string | null;
  discountAmount: string;
  amount: string;
  unitPrice: string;
};
type Doc = {
  id: string;
  status: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  withholdingTotal: string;
  total: string;
  journalEntryId: string | null;
  lines: Line[];
};
type JeLine = { accountId: string; debit: string; credit: string };

/** Per-line discounts (applied before tax) on sales invoices and purchase bills. */
describe('Document line discounts (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let acct: string;
  let appr: string;
  let acc: Record<string, string>;
  let code: Record<string, string>;
  let customerId: string;
  let vendorId: string;
  const server = () => app.getHttpServer() as App;

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());
    await app.get(AccountsService).seedIfEmpty();
    await app.get(TaxCodesService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const users = app.get(UsersService);
    await users.create({
      email: 'acct@disc.test',
      password: 'secret123',
      name: 'Acct',
      role: 'ACCOUNTANT',
    });
    await users.create({
      email: 'appr@disc.test',
      password: 'secret123',
      name: 'Appr',
      role: 'APPROVER',
    });
    acct = (await app.get(AuthService).login('acct@disc.test', 'secret123'))
      .accessToken;
    appr = (await app.get(AuthService).login('appr@disc.test', 'secret123'))
      .accessToken;
    const { data: accounts } = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    const { data: codes } = await app.get(TaxCodesService).list();
    code = Object.fromEntries(codes.map((c) => [c.code, c.id]));
    const partners = app.get(BusinessPartnersService);
    customerId = (
      await partners.create({ code: 'CUST-DSC', name: 'P', isCustomer: true })
    ).id;
    vendorId = (
      await partners.create({ code: 'VEND-DSC', name: 'V', isVendor: true })
    ).id;
  }, 120_000);

  afterAll(() => cleanup());

  const create = (path: string, body: object, status = 201) =>
    request(server())
      .post(path)
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send(body)
      .expect(status);
  const post = async (path: string, id: string) =>
    (
      await request(server())
        .post(`${path}/${id}/post`)
        .set('Authorization', `Bearer ${appr}`)
        .set('Idempotency-Key', randomUUID())
        .expect(200)
    ).body as Doc;
  const jeLines = async (journalEntryId: string) =>
    (
      await prisma.client.journalLine.findMany({ where: { journalEntryId } })
    ).map((l) => ({
      accountId: l.accountId,
      debit: Number(l.debit).toFixed(4),
      credit: Number(l.credit).toFixed(4),
    }));
  const sorted = (ls: JeLine[]) =>
    [...ls]
      .map((l) => `${l.accountId}|${l.debit}|${l.credit}`)
      .sort((a, b) => a.localeCompare(b));

  const saleLines = () => [
    {
      description: 'Barang A',
      accountId: acc['4-1000'],
      quantity: '2',
      unitPrice: '50000',
      discountPercent: '10',
      taxCodeIds: [code['PPN-OUT-11']],
    },
    {
      description: 'Jasa B',
      accountId: acc['4-1000'],
      quantity: '1',
      unitPrice: '1000000',
      discountAmount: '250000',
      taxCodeIds: [code['PPN-OUT-11']],
    },
  ];
  const saleBody = (lines: object[] = saleLines()) => ({
    partnerId: customerId,
    date: '2026-02-10',
    lines,
  });

  it('sales invoice: % and fixed discounts → PPN on the discounted DPP; posts revenue NET; preview parity', async () => {
    const draft = (await create('/v1/sales-invoices', saleBody())).body as Doc;
    expect(
      draft.lines.map((l) => [l.discountPercent, l.discountAmount, l.amount]),
    ).toEqual([
      ['10.0000', '10000.0000', '90000.0000'],
      [null, '250000.0000', '750000.0000'],
    ]);
    expect(draft.subtotal).toBe('840000.0000');
    expect(draft.discountTotal).toBe('260000.0000');
    expect(draft.taxTotal).toBe('92400.0000'); // 11% × 840,000
    expect(draft.total).toBe('932400.0000');

    const posted = await post('/v1/sales-invoices', draft.id);
    expect(posted.status).toBe('POSTED');
    expect(posted.total).toBe('932400.0000');
    expect(posted.discountTotal).toBe('260000.0000');
    const je = await jeLines(posted.journalEntryId!);
    const revenue = je
      .filter((l) => l.accountId === acc['4-1000'])
      .reduce((s, l) => s + Number(l.credit), 0);
    expect(revenue).toBe(840000);
    expect(je.find((l) => l.accountId === acc['1-1200'])!.debit).toBe(
      '932400.0000',
    );

    // The preview takes NET line amounts and reproduces the posted entry.
    const preview = (
      await request(server())
        .post('/v1/journal-entries/preview')
        .set('Authorization', `Bearer ${acct}`)
        .send({
          nature: 'SALE',
          lines: posted.lines.map((l, i) => ({
            accountId: saleLines()[i].accountId,
            amount: l.amount,
            taxCodeIds: saleLines()[i].taxCodeIds,
          })),
        })
        .expect(200)
    ).body as { lines: JeLine[] };
    expect(sorted(preview.lines)).toEqual(sorted(je));
  });

  it('PATCH: replaced lines re-derive the discount; a lines-less edit keeps them; GET + list expose the fields', async () => {
    const draft = (await create('/v1/sales-invoices', saleBody())).body as Doc;
    const patched = (
      await request(server())
        .patch(`/v1/sales-invoices/${draft.id}`)
        .set('Authorization', `Bearer ${acct}`)
        .send({
          lines: [
            {
              ...saleLines()[0],
              discountPercent: undefined,
              discountAmount: '1000',
            },
          ],
        })
        .expect(200)
    ).body as Doc;
    expect(patched.lines[0]).toMatchObject({
      discountPercent: null,
      discountAmount: '1000.0000',
      amount: '99000.0000',
    });
    expect(patched.discountTotal).toBe('1000.0000');
    expect(patched.taxTotal).toBe('10890.0000');

    // Percent line, then a description-only edit: the stored percent survives.
    await request(server())
      .patch(`/v1/sales-invoices/${draft.id}`)
      .set('Authorization', `Bearer ${acct}`)
      .send({ lines: [saleLines()[0]] })
      .expect(200);
    const kept = (
      await request(server())
        .patch(`/v1/sales-invoices/${draft.id}`)
        .set('Authorization', `Bearer ${acct}`)
        .send({ description: 'tetap' })
        .expect(200)
    ).body as Doc;
    expect(kept.lines[0]).toMatchObject({
      discountPercent: '10.0000',
      discountAmount: '10000.0000',
      amount: '90000.0000',
    });
    expect(kept.subtotal).toBe('90000.0000');

    const list = (
      await request(server())
        .get(`/v1/sales-invoices?partnerId=${customerId}&status=DRAFT`)
        .set('Authorization', `Bearer ${acct}`)
        .expect(200)
    ).body as { data: Doc[] };
    expect(list.data.find((d) => d.id === draft.id)!.discountTotal).toBe(
      '10000.0000',
    );
    // A posted document stays immutable.
    await post('/v1/sales-invoices', draft.id);
    await request(server())
      .patch(`/v1/sales-invoices/${draft.id}`)
      .set('Authorization', `Bearer ${acct}`)
      .send({ lines: [saleLines()[1]] })
      .expect(422);
  });

  it.each([
    [
      'percent and amount together',
      { discountPercent: '10', discountAmount: '1' },
      400,
    ],
    ['percent over 100', { discountPercent: '100.01' }, 400],
    ['percent with 5 dp', { discountPercent: '1.00001' }, 400],
    ['negative amount', { discountAmount: '-1' }, 400],
    ['numeric (non-string) percent', { discountPercent: 10 }, 400],
    ['amount above qty × unitPrice', { discountAmount: '100000.0001' }, 422],
  ])('rejects %s (%i)', async (_n, discount, status) => {
    const line = {
      description: 'x',
      accountId: acc['4-1000'],
      quantity: '2',
      unitPrice: '50000',
      taxCodeIds: [],
      ...discount,
    };
    await create('/v1/sales-invoices', saleBody([line]), status);
  });

  it('accepts a 100% discount (zero line) and an amount equal to the gross', async () => {
    const doc = (
      await create(
        '/v1/sales-invoices',
        saleBody([
          { ...saleLines()[0], discountPercent: '100' },
          {
            ...saleLines()[1],
            discountAmount: '1000000',
          },
          {
            description: 'c',
            accountId: acc['4-1000'],
            quantity: '1',
            unitPrice: '500',
            taxCodeIds: [],
          },
        ]),
      )
    ).body as Doc;
    expect(doc.lines.map((l) => l.amount)).toEqual([
      '0.0000',
      '0.0000',
      '500.0000',
    ]);
    expect(doc.discountTotal).toBe('1100000.0000');
    expect(doc.total).toBe('500.0000');
  });

  it('zero-discount regression: amounts/totals/JE unchanged, discount fields default', async () => {
    const doc = (
      await create(
        '/v1/sales-invoices',
        saleBody([
          {
            description: 'Jasa',
            accountId: acc['4-1000'],
            quantity: '3',
            unitPrice: '1000.5',
            taxCodeIds: [code['PPN-OUT-11']],
          },
        ]),
      )
    ).body as Doc;
    expect(doc.lines[0]).toMatchObject({
      discountPercent: null,
      discountAmount: '0.0000',
      amount: '3001.5000',
    });
    expect(doc.discountTotal).toBe('0.0000');
    expect(doc.subtotal).toBe('3001.5000');
    expect(doc.taxTotal).toBe('330.0000'); // 11% × 3001.5 = 330.165 → rupiah
    const posted = await post('/v1/sales-invoices', doc.id);
    expect(posted.total).toBe(doc.total);
    const je = await jeLines(posted.journalEntryId!);
    expect(je.find((l) => l.accountId === acc['4-1000'])!.credit).toBe(
      '3001.5000',
    );
  });

  it('purchase bill: PPN-IN and PPh 23 both on the discounted DPP; expense posted NET', async () => {
    const bill = (
      await create('/v1/purchase-bills', {
        partnerId: vendorId,
        date: '2026-02-10',
        lines: [
          {
            description: 'Jasa',
            accountId: acc['5-2000'],
            quantity: '1',
            unitPrice: '1000000',
            discountPercent: '10',
            taxCodeIds: [code['PPN-IN-11'], code['PPH23-PAY']],
          },
        ],
      })
    ).body as Doc;
    expect(bill.subtotal).toBe('900000.0000');
    expect(bill.discountTotal).toBe('100000.0000');
    expect(bill.taxTotal).toBe('99000.0000');
    expect(bill.withholdingTotal).toBe('18000.0000');
    const posted = await post('/v1/purchase-bills', bill.id);
    const je = await jeLines(posted.journalEntryId!);
    expect(je.find((l) => l.accountId === acc['5-2000'])!.debit).toBe(
      '900000.0000',
    );
  });

  it('DB CHECK rejects a stored discount above the line gross', async () => {
    const doc = (await create('/v1/sales-invoices', saleBody([saleLines()[0]])))
      .body as Doc;
    await expect(
      prisma.client
        .$executeRaw`UPDATE sales_invoice_lines SET discount_amount = 100000.0001 WHERE sales_invoice_id = ${doc.id}`,
    ).rejects.toThrow(/sales_invoice_lines_valid_discount/);
    await expect(
      prisma.client
        .$executeRaw`UPDATE sales_invoice_lines SET discount_percent = 101 WHERE sales_invoice_id = ${doc.id}`,
    ).rejects.toThrow(/sales_invoice_lines_valid_discount/);
  });
});
