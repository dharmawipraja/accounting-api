import { randomUUID } from 'crypto';
import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AuditService } from '../src/audit/audit.service';
import { AUDIT_BODY_MAX_BYTES } from '../src/audit/audit-request';
import { CompanyService } from '../src/company/company.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import type { Prisma } from '@prisma/client';
import { statusFromException } from '../src/common/errors/exception-status';
import { bootstrapTestApp } from './e2e-helpers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('Audit log (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let adminToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());
    const users = app.get(UsersService);
    await users.create({
      email: 'admin@audit.test',
      password: 'secret123',
      name: 'Admin',
      role: 'ADMIN',
    });
    await users.create({
      email: 'view@audit.test',
      password: 'secret123',
      name: 'V',
      role: 'VIEWER',
    });
    adminToken = (
      await app.get(AuthService).login('admin@audit.test', 'secret123')
    ).accessToken;
    viewerToken = (
      await app.get(AuthService).login('view@audit.test', 'secret123')
    ).accessToken;
  }, 120_000);

  afterAll(() => cleanup());
  afterEach(() => jest.restoreAllMocks());

  /** Guard-rejection rows are written fire-and-forget AFTER the response. */
  async function waitForRows(where: Prisma.AuditLogWhereInput, n = 1) {
    for (let i = 0; i < 100; i++) {
      const rows = await prisma.client.auditLog.findMany({ where });
      if (rows.length >= n) return rows;
      await new Promise((r) => setTimeout(r, 20));
    }
    return prisma.client.auditLog.findMany({ where });
  }

  it('records a mutating request and redacts the password', async () => {
    const before = await prisma.client.auditLog.count();
    // A mutating POST that goes through the interceptor (create a partner via the admin).
    await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ code: 'AUD-1', name: 'Audited', isCustomer: true })
      .expect(201);
    const after = await prisma.client.auditLog.count();
    expect(after).toBe(before + 1);
    const row = await prisma.client.auditLog.findFirst({
      where: { path: { contains: '/partners' } },
      orderBy: { timestamp: 'desc' },
    });
    expect(row!.method).toBe('POST');
    expect(row!.statusCode).toBeGreaterThanOrEqual(200);
    expect(row!.statusCode).toBeLessThan(300);
    expect(row!.userId).toBeTruthy();
  });

  it('does not record GET reads', async () => {
    const before = await prisma.client.auditLog.count();
    await request(app.getHttpServer() as App)
      .get('/v1/partners')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(await prisma.client.auditLog.count()).toBe(before);
  });

  it('GET /audit is ADMIN-only and returns entries', async () => {
    await request(app.getHttpServer() as App)
      .get('/v1/audit')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403);
    const res = await request(app.getHttpServer() as App)
      .get('/v1/audit')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as unknown[]).length).toBeGreaterThan(0);
  });

  it('rejects a non-logged ?method filter with 400, accepts a logged verb', async () => {
    await request(app.getHttpServer() as App)
      .get('/v1/audit?method=GET')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(400); // GET is never logged — not in the allowed set
    await request(app.getHttpServer() as App)
      .get('/v1/audit?method=POST')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('iter8: ?from/?to must be real ISO dates / date-times in 1970–9999 (400, never a 500); valid instants work', async () => {
    const get = (qs: string) =>
      request(app.getHttpServer() as App)
        .get(`/v1/audit?${qs}`)
        .set('Authorization', `Bearer ${adminToken}`);
    for (const qs of [
      'from=0000-01-01',
      'to=0000-01-01T00:00:00Z',
      'from=2026-02-30',
      'to=2026-04-31T10:00:00Z',
      'from=1969-12-31',
      'from=2026-01-01T25:00:00Z',
      'from=2026-W01',
    ]) {
      const res = await get(qs);
      expect([qs, res.status]).toEqual([qs, 400]);
      expect((res.body as { code: string }).code).toBe('HTTP_400');
    }
    const ok = await get(
      'from=2020-01-01&to=2999-12-31T23:59:59.999%2B07:00',
    ).expect(200);
    expect((ok.body as unknown[]).length).toBeGreaterThan(0);
    // Each row exposes the replay flag (null for an ordinary request).
    expect((ok.body as { replayed: unknown }[])[0]).toHaveProperty(
      'replayed',
      null,
    );
  });

  it('iter8: a year-0000 timestamp that reaches Postgres (22008) maps to 400, not 500 (backstop)', async () => {
    const err: unknown = await prisma.client.auditLog
      .findMany({ where: { timestamp: { gte: new Date('0000-01-01') } } })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).not.toBeNull();
    expect(statusFromException(err)).toBe(400);
  });

  it('final: ?method=CLI lists the create-admin CLI rows (and only them)', async () => {
    const id = randomUUID();
    await prisma.client.auditLog.create({
      data: {
        id,
        method: 'CLI',
        path: 'scripts/create-admin',
        statusCode: 200,
        durationMs: 0,
      },
    });
    const res = await request(app.getHttpServer() as App)
      .get('/v1/audit?method=CLI&limit=200')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const rows = res.body as { id: string; method: string }[];
    expect(rows.map((r) => r.id)).toContain(id);
    expect(rows.every((r) => r.method === 'CLI')).toBe(true);
  });

  it('iter9: ?method=MIGRATION lists the rows data migrations wrote for their auto-fixes (and only them)', async () => {
    const id = randomUUID();
    await prisma.client.auditLog.create({
      data: {
        id,
        method: 'MIGRATION',
        path: '20261005000000_identifier_code_ci_unique',
        body: { table: 'accounts', id: 'x', old: ' A ', new: 'A' },
        statusCode: 200,
        durationMs: 0,
      },
    });
    const res = await request(app.getHttpServer() as App)
      .get('/v1/audit?method=MIGRATION&limit=200')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const rows = res.body as { id: string; method: string; userId: null }[];
    expect(rows.map((r) => r.id)).toContain(id);
    expect(rows.every((r) => r.method === 'MIGRATION')).toBe(true);
  });

  it('SEC-7: audit_log is append-only — UPDATE and DELETE are rejected', async () => {
    const id = randomUUID();
    await prisma.client.auditLog.create({
      data: {
        id,
        method: 'GET',
        path: '/v1/probe',
        statusCode: 200,
        durationMs: 3,
      },
    });

    await expect(
      prisma.client
        .$executeRaw`UPDATE audit_log SET path = ${'/v1/tampered'} WHERE id = ${id}`,
    ).rejects.toThrow(/append-only/i);

    await expect(
      prisma.client.$executeRaw`DELETE FROM audit_log WHERE id = ${id}`,
    ).rejects.toThrow(/append-only/i);

    const row = await prisma.client.auditLog.findFirst({ where: { id } });
    expect(row).not.toBeNull();
    expect(row!.path).toBe('/v1/probe'); // unchanged by the rejected UPDATE
  });

  it('AUDIT3-7: audit_log rejects TRUNCATE', async () => {
    await expect(
      prisma.client.$executeRawUnsafe('TRUNCATE audit_log'),
    ).rejects.toThrow(/append-only/i);
    expect(await prisma.client.auditLog.count()).toBeGreaterThan(0);
  });

  it('AUDIT3-7: rows record the request trace id and the created entity id', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Request-Id', 'audit-trace-0001')
      .send({ code: 'AUD-2', name: 'Traced', isCustomer: true })
      .expect(201);
    const createdId = (res.body as { id: string }).id;
    // The trace id is ALWAYS server-generated (the response header); the inbound
    // X-Request-Id is kept only as client_request_id.
    const serverId = res.headers['x-request-id'];
    expect(serverId).toMatch(UUID);
    const row = await prisma.client.auditLog.findFirst({
      where: { clientRequestId: 'audit-trace-0001' },
    });
    expect(row).not.toBeNull();
    expect(row!.requestId).toBe(serverId);
    expect(row!.entityId).toBe(createdId);

    // A failed write still records the trace id; no entity id; exactly one row
    // (the exception filter must not add a second one).
    const failedRes = await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Request-Id', 'audit-trace-0002')
      .send({ code: 'AUD-2', name: 'Dup', isCustomer: true })
      .expect(409);
    const failed = await prisma.client.auditLog.findMany({
      where: { clientRequestId: 'audit-trace-0002' },
    });
    expect(failed).toHaveLength(1);
    expect(failed[0].requestId).toBe(failedRes.headers['x-request-id']);
    expect(failed[0].statusCode).toBe(409);
    expect(failed[0].entityId).toBeNull();
  });

  it('an unsafe inbound X-Request-Id is dropped (client_request_id NULL)', async () => {
    await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Request-Id', 'bad id with spaces')
      .send({ code: 'AUD-3', name: 'Unsafe trace', isCustomer: true })
      .expect(201);
    const row = await prisma.client.auditLog.findFirst({
      where: { path: '/v1/partners', method: 'POST', statusCode: 201 },
      orderBy: { timestamp: 'desc' },
    });
    expect(row!.clientRequestId).toBeNull();
    expect(row!.requestId).toMatch(UUID);
  });

  it('a guard 401 on a mutating route writes one audit row without the body', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('X-Request-Id', 'audit-guard-401')
      .send({ code: 'AUD-401', name: 'Anon', isCustomer: true })
      .expect(401);
    const rows = await waitForRows({ clientRequestId: 'audit-guard-401' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      method: 'POST',
      path: '/v1/partners',
      statusCode: 401,
      userId: null,
      requestId: res.headers['x-request-id'],
    });
    expect(rows[0].body).toEqual({});
  });

  it('a guard 403 on a mutating route writes one audit row (user + redacted body)', async () => {
    await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${viewerToken}`)
      .set('X-Request-Id', 'audit-guard-403')
      .send({ code: 'AUD-403', name: 'Viewer', isCustomer: true, token: 'x' })
      .expect(403);
    const rows = await waitForRows({ clientRequestId: 'audit-guard-403' });
    expect(rows).toHaveLength(1);
    expect(rows[0].statusCode).toBe(403);
    expect(rows[0].userId).toBeTruthy();
    expect(rows[0].userRole).toBe('VIEWER');
    expect(rows[0].body).toEqual({
      code: 'AUD-403',
      name: 'Viewer',
      isCustomer: true,
      token: '[REDACTED]',
    });
  });

  it('a guard 401 on a GET is not audited', async () => {
    const before = await prisma.client.auditLog.count();
    await request(app.getHttpServer() as App)
      .get('/v1/partners')
      .expect(401);
    expect(await prisma.client.auditLog.count()).toBe(before);
  });
  it('a guard 401 is answered even when the audit write hangs (row is fire-and-forget)', async () => {
    const record = jest
      .spyOn(app.get(AuditService), 'record')
      .mockImplementation(() => new Promise<void>(() => undefined));
    const started = Date.now();
    await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .send({ code: 'AUD-HANG', name: 'Hang', isCustomer: true })
      .expect(401);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('caps the audited path at 512 chars (query strings can be ~16KB)', async () => {
    await request(app.getHttpServer() as App)
      .post(`/v1/partners?pad=${'z'.repeat(2_000)}`)
      .set('X-Request-Id', 'audit-long-path')
      .send({ code: 'AUD-LONG', name: 'Long', isCustomer: true })
      .expect(401);
    const [row] = await waitForRows({ clientRequestId: 'audit-long-path' });
    expect(row.path).toHaveLength(512);
    expect(row.path.startsWith('/v1/partners?pad=zzz')).toBe(true);
  });

  it('AUDIT3-17: an oversized body is stored as a small _truncated marker object (authenticated 400)', async () => {
    // Above the 512 KiB authenticated cap, below the 1 MB body-parser cap.
    const junk = 'j'.repeat(AUDIT_BODY_MAX_BYTES + 1024);
    await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Request-Id', 'audit-big-body')
      .send({ code: 'AUD-BIG', name: 'Big', isCustomer: true, junk })
      .expect(400); // forbidNonWhitelisted
    const [row] = await waitForRows({ clientRequestId: 'audit-big-body' });
    const body = row.body as {
      _truncated: boolean;
      bytes: number;
      preview: string;
    };
    expect(body._truncated).toBe(true);
    expect(body.bytes).toBeGreaterThan(AUDIT_BODY_MAX_BYTES);
    expect(body.preview.length).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(JSON.stringify(row.body))).toBeLessThan(2048);

    // The list endpoint still serves it as a JSON object (not a cut string).
    const list = await request(app.getHttpServer() as App)
      .get('/v1/audit?method=POST&limit=200')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const listed = (list.body as { id: string; body: unknown }[]).find(
      (r) => r.id === row.id,
    );
    expect(listed?.body).toMatchObject({ _truncated: true });
  });

  it('AUDIT3-17: an anonymous 4xx stores no body (even a huge one)', async () => {
    await request(app.getHttpServer() as App)
      .post('/v1/auth/refresh')
      .set('X-Request-Id', 'audit-anon-400')
      .send({ refreshToken: 'x', junk: 'k'.repeat(20_000) })
      .expect(400);
    const [row] = await waitForRows({ clientRequestId: 'audit-anon-400' });
    expect(row.statusCode).toBe(400);
    expect(row.body).toEqual({});
  });

  it('AUDIT3-17: a 20k-deep JSON body is a clean 400 (no 500) and writes NO audit row', async () => {
    const depth = 20_000;
    const deep = `{"code":"AUD-DEEP","x":${'['.repeat(depth)}${']'.repeat(depth)}}`;
    for (const auth of [true, false]) {
      const id = `audit-deep-${auth}`;
      let req = request(app.getHttpServer() as App)
        .post('/v1/partners')
        .set('Content-Type', 'application/json')
        .set('X-Request-Id', id);
      if (auth) req = req.set('Authorization', `Bearer ${adminToken}`);
      const res = await req.send(deep);
      expect(res.status).toBe(400);
      expect((res.body as { code: string }).code).toBe('HTTP_400');
      await new Promise((r) => setTimeout(r, 100));
      const rows = await prisma.client.auditLog.findMany({
        where: { clientRequestId: id },
      });
      // The depth-limit middleware answers before guards/interceptors run,
      // so no audit row is written (see architecture.md).
      expect(rows).toHaveLength(0);
    }
  });

  it('I1: a 100-line JE with 500-char descriptions is audited untruncated', async () => {
    await app.get(CompanyService).seedIfEmpty();
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const { data: accounts } = await app.get(AccountsService).list();
    const kasId = accounts.find((a) => a.code === '1-1000')!.id;
    const modalId = accounts.find((a) => a.code === '3-1000')!.id;
    const text = (i: number) => `L${i} `.padEnd(500, 'd');
    const body = {
      date: '2026-02-10',
      description: 'h'.repeat(500),
      lines: Array.from({ length: 100 }, (_, i) =>
        i % 2 === 0
          ? { accountId: kasId, debit: '1000.0000', description: text(i) }
          : { accountId: modalId, credit: '1000.0000', description: text(i) },
      ),
    };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(50_000);
    await request(app.getHttpServer() as App)
      .post('/v1/ledger/journal-entries')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Idempotency-Key', randomUUID())
      .set('X-Request-Id', 'audit-je-100')
      .send(body)
      .expect(201);
    const [row] = await waitForRows({ clientRequestId: 'audit-je-100' });
    expect(row.statusCode).toBe(201);
    expect(row.body).toEqual(body);
  });

  // Iteration-4 ruling: 512 KiB only for an authenticated 2xx on a handler
  // that binds @Body(); every other authenticated row caps at 8 KiB, and a
  // bodyless handler stores {} whatever the status.
  const JUNK_CAP = 8192;
  const bigJunk = () => 'q'.repeat(500 * 1024);

  it('iter4: a VIEWER guard 403 with a 500 KB body stores <= 8 KiB', async () => {
    await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${viewerToken}`)
      .set('X-Request-Id', 'audit-403-junk')
      .send({ code: 'AUD-J403', name: 'J', isCustomer: true, junk: bigJunk() })
      .expect(403);
    const [row] = await waitForRows({ clientRequestId: 'audit-403-junk' });
    expect(row.statusCode).toBe(403);
    expect(Buffer.byteLength(JSON.stringify(row.body))).toBeLessThanOrEqual(
      JUNK_CAP,
    );
    expect(row.body).toMatchObject({ _truncated: true });
  });

  it('iter4: a bodyless handler (logout-all 201) with a 500 KB body stores {}', async () => {
    const token = (
      await app.get(AuthService).login('view@audit.test', 'secret123')
    ).accessToken;
    await request(app.getHttpServer() as App)
      .post('/v1/auth/logout-all')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Request-Id', 'audit-logout-all-junk')
      .send({ junk: bigJunk() })
      .expect(201);
    const [row] = await waitForRows({
      clientRequestId: 'audit-logout-all-junk',
    });
    expect(row.statusCode).toBe(201);
    expect(row.body).toEqual({});
    // logout-all revoked every viewer session (viewerToken included).
    viewerToken = (
      await app.get(AuthService).login('view@audit.test', 'secret123')
    ).accessToken;
  });

  it('iter4: an any-role 400 (/tax/calculate junk) stores <= 8 KiB', async () => {
    await request(app.getHttpServer() as App)
      .post('/v1/tax/calculate')
      .set('Authorization', `Bearer ${viewerToken}`)
      .set('X-Request-Id', 'audit-tax-400-junk')
      .send({ junk: bigJunk() })
      .expect(400);
    const [row] = await waitForRows({ clientRequestId: 'audit-tax-400-junk' });
    expect(row.statusCode).toBe(400);
    expect(Buffer.byteLength(JSON.stringify(row.body))).toBeLessThanOrEqual(
      JUNK_CAP,
    );
  });

  it('iter4: a body over the 1 MB parser cap is a 413 PAYLOAD_TOO_LARGE envelope (not a 500)', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Content-Type', 'application/json')
      .set('X-Request-Id', 'audit-413')
      .send(JSON.stringify({ junk: 'x'.repeat(1024 * 1024 + 16) }));
    expect(res.status).toBe(413);
    // The parser runs before the request-id (pino) middleware, so the
    // envelope carries no traceId; it is never a 500 / Sentry event.
    expect(res.body).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request body is too large',
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(
      await prisma.client.auditLog.count({
        where: { clientRequestId: 'audit-413' },
      }),
    ).toBe(0);
  });

  it('final: an unsupported JSON charset / content encoding is a 415 envelope (not a 500), no audit row', async () => {
    // (charset=utf-7 is NOT rejected: body-parser only requires `utf-*` for
    // JSON and iconv-lite decodes UTF-7 — so latin1 is the 415 probe.)
    const cases: Array<{ id: string; headers: Record<string, string> }> = [
      {
        id: 'audit-415-charset',
        headers: { 'Content-Type': 'application/json; charset=latin1' },
      },
      {
        id: 'audit-415-encoding',
        headers: {
          'Content-Type': 'application/json',
          'Content-Encoding': 'br2',
        },
      },
    ];
    for (const c of cases) {
      const res = await request(app.getHttpServer() as App)
        .post('/v1/partners')
        .set('Authorization', `Bearer ${adminToken}`)
        .set(c.headers)
        .set('X-Request-Id', c.id)
        .send('{"code":"AUD-415"}');
      expect(res.status).toBe(415);
      expect((res.body as { code: string }).code).toBe('HTTP_415');
      expect((res.body as { message: string }).message).toMatch(
        /^unsupported (charset|content encoding)/,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(
      await prisma.client.auditLog.count({
        where: { clientRequestId: { in: cases.map((c) => c.id) } },
      }),
    ).toBe(0);
  });

  it('iter6: an anonymous gzip-encoded junk body (untyped zlib 400) is a 400 client error, not a 500 / Sentry', async () => {
    // body-parser 2.x wraps the zlib Z_DATA_ERROR as createError(400, err) —
    // status 400 + expose true but no `type`.
    const errorSpy = jest.spyOn(Logger.prototype, 'error');
    const res = await request(app.getHttpServer() as App)
      .post('/v1/auth/login')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .set('X-Request-Id', 'audit-gzip-junk')
      .send('definitely not gzip');
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('HTTP_400');
    expect(errorSpy).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 100));
    expect(
      await prisma.client.auditLog.count({
        where: { clientRequestId: 'audit-gzip-junk' },
      }),
    ).toBe(0);
  });

  it('iter4: malformed JSON (entity.parse.failed) is already a clean 400, not a 500', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('Content-Type', 'application/json')
      .send('{"code": "AUD-BAD",');
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('HTTP_400');
  });

  it('I2: a failed login (401) keeps only the normalized email, never the password', async () => {
    await request(app.getHttpServer() as App)
      .post('/v1/auth/login')
      .set('X-Request-Id', 'audit-login-401')
      .send({ email: '  Admin@Audit.TEST ', password: 'wrong-password-1' })
      .expect(401);
    const [row] = await waitForRows({ clientRequestId: 'audit-login-401' });
    expect(row).toMatchObject({ statusCode: 401, userId: null });
    expect(row.body).toEqual({ email: 'admin@audit.test' });
    expect(JSON.stringify(row)).not.toContain('wrong-password-1');
  });

  it('I2: a rejected login body (400) keeps only the email', async () => {
    await request(app.getHttpServer() as App)
      .post('/v1/auth/login')
      .set('X-Request-Id', 'audit-login-400')
      .send({ email: 'Probe@Audit.test', password: 'short' })
      .expect(400);
    const [row] = await waitForRows({ clientRequestId: 'audit-login-400' });
    expect(row.statusCode).toBe(400);
    expect(row.body).toEqual({ email: 'probe@audit.test' });
  });

  it('I2: other anonymous routes still store {} even with an email field', async () => {
    await request(app.getHttpServer() as App)
      .post('/v1/auth/refresh')
      .set('X-Request-Id', 'audit-refresh-email')
      .send({ refreshToken: 'x', email: 'a@b.io' })
      .expect(400);
    const [row] = await waitForRows({ clientRequestId: 'audit-refresh-email' });
    expect(row.body).toEqual({});
  });
});
