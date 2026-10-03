// Must stay the first import: pins THROTTLE_LOGIN_IP_LIMIT before throttle.config loads.
import './throttle-default-env';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { type App } from 'supertest/types';
import { UsersService } from '../src/users/users.service';
import { AuthService } from '../src/auth/auth.service';
import { LoginFailureLimiter } from '../src/auth/login-failure-limiter';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { bootstrapTestApp } from './e2e-helpers';

describe('Throttle policy (e2e)', () => {
  let app: INestApplication;
  let cleanup: () => Promise<void>;
  let prisma: PrismaService;
  let token: string;

  beforeAll(async () => {
    ({ app, cleanup, prisma } = await bootstrapTestApp());
    (
      app.getHttpAdapter().getInstance() as {
        set: (k: string, v: unknown) => void;
      }
    ).set('trust proxy', 1);
    await app.get(UsersService).create({
      email: 'thr@test.io',
      password: 'secret123',
      name: 'Thr',
      role: 'ADMIN',
    });
    // direct service login (NOT via HTTP) so it doesn't consume the login bucket
    token = (await app.get(AuthService).login('thr@test.io', 'secret123'))
      .accessToken;
  }, 120_000);

  afterAll(() => cleanup());

  it('caps brute-force login at 10/min per IP (11th is 429)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(app.getHttpServer() as App)
        .post('/v1/auth/login')
        .send({ email: 'thr@test.io', password: 'wrong-password' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true); // bad creds, under the cap
    expect(statuses[10]).toBe(429); // 11th blocked by the login throttle

    // A guard rejection (the throttler runs before interceptors) is still
    // audited — one row, status 429; anonymous, so only the forensic email is
    // kept (never the password).
    // (written fire-and-forget after the response — poll briefly)
    let throttled = await prisma.client.auditLog.findMany({
      where: { path: '/v1/auth/login', statusCode: 429 },
    });
    for (let i = 0; i < 100 && throttled.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      throttled = await prisma.client.auditLog.findMany({
        where: { path: '/v1/auth/login', statusCode: 429 },
      });
    }
    expect(throttled).toHaveLength(1);
    expect(throttled[0].body).toEqual({ email: 'thr@test.io' });
    // The interceptor-written 401 rows keep the same forensic email only.
    const failed = await prisma.client.auditLog.findMany({
      where: { path: '/v1/auth/login', statusCode: 401 },
    });
    expect(failed.length).toBeGreaterThanOrEqual(10);
    for (const row of failed) {
      expect(row.body).toEqual({ email: 'thr@test.io' });
    }
  });

  it('an attacker IP cannot lock the owner out: the per-minute login bucket is per (email, IP)', async () => {
    await app.get(UsersService).create({
      email: 'owner@test.io',
      password: 'secret123',
      name: 'Owner',
      role: 'ADMIN',
    });
    const attempt = (ip: string, password: string) =>
      request(app.getHttpServer() as App)
        .post('/v1/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: 'owner@test.io', password });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++)
      statuses.push((await attempt('198.51.100.7', 'wrong-password')).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429); // the attacker's own IP is throttled...
    // ...while the owner, from their own IP, still logs in.
    await attempt('198.51.100.8', 'secret123').expect(200);
  });

  it('caps guessing one account from MANY IPs; IPs that logged in before keep working', async () => {
    await app.get(UsersService).create({
      email: 'spray@test.io',
      password: 'secret123',
      name: 'Spray',
      role: 'ACCOUNTANT',
    });
    const attempt = (ip: string, password: string) =>
      request(app.getHttpServer() as App)
        .post('/v1/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: 'spray@test.io', password });
    await attempt('192.0.2.200', 'secret123').expect(200); // a known IP
    // LOGIN_FAILURE_LIMIT (default 20) failures, each from a fresh IP.
    for (let i = 0; i < 20; i++)
      await attempt(`203.0.113.${i}`, 'wrong-password').expect(401);
    // An unseen IP is now refused even with the right password...
    await attempt('203.0.113.99', 'secret123').expect(429);
    // ...but the owner's known IP is not locked out.
    await attempt('192.0.2.200', 'secret123').expect(200);
  });

  it('LOGIN_FAILURE_HARD_LIMIT (100) refuses even a known IP — one shared office IP cannot guess forever', async () => {
    await app.get(UsersService).create({
      email: 'office@test.io',
      password: 'secret123',
      name: 'Office',
      role: 'ACCOUNTANT',
    });
    const attempt = (password: string) =>
      request(app.getHttpServer() as App)
        .post('/v1/auth/login')
        .set('X-Forwarded-For', '192.0.2.210')
        .send({ email: 'office@test.io', password });
    await attempt('secret123').expect(200); // the shared IP is now known
    // 99 failures without HTTP (the per-(email, IP) bucket allows 10/min).
    const limiter = app.get(LoginFailureLimiter);
    for (let i = 0; i < 99; i++) await limiter.recordFailure('office@test.io');
    // Past the soft ceiling the known IP still gets a password check...
    await attempt('wrong-password').expect(401); // failure #100
    // ...but at the hard ceiling it is refused too, right password or not.
    await attempt('secret123').expect(429);
  });

  it('AUDIT3-7: login is ALSO capped per client IP — rotating emails cannot bypass it', async () => {
    // 30/min per IP (THROTTLE_LOGIN_IP_LIMIT default). Every attempt uses a
    // DIFFERENT email, so the per-email bucket never trips; only the IP one can.
    const ip = '198.51.100.77';
    const statuses: number[] = [];
    let retryAfter: string | undefined;
    for (let i = 0; i < 31; i++) {
      const res = await request(app.getHttpServer() as App)
        .post('/v1/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: `spray${i}@test.io`, password: 'wrong-password' });
      statuses.push(res.status);
      retryAfter = res.headers['retry-after'];
    }
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses[30]).toBe(429);
    // The IP bucket is a NAMED throttler (Retry-After-loginIp); clients also
    // get the standard Retry-After (seconds) to back off by.
    expect(Number(retryAfter)).toBeGreaterThan(0);

    // A different client IP still has its own budget.
    const other = await request(app.getHttpServer() as App)
      .post('/v1/auth/login')
      .set('X-Forwarded-For', '198.51.100.78')
      .send({ email: 'spray-other@test.io', password: 'wrong-password' });
    expect(other.status).toBe(401);
  }, 60_000);

  it('AUDIT3-17: a rotating `email` field does NOT buy anonymous non-login routes a fresh bucket; stored bodies stay tiny', async () => {
    // Before the fix every anonymous request carrying `email` was keyed
    // `login:<email>` — so a rotating email on /auth/refresh bypassed the IP
    // bucket, and each 400 wrote the full 50 KB junk body to audit_log.
    const ip = '198.51.100.201';
    const junk = 'x'.repeat(50 * 1024);
    const statuses: number[] = [];
    for (let i = 0; i < 60; i++) {
      const res = await request(app.getHttpServer() as App)
        .post('/v1/auth/refresh')
        .set('X-Forwarded-For', ip)
        .send({ email: `rot${i}@test.io`, refreshToken: 'nope', junk });
      statuses.push(res.status);
    }
    // THROTTLE_REFRESH_LIMIT default 30/min per IP on this route.
    expect(statuses.slice(0, 30).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(30).every((s) => s === 429)).toBe(true);

    // Anonymous 4xx rows never store the caller's body.
    let rows = await prisma.client.auditLog.findMany({
      where: { path: '/v1/auth/refresh', ip },
    });
    for (let i = 0; i < 100 && rows.length < 31; i++) {
      await new Promise((r) => setTimeout(r, 20));
      rows = await prisma.client.auditLog.findMany({
        where: { path: '/v1/auth/refresh', ip },
      });
    }
    expect(rows.length).toBeGreaterThanOrEqual(31);
    for (const row of rows) {
      expect(row.body).toEqual({});
    }
  }, 60_000);

  it('a normal low-volume authenticated request is not throttled', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});
