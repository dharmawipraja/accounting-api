import './audit-timeout-env';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { JournalService } from '../src/ledger/journal/journal.service';
import {
  AUDIT_BODY_MAX_BYTES,
  AUDIT_SMALL_BODY_MAX_BYTES,
} from '../src/audit/audit-request';
import { bootstrapTestApp } from './e2e-helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** AUDIT3-IT2: a request cut off by RequestTimeoutInterceptor (408) must still
 *  write exactly ONE audit row; a normal success must also write exactly one. */
describe('Audit covers timed-out requests (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let token: string;

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());
    await app.get(UsersService).create({
      email: 'admin@audit-timeout.test',
      password: 'secret123',
      name: 'Admin',
      role: 'ADMIN',
    });
    token = (
      await app.get(AuthService).login('admin@audit-timeout.test', 'secret123')
    ).accessToken;
  }, 120_000);

  afterAll(() => cleanup());
  afterEach(() => jest.restoreAllMocks());

  it('a 408 mutating request writes exactly one audit row with status 408', async () => {
    const partners = app.get(BusinessPartnersService);
    jest.spyOn(partners, 'create').mockImplementation(async () => {
      await sleep(2_500); // slower than REQUEST_TIMEOUT_MS (1500)
      throw new Error('stub handler should have been cut off');
    });
    const before = await prisma.client.auditLog.count();
    await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'TMO-1', name: 'Slow', isCustomer: true })
      .expect(408);
    // Let the stub settle — a late handler completion must not add a 2nd row.
    await sleep(1_500);
    const rows = await prisma.client.auditLog.findMany({
      where: { path: '/v1/partners', method: 'POST' },
      orderBy: { timestamp: 'asc' },
    });
    expect(await prisma.client.auditLog.count()).toBe(before + 1);
    expect(rows[rows.length - 1].statusCode).toBe(408);
  }, 20_000);

  it('a successful mutating request still writes exactly one row', async () => {
    const before = await prisma.client.auditLog.count();
    await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'TMO-2', name: 'Fast', isCustomer: true })
      .expect(201);
    expect(await prisma.client.auditLog.count()).toBe(before + 1);
  });

  it('iter6: a 408 on a body the ValidationPipe accepted stores the FULL body (512 KiB tier), not an 8 KiB marker', async () => {
    const journal = app.get(JournalService);
    // The write "commits" (stub) but the handler outlives REQUEST_TIMEOUT_MS.
    jest.spyOn(journal, 'createDraft').mockImplementation(async () => {
      await sleep(2_500);
      throw new Error('stub handler should have been cut off');
    });
    const acct = '11111111-1111-4111-8111-111111111111';
    const body = {
      date: '2026-07-01',
      description: 'timeout probe',
      lines: Array.from({ length: 100 }, (_, i) => ({
        accountId: acct,
        ...(i % 2 === 0 ? { debit: '1.0000' } : { credit: '1.0000' }),
        description: 'd'.repeat(500),
      })),
    };
    const size = Buffer.byteLength(JSON.stringify(body));
    expect(size).toBeGreaterThan(AUDIT_SMALL_BODY_MAX_BYTES);
    expect(size).toBeLessThan(AUDIT_BODY_MAX_BYTES);
    await request(app.getHttpServer() as App)
      .post('/v1/ledger/journal-entries')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'tmo-full-body-1')
      .set('X-Request-Id', 'tmo-full-body')
      .send(body)
      .expect(408);
    await sleep(1_500);
    const row = await prisma.client.auditLog.findFirst({
      where: { clientRequestId: 'tmo-full-body' },
    });
    expect(row).toMatchObject({ statusCode: 408 });
    expect(row!.body).toEqual(body);
  }, 20_000);

  it('iter6: a 400 from the ValidationPipe (never accepted) keeps the 8 KiB tier', async () => {
    const body = {
      date: '2026-07-01',
      description: 'invalid probe',
      lines: Array.from({ length: 100 }, () => ({
        accountId: 'not-a-uuid',
        description: 'd'.repeat(500),
      })),
    };
    await request(app.getHttpServer() as App)
      .post('/v1/ledger/journal-entries')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'tmo-invalid-body-1')
      .set('X-Request-Id', 'tmo-invalid-body')
      .send(body)
      .expect(400);
    const row = await prisma.client.auditLog.findFirst({
      where: { clientRequestId: 'tmo-invalid-body' },
    });
    expect(row).toMatchObject({ statusCode: 400 });
    expect(row!.body).toMatchObject({ _truncated: true });
    expect(Buffer.byteLength(JSON.stringify(row!.body))).toBeLessThanOrEqual(
      AUDIT_SMALL_BODY_MAX_BYTES,
    );
  });
});
