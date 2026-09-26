import type { Server } from 'http';
import type { AddressInfo } from 'net';
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

  it('listens once on IPv4 loopback so supertest reuses that address (never a per-request listen(0) on ::)', () => {
    // An unlistened server makes supertest call listen(0) per request (binds
    // :: dual-stack) and then connect to 127.0.0.1:<port> — on macOS another
    // local process already bound to 127.0.0.1:<port> answers instead
    // (seen as foreign 426 Upgrade Required / 405 responses).
    const server = h.app.getHttpServer() as Server;
    expect(server.listening).toBe(true);
    const addr = server.address() as AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
    expect(addr.port).toBeGreaterThan(0);
  });

  it('raises the per-IP login ceiling for the suite (loopback is one client IP)', () => {
    expect(THROTTLE.loginIp).toBe(1000);
  });
});

describe('bootstrapTestApp cleanup', () => {
  it('closes the HTTP listener', async () => {
    const h = await bootstrapTestApp();
    const server = h.app.getHttpServer() as Server;
    await h.cleanup();
    expect(server.listening).toBe(false);
  }, 120_000);
});
