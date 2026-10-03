import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { SalesInvoicesService } from '../src/invoicing/sales-invoices.service';
import { bootstrapTestApp, tomorrowWib, wibDayPlus } from './e2e-helpers';

describe('JournalEntries (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let accountantToken: string;
  let approverToken: string;
  let adminToken: string;
  let kasId: string;
  let modalId: string;
  let saldoAwalId: string;

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());

    // Seed data
    await app.get(CompanyService).seedIfEmpty();
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);

    // Resolve account IDs
    const { data: accounts } = await app.get(AccountsService).list();
    kasId = accounts.find((a) => a.code === '1-1000')!.id;
    modalId = accounts.find((a) => a.code === '3-1000')!.id;
    saldoAwalId = accounts.find((a) => a.code === '3-9000')!.id;

    // Create users
    const users = app.get(UsersService);
    await users.create({
      email: 'accountant@journal.test',
      password: 'secret123',
      name: 'Accountant',
      role: 'ACCOUNTANT',
    });
    await users.create({
      email: 'approver@journal.test',
      password: 'secret123',
      name: 'Approver',
      role: 'APPROVER',
    });
    await users.create({
      email: 'admin@journal.test',
      password: 'secret123',
      name: 'Admin',
      role: 'ADMIN',
    });

    // Get tokens
    const auth = app.get(AuthService);
    accountantToken = (await auth.login('accountant@journal.test', 'secret123'))
      .accessToken;
    approverToken = (await auth.login('approver@journal.test', 'secret123'))
      .accessToken;
    adminToken = (await auth.login('admin@journal.test', 'secret123'))
      .accessToken;
  }, 120_000);

  afterAll(() => cleanup());

  /** One live OPENING entry at a time: reverse the current one (if any) so
   *  a test can post a fresh opening. */
  const reverseLiveOpening = async () => {
    const live = await prisma.client.journalEntry.findFirst({
      where: { sourceType: 'OPENING', status: 'POSTED' },
    });
    if (live) await app.get(PostingService).reverse(live.id, 'admin');
  };

  const balancedBody = (date = '2026-02-10') => ({
    date,
    description: 'Owner injects capital',
    lines: [
      { accountId: kasId, debit: '1000000' },
      { accountId: modalId, credit: '1000000' },
    ],
  });

  it('rejects a journal entry with more than 100 lines (400)', async () => {
    const body = balancedBody();
    body.lines = [
      ...Array.from({ length: 51 }, () => ({
        accountId: kasId,
        debit: '1000',
      })),
      ...Array.from({ length: 51 }, () => ({
        accountId: modalId,
        credit: '1000',
      })),
    ] as typeof body.lines;
    await request(app.getHttpServer() as App)
      .post('/v1/ledger/journal-entries')
      .set('Authorization', `Bearer ${accountantToken}`)
      .set('Idempotency-Key', randomUUID())
      .send(body)
      .expect(400);
  });

  it('rejects opening balances with more than 100 rows (400)', async () => {
    await request(app.getHttpServer() as App)
      .post('/v1/ledger/opening-balances')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        date: '2026-01-01',
        balances: Array.from({ length: 101 }, () => ({
          accountId: kasId,
          debit: '1000',
        })),
      })
      .expect(400);
  });

  it('ACCOUNTANT creates a DRAFT journal entry (201, status=DRAFT, entryNumber=null)', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/v1/ledger/journal-entries')
      .set('Authorization', `Bearer ${accountantToken}`)
      .set('Idempotency-Key', randomUUID())
      .send(balancedBody())
      .expect(201);

    const body = res.body as {
      id: string;
      status: string;
      entryNumber: number | null;
      description: string;
    };
    expect(body.status).toBe('DRAFT');
    expect(body.entryNumber).toBeNull();
    expect(body.id).toBeDefined();
    expect(body.description).toBe('Owner injects capital');
  });

  it('APPROVER posts a DRAFT in-place (200, same id, status=POSTED, entryNumber>0)', async () => {
    // ACCOUNTANT creates draft
    const draftRes = await request(app.getHttpServer() as App)
      .post('/v1/ledger/journal-entries')
      .set('Authorization', `Bearer ${accountantToken}`)
      .set('Idempotency-Key', randomUUID())
      .send(balancedBody())
      .expect(201);
    const draftId = (draftRes.body as { id: string }).id;

    // APPROVER posts it
    const postRes = await request(app.getHttpServer() as App)
      .post(`/v1/ledger/journal-entries/${draftId}/post`)
      .set('Authorization', `Bearer ${approverToken}`)
      .set('Idempotency-Key', randomUUID())
      .expect(200);

    const posted = postRes.body as {
      id: string;
      status: string;
      entryNumber: number;
      entryRef: string;
    };
    expect(posted.id).toBe(draftId);
    expect(posted.status).toBe('POSTED');
    expect(posted.entryNumber).toBeGreaterThan(0);
    expect(posted.entryRef).toMatch(/^JE\/2026\/\d{6}$/);
  });

  it('ACCOUNTANT POST /:id/post is rejected with 403 (role guard)', async () => {
    // ACCOUNTANT creates draft
    const draftRes = await request(app.getHttpServer() as App)
      .post('/v1/ledger/journal-entries')
      .set('Authorization', `Bearer ${accountantToken}`)
      .set('Idempotency-Key', randomUUID())
      .send(balancedBody())
      .expect(201);
    const draftId = (draftRes.body as { id: string }).id;

    // ACCOUNTANT tries to post — should be 403
    await request(app.getHttpServer() as App)
      .post(`/v1/ledger/journal-entries/${draftId}/post`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .set('Idempotency-Key', randomUUID())
      .expect(403);
  });

  it('ACCOUNTANT soft-deletes a DRAFT (204) then GET returns 404', async () => {
    // ACCOUNTANT creates draft
    const draftRes = await request(app.getHttpServer() as App)
      .post('/v1/ledger/journal-entries')
      .set('Authorization', `Bearer ${accountantToken}`)
      .set('Idempotency-Key', randomUUID())
      .send(balancedBody())
      .expect(201);
    const draftId = (draftRes.body as { id: string }).id;

    // Delete it
    await request(app.getHttpServer() as App)
      .delete(`/v1/ledger/journal-entries/${draftId}`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(204);

    // GET should 404
    await request(app.getHttpServer() as App)
      .get(`/v1/ledger/journal-entries/${draftId}`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(404);
  });

  it('double-posting the same draft posts once with no number gap', async () => {
    const draftRes = await request(app.getHttpServer() as App)
      .post('/v1/ledger/journal-entries')
      .set('Authorization', `Bearer ${accountantToken}`)
      .set('Idempotency-Key', randomUUID())
      .send(balancedBody())
      .expect(201);
    const draftId = (draftRes.body as { id: string }).id;

    const seqBefore = await prisma.client.journalSequence.findUnique({
      where: { fiscalYear: 2026 },
    });
    // Distinct keys so the idempotency layer passes both through to the posting
    // layer, which must arbitrate exactly one winner (no double-post, no gap).
    const both = await Promise.allSettled([
      request(app.getHttpServer() as App)
        .post(`/v1/ledger/journal-entries/${draftId}/post`)
        .set('Authorization', `Bearer ${approverToken}`)
        .set('Idempotency-Key', randomUUID()),
      request(app.getHttpServer() as App)
        .post(`/v1/ledger/journal-entries/${draftId}/post`)
        .set('Authorization', `Bearer ${approverToken}`)
        .set('Idempotency-Key', randomUUID()),
    ]);
    const codes = both.map((r) =>
      r.status === 'fulfilled' ? r.value.status : 0,
    );
    expect(codes.filter((c) => c === 200)).toHaveLength(1); // exactly one wins
    expect(codes.some((c) => c >= 400 && c < 500)).toBe(true); // the other is a 4xx
    const seqAfter = await prisma.client.journalSequence.findUnique({
      where: { fiscalYear: 2026 },
    });
    // Exactly one sequence number consumed — the loser burned none (no gap).
    expect(seqAfter!.nextNumber - seqBefore!.nextNumber).toBe(1);
  });

  it('createAndPost (?post=true) directly posts when SoD is off (201, status=POSTED)', async () => {
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });

    const res = await request(app.getHttpServer() as App)
      .post('/v1/ledger/journal-entries?post=true')
      .set('Authorization', `Bearer ${approverToken}`)
      .set('Idempotency-Key', randomUUID())
      .send(balancedBody())
      .expect(201);

    const body = res.body as {
      id: string;
      status: string;
      entryNumber: number;
    };
    expect(body.status).toBe('POSTED');
    expect(body.entryNumber).toBeGreaterThan(0);
    expect(body.id).toBeDefined();
  });

  it('blocks an ACCOUNTANT from create-and-post (?post=true) with 403', async () => {
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    await request(app.getHttpServer() as App)
      .post('/v1/ledger/journal-entries?post=true')
      .set('Authorization', `Bearer ${accountantToken}`)
      .set('Idempotency-Key', randomUUID())
      .send(balancedBody())
      .expect(403);
  });

  it('createAndPost is idempotent: same Idempotency-Key returns the same entry', async () => {
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    const key = `idem-${randomUUID()}`;

    const first = await request(app.getHttpServer() as App)
      .post('/v1/ledger/journal-entries?post=true')
      .set('Authorization', `Bearer ${approverToken}`)
      .set('Idempotency-Key', key)
      .send(balancedBody())
      .expect(201);
    const second = await request(app.getHttpServer() as App)
      .post('/v1/ledger/journal-entries?post=true')
      .set('Authorization', `Bearer ${approverToken}`)
      .set('Idempotency-Key', key)
      .send(balancedBody())
      .expect(201);

    const firstId = (first.body as { id: string }).id;
    const secondId = (second.body as { id: string }).id;
    expect(secondId).toBe(firstId);
  });

  it('concurrent same-key createAndPost posts exactly once (no double-post)', async () => {
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    const key = `idem-concurrent-${randomUUID()}`;
    const desc = `Concurrent ${Date.now()}`;
    const payload = { ...balancedBody(), description: desc };
    const before = await prisma.client.journalEntry.count({
      where: { description: desc, status: 'POSTED' },
    });
    const both = await Promise.allSettled([
      request(app.getHttpServer() as App)
        .post('/v1/ledger/journal-entries?post=true')
        .set('Authorization', `Bearer ${approverToken}`)
        .set('Idempotency-Key', key)
        .send(payload),
      request(app.getHttpServer() as App)
        .post('/v1/ledger/journal-entries?post=true')
        .set('Authorization', `Bearer ${approverToken}`)
        .set('Idempotency-Key', key)
        .send(payload),
    ]);
    const after = await prisma.client.journalEntry.count({
      where: { description: desc, status: 'POSTED' },
    });
    expect(after - before).toBe(1); // exactly one entry — no double-post
    const codes = both.map((r) =>
      r.status === 'fulfilled' ? r.value.status : 0,
    );
    expect(codes.filter((c) => c === 201).length).toBeGreaterThanOrEqual(1);
    codes.forEach((c) => expect([201, 409]).toContain(c));
  });

  it('opening balances auto-plug credits Saldo Awal (3-9000) (200, sourceType=OPENING)', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/v1/ledger/opening-balances')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        date: '2026-01-01',
        balances: [{ accountId: kasId, debit: '5000000' }],
      })
      .expect(200);

    const body = res.body as { id: string; sourceType: string };
    expect(body.sourceType).toBe('OPENING');

    const lines = await prisma.client.journalLine.findMany({
      where: { journalEntryId: body.id },
    });
    const plug = lines.find((l) => l.accountId === saldoAwalId);
    expect(plug).toBeDefined();
    expect(plug!.credit.toString()).toBe('5000000');
  });

  it.each([
    ['REVENUE', '4-1000'],
    ['EXPENSE', '5-2000'],
  ])(
    'rejects opening balances on a %s account (422 PNL_IN_OPENING) and writes nothing',
    async (_type, code) => {
      const { data: accounts } = await app.get(AccountsService).list();
      const pnlId = accounts.find((a) => a.code === code)!.id;
      const before = await prisma.client.journalEntry.count({
        where: { sourceType: 'OPENING' },
      });
      const res = await request(app.getHttpServer() as App)
        .post('/v1/ledger/opening-balances')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          date: '2026-01-05',
          balances: [
            { accountId: kasId, debit: '1000' },
            { accountId: pnlId, credit: '1000' },
          ],
        })
        .expect(422);
      expect(res.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { accountId: pnlId, reason: 'PNL_IN_OPENING' },
      });
      expect(
        await prisma.client.journalEntry.count({
          where: { sourceType: 'OPENING' },
        }),
      ).toBe(before);
    },
  );

  it('PostingService.post({sourceType: OPENING}) itself rejects a P&L account (policy, not just the endpoint)', async () => {
    const { data: accounts } = await app.get(AccountsService).list();
    const pnlId = accounts.find((a) => a.code === '4-1000')!.id;
    const before = await prisma.client.journalEntry.count({
      where: { sourceType: 'OPENING' },
    });
    await expect(
      app.get(PostingService).post(
        {
          date: new Date('2026-01-05'),
          description: 'direct opening',
          sourceType: 'OPENING',
          createdBy: 'admin',
          lines: [
            { accountId: kasId, debit: '1000' },
            { accountId: pnlId, credit: '1000' },
          ],
        },
        'admin',
      ),
    ).rejects.toMatchObject({
      details: { accountId: pnlId, reason: 'PNL_IN_OPENING' },
    });
    expect(
      await prisma.client.journalEntry.count({
        where: { sourceType: 'OPENING' },
      }),
    ).toBe(before);
  });

  it('balanced opening balances produce no equity plug line (200)', async () => {
    await reverseLiveOpening();
    // L-14: JournalService.postOpeningBalances — plug is zero, no OBE line emitted
    const res = await request(app.getHttpServer() as App)
      .post('/v1/ledger/opening-balances')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        date: '2026-01-02',
        balances: [
          { accountId: kasId, debit: '5000000' },
          { accountId: modalId, credit: '5000000' },
        ],
      })
      .expect(200);

    const body = res.body as { id: string; sourceType: string };
    expect(body.sourceType).toBe('OPENING');
    const lines = await prisma.client.journalLine.findMany({
      where: { journalEntryId: body.id },
    });
    const plug = lines.find((l) => l.accountId === saldoAwalId);
    expect(plug).toBeUndefined(); // balanced input → no OBE plug
  });
  describe('POST /:id/reverse — source guard + optional reversal date', () => {
    const postManual = async (date = '2026-03-10') => {
      await app
        .get(CompanyService)
        .update({ segregationOfDutiesEnabled: false });
      const res = await request(app.getHttpServer() as App)
        .post('/v1/ledger/journal-entries?post=true')
        .set('Authorization', `Bearer ${approverToken}`)
        .set('Idempotency-Key', randomUUID())
        .send(balancedBody(date))
        .expect(201);
      return (res.body as { id: string }).id;
    };
    const reverse = (id: string) =>
      request(app.getHttpServer() as App)
        .post(`/v1/ledger/journal-entries/${id}/reverse`)
        .set('Authorization', `Bearer ${approverToken}`)
        .set('Idempotency-Key', randomUUID());

    it('rejects reversing a document-owned (SALES_INVOICE) entry with 422', async () => {
      const entry = await app.get(PostingService).post(
        {
          date: new Date('2026-03-10'),
          description: 'Invoice-owned entry',
          sourceType: 'SALES_INVOICE',
          sourceId: randomUUID(),
          createdBy: 'creator',
          lines: [
            { accountId: kasId, debit: '1000' },
            { accountId: modalId, credit: '1000' },
          ],
        },
        'poster',
      );
      const res = await reverse(entry.id).expect(422);
      const body = res.body as {
        code: string;
        message: string;
        details: { entryId: string; sourceType: string };
      };
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.message).toBe(
        'Only MANUAL or OPENING entries can be reversed here; void the source document instead',
      );
      expect(body.details).toEqual({
        entryId: entry.id,
        sourceType: 'SALES_INVOICE',
      });
      const still = await prisma.client.journalEntry.findUnique({
        where: { id: entry.id },
      });
      expect(still!.status).toBe('POSTED');
    });

    it('reverses a MANUAL entry with no body on the original date (200)', async () => {
      const id = await postManual('2026-03-10');
      const res = await reverse(id).expect(200);
      const body = res.body as { sourceType: string; date: string };
      expect(body.sourceType).toBe('REVERSAL');
      expect(body.date.slice(0, 10)).toBe('2026-03-10');
    });

    it('reverses a MANUAL entry on a later body date (200)', async () => {
      const id = await postManual('2026-03-10');
      const res = await reverse(id).send({ date: '2026-04-05' }).expect(200);
      const body = res.body as { date: string; reversalOfId: string };
      expect(body.date.slice(0, 10)).toBe('2026-04-05');
      expect(body.reversalOfId).toBe(id);
    });

    it('rejects a reversal date before the original date (422)', async () => {
      const id = await postManual('2026-03-10');
      const res = await reverse(id).send({ date: '2026-03-09' }).expect(422);
      expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
    });

    it('rejects a reversal date after today (WIB) with 422 { date, today }', async () => {
      const id = await postManual('2026-03-10');
      const res = await reverse(id).send({ date: tomorrowWib() }).expect(422);
      const body = res.body as {
        code: string;
        details: { date: string; today: string };
      };
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.details.date).toBe(tomorrowWib());
      expect(body.details.today < body.details.date).toBe(true);
      const still = await prisma.client.journalEntry.findUnique({
        where: { id },
      });
      expect(still!.status).toBe('POSTED');
    });

    it('iter6: a future-dated MANUAL entry reverses on its own explicit date (200); a date after both today and it → 422', async () => {
      const own = wibDayPlus(3);
      const id = await postManual(own);
      const tooLate = await reverse(id)
        .send({ date: wibDayPlus(4) })
        .expect(422);
      expect(
        (tooLate.body as { details: Record<string, string> }).details,
      ).toEqual({
        date: wibDayPlus(4),
        today: wibDayPlus(0),
        originalDate: own,
      });
      const res = await reverse(id).send({ date: own }).expect(200);
      expect((res.body as { date: string }).date.slice(0, 10)).toBe(own);
    });

    it('iter7: the date ceiling is checked in prepareReversal on the re-read entry, AFTER the POSTED check (a DRAFT with a far-future date → the POSTED 422, not the ceiling)', async () => {
      const draft = await request(app.getHttpServer() as App)
        .post('/v1/ledger/journal-entries')
        .set('Authorization', `Bearer ${accountantToken}`)
        .set('Idempotency-Key', randomUUID())
        .send(balancedBody('2026-03-10'))
        .expect(201);
      const id = (draft.body as { id: string }).id;
      const res = await reverse(id).send({ date: '2099-01-01' }).expect(422);
      expect(res.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        message: 'Only a POSTED entry can be reversed',
        details: { entryId: id, status: 'DRAFT' },
      });
    });

    it('rejects a non date-only reversal date (400)', async () => {
      const id = await postManual('2026-03-10');
      await reverse(id).send({ date: '2026-04-05T10:00:00Z' }).expect(400);
    });

    it('reverses an OPENING entry via the journal endpoint (200)', async () => {
      await reverseLiveOpening();
      const ob = await request(app.getHttpServer() as App)
        .post('/v1/ledger/opening-balances')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          date: '2026-01-03',
          balances: [
            { accountId: kasId, debit: '700' },
            { accountId: modalId, credit: '700' },
          ],
        })
        .expect(200);
      await reverse((ob.body as { id: string }).id).expect(200);
    });
  });

  describe('AR/AP control accounts are document-only for MANUAL entries', () => {
    let arId: string;
    let apId: string;

    beforeAll(async () => {
      arId = (await prisma.client.account.findFirst({
        where: { role: 'AR_CONTROL' },
      }))!.id;
      apId = (await prisma.client.account.findFirst({
        where: { role: 'AP_CONTROL' },
      }))!.id;
    });

    const controlBody = (accountId: string) => ({
      date: '2026-03-12',
      description: 'Manual hit on a control account',
      lines: [
        { accountId, debit: '5000' },
        { accountId: modalId, credit: '5000' },
      ],
    });

    it('rejects a direct MANUAL post touching AR control with 422 {accountId, role}', async () => {
      await app
        .get(CompanyService)
        .update({ segregationOfDutiesEnabled: false });
      const res = await request(app.getHttpServer() as App)
        .post('/v1/ledger/journal-entries?post=true')
        .set('Authorization', `Bearer ${approverToken}`)
        .set('Idempotency-Key', randomUUID())
        .send(controlBody(arId))
        .expect(422);
      const body = res.body as { code: string; details: unknown };
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.details).toEqual({ accountId: arId, role: 'AR_CONTROL' });
    });

    it('rejects creating a MANUAL draft touching AP control with 422 {accountId, role}', async () => {
      const res = await request(app.getHttpServer() as App)
        .post('/v1/ledger/journal-entries')
        .set('Authorization', `Bearer ${accountantToken}`)
        .set('Idempotency-Key', randomUUID())
        .send(controlBody(apId))
        .expect(422);
      const body = res.body as { code: string; details: unknown };
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.details).toEqual({ accountId: apId, role: 'AP_CONTROL' });
    });

    it('rejects posting a pre-existing MANUAL draft touching AR control (422, stays DRAFT)', async () => {
      // A draft written before the guard existed (bypasses the create check).
      const draft = await prisma.client.journalEntry.create({
        data: {
          date: new Date('2026-03-12'),
          description: 'Legacy draft on AR control',
          sourceType: 'MANUAL',
          status: 'DRAFT',
          createdBy: randomUUID(),
          lines: {
            create: [
              { lineNo: 1, accountId: arId, debit: '5000', credit: '0' },
              { lineNo: 2, accountId: modalId, debit: '0', credit: '5000' },
            ],
          },
        },
      });
      const res = await request(app.getHttpServer() as App)
        .post(`/v1/ledger/journal-entries/${draft.id}/post`)
        .set('Authorization', `Bearer ${approverToken}`)
        .set('Idempotency-Key', randomUUID())
        .expect(422);
      const body = res.body as { code: string; details: unknown };
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.details).toEqual({ accountId: arId, role: 'AR_CONTROL' });
      const still = await prisma.client.journalEntry.findUnique({
        where: { id: draft.id },
      });
      expect(still!.status).toBe('DRAFT');
    });

    it('still allows OPENING balances on AR/AP control (200)', async () => {
      await reverseLiveOpening();
      const res = await request(app.getHttpServer() as App)
        .post('/v1/ledger/opening-balances')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({
          date: '2026-01-04',
          balances: [
            { accountId: arId, debit: '900' },
            { accountId: apId, credit: '400' },
          ],
        })
        .expect(200);
      expect((res.body as { sourceType: string }).sourceType).toBe('OPENING');
    });
  });
  describe('draft create validates accounts like post (422 INVALID_ACCOUNT)', () => {
    const draftBody = (accountId: string) => ({
      date: '2026-03-14',
      description: 'Draft with a bad account',
      lines: [
        { accountId, debit: '5000' },
        { accountId: modalId, credit: '5000' },
      ],
    });
    const createDraft = (accountId: string) =>
      request(app.getHttpServer() as App)
        .post('/v1/ledger/journal-entries')
        .set('Authorization', `Bearer ${accountantToken}`)
        .set('Idempotency-Key', randomUUID())
        .send(draftBody(accountId));

    it('unknown account id → 422 INVALID_ACCOUNT (not a 409 FK violation)', async () => {
      const missing = randomUUID();
      const res = await createDraft(missing).expect(422);
      const body = res.body as { code: string; details: unknown };
      expect(body.code).toBe('INVALID_ACCOUNT');
      expect(body.details).toEqual({ accountId: missing });
    });

    it('header (non-postable) account → 422 INVALID_ACCOUNT', async () => {
      const header = (await prisma.client.account.findFirst({
        where: { isPostable: false },
      }))!;
      const res = await createDraft(header.id).expect(422);
      expect((res.body as { code: string }).code).toBe('INVALID_ACCOUNT');
    });

    it('inactive account → 422 INVALID_ACCOUNT', async () => {
      const inactive = await prisma.client.account.create({
        data: {
          code: '6-9901',
          name: 'Inactive draft target',
          type: 'EXPENSE',
          subtype: 'OPERATING_EXPENSE',
          normalBalance: 'DEBIT',
          isPostable: true,
          isActive: false,
        },
      });
      const res = await createDraft(inactive.id).expect(422);
      expect((res.body as { code: string }).code).toBe('INVALID_ACCOUNT');
    });

    it('soft-deleted account → 422 INVALID_ACCOUNT', async () => {
      const gone = await prisma.client.account.create({
        data: {
          code: '6-9902',
          name: 'Deleted draft target',
          type: 'EXPENSE',
          subtype: 'OPERATING_EXPENSE',
          normalBalance: 'DEBIT',
          isPostable: true,
          deletedAt: new Date(),
        },
      });
      const res = await createDraft(gone.id).expect(422);
      expect((res.body as { code: string }).code).toBe('INVALID_ACCOUNT');
    });
  });

  describe('draft create enforces the per-line one-sided rule (422 UNBALANCED_ENTRY)', () => {
    const createDraft = (lines: Record<string, string>[]) =>
      request(app.getHttpServer() as App)
        .post('/v1/ledger/journal-entries')
        .set('Authorization', `Bearer ${accountantToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ date: '2026-03-15', description: 'one-sided rule', lines });

    it.each([
      ['both debit and credit', { debit: '100', credit: '100' }],
      ['neither side', {}],
      ['a zero debit only', { debit: '0' }],
    ])('rejects a line with %s', async (_label, sides) => {
      const res = await createDraft([
        { accountId: kasId, ...sides },
        { accountId: modalId, credit: '100' },
      ]).expect(422);
      expect((res.body as { code: string }).code).toBe('UNBALANCED_ENTRY');
    });

    it('still accepts an unbalanced (but one-sided) draft — totals are checked at post', async () => {
      const res = await createDraft([
        { accountId: kasId, debit: '100' },
        { accountId: modalId, credit: '90' },
      ]).expect(201);
      expect((res.body as { status: string }).status).toBe('DRAFT');
    });
  });

  describe('opening balances guard rails (one live entry; AR/AP only before documents)', () => {
    const postOpening = (
      balances: Record<string, string>[],
      date = '2026-01-01',
    ) =>
      request(app.getHttpServer() as App)
        .post('/v1/ledger/opening-balances')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Idempotency-Key', randomUUID())
        .send({ date, balances });
    const kasOnly = () => [{ accountId: kasId, debit: '1000' }];

    it('refuses a second opening entry while one is live (409, details.existingEntryId); reversing it re-opens the slot', async () => {
      await reverseLiveOpening();
      const first = (await postOpening(kasOnly()).expect(200)).body as {
        id: string;
        entryRef: string;
      };
      const before = await prisma.client.journalEntry.count({
        where: { sourceType: 'OPENING' },
      });
      const res = await postOpening(kasOnly()).expect(409);
      expect(res.body).toMatchObject({
        code: 'CONFLICT',
        details: { existingEntryId: first.id, entryRef: first.entryRef },
      });
      expect(
        await prisma.client.journalEntry.count({
          where: { sourceType: 'OPENING' },
        }),
      ).toBe(before);

      await request(app.getHttpServer() as App)
        .post(`/v1/ledger/journal-entries/${first.id}/reverse`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Idempotency-Key', randomUUID())
        .expect(200);
      await postOpening(kasOnly()).expect(200);
    });

    it('two concurrent opening posts: exactly one wins, the other is 409', async () => {
      await reverseLiveOpening();
      const codes = (
        await Promise.all([postOpening(kasOnly()), postOpening(kasOnly())])
      ).map((r) => r.status);
      expect(codes.sort()).toEqual([200, 409]);
      expect(
        await prisma.client.journalEntry.count({
          where: { sourceType: 'OPENING', status: 'POSTED' },
        }),
      ).toBe(1);
    });

    // Last in the spec: it creates a sales invoice, which permanently closes
    // the AR/AP opening window for this database.
    it('refuses AR/AP control lines once any document exists (422 DOCUMENTS_EXIST); other accounts still open', async () => {
      const arId = (await prisma.client.account.findFirst({
        where: { role: 'AR_CONTROL' },
      }))!.id;
      const customer = await app.get(BusinessPartnersService).create({
        code: 'CUST-OPENING-1',
        name: 'Pelanggan Opening',
        isCustomer: true,
      });
      const acct = (await prisma.client.user.findFirst({
        where: { email: 'accountant@journal.test' },
      }))!;
      const revenueId = (await prisma.client.account.findFirst({
        where: { code: '4-1000' },
      }))!.id;
      // A DRAFT is enough: "any status".
      await app.get(SalesInvoicesService).createDraft({
        partnerId: customer.id,
        date: new Date('2026-02-01'),
        dueDate: new Date('2026-03-01'),
        description: 'First document',
        lines: [
          {
            description: 'Jasa',
            accountId: revenueId,
            quantity: '1',
            unitPrice: '1000',
            taxCodeIds: [],
          },
        ],
        createdBy: acct.id,
      });

      await reverseLiveOpening();
      const res = await postOpening([{ accountId: arId, debit: '900' }]).expect(
        422,
      );
      expect(res.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: {
          accountId: arId,
          role: 'AR_CONTROL',
          reason: 'DOCUMENTS_EXIST',
        },
      });
      await postOpening(kasOnly()).expect(200);
    });
  });
});
