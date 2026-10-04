import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { CompanyService } from '../src/company/company.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { SalesInvoicesService } from '../src/invoicing/sales-invoices.service';
import { PurchaseBillsService } from '../src/invoicing/purchase-bills.service';
import { NotesService } from '../src/invoicing/notes.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';
import { readXlsx } from './xlsx-read';
import type { PpnRecap } from '../src/reporting/ppn-recap.service';

const binary = (
  res: unknown,
  cb: (err: Error | null, body: Buffer) => void,
) => {
  const stream = res as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
};

/**
 * Rekap PPN Masa: sales (DPP Nilai Lain, discounts), retur, voids in the same
 * and a later masa, purchases + retur, and a manual journal on the PPN
 * account — tied to the ledger and to the Coretax XML math.
 */
describe('Reporting PPN recap (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let viewer: string;
  let admin: string;
  let acc: Record<string, string>;
  const ids: Record<string, string> = {};
  const server = () => app.getHttpServer() as App;
  const get = (url: string, token = viewer) =>
    request(server()).get(url).set('Authorization', `Bearer ${token}`);
  const recap = async (period: string) =>
    (await get(`/v1/reports/ppn-recap?period=${period}`).expect(200))
      .body as PpnRecap;

  /** Σ PPN-account movement in [from, to] from non-MANUAL journals:
   *  credit − debit (Output 2-1100) or debit − credit (Input 1-1400). */
  const ledgerMovement = async (code: string, from: string, to: string) => {
    const [r] = await prisma.$queryRaw<{ cr: string; dr: string }[]>`
      SELECT COALESCE(SUM(jl.credit), 0)::text AS cr,
             COALESCE(SUM(jl.debit), 0)::text AS dr
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      JOIN accounts a ON a.id = jl.account_id
      LEFT JOIN journal_entries s ON s.id = je.reversal_of_id
      WHERE a.code = ${code} AND je.posted_at IS NOT NULL
        AND je.date BETWEEN ${new Date(from)} AND ${new Date(to)}
        AND COALESCE(s.source_type, je.source_type) <> 'MANUAL'`;
    return { cr: Number(r.cr), dr: Number(r.dr) };
  };

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());
    await app.get(CompanyService).seedIfEmpty();
    await app.get(AccountsService).seedIfEmpty();
    await app.get(TaxCodesService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const users = app.get(UsersService);
    const auth = app.get(AuthService);
    await users.create({
      email: 'v@ppn.test',
      password: 'secret123',
      name: 'V',
      role: 'VIEWER',
    });
    await users.create({
      email: 'a@ppn.test',
      password: 'secret123',
      name: 'A',
      role: 'ADMIN',
    });
    viewer = (await auth.login('v@ppn.test', 'secret123')).accessToken;
    admin = (await auth.login('a@ppn.test', 'secret123')).accessToken;
    const { data: accounts } = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    const { data: codes } = await app.get(TaxCodesService).list();
    const code = Object.fromEntries(codes.map((c) => [c.code, c.id]));

    await request(server())
      .patch('/v1/company/settings')
      .set('Authorization', `Bearer ${admin}`)
      .send({
        npwp: '0012345678901000',
        coretaxDefaultItemType: 'A',
        coretaxDefaultUnitCode: 'UM.0018',
      })
      .expect(200);
    const partners = app.get(BusinessPartnersService);
    const customer = await partners.create({
      code: 'PPN-C',
      name: 'PT Pembeli',
      npwp: '0098765432109000',
      address: 'Jl. Sudirman 1',
      isCustomer: true,
    });
    const vendor = await partners.create({
      code: 'PPN-V',
      name: 'PT Pemasok',
      npwp: '0011122233344000',
      isVendor: true,
    });
    const invoices = app.get(SalesInvoicesService);
    const bills = app.get(PurchaseBillsService);
    const notes = app.get(NotesService);
    const ppnOut = [code['PPN-OUT-11']];
    const invoice = async (date: string, lines: object[]) => {
      const d = await invoices.createDraft({
        partnerId: customer.id,
        date: new Date(date),
        lines: lines as never,
        createdBy: 'creator',
      });
      return invoices.post(d.id, 'poster');
    };
    const simple = (unitPrice: string) => ({
      description: 'Jasa',
      accountId: acc['4-1000'],
      quantity: '1',
      unitPrice,
      taxCodeIds: ppnOut,
    });

    // March invoice voided in April (cross-masa batal).
    ids.D = (await invoice('2026-03-15', [simple('200000')])).id;
    // A: DPP Nilai Lain 11/12 at 12%, % and fixed discounts, a non-PPN line.
    const a = await invoice('2026-04-05', [
      {
        description: 'Konsultasi',
        accountId: acc['4-1000'],
        quantity: '2',
        unitPrice: '50000',
        discountPercent: '10',
        taxCodeIds: ppnOut,
      },
      {
        description: 'Barang',
        accountId: acc['4-1000'],
        quantity: '1',
        unitPrice: '30000',
        discountAmount: '5000',
        taxCodeIds: ppnOut,
      },
      { ...simple('7000'), taxCodeIds: [] },
    ]);
    ids.A = a.id;
    ids.B = (await invoice('2026-04-10', [simple('1000000')])).id;
    ids.C = (await invoice('2026-04-12', [simple('500000')])).id;
    await invoices.void(ids.B, 'voider', new Date('2026-04-20'));
    await invoices.void(ids.D, 'voider', new Date('2026-04-08'));
    await invoices.void(ids.C, 'voider', new Date('2026-05-03'));

    // Retur keluaran: line 2 of A (DPP 25,000 → PPN 2,750).
    const full = await invoices.getById(ids.A);
    const cn = await notes.createDraft('SALES', {
      originalId: ids.A,
      date: new Date('2026-04-15'),
      lines: [{ originalLineId: full.lines![1].id, quantity: '1' }],
      createdBy: 'creator',
    });
    ids.CN = (await notes.post('SALES', cn.id, 'poster')).id;

    // Purchases: 4 × 500,000 + PPN 11% = 220,000; retur 1 unit (55,000).
    const bd = await bills.createDraft({
      partnerId: vendor.id,
      vendorInvoiceNo: 'INV-V-1',
      date: new Date('2026-04-06'),
      lines: [
        {
          description: 'Bahan',
          accountId: acc['5-2000'],
          quantity: '4',
          unitPrice: '500000',
          taxCodeIds: [code['PPN-IN-11']],
        },
      ],
      createdBy: 'creator',
    });
    const bill = await bills.post(bd.id, 'poster');
    ids.E = bill.id;
    const fullBill = await bills.getById(ids.E);
    const dn = await notes.createDraft('PURCHASE', {
      originalId: ids.E,
      date: new Date('2026-04-18'),
      lines: [{ originalLineId: fullBill.lines![0].id, quantity: '1' }],
      createdBy: 'creator',
    });
    ids.DN = (await notes.post('PURCHASE', dn.id, 'poster')).id;

    // A manual journal on the PPN Output account: flagged, not recapped.
    await app.get(PostingService).post(
      {
        date: new Date('2026-04-25'),
        description: 'Koreksi PPN manual',
        sourceType: 'MANUAL',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: '1000' },
          { accountId: acc['2-1100'], credit: '1000' },
        ],
      },
      'p',
    );
  }, 120_000);

  afterAll(() => cleanup());

  it('sums faktur, batal, retur and nets kurang/lebih bayar', async () => {
    const r = await recap('2026-04');
    expect(r).toMatchObject({
      period: '2026-04',
      from: '2026-04-01',
      to: '2026-04-30',
      isPkp: true,
      // A (12,650) + B (110,000) + C (55,000) — C is voided only in May.
      ppnKeluaran: {
        count: 3,
        dpp: '1615000.0000',
        dppNilaiLain: '1480416.6700',
        ppn: '177650.0000',
      },
      // B (same masa) + D (March invoice voided in April).
      batalKeluaran: { count: 2, dpp: '1200000.0000', ppn: '132000.0000' },
      returKeluaran: {
        count: 1,
        dpp: '25000.0000',
        dppNilaiLain: '22916.6700',
        ppn: '2750.0000',
      },
      ppnKeluaranNet: '42900.0000',
      ppnMasukan: { count: 1, dpp: '2000000.0000', ppn: '220000.0000' },
      batalMasukan: { count: 0, ppn: '0.0000' },
      returMasukan: { count: 1, dpp: '500000.0000', ppn: '55000.0000' },
      ppnMasukanNet: '165000.0000',
      net: '-122100.0000',
      netStatus: 'LEBIH_BAYAR',
    });
    const f = r.fakturs;
    expect(f.keluaran.map((x) => [x.id, x.trxCode, x.status])).toEqual([
      [ids.A, '04', 'POSTED'],
      [ids.B, '04', 'VOID'],
      [ids.C, '04', 'VOID'],
    ]);
    expect(f.keluaran[0]).toMatchObject({
      partnerName: 'PT Pembeli',
      npwp: '0098765432109000',
      dpp: '115000.0000',
      ppn: '12650.0000',
      taxInvoiceStatus: 'NONE',
      voidedOn: null,
    });
    expect(f.batalKeluaran.map((x) => x.id)).toEqual([ids.D, ids.B]);
    expect(f.returKeluaran[0]).toMatchObject({
      id: ids.CN,
      cancellation: false,
    });
    expect(f.masukan[0]).toMatchObject({
      id: ids.E,
      vendorInvoiceNo: 'INV-V-1',
      partnerName: 'PT Pemasok',
      npwp: '0011122233344000',
    });
    expect(f.returMasukan[0].id).toBe(ids.DN);
    // Only the cross-masa void warns (pembetulan), plus the manual journal.
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toMatch(/masa asalnya 2026-03/);
    expect(r.warnings[1]).toMatch(/jurnal non-dokumen/);
  });

  it('ties to the ledger and flags the manual PPN journal', async () => {
    const r = await recap('2026-04');
    const out = await ledgerMovement('2-1100', '2026-04-01', '2026-04-30');
    const inp = await ledgerMovement('1-1400', '2026-04-01', '2026-04-30');
    expect(out.cr - out.dr).toBe(Number(r.ppnKeluaranNet));
    expect(inp.dr - inp.cr).toBe(Number(r.ppnMasukanNet));
    expect(r.ledger).toMatchObject({
      ppnKeluaran: r.ppnKeluaranNet,
      ppnMasukan: r.ppnMasukanNet,
      ties: true,
      unreconciledManualEntries: {
        ppnKeluaran: '1000.0000',
        ppnMasukan: '0.0000',
      },
    });
    expect(r.ledger.unreconciledManualEntries.entries).toEqual([
      expect.objectContaining({
        sourceType: 'MANUAL',
        accountCode: '2-1100',
        side: 'KELUARAN',
        amount: '1000.0000',
        date: '2026-04-25',
      }),
    ]);
  });

  it('a later-month void reduces the void masa and warns', async () => {
    const may = await recap('2026-05');
    expect(may).toMatchObject({
      ppnKeluaran: { count: 0, ppn: '0.0000' },
      batalKeluaran: { count: 1, ppn: '55000.0000' },
      ppnKeluaranNet: '-55000.0000',
      net: '-55000.0000',
      netStatus: 'LEBIH_BAYAR',
      ledger: { ppnKeluaran: '-55000.0000', ties: true },
    });
    expect(may.warnings[0]).toMatch(/masa asalnya 2026-04 \(pembetulan/);
    // March keeps D as issued (reproducible: its void lives in April).
    const march = await recap('2026-03');
    expect(march).toMatchObject({
      ppnKeluaran: { count: 1, ppn: '22000.0000' },
      ppnKeluaranNet: '22000.0000',
      netStatus: 'KURANG_BAYAR',
      ledger: { ppnKeluaran: '22000.0000', ties: true },
    });
    expect(march.fakturs.keluaran[0]).toMatchObject({
      id: ids.D,
      status: 'VOID',
      voidedOn: '2026-04-08',
    });
  });

  it('matches the Coretax XML amounts of the faktur', async () => {
    const xml = (
      await request(server())
        .get('/v1/tax/coretax/faktur-keluaran?from=2026-04-05&to=2026-04-05')
        .set('Authorization', `Bearer ${admin}`)
        .expect(200)
    ).text;
    const sum = (tag: string) =>
      [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].reduce(
        (s, m) => s + Number(m[1]),
        0,
      );
    const row = (await recap('2026-04')).fakturs.keluaran[0];
    expect(Number(row.dpp)).toBe(sum('TaxBase'));
    expect(Number(row.dppNilaiLain)).toBeCloseTo(sum('OtherTaxBase'), 2);
    expect(Number(row.fakturPpn)).toBe(sum('VAT'));
    expect(xml).toContain(`<TrxCode>${row.trxCode}</TrxCode>`);
  });

  it('exports CSV and XLSX with the Indonesian labels', async () => {
    const csv = await get(
      '/v1/reports/ppn-recap?period=2026-04&format=csv',
    ).expect(200);
    expect(csv.headers['content-disposition']).toBe(
      'attachment; filename="ppn-recap-2026-04.csv"',
    );
    const lines = csv.text.slice(1).split('\r\n');
    for (const [label, value] of [
      ['Total PPN Keluaran', '177650.0000'],
      ['Total Retur PPN Keluaran', '2750.0000'],
      ['PPN Keluaran Bersih', '42900.0000'],
      ['Total PPN Masukan', '220000.0000'],
      ['PPN Masukan Bersih', '165000.0000'],
      ['Kurang/(Lebih) Bayar', '-122100.0000'],
    ])
      expect(lines.find((l) => l.startsWith(`${label},`))?.split(',')[8]).toBe(
        value,
      );
    expect(lines).toContain('Status: Lebih Bayar');

    const xlsx = await get('/v1/reports/ppn-recap?period=2026-04&format=xlsx')
      .buffer(true)
      .parse(binary)
      .expect(200);
    expect(xlsx.headers['content-disposition']).toBe(
      'attachment; filename="ppn-recap-2026-04.xlsx"',
    );
    const rows = readXlsx(xlsx.body as Buffer).rows;
    expect(rows[0][0]).toBe('Rekap PPN Masa');
    const net = rows.find((r) => r[0] === 'Kurang/(Lebih) Bayar');
    expect(Number(net?.[8])).toBe(-122100);
    expect(rows.find((r) => r[0] === 'PPN Masukan')).toBeDefined();
  });

  it('validates the masa and reports a non-PKP company without 422', async () => {
    for (const p of ['2026-13', '1999-12', '2026-4', ''])
      await get(`/v1/reports/ppn-recap?period=${p}`).expect(400);
    await get('/v1/reports/ppn-recap').expect(400);
    await request(server())
      .patch('/v1/company/settings')
      .set('Authorization', `Bearer ${admin}`)
      .send({ isPkp: false })
      .expect(200);
    const r = await recap('2026-07');
    expect(r).toMatchObject({
      isPkp: false,
      ppnKeluaranNet: '0.0000',
      ppnMasukanNet: '0.0000',
      net: '0.0000',
      netStatus: 'NIHIL',
      ledger: { ties: true },
    });
    expect(r.warnings[0]).toMatch(/bukan PKP/);
  });
});
