import { Test } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { CompanyService } from '../src/company/company.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('metrics (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prisma: PrismaService;
  let acc: Record<string, string>;
  let posting: PostingService;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = makePrismaOverride(db.url);
    await prisma.$connect();
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();
    app = mod.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.get(CompanyService).seedIfEmpty();
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const { data: accounts } = await app.get(AccountsService).list();
    acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    posting = app.get(PostingService);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await db?.stop();
  });

  /** GET /metrics and return the value of the given single-value counter/gauge. */
  const scrapeCounter = async (name: string): Promise<number> => {
    const res = await request(app.getHttpServer() as App)
      .get('/metrics')
      .expect(200);
    // Match the metric SAMPLE line (`name <value>`), not the HELP/TYPE comment lines.
    const line = res.text.split('\n').find((l) => l.startsWith(`${name} `));
    if (!line) return 0;
    return Number(line.slice(name.length + 1).trim());
  };

  it('exposes Prometheus metrics families', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/metrics')
      .expect(200);
    const body = res.text;
    for (const m of [
      'process_cpu',
      'nodejs_',
      'http_request_duration_seconds',
      'db_pool_total',
      'db_pool_idle',
      'db_pool_waiting',
      'ledger_entries_posted_total',
    ]) {
      expect(body).toContain(m);
    }
  });

  it('increments ledger_entries_posted_total after a post', async () => {
    const before = await scrapeCounter('ledger_entries_posted_total');
    // Post a balanced manual entry (Dr 1-1000 Kas / Cr 3-1000 Modal) via the service.
    const entry = await posting.post(
      {
        date: new Date('2026-03-01'),
        description: 'metrics counter probe',
        sourceType: 'MANUAL',
        createdBy: 'a',
        lines: [
          { accountId: acc['1-1000'], debit: '1000' },
          { accountId: acc['3-1000'], credit: '1000' },
        ],
      },
      'p',
    );
    expect(entry.status).toBe('POSTED');
    const after = await scrapeCounter('ledger_entries_posted_total');
    expect(after).toBeGreaterThan(before);
  });
});
