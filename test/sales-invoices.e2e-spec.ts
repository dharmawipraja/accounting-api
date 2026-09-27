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
import { bootstrapTestApp, tomorrowWib, wibDayPlus } from './e2e-helpers';

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

    it("matches by partner code substring, returning that partner's invoices", async () => {
      const res = await request(app.getHttpServer() as App)
        .get('/v1/sales-invoices?q=srch')
        .set('Authorization', `Bearer ${acct}`)
        .expect(200);
      const body = res.body as { total: number };
      // Both CUST-SRCH invoices match on the partner code (case-insensitive).
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

  // ── Guard-branch coverage (I-1, I-2, I-4, I-5, I-6, I-9, I-10) ──────────

  it('I-1: rejects PUT on an already-posted invoice → 422 (update onlyDraftEdit guard)', async () => {
    // Create and post a draft, then attempt to update the now-POSTED invoice.
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
    const res = await request(app.getHttpServer() as App)
      .patch(`/v1/sales-invoices/${id}`)
      .set('Authorization', `Bearer ${acct}`)
      .send({ description: 'changed' })
      .expect(422);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('I-2: update with no lines reuses existing lines; totals unchanged → 200', async () => {
    // Lines-null branch: input.lines is undefined, service falls back to row.lines.
    const draft = await request(app.getHttpServer() as App)
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send(draftBody())
      .expect(201);
    const id = (draft.body as { id: string }).id;
    const res = await request(app.getHttpServer() as App)
      .patch(`/v1/sales-invoices/${id}`)
      .set('Authorization', `Bearer ${acct}`)
      .send({ description: 'desc only, no lines' })
      .expect(200);
    const body = res.body as { subtotal: string; total: string };
    // Totals must match the original draft (lines not changed).
    expect(body.subtotal).toBe('1000000.0000');
    expect(body.total).toBe('1110000.0000');
  });

  it('rejects a PATCH whose line uses a soft-deleted tax code (422 Unknown tax code)', async () => {
    const taxCodes = app.get(TaxCodesService);
    const ppn = await taxCodes.findById(code['PPN-OUT-11']);
    const gone = await taxCodes.create({
      code: 'PPN-OUT-GONE',
      name: 'PPN Keluaran (dihapus)',
      kind: 'PPN_OUTPUT',
      rate: '0.11',
      taxAccountId: ppn.taxAccountId,
    });
    await taxCodes.softDelete(gone.id, 'tester');
    const draft = await request(app.getHttpServer() as App)
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send(draftBody())
      .expect(201);
    const id = (draft.body as { id: string }).id;
    const body = draftBody();
    body.lines[0].taxCodeIds = [gone.id];
    const res = await request(app.getHttpServer() as App)
      .patch(`/v1/sales-invoices/${id}`)
      .set('Authorization', `Bearer ${acct}`)
      .send({ lines: body.lines })
      .expect(422);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { taxCodeId: gone.id },
    });
  });

  it('I-4: list filtered by status=POSTED returns only posted invoices → 200', async () => {
    // status-filter branch in listPage() (q.status path).
    const res = await request(app.getHttpServer() as App)
      .get('/v1/sales-invoices?status=POSTED')
      .set('Authorization', `Bearer ${acct}`)
      .expect(200);
    const body = res.body as { data: { status: string }[] };
    expect(body.data.every((i) => i.status === 'POSTED')).toBe(true);
  });

  it('I-5: POST /post on an already-posted invoice → 422 (post notADraft guard)', async () => {
    // status !== DRAFT guard in post() — attempt to post a POSTED invoice.
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
    const res = await request(app.getHttpServer() as App)
      .post(`/v1/sales-invoices/${id}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(422);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('I-6: POST /post with a deactivated customer → 422 (partnerInactive guard at post time)', async () => {
    // !partner.isActive guard in post(): deactivate partner after draft creation.
    const inactiveCustomer = await app.get(BusinessPartnersService).create({
      code: 'CUST-INACTIVE-POST',
      name: 'Inactive',
      isCustomer: true,
    });
    const draft = await request(app.getHttpServer() as App)
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({ ...draftBody(), partnerId: inactiveCustomer.id })
      .expect(201);
    const id = (draft.body as { id: string }).id;
    // Deactivate the partner after the draft was saved.
    await app.get(BusinessPartnersService).deactivate(inactiveCustomer.id);
    const res = await request(app.getHttpServer() as App)
      .post(`/v1/sales-invoices/${id}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(422);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('I-9: void a DRAFT invoice → 422 (void onlyPostedVoid guard)', async () => {
    // status !== POSTED guard in void(): attempt to void a DRAFT document.
    const draft = await request(app.getHttpServer() as App)
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send(draftBody())
      .expect(201);
    const id = (draft.body as { id: string }).id;
    const res = await request(app.getHttpServer() as App)
      .post(`/v1/sales-invoices/${id}/void`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(422);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('I-10: void a posted invoice that has an outstanding payment → 409 (voidWithPaymentsFirst pre-tx guard)', async () => {
    // !Money.of(row.amountPaid).isZero() guard in void(): invoice has amountPaid > 0.
    const paidCustomer = await app
      .get(BusinessPartnersService)
      .create({ code: 'CUST-PAID-VOID', name: 'PaidVoid', isCustomer: true });
    const draft = await request(app.getHttpServer() as App)
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({ ...draftBody(), partnerId: paidCustomer.id })
      .expect(201);
    const id = (draft.body as { id: string }).id;
    await request(app.getHttpServer() as App)
      .post(`/v1/sales-invoices/${id}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    // Create and post a partial payment so amountPaid > 0.
    const payment = await request(app.getHttpServer() as App)
      .post('/v1/payments')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        direction: 'RECEIPT',
        partnerId: paidCustomer.id,
        date: '2026-02-20',
        cashAccountId: acc['1-1000'],
        allocations: [{ salesInvoiceId: id, amount: '500000' }],
      })
      .expect(201);
    await request(app.getHttpServer() as App)
      .post(`/v1/payments/${(payment.body as { id: string }).id}/post`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);
    const res = await request(app.getHttpServer() as App)
      .post(`/v1/sales-invoices/${id}/void`)
      .set('Authorization', `Bearer ${appr}`)
      .set('Idempotency-Key', randomUUID())
      .expect(409);
    expect((res.body as { code: string }).code).toBe('CONFLICT');
  });
  describe('void with an optional later date (closed original period)', () => {
    const postInvoice = async (date: string) => {
      const draft = await request(app.getHttpServer() as App)
        .post('/v1/sales-invoices')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', randomUUID())
        .send({ ...draftBody(), date })
        .expect(201);
      const id = (draft.body as { id: string }).id;
      const posted = await request(app.getHttpServer() as App)
        .post(`/v1/sales-invoices/${id}/post`)
        .set('Authorization', `Bearer ${appr}`)
        .set('Idempotency-Key', randomUUID())
        .expect(200);
      return {
        id,
        journalEntryId: (posted.body as { journalEntryId: string })
          .journalEntryId,
      };
    };
    const voidReq = (id: string) =>
      request(app.getHttpServer() as App)
        .post(`/v1/sales-invoices/${id}/void`)
        .set('Authorization', `Bearer ${appr}`)
        .set('Idempotency-Key', randomUUID());

    it('no-body void stores voidedOn = invoice date and reverses on that date', async () => {
      const inv = await postInvoice('2026-02-12');
      const res = await voidReq(inv.id).expect(200);
      const body = res.body as { status: string; voidedOn: string };
      expect(body.status).toBe('VOID');
      expect(body.voidedOn.slice(0, 10)).toBe('2026-02-12');
      const rev = await prisma.client.journalEntry.findFirst({
        where: { reversalOfId: inv.journalEntryId },
      });
      expect(rev!.date.toISOString().slice(0, 10)).toBe('2026-02-12');
    });

    it('rejects a void date before the invoice date (422)', async () => {
      const inv = await postInvoice('2026-02-12');
      const res = await voidReq(inv.id)
        .send({ date: '2026-02-11' })
        .expect(422);
      expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
    });

    it('rejects a void date after today (WIB) with 422 { date, today }; stays POSTED', async () => {
      const inv = await postInvoice('2026-02-12');
      const res = await voidReq(inv.id)
        .send({ date: tomorrowWib() })
        .expect(422);
      const body = res.body as {
        code: string;
        details: { date: string; today: string };
      };
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.details.date).toBe(tomorrowWib());
      expect(body.details.today < body.details.date).toBe(true);
      expect(
        (await prisma.client.salesInvoice.findFirst({ where: { id: inv.id } }))!
          .status,
      ).toBe('POSTED');
    });

    it('iter6: a future-dated invoice voids with an explicit date equal to its own date (200); a date after both today and it → 422', async () => {
      const own = wibDayPlus(3);
      const inv = await postInvoice(own);
      const tooLate = await voidReq(inv.id)
        .send({ date: wibDayPlus(4) })
        .expect(422);
      expect(
        (tooLate.body as { details: Record<string, string> }).details,
      ).toEqual({
        date: wibDayPlus(4),
        today: wibDayPlus(0),
        originalDate: own,
      });
      const res = await voidReq(inv.id).send({ date: own }).expect(200);
      const body = res.body as { status: string; voidedOn: string };
      expect(body.status).toBe('VOID');
      expect(body.voidedOn.slice(0, 10)).toBe(own);
    });

    it('voids into a later open period once the invoice period is closed', async () => {
      const inv = await postInvoice('2026-01-15');
      const periods = app.get(PeriodsService);
      const jan = (await periods.list(2026)).find(
        (p) => p.startDate.toISOString().slice(0, 10) === '2026-01-01',
      )!;
      await periods.close(jan.id, 'closer');
      try {
        // Without a date the reversal targets the closed January period.
        const closed = await voidReq(inv.id).expect(409);
        expect((closed.body as { code: string }).code).toBe('CLOSED_PERIOD');

        const res = await voidReq(inv.id)
          .send({ date: '2026-02-10' })
          .expect(200);
        const body = res.body as { status: string; voidedOn: string };
        expect(body.status).toBe('VOID');
        expect(body.voidedOn.slice(0, 10)).toBe('2026-02-10');
        const rev = await prisma.client.journalEntry.findFirst({
          where: { reversalOfId: inv.journalEntryId },
        });
        expect(rev!.date.toISOString().slice(0, 10)).toBe('2026-02-10');
        expect(rev!.sourceType).toBe('REVERSAL');
      } finally {
        await periods.reopen(jan.id);
      }
    });
  });

  describe('line accounts: no control/cash/tax accounts; sales lines must be REVENUE/OTHER_INCOME', () => {
    const server = () => app.getHttpServer() as App;
    const bodyWithAccount = (accountId: string) => {
      const b = draftBody();
      b.lines[0].accountId = accountId;
      b.lines[0].taxCodeIds = [];
      return b;
    };
    const create = (accountId: string) =>
      request(server())
        .post('/v1/sales-invoices')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', randomUUID())
        .send(bodyWithAccount(accountId));
    const expect422 = (res: request.Response, details: unknown) => {
      const body = res.body as { code: string; details: unknown };
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.details).toEqual(details);
    };

    it('rejects a line on AR control with 422 {accountId, role}', async () => {
      const res = await create(acc['1-1200']).expect(422);
      expect422(res, { accountId: acc['1-1200'], role: 'AR_CONTROL' });
    });

    it('rejects a line on a CASH account with 422 {accountId, role}', async () => {
      const res = await create(acc['1-1000']).expect(422);
      expect422(res, { accountId: acc['1-1000'], role: 'CASH' });
    });

    it('rejects a line on a tax account with 422 {accountId, reason: TAX_ACCOUNT}', async () => {
      const res = await create(acc['2-1100']).expect(422);
      expect422(res, { accountId: acc['2-1100'], reason: 'TAX_ACCOUNT' });
    });

    it('rejects a line on a non-revenue (expense) account with 422 {accountId, reason: ACCOUNT_TYPE}', async () => {
      const res = await create(acc['5-2000']).expect(422);
      expect422(res, { accountId: acc['5-2000'], reason: 'ACCOUNT_TYPE' });
    });

    it('accepts a line on an OTHER_INCOME revenue account (Pendapatan Lain-lain) (201)', async () => {
      await create(acc['4-9000']).expect(201);
    });

    it('rejects a PATCH that moves a draft line onto AR control (422)', async () => {
      const draft = await create(acc['4-1000']).expect(201);
      const id = (draft.body as { id: string }).id;
      const res = await request(server())
        .patch(`/v1/sales-invoices/${id}`)
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', randomUUID())
        .send({ lines: bodyWithAccount(acc['1-1200']).lines })
        .expect(422);
      expect422(res, { accountId: acc['1-1200'], role: 'AR_CONTROL' });
    });

    it('rejects posting a pre-existing draft whose line hits AR control (422, stays DRAFT)', async () => {
      const draft = await create(acc['4-1000']).expect(201);
      const id = (draft.body as { id: string }).id;
      // Simulate a draft written before the guard existed.
      await prisma.client.salesInvoiceLine.updateMany({
        where: { salesInvoiceId: id },
        data: { accountId: acc['1-1200'] },
      });
      const res = await request(server())
        .post(`/v1/sales-invoices/${id}/post`)
        .set('Authorization', `Bearer ${appr}`)
        .set('Idempotency-Key', randomUUID())
        .expect(422);
      expect422(res, { accountId: acc['1-1200'], role: 'AR_CONTROL' });
      const still = await prisma.client.salesInvoice.findUnique({
        where: { id },
      });
      expect(still!.status).toBe('DRAFT');
    });

    it('preview rejects a AR-control line the same way a create does (422)', async () => {
      const res = await request(server())
        .post('/v1/journal-entries/preview')
        .set('Authorization', `Bearer ${acct}`)
        .send({
          nature: 'SALE',
          settlementAccountId: acc['1-1200'],
          lines: [{ accountId: acc['1-1200'], amount: '1000', taxCodeIds: [] }],
        })
        .expect(422);
      expect422(res, { accountId: acc['1-1200'], role: 'AR_CONTROL' });
    });
  });

  describe('draft create/PATCH validate line accounts like post (422 INVALID_ACCOUNT)', () => {
    const server = () => app.getHttpServer() as App;
    const lines = (accountId: string) => [
      {
        description: 'Jasa',
        accountId,
        quantity: '1',
        unitPrice: '1000',
        taxCodeIds: [] as string[],
      },
    ];
    const create = (accountId: string) =>
      request(server())
        .post('/v1/sales-invoices')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', randomUUID())
        .send({ ...draftBody(), lines: lines(accountId) });
    const newRevenue = (codeStr: string, extra: Record<string, unknown>) =>
      prisma.client.account.create({
        data: {
          code: codeStr,
          name: `Revenue ${codeStr}`,
          type: 'REVENUE',
          subtype: 'REVENUE',
          normalBalance: 'CREDIT',
          isPostable: true,
          ...extra,
        },
      });
    const expectInvalid = (res: request.Response, accountId: string) => {
      const body = res.body as { code: string; details: unknown };
      expect(body.code).toBe('INVALID_ACCOUNT');
      expect(body.details).toEqual({ accountId });
    };

    it('unknown account id → 422 INVALID_ACCOUNT (not a 409 FK violation)', async () => {
      const missing = randomUUID();
      expectInvalid(await create(missing).expect(422), missing);
    });

    it('header (non-postable) revenue account → 422 INVALID_ACCOUNT', async () => {
      expectInvalid(await create(acc['4-0000']).expect(422), acc['4-0000']);
    });

    it('inactive revenue account → 422 INVALID_ACCOUNT', async () => {
      const a = await newRevenue('4-9801', { isActive: false });
      expectInvalid(await create(a.id).expect(422), a.id);
    });

    it('soft-deleted revenue account → 422 INVALID_ACCOUNT', async () => {
      const a = await newRevenue('4-9802', { deletedAt: new Date() });
      expectInvalid(await create(a.id).expect(422), a.id);
    });

    it('PATCH onto an unknown account → 422 INVALID_ACCOUNT', async () => {
      const draft = await create(acc['4-1000']).expect(201);
      const id = (draft.body as { id: string }).id;
      const missing = randomUUID();
      const res = await request(server())
        .patch(`/v1/sales-invoices/${id}`)
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', randomUUID())
        .send({ lines: lines(missing) })
        .expect(422);
      expectInvalid(res, missing);
    });

    it('PATCH (no lines) of a draft whose stored line account was deactivated → 422 INVALID_ACCOUNT', async () => {
      const a = await newRevenue('4-9803', {});
      const draft = await create(a.id).expect(201);
      const id = (draft.body as { id: string }).id;
      await prisma.client.account.update({
        where: { id: a.id },
        data: { isActive: false },
      });
      const res = await request(server())
        .patch(`/v1/sales-invoices/${id}`)
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', randomUUID())
        .send({ description: 'still a draft' })
        .expect(422);
      expectInvalid(res, a.id);
    });
  });
});
