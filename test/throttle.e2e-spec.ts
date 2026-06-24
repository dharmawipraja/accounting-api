import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { UsersService } from '../src/users/users.service';
import { AuthService } from '../src/auth/auth.service';
import { bootstrapTestApp } from './e2e-helpers';

describe('Throttle policy (e2e)', () => {
  let app: INestApplication;
  let cleanup: () => Promise<void>;
  let token: string;

  beforeAll(async () => {
    ({ app, cleanup } = await bootstrapTestApp());
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
  });

  it('SEC-3: login throttle is per-email, not bypassable by rotating X-Forwarded-For', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(app.getHttpServer() as App)
        .post('/v1/auth/login')
        .set('X-Forwarded-For', `203.0.113.${i}`) // a DIFFERENT client IP each attempt
        // distinct email → fresh bucket, isolated from the per-IP test above
        .send({ email: 'sec3@test.io', password: 'wrong-password' });
      statuses.push(res.status);
    }
    // The first 10 genuinely land under the cap (proves no bucket bleed)...
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    // ...then the email-keyed bucket trips regardless of the rotating IP.
    expect(statuses[10]).toBe(429);
  });

  it('a normal low-volume authenticated request is not throttled', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});
