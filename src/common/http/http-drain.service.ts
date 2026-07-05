import { BeforeApplicationShutdown, Injectable } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Server } from 'http';

/**
 * Kicks idle keep-alive sockets (from the reverse proxy) as soon as shutdown
 * starts, so the subsequent HTTP-server close only waits on genuinely active
 * requests instead of up to keepAliveTimeout (65s) — which would outlive the
 * container's stop_grace_period.
 */
@Injectable()
export class HttpDrainService implements BeforeApplicationShutdown {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  beforeApplicationShutdown(): void {
    const server = this.adapterHost.httpAdapter?.getHttpServer() as
      | Server
      | undefined;
    server?.closeIdleConnections?.();
  }
}
