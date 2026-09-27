import './audit-timeout-env';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
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

/** Bounded poll: re-evaluate `probe` every 25 ms until it returns a value,
 *  failing after `timeoutMs` — no fixed sleep gates an assertion. */
async function pollFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  what: string,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** A stub that outlives REQUEST_TIMEOUT_MS (1500) and then throws, exposing
 *  `settled` so the spec awaits the late completion instead of guessing. */
function slowFailingStub(): {
  impl: () => Promise<never>;
  settled: Promise<void>;
} {
  let markSettled!: () => void;
  const settled = new Promise<void>((r) => (markSettled = r));
  return {
    settled,
    impl: async () => {
      try {
        await sleep(2_500);
        throw new Error('stub handler should have been cut off');
      } finally {
        markSettled();
      }
    },
  };
}

/** After the stub settled: a few event-loop turns for any (erroneous) late
 *  audit write to surface before the exactly-one assertion. Not a gate on a
 *  positive condition — those poll. */
const LATE_WRITE_GRACE_MS = 300;

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
    const stub = slowFailingStub();
    jest.spyOn(partners, 'create').mockImplementation(stub.impl);
    const before = await prisma.client.auditLog.count();
    await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Request-Id', 'tmo-partner-408')
      .send({ code: 'TMO-1', name: 'Slow', isCustomer: true })
      .expect(408);
    await pollFor(
      () =>
        prisma.client.auditLog.findFirst({
          where: { clientRequestId: 'tmo-partner-408' },
        }),
      'the 408 audit row',
    );
    // A late handler completion must not add a 2nd row: wait for the stub to
    // actually settle, then give any late write a moment to land.
    await stub.settled;
    await sleep(LATE_WRITE_GRACE_MS);
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
    // A slow handler that never writes anything: the stub sleeps past
    // REQUEST_TIMEOUT_MS and then throws (nothing is committed) — only the
    // interceptor's 408 audit row, carrying the accepted body, is under test.
    const stub = slowFailingStub();
    jest.spyOn(journal, 'createDraft').mockImplementation(stub.impl);
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
    const row = await pollFor(
      () =>
        prisma.client.auditLog.findFirst({
          where: { clientRequestId: 'tmo-full-body' },
        }),
      'the 408 audit row',
    );
    await stub.settled; // don't leak the stub's timer into the next test
    expect(row).toMatchObject({ statusCode: 408 });
    expect(row.body).toEqual(body);
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
    const row = await pollFor(
      () =>
        prisma.client.auditLog.findFirst({
          where: { clientRequestId: 'tmo-invalid-body' },
        }),
      'the 400 audit row',
    );
    expect(row).toMatchObject({ statusCode: 400 });
    expect(row.body).toMatchObject({ _truncated: true });
    expect(Buffer.byteLength(JSON.stringify(row.body))).toBeLessThanOrEqual(
      AUDIT_SMALL_BODY_MAX_BYTES,
    );
  });
});
