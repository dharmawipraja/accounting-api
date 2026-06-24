import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import helmet from 'helmet';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { bootstrapTestApp } from './e2e-helpers';

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
});
