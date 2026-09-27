import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { type App } from 'supertest/types';
import { bootstrapTestApp } from './e2e-helpers';

describe('traceId correlation (e2e)', () => {
  let app: INestApplication;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ app, cleanup } = await bootstrapTestApp());
  }, 120_000);

  afterAll(() => cleanup());

  it('echoes a generated UUID X-Request-Id on a normal response', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/health')
      .expect(200);
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('never reuses an inbound X-Request-Id — the trace id is always server-generated', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/health')
      .set('X-Request-Id', 'trace-abc-123')
      .expect(200);
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('ignores an oversized/garbage inbound X-Request-Id and generates a UUID', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/health')
      .set('X-Request-Id', 'x'.repeat(200))
      .expect(200);
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('correlates: the error envelope traceId equals the X-Request-Id header (same id)', async () => {
    // an unauthenticated protected route -> 401 envelope; the traceId MUST be the
    // same id echoed in the response header (that correlation is the whole point).
    const res = await request(app.getHttpServer() as App)
      .get('/v1/reports/balance-sheet')
      .set('X-Request-Id', 'trace-corr-xyz')
      .expect(401);
    const id = res.headers['x-request-id'];
    expect(id).not.toBe('trace-corr-xyz'); // server-generated, not the inbound
    expect((res.body as { traceId?: string }).traceId).toBe(id);
  });
});
