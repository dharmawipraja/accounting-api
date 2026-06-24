import * as request from 'supertest';
import { type App } from 'supertest/types';
import { bootstrapTestApp, TestApp } from './e2e-helpers';

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
});
