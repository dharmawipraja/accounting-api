import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import helmet from 'helmet';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { bootstrapTestApp } from './e2e-helpers';
import { UsersService } from '../src/users/users.service';

describe('Hardening (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp({
      configure: (a) => a.use(helmet()),
    }));
  }, 120_000);

  afterAll(() => cleanup());

  it('GET /ready reports the database is up', () => {
    return request(app.getHttpServer() as App)
      .get('/ready')
      .expect(200)
      .expect((r) => {
        const body = r.body as { db: string };
        expect(body.db).toBe('up');
      });
  });

  it('GET /ready returns 503 when the database is down', async () => {
    const spy = jest
      .spyOn(prisma, '$queryRaw')
      .mockRejectedValueOnce(new Error('connection refused'));
    await request(app.getHttpServer() as App)
      .get('/ready')
      .expect(503);
    spy.mockRestore();
  });

  it('sets security headers via helmet', () => {
    return request(app.getHttpServer() as App)
      .get('/health')
      .expect(200)
      .expect((r) => {
        expect(r.headers['x-dns-prefetch-control']).toBeDefined();
      });
  });

  it('rejects unknown body properties (400)', () => {
    return request(app.getHttpServer() as App)
      .post('/v1/auth/login')
      .send({ email: 'a@b.com', password: 'secret123', injected: 'x' })
      .expect(400);
  });

  it('iter8: every /v1 response carries Cache-Control: no-store (authenticated GET, login 200 / 400 / 401); probes keep their own caching', async () => {
    await app.get(UsersService).create({
      email: 'cache@h.test',
      password: 'secret123',
      name: 'C',
      role: 'VIEWER',
    });
    const server = app.getHttpServer() as App;
    const login = await request(server)
      .post('/v1/auth/login')
      .send({ email: 'cache@h.test', password: 'secret123' })
      .expect(200);
    expect(login.headers['cache-control']).toBe('no-store');
    const token = (login.body as { accessToken: string }).accessToken;
    const get = await request(server)
      .get('/v1/ledger/accounts')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(get.headers['cache-control']).toBe('no-store');
    // Conditional GETs can't turn into a 304 of an authenticated body: the
    // API sends no ETag.
    expect(get.headers.etag).toBeUndefined();
    for (const [res, status] of [
      [
        await request(server)
          .post('/v1/auth/login')
          .send({ email: 'cache@h.test', password: 'wrong-pass' }),
        401,
      ],
      [await request(server).post('/v1/auth/login').send({}), 400],
      [await request(server).get('/v1/ledger/accounts'), 401],
    ] as const) {
      expect(res.status).toBe(status);
      expect(res.headers['cache-control']).toBe('no-store');
    }
    const health = await request(server).get('/health').expect(200);
    expect(health.headers['cache-control']).toBeUndefined();
    await request(server).get('/ready').expect(200);
  });

  it('iter8-final: a body-parser rejection under /v1 (malformed JSON 400, over-cap 413) carries Cache-Control: no-store too', async () => {
    const server = app.getHttpServer() as App;
    const malformed = await request(server)
      .post('/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": "x@y.z",')
      .expect(400);
    expect(malformed.headers['cache-control']).toBe('no-store');
    const tooLarge = await request(server)
      .post('/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'x'.repeat(1_100_000) }))
      .expect(413);
    expect(tooLarge.headers['cache-control']).toBe('no-store');
  });
});
