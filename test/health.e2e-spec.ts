import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { bootstrapTestApp } from './e2e-helpers';

describe('Health (e2e)', () => {
  let app: INestApplication;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ app, cleanup } = await bootstrapTestApp({ pipe: false }));
  }, 120_000);

  afterAll(() => cleanup());

  it('GET /health returns ok', () => {
    return request(app.getHttpServer() as App)
      .get('/health')
      .expect(200)
      .expect({ status: 'ok' });
  });
});
