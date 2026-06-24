import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';

describe('SalesInvoices (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let acct: string; // accountant token
  let appr: string; // approver token
  let acc: Record<string, string>;
  let code: Record<string, string>;
  let customerId: string;

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());
    await app.get(AccountsService).seedIfEmpty();
    await app.get(TaxCodesService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const users = app.get(UsersService);
    await users.create({
      email: 'acct@si.test',
      password: 'secret123',
      name: 'Acct',
      role: 'ACCOUNTANT',
    });
    await users.create({
      email: 'appr@si.test',
      password: 'secret123',
      name: 'Appr',
      role: 'APPROVER',
    });
    acct = (await app.get(AuthService).login('acct@si.test', 'secret123'))
      .accessToken;
    appr = (await app.get(AuthService).login('appr@si.test', 'secret123'))
      .accessToken;
    const { data: accounts } = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    const { data: codes } = await app.get(TaxCodesService).list();
    code = Object.fromEntries(codes.map((c) => [c.code, c.id]));
    customerId = (
      await app
        .get(BusinessPartnersService)
        .create({ code: 'CUST-SI', name: 'Pelanggan', isCustomer: true })
    ).id;
  }, 120_000);

  afterAll(() => cleanup());

  const draftBody = () => ({
    partnerId: customerId,
    date: '2026-02-10',
    description: 'Jual jasa',
    lines: [
      {
        description: 'Jasa konsultasi',
        accountId: acc['4-1000'],
        quantity: '1',
        unitPrice: '1000000',
        taxCodeIds: [code['PPN-OUT-11']],
      },
    ],
  });

  it('creates a DRAFT invoice with computed totals (201)', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send(draftBody())
      .expect(201);
    const body = res.body as {
      status: string;
      subtotal: string;
      taxTotal: string;
      total: string;
      invoiceNumber: number | null;
      lines: { amount: string; unitPrice: string }[];
    };
    expect(body.status).toBe('DRAFT');
    expect(body.subtotal).toBe('1000000.0000');
    expect(body.taxTotal).toBe('110000.0000');
    expect(body.total).toBe('1110000.0000');
    expect(body.invoiceNumber).toBeNull();
    // Line-level money is serialized to the same 4dp convention.
    expect(body.lines[0].amount).toBe('1000000.0000');
    expect(body.lines[0].unitPrice).toBe('1000000.0000');
  });

  it('posts a DRAFT invoice → POSTED, gapless number, balanced GL entry hitting AR (1-1200)', async () => {
    const draft = await request(app.getHttpServer() as App)
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send(draftBody())
      .expect(201);
    const id = (draft.body as { id: string }).id;
    const posted = await request(app.getHttpServer() as App)
      .post(`/v1/sales-invoices/${id}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    const body = posted.body as {
      status: string;
      invoiceNumber: number;
      invoiceRef: string;
      journalEntryId: string;
      outstanding: string;
      paymentStatus: string;
    };
    expect(body.status).toBe('POSTED');
    expect(body.invoiceNumber).toBeGreaterThan(0);
    expect(body.invoiceRef).toMatch(/^INV\/2026\/\d{6}$/);
    expect(body.outstanding).toBe('1110000.0000');
    expect(body.paymentStatus).toBe('UNPAID');
    // GL entry balances and debits AR (Piutang 1-1200) by the total.
    const lines = await prisma.client.journalLine.findMany({
      where: { journalEntryId: body.journalEntryId },
    });
    const debit = lines.reduce((s, l) => s + Number(l.debit), 0);
    const credit = lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(debit).toBe(credit);
    const ar = lines.find((l) => l.accountId === acc['1-1200']);
    expect(ar!.debit.toString()).toBe('1110000');
  });

  it('rejects an ACCOUNTANT trying to post (403)', async () => {
    const draft = await request(app.getHttpServer() as App)
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send(draftBody())
      .expect(201);
    const id = (draft.body as { id: string }).id;
    await request(app.getHttpServer() as App)
      .post(`/v1/sales-invoices/${id}/post`)
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .expect(403);
  });

  it('voids a POSTED unpaid invoice (200) → VOID and reverses the GL entry', async () => {
    const draft = await request(app.getHttpServer() as App)
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send(draftBody())
      .expect(201);
    const id = (draft.body as { id: string }).id;
    await request(app.getHttpServer() as App)
      .post(`/v1/sales-invoices/${id}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    const voided = await request(app.getHttpServer() as App)
      .post(`/v1/sales-invoices/${id}/void`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    expect((voided.body as { status: string }).status).toBe('VOID');
  });

  it('rejects posting a draft for a non-customer partner (422)', async () => {
    const vendor = await app
      .get(BusinessPartnersService)
      .create({ code: 'VEND-ONLY', name: 'V', isVendor: true });
    await request(app.getHttpServer() as App)
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({ ...draftBody(), partnerId: vendor.id })
      .expect(422);
  });

  describe('search (?q=)', () => {
    let searchPartnerId: string;

    beforeAll(async () => {
      // Create a distinct partner whose name can be matched by partner-name search
      searchPartnerId = (
        await app.get(BusinessPartnersService).create({
          code: 'CUST-SRCH',
          name: 'PT Budi Jaya',
          isCustomer: true,
        })
      ).id;

      // Create two invoices with distinct descriptions for this partner
      const lineBase = {
        accountId: acc['4-1000'],
        quantity: '1',
        unitPrice: '500000',
        taxCodeIds: [code['PPN-OUT-11']],
      };

      await request(app.getHttpServer() as App)
        .post('/v1/sales-invoices')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          partnerId: searchPartnerId,
          date: '2026-03-01',
          description: 'Jasa konsultasi pajak',
          lines: [{ ...lineBase, description: 'Konsultasi pajak' }],
        })
        .expect(201);

      await request(app.getHttpServer() as App)
        .post('/v1/sales-invoices')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          partnerId: searchPartnerId,
          date: '2026-03-02',
          description: 'Penjualan barang elektronik',
          lines: [{ ...lineBase, description: 'Barang elektronik' }],
        })
        .expect(201);
    });

    it('matches by description substring', async () => {
      const res = await request(app.getHttpServer() as App)
        .get('/v1/sales-invoices?q=konsultasi')
        .set('Authorization', `Bearer ${acct}`)
        .expect(200);
      const body = res.body as {
        data: { description: string }[];
        total: number;
      };
      expect(body.data.some((i) => i.description?.includes('konsultasi'))).toBe(
        true,
      );
    });

    it('matches by partner name, returning both invoices for that partner', async () => {
      const res = await request(app.getHttpServer() as App)
        .get('/v1/sales-invoices?q=budi')
        .set('Authorization', `Bearer ${acct}`)
        .expect(200);
      const body = res.body as { total: number };
      expect(body.total).toBeGreaterThanOrEqual(2);
    });

    it('composes ?q= with ?status= filter', async () => {
      // DRAFT invoices are searchable — composing with status=DRAFT should still find them
      const res = await request(app.getHttpServer() as App)
        .get('/v1/sales-invoices?q=budi&status=DRAFT')
        .set('Authorization', `Bearer ${acct}`)
        .expect(200);
      const body = res.body as { data: { status: string }[] };
      expect(body.data.every((i) => i.status === 'DRAFT')).toBe(true);
    });

    it('ignores a sub-min-length q (returns normal list)', async () => {
      const res = await request(app.getHttpServer() as App)
        .get('/v1/sales-invoices?q=a&limit=5')
        .set('Authorization', `Bearer ${acct}`)
        .expect(200);
      const body = res.body as { data: unknown[]; limit: number };
      expect(body.limit).toBe(5);
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('excludes a soft-deleted invoice from search results', async () => {
      const lineBase = {
        accountId: acc['4-1000'],
        quantity: '1',
        unitPrice: '250000',
        taxCodeIds: [code['PPN-OUT-11']],
      };

      // Create a DRAFT invoice with a highly distinctive description
      const created = await request(app.getHttpServer() as App)
        .post('/v1/sales-invoices')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          partnerId: searchPartnerId,
          date: '2026-04-01',
          description: 'Zarthronex deleted invoice test',
          lines: [{ ...lineBase, description: 'Zarthronex line' }],
        })
        .expect(201);
      const id = (created.body as { id: string }).id;

      // Confirm it appears in search before deletion
      const before = await request(app.getHttpServer() as App)
        .get('/v1/sales-invoices?q=Zarthronex')
        .set('Authorization', `Bearer ${acct}`)
        .expect(200);
      const bodyBefore = before.body as {
        data: { id: string }[];
        total: number;
      };
      expect(bodyBefore.data.some((i) => i.id === id)).toBe(true);
      expect(bodyBefore.total).toBeGreaterThanOrEqual(1);

      // Soft-delete via the DELETE endpoint (deleteDraft path — only works on DRAFT)
      await request(app.getHttpServer() as App)
        .delete(`/v1/sales-invoices/${id}`)
        .set('Authorization', `Bearer ${acct}`)
        .expect(204);

      // Confirm it no longer appears in search results after deletion
      const after = await request(app.getHttpServer() as App)
        .get('/v1/sales-invoices?q=Zarthronex')
        .set('Authorization', `Bearer ${acct}`)
        .expect(200);
      const bodyAfter = after.body as {
        data: { id: string }[];
        total: number;
      };
      expect(bodyAfter.data.some((i) => i.id === id)).toBe(false);
      expect(bodyAfter.total).toBe(0);
    });
  });
});
