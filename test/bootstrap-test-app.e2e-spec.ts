import * as request from 'supertest';
import { type App } from 'supertest/types';
import { bootstrapTestApp, TestApp } from './e2e-helpers';
import { THROTTLE } from '../src/config/throttle.config';

describe('bootstrapTestApp (e2e harness smoke)', () => {
  let h: TestApp;

  beforeAll(async () => {
    h = await bootstrapTestApp();
  }, 120_000);

  afterAll(() => h.cleanup());

  it('boots the app and serves an un-versioned request', async () => {
    await request(h.app.getHttpServer() as App)
      .get('/metrics')
      .expect(200);
  });

  it('raises the per-IP login ceiling for the suite (loopback is one client IP)', () => {
    expect(THROTTLE.loginIp).toBe(1000);
  });
});
