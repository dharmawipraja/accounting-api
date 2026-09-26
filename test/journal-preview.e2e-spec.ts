import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { Money } from '../src/common/money/money';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { CompanyService } from '../src/company/company.service';
import { asOfOrToday } from '../src/common/dates/query-dates';
import { bootstrapTestApp } from './e2e-helpers';

describe('Journal preview (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let acct: string;
  let appr: string;
  let viewer: string;
  let acc: Record<string, string>;
  let code: Record<string, string>;
  let customerId: string;

  const server = () => app.getHttpServer() as App;
  const norm = (v: string | { toString(): string }) =>
    Money.of(v.toString()).toPersistence();

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());
    await app.get(AccountsService).seedIfEmpty();
    await app.get(TaxCodesService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const users = app.get(UsersService);
    await users.create({
      email: 'acct@jp.test',
      password: 'secret123',
      name: 'A',
      role: 'ACCOUNTANT',
    });
    await users.create({
      email: 'appr@jp.test',
      password: 'secret123',
      name: 'B',
      role: 'APPROVER',
    });
    await users.create({
      email: 'view@jp.test',
      password: 'secret123',
      name: 'V',
      role: 'VIEWER',
    });
    viewer = (await app.get(AuthService).login('view@jp.test', 'secret123'))
      .accessToken;
    acct = (await app.get(AuthService).login('acct@jp.test', 'secret123'))
      .accessToken;
    appr = (await app.get(AuthService).login('appr@jp.test', 'secret123'))
      .accessToken;
    const { data: accounts } = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    const { data: codes } = await app.get(TaxCodesService).list();
    code = Object.fromEntries(codes.map((c) => [c.code, c.id]));
    customerId = (
      await app
        .get(BusinessPartnersService)
        .create({ code: 'CUST-JP', name: 'Pelanggan', isCustomer: true })
    ).id;
  }, 120_000);

  afterAll(() => cleanup());

  const saleBody = () => ({
    nature: 'SALE',
    settlementAccountId: acc['1-1200'], // AR control
    lines: [
      {
        accountId: acc['4-1000'],
        amount: '1000000',
        taxCodeIds: [code['PPN-OUT-11']],
      },
    ],
  });

  it('optional date inside an open period previews normally (200)', async () => {
    await request(server())
      .post('/v1/journal-entries/preview')
      .set('Authorization', `Bearer ${acct}`)
      .send({ ...saleBody(), date: '2026-03-10' })
      .expect(200);
  });

  it('optional date outside any open period previews the 409 a real post would give', async () => {
    // Beyond the auto-generated window (current + next fiscal year, from the
    // WIB "today") forever — a fixed future date would start auto-generating
    // its year (and preview 200) once the calendar caught up with it.
    const company = app.get(CompanyService);
    const current = await company.fiscalYearFor(asOfOrToday());
    const { start } = await company.fiscalYearBounds(current + 2);
    await request(server())
      .post('/v1/journal-entries/preview')
      .set('Authorization', `Bearer ${acct}`)
      .send({ ...saleBody(), date: start.toISOString().slice(0, 10) })
      .expect(409);
    expect(await app.get(PeriodsService).list(current + 2)).toHaveLength(0);
  });

  it('rejects more than 100 lines with 400', async () => {
    const body = saleBody();
    body.lines = Array.from({ length: 101 }, () => ({
      accountId: acc['4-1000'],
      amount: '1000',
      taxCodeIds: [],
    }));
    await request(server())
      .post('/v1/journal-entries/preview')
      .set('Authorization', `Bearer ${acct}`)
      .send(body)
      .expect(400);
  });

  it('SALE preview: balanced, enriched with code/name, equals /tax/calculate lines', async () => {
    const preview = (
      await request(server())
        .post('/v1/journal-entries/preview')
        .set('Authorization', `Bearer ${acct}`)
        .send(saleBody())
        .expect(200)
    ).body as {
      lines: {
        accountId: string;
        accountCode: string;
        accountName: string;
        debit: string;
        credit: string;
      }[];
      totalDebit: string;
      totalCredit: string;
      balanced: boolean;
    };
    expect(preview.balanced).toBe(true);
    expect(preview.totalDebit).toBe(preview.totalCredit);
    const ar = preview.lines.find((l) => l.accountId === acc['1-1200'])!;
    expect(ar.debit).toBe('1110000.0000');
    expect(ar.credit).toBe('0.0000');
    expect(ar.accountCode).toBe('1-1200');
    expect(ar.accountName.length).toBeGreaterThan(0);

    const calc = (
      await request(server())
        .post('/v1/tax/calculate')
        .set('Authorization', `Bearer ${acct}`)
        .send(saleBody())
        .expect(200)
    ).body as {
      journalLines: { accountId: string; debit?: string; credit?: string }[];
    };
    // Same accounts + amounts as the tax engine's journalLines (the post derivation).
    for (const jl of calc.journalLines) {
      const pl = preview.lines.find((l) => l.accountId === jl.accountId)!;
      expect(pl.debit).toBe(norm(jl.debit ?? '0'));
      expect(pl.credit).toBe(norm(jl.credit ?? '0'));
    }
  });

  describe('settlementAccountId is accepted but ignored (control resolved by role)', () => {
    type Preview = { lines: { accountId: string; debit: string }[] };
    const previewWith = async (body: object) =>
      (
        await request(server())
          .post('/v1/journal-entries/preview')
          .set('Authorization', `Bearer ${acct}`)
          .send(body)
          .expect(200)
      ).body as Preview;

    it('SALE: a client-supplied non-control account is ignored; AR control is used', async () => {
      const p = await previewWith({
        ...saleBody(),
        settlementAccountId: acc['1-1000'], // Kas — not AR control
      });
      expect(
        p.lines.find((l) => l.accountId === acc['1-1000']),
      ).toBeUndefined();
      const ar = p.lines.find((l) => l.accountId === acc['1-1200'])!;
      expect(ar.debit).toBe('1110000.0000');
    });

    it('SALE: settlementAccountId may be omitted', async () => {
      const { settlementAccountId: _omit, ...body } = saleBody();
      void _omit;
      const p = await previewWith(body);
      expect(p.lines.some((l) => l.accountId === acc['1-1200'])).toBe(true);
    });

    it('PURCHASE: resolves AP control by role regardless of the client value', async () => {
      const ap = (await prisma.client.account.findFirst({
        where: { role: 'AP_CONTROL' },
      }))!;
      const p = await previewWith({
        nature: 'PURCHASE',
        settlementAccountId: acc['1-1200'], // AR control — wrong side
        lines: [{ accountId: acc['5-2000'], amount: '500000', taxCodeIds: [] }],
      });
      expect(
        p.lines.find((l) => l.accountId === acc['1-1200']),
      ).toBeUndefined();
      expect(p.lines.some((l) => l.accountId === ap.id)).toBe(true);
    });
  });

  it("preview can't lie: matches a real posted invoice's GL exactly", async () => {
    const draft = await request(server())
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        partnerId: customerId,
        date: '2026-02-10',
        description: 'Preview parity',
        lines: [
          {
            description: 'Jasa',
            accountId: acc['4-1000'],
            quantity: '1',
            unitPrice: '1000000',
            taxCodeIds: [code['PPN-OUT-11']],
          },
        ],
      })
      .expect(201);
    const id = (draft.body as { id: string }).id;
    const posted = await request(server())
      .post(`/v1/sales-invoices/${id}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    const journalEntryId = (posted.body as { journalEntryId: string })
      .journalEntryId;
    const jeLines = await prisma.client.journalLine.findMany({
      where: { journalEntryId },
      orderBy: { lineNo: 'asc' },
    });

    const preview = (
      await request(server())
        .post('/v1/journal-entries/preview')
        .set('Authorization', `Bearer ${acct}`)
        .send(saleBody())
        .expect(200)
    ).body as { lines: { accountId: string; debit: string; credit: string }[] };

    // Every posted GL line has a matching preview line with identical debit/credit.
    for (const jl of jeLines) {
      const pl = preview.lines.find((l) => l.accountId === jl.accountId)!;
      expect(pl).toBeDefined();
      expect(pl.debit).toBe(norm(jl.debit));
      expect(pl.credit).toBe(norm(jl.credit));
    }
    expect(preview.lines.length).toBe(jeLines.length);
  });

  it('does not write any journal entry (read-only) and needs no Idempotency-Key', async () => {
    const before = await prisma.client.journalEntry.count();
    await request(server())
      .post('/v1/journal-entries/preview')
      .set('Authorization', `Bearer ${acct}`)
      .send(saleBody())
      .expect(200); // no Idempotency-Key header set → still 200, not 422
    const after = await prisma.client.journalEntry.count();
    expect(after).toBe(before);
  });

  it('rejects a non-postable (header) account with 422', async () => {
    const header = await prisma.client.account.findFirst({
      where: { isPostable: false },
    });
    expect(header).not.toBeNull();
    await request(server())
      .post('/v1/journal-entries/preview')
      .set('Authorization', `Bearer ${acct}`)
      .send({
        nature: 'SALE',
        settlementAccountId: acc['1-1200'],
        lines: [{ accountId: header!.id, amount: '1000000', taxCodeIds: [] }],
      })
      .expect(422);
  });

  it('iter6: a free (zero-amount) SALE line on an INACTIVE account → 422 INVALID_ACCOUNT, same as the draft/post', async () => {
    const revenue = await prisma.client.account.findUniqueOrThrow({
      where: { id: acc['4-1000'] },
    });
    const inactive = await app.get(AccountsService).create({
      code: '4-9901',
      name: 'Pendapatan nonaktif',
      type: revenue.type,
      subtype: revenue.subtype,
      normalBalance: revenue.normalBalance,
    });
    await prisma.client.account.update({
      where: { id: inactive.id },
      data: { isActive: false },
    });
    const res = await request(server())
      .post('/v1/journal-entries/preview')
      .set('Authorization', `Bearer ${acct}`)
      .send({
        nature: 'SALE',
        lines: [
          { accountId: acc['4-1000'], amount: '1000000', taxCodeIds: [] },
          { accountId: inactive.id, amount: '0', taxCodeIds: [] },
        ],
      });
    expect(res.status).toBe(422);
    expect((res.body as { code: string }).code).toBe('INVALID_ACCOUNT');
    // The draft create rejects the same body with the same error.
    const draft = await request(server())
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        partnerId: customerId,
        date: '2026-03-10',
        lines: [
          {
            description: 'Jasa',
            accountId: acc['4-1000'],
            quantity: '1',
            unitPrice: '1000000',
            taxCodeIds: [],
          },
          {
            description: 'Gratis',
            accountId: inactive.id,
            quantity: '1',
            unitPrice: '0',
            taxCodeIds: [],
          },
        ],
      });
    expect(draft.status).toBe(422);
    expect((draft.body as { code: string }).code).toBe('INVALID_ACCOUNT');
  });

  it('rejects an unknown tax code with 422', async () => {
    await request(server())
      .post('/v1/journal-entries/preview')
      .set('Authorization', `Bearer ${acct}`)
      .send({
        nature: 'SALE',
        settlementAccountId: acc['1-1200'],
        lines: [
          {
            accountId: acc['4-1000'],
            amount: '1000000',
            taxCodeIds: [randomUUID()],
          },
        ],
      })
      .expect(422);
  });

  it("PAYMENT preview can't lie: matches a real posted receipt's GL exactly", async () => {
    // A posted invoice to allocate against.
    const inv = await request(server())
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        partnerId: customerId,
        date: '2026-02-10',
        description: 'For payment',
        lines: [
          {
            description: 'Jasa',
            accountId: acc['4-1000'],
            quantity: '1',
            unitPrice: '1000000',
            taxCodeIds: [],
          },
        ],
      })
      .expect(201);
    const invId = (inv.body as { id: string }).id;
    await request(server())
      .post(`/v1/sales-invoices/${invId}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);

    const paymentBody = {
      nature: 'PAYMENT',
      direction: 'RECEIPT',
      cashAccountId: acc['1-1000'],
      allocations: [{ salesInvoiceId: invId, amount: '400000' }],
    };

    // Post a real payment with the same cash account + allocation total.
    const pay = await request(server())
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: customerId,
        date: '2026-02-15',
        cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: invId, amount: '400000' }],
      })
      .expect(201);
    const payId = (pay.body as { id: string }).id;
    const postedPay = await request(server())
      .post(`/v1/payments/${payId}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    const journalEntryId = (postedPay.body as { journalEntryId: string })
      .journalEntryId;
    const jeLines = await prisma.client.journalLine.findMany({
      where: { journalEntryId },
      orderBy: { lineNo: 'asc' },
    });

    const preview = (
      await request(server())
        .post('/v1/journal-entries/preview')
        .set('Authorization', `Bearer ${acct}`)
        .send(paymentBody)
        .expect(200)
    ).body as {
      lines: { accountId: string; debit: string; credit: string }[];
      balanced: boolean;
    };

    expect(preview.balanced).toBe(true);
    expect(preview.lines.length).toBe(jeLines.length); // exactly 2 lines
    for (const jl of jeLines) {
      const pl = preview.lines.find((l) => l.accountId === jl.accountId)!;
      expect(pl).toBeDefined();
      expect(pl.debit).toBe(norm(jl.debit));
      expect(pl.credit).toBe(norm(jl.credit));
    }
    // RECEIPT: cash (1-1000) debited, AR control (1-1200) credited.
    expect(
      preview.lines.find((l) => l.accountId === acc['1-1000'])!.debit,
    ).toBe('400000.0000');
    expect(
      preview.lines.find((l) => l.accountId === acc['1-1200'])!.credit,
    ).toBe('400000.0000');
  });

  it('rejects a RECEIPT allocation that references a purchase bill (422)', async () => {
    await request(server())
      .post('/v1/journal-entries/preview')
      .set('Authorization', `Bearer ${acct}`)
      .send({
        nature: 'PAYMENT',
        direction: 'RECEIPT',
        cashAccountId: acc['1-1000'],
        allocations: [{ purchaseBillId: randomUUID(), amount: '100000' }],
      })
      .expect(422);
  });
  // Iteration-5: fields that belong to the OTHER nature are rejected (400) —
  // they used to skip every validator and be stored in the append-only
  // audit_log; and read-only POSTs always use the 8 KiB audit tier.
  describe('iter5: foreign-nature fields + read-only audit tier', () => {
    const AUDIT_SMALL = 8192;
    const auditRow = async (clientRequestId: string) => {
      for (let i = 0; i < 100; i++) {
        const row = await prisma.client.auditLog.findFirst({
          where: { clientRequestId },
        });
        if (row) return row;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`no audit row for ${clientRequestId}`);
    };
    const preview = (token: string, body: object, requestId?: string) => {
      const req = request(server())
        .post('/v1/journal-entries/preview')
        .set('Authorization', `Bearer ${token}`);
      if (requestId) req.set('X-Request-Id', requestId);
      return req.send(body);
    };
    const paymentBody = () => ({
      nature: 'PAYMENT',
      direction: 'RECEIPT',
      cashAccountId: acc['1-1000'],
      allocations: [{ salesInvoiceId: randomUUID(), amount: '100000' }],
    });

    it('a VIEWER SALE preview carrying 2,800 junk allocations is a 400 whose audit row stays <= 8 KiB', async () => {
      const allocations = Array.from({ length: 2800 }, () => ({
        salesInvoiceId: randomUUID(),
        amount: '1000000.0000',
        memo: 'j'.repeat(100),
      }));
      await preview(
        viewer,
        { ...saleBody(), allocations },
        'jp-iter5-junk-allocations',
      ).expect(400);
      const row = await auditRow('jp-iter5-junk-allocations');
      expect(row.statusCode).toBe(400);
      expect(Buffer.byteLength(JSON.stringify(row.body))).toBeLessThanOrEqual(
        AUDIT_SMALL,
      );
    });

    it.each([
      ['direction', { direction: 'RECEIPT' }],
      ['cashAccountId', { cashAccountId: randomUUID() }],
      ['allocations', { allocations: [] }],
      ['allocations (null)', { allocations: null }],
    ])('SALE/PURCHASE with PAYMENT field %s → 400', async (_name, extra) => {
      await preview(acct, { ...saleBody(), ...extra }).expect(400);
      await preview(acct, {
        nature: 'PURCHASE',
        lines: [{ accountId: acc['5-2000'], amount: '1000', taxCodeIds: [] }],
        ...extra,
      }).expect(400);
    });

    it.each([
      ['lines', () => ({ lines: saleBody().lines })],
      ['lines (empty)', () => ({ lines: [] })],
      ['settlementAccountId', () => ({ settlementAccountId: randomUUID() })],
    ])('PAYMENT with SALE/PURCHASE field %s → 400', async (_name, extra) => {
      await preview(acct, { ...paymentBody(), ...extra() }).expect(400);
    });

    it('the documented SALE / PURCHASE / PAYMENT payloads still preview (200)', async () => {
      const { settlementAccountId: _omit, ...sale } = saleBody();
      void _omit;
      await preview(acct, sale).expect(200);
      await preview(acct, {
        nature: 'PURCHASE',
        lines: [{ accountId: acc['5-2000'], amount: '1000', taxCodeIds: [] }],
      }).expect(200);
      await preview(acct, paymentBody()).expect(200);
    });

    it('a valid >8 KiB preview (200) is audited at the 8 KiB read-only tier (_truncated marker)', async () => {
      const lines = Array.from({ length: 100 }, () => ({
        accountId: acc['4-1000'],
        amount: '1000000.0000',
        taxCodeIds: [code['PPN-OUT-11']],
      }));
      const body = { nature: 'SALE', date: '2026-03-10', lines };
      expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(
        AUDIT_SMALL,
      );
      await preview(viewer, body, 'jp-iter5-big-valid').expect(200);
      const row = await auditRow('jp-iter5-big-valid');
      expect(row.statusCode).toBe(200);
      expect(row.body).toMatchObject({ _truncated: true });
      expect(Buffer.byteLength(JSON.stringify(row.body))).toBeLessThanOrEqual(
        AUDIT_SMALL,
      );
    });
  });
});
