import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { BalancesService } from '../src/ledger/balances/balances.service';
import { CompanyService } from '../src/company/company.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { SalesInvoicesService } from '../src/invoicing/sales-invoices.service';
import { PurchaseBillsService } from '../src/invoicing/purchase-bills.service';
import { NoteKindKey, NotesService } from '../src/invoicing/notes.service';
import { ValidationFailedError } from '../src/common/errors/domain-errors';
import { Money } from '../src/common/money/money';
import { bootstrapTestApp } from './e2e-helpers';
import { expectAgingPrefilterEquivalent } from './aging-prefilter-equivalence';

/**
 * Credit/debit-note remainders: whole returns of an original reproduce it
 * exactly (per-code rupiah tax, fixed discounts) whatever the split — the
 * line / tax code a note completes takes the remainder, partial notes are
 * capped at it — and notes keep working on an original whose tax code,
 * account or partner has since been deactivated.
 */
describe('Credit / debit note remainders (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let notes: NotesService;
  let invoices: SalesInvoicesService;
  let bills: PurchaseBillsService;
  let acc: Record<string, string>;
  let role: Record<string, string>;
  let tax: Record<string, string>;
  let n = 0;

  const m4 = (v: unknown) => Money.of(String(v)).toPersistence();

  const partner = async (kind: 'isCustomer' | 'isVendor') =>
    (
      await app.get(BusinessPartnersService).create({
        code: `REM-${++n}`,
        name: `Remainder partner ${n}`,
        [kind]: true,
      })
    ).id;

  type Line = {
    quantity: string;
    unitPrice: string;
    discountAmount?: string;
    taxCodeIds: string[];
  };
  const docLines = (lines: Line[], accountId: string) =>
    lines.map((l, i) => ({ description: `L${i + 1}`, accountId, ...l }));

  const postedInvoice = async (partnerId: string, lines: Line[]) => {
    const d = await invoices.createDraft({
      partnerId,
      date: new Date('2026-04-01'),
      lines: docLines(lines, acc['4-1000']),
      createdBy: 'creator',
    });
    return invoices.post(d.id, 'poster');
  };

  const postedBill = async (partnerId: string, lines: Line[]) => {
    const d = await bills.createDraft({
      partnerId,
      date: new Date('2026-04-01'),
      lines: docLines(lines, acc['5-2000']),
      createdBy: 'creator',
    });
    return bills.post(d.id, 'poster');
  };

  const draft = (
    key: NoteKindKey,
    originalId: string,
    lineId: string,
    q = '1',
  ) =>
    notes.createDraft(key, {
      originalId,
      date: new Date('2026-04-02'),
      lines: [{ originalLineId: lineId, quantity: q }],
      createdBy: 'creator',
    });
  const posted = async (
    key: NoteKindKey,
    originalId: string,
    lineId: string,
    q = '1',
  ) => notes.post(key, (await draft(key, originalId, lineId, q)).id, 'poster');

  const outstanding = async (kind: 'invoice' | 'bill', id: string) =>
    (kind === 'invoice'
      ? invoices.present(await invoices.getById(id))
      : bills.present(await bills.getById(id))
    ).outstanding;

  const advance = async (r: 'CUSTOMER_ADVANCE' | 'VENDOR_ADVANCE') =>
    m4(
      (
        await app
          .get(BalancesService)
          .accountBalance(role[r], new Date('2026-12-31'))
      ).balance,
    );

  const sum = (xs: unknown[]) =>
    Money.sum(xs.map((x) => Money.of(String(x)))).toPersistence();

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());
    await app.get(CompanyService).seedIfEmpty();
    await app.get(AccountsService).seedIfEmpty();
    await app.get(TaxCodesService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const { data: accounts } = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    role = Object.fromEntries(
      accounts.filter((a) => a.role).map((a) => [a.role!, a.id]),
    );
    tax = Object.fromEntries(
      (await prisma.client.taxCode.findMany()).map((t) => [t.code, t.id]),
    );
    notes = app.get(NotesService);
    invoices = app.get(SalesInvoicesService);
    bills = app.get(PurchaseBillsService);
  }, 120_000);

  afterAll(() => cleanup());

  it.each([
    // 2 × 1 050 → PPN round(231) = 231; per unit round(115.5) = 116 → 116 + 115.
    ['1050', '231.0000', ['116.0000', '115.0000']],
    // 2 × 1 040 → PPN round(228.8) = 229; per unit round(114.4) = 114 → 114 + 115.
    ['1040', '229.0000', ['114.0000', '115.0000']],
  ])(
    'Rp%s × 2, PPN 11%%: two 1-unit credit notes sum to the invoice exactly',
    async (price, invoiceTax, noteTaxes) => {
      const inv = await postedInvoice(await partner('isCustomer'), [
        { quantity: '2', unitPrice: price, taxCodeIds: [tax['PPN-OUT-11']] },
      ]);
      expect(m4(inv.taxTotal)).toBe(invoiceTax);
      const before = await advance('CUSTOMER_ADVANCE');
      const line = inv.lines![0].id;
      const a = await posted('SALES', inv.id, line);
      const b = await posted('SALES', inv.id, line);
      expect([m4(a.taxTotal), m4(b.taxTotal)]).toEqual(noteTaxes);
      expect(sum([a.total, b.total])).toBe(m4(inv.total));
      expect(m4(b.unappliedAmount)).toBe('0.0000');
      expect(await outstanding('invoice', inv.id)).toBe('0.0000');
      // No phantom partner credit on Uang Muka Pelanggan.
      expect(await advance('CUSTOMER_ADVANCE')).toBe(before);
    },
  );

  it('fixed discount: the completing note takes the remaining discount', async () => {
    const inv = await postedInvoice(await partner('isCustomer'), [
      {
        quantity: '3',
        unitPrice: '100000',
        discountAmount: '100',
        taxCodeIds: [tax['PPN-OUT-11']],
      },
    ]);
    const line = inv.lines![0].id;
    const ns = [
      await posted('SALES', inv.id, line),
      await posted('SALES', inv.id, line),
      await posted('SALES', inv.id, line),
    ];
    expect(ns.map((x) => m4(x.lines![0].discountAmount))).toEqual([
      '33.3333',
      '33.3333',
      '33.3334',
    ]);
    expect(sum(ns.map((x) => x.subtotal))).toBe(m4(inv.subtotal));
    expect(sum(ns.map((x) => x.taxTotal))).toBe(m4(inv.taxTotal));
    expect(sum(ns.map((x) => x.total))).toBe(m4(inv.total));
    expect(await outstanding('invoice', inv.id)).toBe('0.0000');
  });

  it('partial then complete (debit notes): a draft priced before the completing note keeps the sum exact', async () => {
    const bill = await postedBill(await partner('isVendor'), [
      { quantity: '2', unitPrice: '1050', taxCodeIds: [tax['PPN-IN-11']] },
    ]);
    const before = await advance('VENDOR_ADVANCE');
    const line = bill.lines![0].id;
    const a = await draft('PURCHASE', bill.id, line); // partial: raw 116
    const b = await draft('PURCHASE', bill.id, line); // completes: 231 − 116
    expect([m4(a.taxTotal), m4(b.taxTotal)]).toEqual(['116.0000', '115.0000']);
    // Posted in the other order: each still takes 231 − the other.
    const pb = await notes.post('PURCHASE', b.id, 'poster');
    const pa = await notes.post('PURCHASE', a.id, 'poster');
    expect([m4(pa.taxTotal), m4(pb.taxTotal)]).toEqual([
      '116.0000',
      '115.0000',
    ]);
    expect(sum([pa.total, pb.total])).toBe(m4(bill.total));
    expect(await outstanding('bill', bill.id)).toBe('0.0000');
    expect(await advance('VENDOR_ADVANCE')).toBe(before);
  });

  it('a partial note is capped at what the other notes left (never exceeds the original)', async () => {
    const inv = await postedInvoice(await partner('isCustomer'), [
      { quantity: '4', unitPrice: '1050', taxCodeIds: [tax['PPN-OUT-11']] },
    ]);
    // Invoice PPN round(462) = 462; three 1-unit notes take 116 each (348).
    const line = inv.lines![0].id;
    const ns = [
      await posted('SALES', inv.id, line),
      await posted('SALES', inv.id, line),
      await posted('SALES', inv.id, line),
    ];
    // 0.9999 unit: raw round(115.488…) = 115 > 462 − 348 → capped at 114.
    ns.push(await posted('SALES', inv.id, line, '0.9999'));
    // The last 0.0001 completes the code: remainder 0.
    ns.push(await posted('SALES', inv.id, line, '0.0001'));
    expect(ns.map((x) => m4(x.taxTotal))).toEqual([
      '116.0000',
      '116.0000',
      '116.0000',
      '114.0000',
      '0.0000',
    ]);
    expect(sum(ns.map((x) => x.taxTotal))).toBe(m4(inv.taxTotal));
    expect(sum(ns.map((x) => x.total))).toBe(m4(inv.total));
    expect(await outstanding('invoice', inv.id)).toBe('0.0000');
  });

  it('concurrent completing notes: one wins, the sum stays exact', async () => {
    const inv = await postedInvoice(await partner('isCustomer'), [
      { quantity: '2', unitPrice: '1050', taxCodeIds: [tax['PPN-OUT-11']] },
    ]);
    const line = inv.lines![0].id;
    await posted('SALES', inv.id, line);
    const races = await Promise.allSettled([
      draft('SALES', inv.id, line),
      draft('SALES', inv.id, line),
    ]);
    const ok = races.filter((r) => r.status === 'fulfilled');
    const failed = races.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed[0].reason).toBeInstanceOf(ValidationFailedError);
    const winner = (ok[0] as PromiseFulfilledResult<{ id: string }>).value;
    const p = await notes.post('SALES', winner.id, 'poster');
    expect(m4(p.taxTotal)).toBe('115.0000');
    expect(await outstanding('invoice', inv.id)).toBe('0.0000');
  });

  it('concurrent posts of two drafts that together complete the invoice', async () => {
    const inv = await postedInvoice(await partner('isCustomer'), [
      { quantity: '2', unitPrice: '1050', taxCodeIds: [tax['PPN-OUT-11']] },
    ]);
    const line = inv.lines![0].id;
    const a = await draft('SALES', inv.id, line);
    const b = await draft('SALES', inv.id, line);
    const [pa, pb] = await Promise.all([
      notes.post('SALES', a.id, 'poster'),
      notes.post('SALES', b.id, 'poster'),
    ]);
    expect(sum([pa.taxTotal, pb.taxTotal])).toBe('231.0000');
    expect(sum([pa.total, pb.total])).toBe(m4(inv.total));
    expect(await outstanding('invoice', inv.id)).toBe('0.0000');
  });

  it('rate change: a note still returns an invoice whose code was deactivated', async () => {
    const codes = app.get(TaxCodesService);
    const { taxAccountId: ppnAccount } =
      await prisma.client.taxCode.findFirstOrThrow({
        where: { id: tax['PPN-OUT-11'] },
      });
    const old = await codes.create({
      code: 'PPN-OUT-OLD',
      name: 'PPN Keluaran lama',
      kind: 'PPN_OUTPUT',
      rate: '0.11',
      taxAccountId: ppnAccount,
    });
    const c = await partner('isCustomer');
    const inv = await postedInvoice(c, [
      { quantity: '2', unitPrice: '1050', taxCodeIds: [old.id] },
    ]);
    await codes.create({
      code: 'PPN-OUT-NEW',
      name: 'PPN Keluaran baru',
      kind: 'PPN_OUTPUT',
      rate: '0.12',
      taxAccountId: ppnAccount,
    });
    await codes.deactivate(old.id);
    // Invoices stay strict…
    await expect(
      invoices.createDraft({
        partnerId: c,
        date: new Date('2026-04-01'),
        lines: docLines(
          [{ quantity: '1', unitPrice: '1', taxCodeIds: [old.id] }],
          acc['4-1000'],
        ),
        createdBy: 'creator',
      }),
    ).rejects.toThrow('Tax code is inactive');
    // …a note on the old invoice uses the old (inactive) 11% code.
    const a = await posted('SALES', inv.id, inv.lines![0].id);
    const b = await posted('SALES', inv.id, inv.lines![0].id);
    expect([m4(a.taxTotal), m4(b.taxTotal)]).toEqual(['116.0000', '115.0000']);
    expect(await outstanding('invoice', inv.id)).toBe('0.0000');
  });

  it('deactivated revenue account and partner do not block a note', async () => {
    const c = await partner('isCustomer');
    const inv = await postedInvoice(c, [
      { quantity: '2', unitPrice: '1000', taxCodeIds: [tax['PPN-OUT-11']] },
    ]);
    await app.get(BusinessPartnersService).deactivate(c);
    await prisma.client.account.update({
      where: { id: acc['4-1000'] },
      data: { isActive: false },
    });
    try {
      const d = await draft('SALES', inv.id, inv.lines![0].id);
      const p = await notes.post('SALES', d.id, 'poster');
      expect(p.status).toBe('POSTED');
      expect(m4(p.total)).toBe('1110.0000');
      // Invoices stay strict for the inactive partner.
      await expect(
        invoices.createDraft({
          partnerId: c,
          date: new Date('2026-04-01'),
          lines: docLines(
            [{ quantity: '1', unitPrice: '1', taxCodeIds: [] }],
            acc['4-1000'],
          ),
          createdBy: 'creator',
        }),
      ).rejects.toBeInstanceOf(ValidationFailedError);
    } finally {
      await prisma.client.account.update({
        where: { id: acc['4-1000'] },
        data: { isActive: true },
      });
    }
  });

  it('returning a zero-quantity original line is a 422, not a 500', async () => {
    const inv = await postedInvoice(await partner('isCustomer'), [
      { quantity: '0', unitPrice: '1000', taxCodeIds: [] },
      { quantity: '1', unitPrice: '1000', taxCodeIds: [] },
    ]);
    await expect(draft('SALES', inv.id, inv.lines![0].id)).rejects.toThrow(
      ValidationFailedError,
    );
    await expect(draft('SALES', inv.id, inv.lines![0].id)).rejects.toThrow(
      'Original line has zero quantity; nothing to return',
    );
  });
  it('aging pre-filter is equivalent to the exact as-of computation over this history', async () => {
    await expectAgingPrefilterEquivalent(app);
  }, 120_000);
});
