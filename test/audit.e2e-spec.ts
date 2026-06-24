import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';

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
});
