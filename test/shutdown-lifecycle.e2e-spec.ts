import { Server } from 'http';
import { bootstrapTestApp, TestApp } from './e2e-helpers';

/**
 * Graceful-shutdown ordering: on app.close() (same hook sequence as SIGTERM),
 * in-flight HTTP work must be able to finish before the DB goes away. Nest runs
 * onModuleDestroy → beforeApplicationShutdown → dispose (HTTP close) →
 * onApplicationShutdown, so DB/Redis teardown must live in
 * onApplicationShutdown — never onModuleDestroy.
 */
describe('graceful shutdown ordering (e2e)', () => {
  let h: TestApp;
  const events: string[] = [];

  beforeAll(async () => {
    h = await bootstrapTestApp();

    const server = h.app.getHttpServer() as Server;
    const origClose = server.close.bind(server);
    jest
      .spyOn(server, 'close')
      .mockImplementation((cb?: (err?: Error) => void) => {
        events.push('server.close');
        return origClose(cb);
      });
    jest.spyOn(server, 'closeIdleConnections').mockImplementation(function (
      this: Server,
    ) {
      events.push('server.closeIdleConnections');
      return Server.prototype.closeIdleConnections.call(this);
    });
    const origDisconnect = h.prisma.$disconnect.bind(h.prisma);
    jest.spyOn(h.prisma, '$disconnect').mockImplementation(async () => {
      events.push('prisma.$disconnect');
      return origDisconnect();
    });

    await h.app.close();
  }, 120_000);

  afterAll(async () => {
    // app is already closed above; release the spec's own handles directly.
    await h.prisma.$disconnect();
    await h.db.stop();
  });

  it('closes the HTTP server before disconnecting Prisma', () => {
    expect(events).toContain('server.close');
    expect(events).toContain('prisma.$disconnect');
    expect(events.indexOf('prisma.$disconnect')).toBeGreaterThan(
      events.indexOf('server.close'),
    );
  });

  it('proactively closes idle keep-alive sockets before the server close drains', () => {
    expect(events).toContain('server.closeIdleConnections');
    expect(events.indexOf('server.closeIdleConnections')).toBeLessThan(
      events.indexOf('server.close'),
    );
  });
});
