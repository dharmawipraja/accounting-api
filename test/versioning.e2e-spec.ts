import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { bootstrapTestApp } from './e2e-helpers';

describe('API versioning (e2e)', () => {
  let app: INestApplication;
  let cleanup: () => Promise<void>;
  const server = () => app.getHttpServer() as App;

  beforeAll(async () => {
    ({ app, cleanup } = await bootstrapTestApp());
  }, 120_000);

  afterAll(() => cleanup());

  it('serves business routes under /v1 and 404s the unprefixed path', async () => {
    await request(server()).get('/v1/ledger/accounts').expect(401); // auth required, but route exists
    await request(server()).get('/ledger/accounts').expect(404);
  });

  it('keeps health and metrics version-neutral', async () => {
    await request(server()).get('/health').expect(200);
    await request(server()).get('/ready').expect(200);
    await request(server()).get('/v1/health').expect(404);
    // /metrics stays unprefixed; the versioned path must not exist.
    await request(server()).get('/v1/metrics').expect(404);
  });
});
