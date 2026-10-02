import { Injectable } from '@nestjs/common';
import {
  Registry,
  collectDefaultMetrics,
  Histogram,
  Counter,
  Gauge,
} from 'prom-client';
import { PrismaService } from '../common/prisma/prisma.service';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly httpDuration: Histogram<string>;
  private readonly ledgerPosted: Counter<string>;
  private readonly loginFailures: Counter<string>;
  private readonly loginLockouts: Counter<string>;

  constructor(private readonly prisma: PrismaService) {
    collectDefaultMetrics({ register: this.registry });
    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers: [this.registry],
    });
    this.ledgerPosted = new Counter({
      name: 'ledger_entries_posted_total',
      help: 'Total posted journal entries',
      registers: [this.registry],
    });
    this.loginFailures = new Counter({
      name: 'auth_login_failures_total',
      help: 'Failed login attempts (wrong password, unknown or inactive user)',
      registers: [this.registry],
    });
    this.loginLockouts = new Counter({
      name: 'auth_login_lockouts_total',
      help: 'Logins refused by the per-account failed-login ceiling',
      registers: [this.registry],
    });
    const stats = () => this.prisma.getPoolStats();
    new Gauge({
      name: 'db_pool_total',
      help: 'pg pool total connections',
      registers: [this.registry],
      collect() {
        this.set(stats().total);
      },
    });
    new Gauge({
      name: 'db_pool_idle',
      help: 'pg pool idle connections',
      registers: [this.registry],
      collect() {
        this.set(stats().idle);
      },
    });
    new Gauge({
      name: 'db_pool_waiting',
      help: 'pg pool waiting requests',
      registers: [this.registry],
      collect() {
        this.set(stats().waiting);
      },
    });
  }

  incLedgerEntriesPosted(): void {
    this.ledgerPosted.inc();
  }

  incLoginFailure(): void {
    this.loginFailures.inc();
  }

  incLoginLockout(): void {
    this.loginLockouts.inc();
  }

  async metrics(): Promise<string> {
    return this.registry.metrics();
  }

  contentType(): string {
    return this.registry.contentType;
  }
}
