import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AuditService } from '../src/audit/audit.service';
import type { Prisma } from '@prisma/client';
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
});
