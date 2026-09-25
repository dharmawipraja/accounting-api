import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
import { ConflictDomainError } from '../src/common/errors/domain-errors';
import { PostingService } from '../src/ledger/posting/posting.service';
import { CompanyService } from '../src/company/company.service';
import { SalesInvoicesService } from '../src/invoicing/sales-invoices.service';

describe('Idempotency (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let acct: string;
  let acc: Record<string, string>;
  let code: Record<string, string>;
  const server = () => app.getHttpServer() as App;

  const newCustomer = async (codeStr: string): Promise<string> =>
    (
      await app
        .get(BusinessPartnersService)
        .create({ code: codeStr, name: 'PT Idem', isCustomer: true })
    ).id;

  const invoiceBody = (partnerId: string, unitPrice = '1000000') => ({
    partnerId,
    date: '2026-02-10',
    description: 'Jasa',
    lines: [
      {
        description: 'Jasa konsultasi',
        accountId: acc['4-1000'],
        quantity: '1',
        unitPrice,
        taxCodeIds: [code['PPN-OUT-11']],
      },
    ],
  });

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());
    await app.get(AccountsService).seedIfEmpty();
    await app.get(TaxCodesService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const users = app.get(UsersService);
    await users.create({
      email: 'acct@idem.test',
      password: 'secret123',
      name: 'Acct',
      role: 'ACCOUNTANT',
    });
    acct = (await app.get(AuthService).login('acct@idem.test', 'secret123'))
      .accessToken;
    acc = Object.fromEntries(
      (await app.get(AccountsService).list()).data.map((a) => [a.code, a.id]),
    );
    code = Object.fromEntries(
      (await app.get(TaxCodesService).list()).data.map((c) => [c.code, c.id]),
    );
  }, 120_000);

  afterAll(() => cleanup());

  it('replays the same key+body and creates exactly one invoice', async () => {
    const partnerId = await newCustomer('CUST-IDEM-1');
    const key = randomUUID();
    const body = invoiceBody(partnerId);
    const first = await request(server())
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const second = await request(server())
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect((second.body as { id: string }).id).toBe(
      (first.body as { id: string }).id,
    );
    const count = await prisma.client.salesInvoice.count({
      where: { partnerId },
    });
    expect(count).toBe(1);
  });

  it('scopes keys per user: a second user reusing the key gets a fresh execution', async () => {
    await app.get(UsersService).create({
      email: 'acct2@idem.test',
      password: 'secret123',
      name: 'Acct2',
      role: 'ACCOUNTANT',
    });
    const acct2 = (
      await app.get(AuthService).login('acct2@idem.test', 'secret123')
    ).accessToken;

    const partnerId = await newCustomer('CUST-IDEM-XUSER');
    const key = randomUUID();
    const body = invoiceBody(partnerId);
    const first = await request(server())
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    // Same key + identical body from a DIFFERENT user must not replay the
    // first user's cached response — keys are namespaced per user.
    const second = await request(server())
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct2}`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    expect((second.body as { id: string }).id).not.toBe(
      (first.body as { id: string }).id,
    );
    const count = await prisma.client.salesInvoice.count({
      where: { partnerId },
    });
    expect(count).toBe(2);
  });

  it('rejects the same key with a different body (422)', async () => {
    const partnerId = await newCustomer('CUST-IDEM-2');
    const key = randomUUID();
    await request(server())
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', key)
      .send(invoiceBody(partnerId, '1000000'))
      .expect(201);
    await request(server())
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', key)
      .send(invoiceBody(partnerId, '2000000'))
      .expect(422);
  });

  it('requires the header (422 when missing)', async () => {
    const partnerId = await newCustomer('CUST-IDEM-3');
    await request(server())
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .send(invoiceBody(partnerId))
      .expect(422);
  });

  it('two concurrent identical requests create exactly one invoice', async () => {
    const partnerId = await newCustomer('CUST-IDEM-RACE');
    const key = randomUUID();
    const body = invoiceBody(partnerId);
    const send = () =>
      request(server())
        .post('/v1/sales-invoices')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', key)
        .send(body);
    const results = await Promise.allSettled([send(), send()]);
    const statuses = results.map((r) =>
      r.status === 'fulfilled' ? r.value.status : 0,
    );
    // One succeeds (201). The other replays (201) or is rejected in-flight (409).
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
    const count = await prisma.client.salesInvoice.count({
      where: { partnerId },
    });
    expect(count).toBe(1);
  });

  it('SEC-2: rejects an over-long Idempotency-Key with 422', async () => {
    // Reuse the same idempotent endpoint, auth token, and body the existing
    // HTTP idempotency test in this file uses. Only the key is malformed.
    const tooLong = 'a'.repeat(129);
    const partnerId = await newCustomer('CUST-IDEM-SEC2');
    await request(app.getHttpServer() as App)
      .post('/v1/sales-invoices')
      .set('Authorization', `Bearer ${acct}`)
      .set('Idempotency-Key', tooLong)
      .send(invoiceBody(partnerId))
      .expect(422);
  });

  it('SEC-2: purgeCompleted deletes only completed keys older than the retention', async () => {
    const idem = app.get(IdempotencyService);
    const old = new Date('2000-01-01');
    // Old completed key — must be purged.
    await prisma.client.idempotencyKey.create({
      data: {
        userId: 'u-purge',
        key: 'purge-old',
        method: 'POST',
        path: '/v1/x',
        requestHash: 'h',
        response: { ok: true },
        httpStatus: 201,
        createdAt: old,
        completedAt: old,
      },
    });
    // Fresh completed key — must survive.
    await prisma.client.idempotencyKey.create({
      data: {
        userId: 'u-purge',
        key: 'purge-fresh',
        method: 'POST',
        path: '/v1/y',
        requestHash: 'h',
        response: { ok: true },
        httpStatus: 201,
        completedAt: new Date(),
      },
    });
    // In-flight key (completedAt null) — must survive (the FIN-L2 lazy-expiry owns these).
    await prisma.client.idempotencyKey.create({
      data: {
        userId: 'u-purge',
        key: 'purge-inflight',
        method: 'POST',
        path: '/v1/z',
        requestHash: 'h',
      },
    });

    const deleted = await idem.purgeCompleted(86_400_000); // 24h retention
    expect(deleted).toBe(1);
    expect(
      await prisma.client.idempotencyKey.findUnique({
        where: { userId_key: { userId: 'u-purge', key: 'purge-old' } },
      }),
    ).toBeNull();
    expect(
      await prisma.client.idempotencyKey.findUnique({
        where: { userId_key: { userId: 'u-purge', key: 'purge-fresh' } },
      }),
    ).not.toBeNull();
    expect(
      await prisma.client.idempotencyKey.findUnique({
        where: { userId_key: { userId: 'u-purge', key: 'purge-inflight' } },
      }),
    ).not.toBeNull();
  });

  // Real-Postgres tests that verify the DbNull predicate in deleteMany actually
  // matches SQL-NULL response rows (which is the true in-flight state). These
  // tests bypass the HTTP interceptor and call IdempotencyService directly so
  // they are not coupled to the interceptor's request-hash computation.
  describe('stale in-flight key reclaim — real-Postgres predicate (FIN-L2)', () => {
    let idem: IdempotencyService;

    beforeAll(() => {
      idem = app.get(IdempotencyService);
    });

    it('reclaims a stale in-flight row (SQL-NULL response) and returns replay:false', async () => {
      const key = 'reclaim-stale-' + randomUUID();
      // Insert a reservation without a response value → SQL NULL (the real in-flight state).
      await prisma.client.idempotencyKey.create({
        data: {
          userId: 'u-reclaim',
          key,
          method: 'POST',
          path: '/v1/x',
          requestHash: 'h',
        },
      });
      // Back-date createdAt beyond the 120 s TTL so the row is considered stale.
      await prisma.client.idempotencyKey.update({
        where: { userId_key: { userId: 'u-reclaim', key } },
        data: { createdAt: new Date(Date.now() - 200_000) },
      });

      // reserve() must delete the stale SQL-NULL row and re-insert → replay:false.
      // If the DbNull predicate were wrong (JsonNull), deleteMany would match 0
      // rows and this would throw ConflictDomainError (409) instead.
      await expect(
        idem.reserve('u-reclaim', key, 'POST', '/v1/x', 'h'),
      ).resolves.toEqual({
        replay: false,
      });
    });

    it('keeps a fresh in-flight row as ConflictDomainError (not reclaimed)', async () => {
      const key = 'reclaim-fresh-' + randomUUID();
      // Insert a fresh reservation (createdAt defaults to now()).
      await prisma.client.idempotencyKey.create({
        data: {
          userId: 'u-reclaim',
          key,
          method: 'POST',
          path: '/v1/y',
          requestHash: 'h',
        },
      });

      // reserve() must NOT reclaim a row that is still within the TTL window.
      await expect(
        idem.reserve('u-reclaim', key, 'POST', '/v1/y', 'h'),
      ).rejects.toBeInstanceOf(ConflictDomainError);
    });
  });
  // Audit #6: complete() runs after the business tx commits. If it fails, the
  // key must NOT be released — a same-key retry would re-execute a committed
  // write. The write marks the key committed inside its own transaction, so
  // the retry gets a 409 instead of a duplicate.
  describe('complete() failure after a committed write (never double-executes)', () => {
    let approver: string;
    let idem: IdempotencyService;

    beforeAll(async () => {
      idem = app.get(IdempotencyService);
      await app.get(CompanyService).seedIfEmpty();
      // Direct create-and-post requires Segregation of Duties off.
      await app
        .get(CompanyService)
        .update({ segregationOfDutiesEnabled: false });
      await app.get(UsersService).create({
        email: 'approver@idem.test',
        password: 'secret123',
        name: 'Approver',
        role: 'APPROVER',
      });
      approver = (
        await app.get(AuthService).login('approver@idem.test', 'secret123')
      ).accessToken;
    });

    afterEach(() => jest.restoreAllMocks());

    it('invoice create: 500 when complete() fails, same-key retry 409, exactly one invoice', async () => {
      const partnerId = await newCustomer('CUST-IDEM-COMMIT');
      const key = randomUUID();
      const body = invoiceBody(partnerId);
      jest
        .spyOn(idem, 'complete')
        .mockRejectedValueOnce(new Error('simulated DB blip'));
      await request(server())
        .post('/v1/sales-invoices')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', key)
        .send(body)
        .expect(500);
      const retry = await request(server())
        .post('/v1/sales-invoices')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', key)
        .send(body);
      expect(retry.status).toBe(409);
      expect((retry.body as { code: string }).code).toBe('CONFLICT');
      expect((retry.body as { message: string }).message).toMatch(/committed/);
      expect(
        await prisma.client.salesInvoice.count({ where: { partnerId } }),
      ).toBe(1);
    });

    it('journal create-and-post: 500 when complete() fails, same-key retry 409, exactly one posted entry', async () => {
      const description = `idem-commit-${randomUUID()}`;
      const key = randomUUID();
      const body = {
        date: '2026-02-10',
        description,
        lines: [
          { accountId: acc['1-1000'], debit: '1000000' },
          { accountId: acc['3-1000'], credit: '1000000' },
        ],
      };
      jest
        .spyOn(idem, 'complete')
        .mockRejectedValueOnce(new Error('simulated DB blip'));
      await request(server())
        .post('/v1/ledger/journal-entries?post=true')
        .set('Authorization', `Bearer ${approver}`)
        .set('Idempotency-Key', key)
        .send(body)
        .expect(500);
      await request(server())
        .post('/v1/ledger/journal-entries?post=true')
        .set('Authorization', `Bearer ${approver}`)
        .set('Idempotency-Key', key)
        .send(body)
        .expect(409);
      expect(
        await prisma.client.journalEntry.count({ where: { description } }),
      ).toBe(1);
    });
    it('a successful write marks its key committed inside the tx (ALS context reaches the service layer)', async () => {
      const partnerId = await newCustomer('CUST-IDEM-MARK');
      const key = randomUUID();
      await request(server())
        .post('/v1/sales-invoices')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', key)
        .send(invoiceBody(partnerId))
        .expect(201);
      const row = await prisma.client.idempotencyKey.findFirst({
        where: { key },
      });
      expect(row?.committedAt).toBeInstanceOf(Date);
      expect(row?.completedAt).toBeInstanceOf(Date);
    });

    it('a handler error AFTER the commit keeps the key: retry 409, exactly one invoice', async () => {
      const partnerId = await newCustomer('CUST-IDEM-POSTCOMMIT');
      const key = randomUUID();
      const body = invoiceBody(partnerId);
      // present() runs in the controller after createDraft's tx committed.
      jest
        .spyOn(app.get(SalesInvoicesService), 'present')
        .mockImplementationOnce(() => {
          throw new Error('simulated post-commit failure');
        });
      await request(server())
        .post('/v1/sales-invoices')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', key)
        .send(body)
        .expect(500);
      await request(server())
        .post('/v1/sales-invoices')
        .set('Authorization', `Bearer ${acct}`)
        .set('Idempotency-Key', key)
        .send(body)
        .expect(409);
      expect(
        await prisma.client.salesInvoice.count({ where: { partnerId } }),
      ).toBe(1);
    });

    it('a handler error inside the tx (rolled back) releases the key so a retry re-executes', async () => {
      const description = `idem-rollback-${randomUUID()}`;
      const key = randomUUID();
      const body = {
        date: '2026-02-10',
        description,
        lines: [
          { accountId: acc['1-1000'], debit: '1000000' },
          { accountId: acc['3-1000'], credit: '1000000' },
        ],
      };
      // Fail the in-tx post derivation once: the tx rolls back, nothing committed.
      const posting = app.get(PostingService);
      jest
        .spyOn(posting, 'createPostedEntryInTx')
        .mockRejectedValueOnce(new Error('simulated in-tx failure'));
      await request(server())
        .post('/v1/ledger/journal-entries?post=true')
        .set('Authorization', `Bearer ${approver}`)
        .set('Idempotency-Key', key)
        .send(body)
        .expect(500);
      expect(
        await prisma.client.idempotencyKey.findFirst({ where: { key } }),
      ).toBeNull();
      await request(server())
        .post('/v1/ledger/journal-entries?post=true')
        .set('Authorization', `Bearer ${approver}`)
        .set('Idempotency-Key', key)
        .send(body)
        .expect(201);
      expect(
        await prisma.client.journalEntry.count({ where: { description } }),
      ).toBe(1);
    });

    it('stale reclaim never reclaims a committed row (409 committed, not a re-run)', async () => {
      const key = 'reclaim-committed-' + randomUUID();
      await prisma.client.idempotencyKey.create({
        data: {
          userId: 'u-reclaim',
          key,
          method: 'POST',
          path: '/v1/x',
          requestHash: 'h',
          createdAt: new Date(Date.now() - 200_000),
          committedAt: new Date(Date.now() - 199_000),
        },
      });
      const err: unknown = await idem
        .reserve('u-reclaim', key, 'POST', '/v1/x', 'h')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictDomainError);
      expect((err as ConflictDomainError).details).toMatchObject({
        committed: true,
      });
      expect(await prisma.client.idempotencyKey.count({ where: { key } })).toBe(
        1,
      );
    });
  });
});
