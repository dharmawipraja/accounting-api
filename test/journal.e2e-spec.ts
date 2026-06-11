import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('JournalEntries (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prismaOverride: PrismaService;
  let accountantToken: string;
  let approverToken: string;
  let kasId: string;
  let modalId: string;

  beforeAll(async () => {
    db = await startTestDb();
    prismaOverride = makePrismaOverride(db.url);
    await prismaOverride.$connect();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prismaOverride)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    // Seed data
    await app.get(CompanyService).seedIfEmpty();
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);

    // Resolve account IDs
    const accounts = await app.get(AccountsService).list();
    kasId = accounts.find((a) => a.code === '1-1000')!.id;
    modalId = accounts.find((a) => a.code === '3-1000')!.id;

    // Create users
    const users = app.get(UsersService);
    await users.create({
      email: 'accountant@journal.test',
      password: 'secret123',
      name: 'Accountant',
      role: 'ACCOUNTANT',
    });
    await users.create({
      email: 'approver@journal.test',
      password: 'secret123',
      name: 'Approver',
      role: 'APPROVER',
    });

    // Get tokens
    const auth = app.get(AuthService);
    accountantToken = (await auth.login('accountant@journal.test', 'secret123'))
      .accessToken;
    approverToken = (await auth.login('approver@journal.test', 'secret123'))
      .accessToken;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prismaOverride.$disconnect();
    await db?.stop();
  });

  const balancedBody = (date = '2026-02-10') => ({
    date,
    description: 'Owner injects capital',
    lines: [
      { accountId: kasId, debit: '1000000' },
      { accountId: modalId, credit: '1000000' },
    ],
  });

  it('ACCOUNTANT creates a DRAFT journal entry (201, status=DRAFT, entryNumber=null)', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/ledger/journal-entries')
      .set('Authorization', `Bearer ${accountantToken}`)
      .send(balancedBody())
      .expect(201);

    const body = res.body as {
      id: string;
      status: string;
      entryNumber: number | null;
      description: string;
    };
    expect(body.status).toBe('DRAFT');
    expect(body.entryNumber).toBeNull();
    expect(body.id).toBeDefined();
    expect(body.description).toBe('Owner injects capital');
  });

  it('APPROVER posts a DRAFT in-place (200, same id, status=POSTED, entryNumber>0)', async () => {
    // ACCOUNTANT creates draft
    const draftRes = await request(app.getHttpServer() as App)
      .post('/ledger/journal-entries')
      .set('Authorization', `Bearer ${accountantToken}`)
      .send(balancedBody())
      .expect(201);
    const draftId = (draftRes.body as { id: string }).id;

    // APPROVER posts it
    const postRes = await request(app.getHttpServer() as App)
      .post(`/ledger/journal-entries/${draftId}/post`)
      .set('Authorization', `Bearer ${approverToken}`)
      .expect(200);

    const posted = postRes.body as {
      id: string;
      status: string;
      entryNumber: number;
      entryRef: string;
    };
    expect(posted.id).toBe(draftId);
    expect(posted.status).toBe('POSTED');
    expect(posted.entryNumber).toBeGreaterThan(0);
    expect(posted.entryRef).toMatch(/^JE\/2026\/\d{6}$/);
  });

  it('ACCOUNTANT POST /:id/post is rejected with 403 (role guard)', async () => {
    // ACCOUNTANT creates draft
    const draftRes = await request(app.getHttpServer() as App)
      .post('/ledger/journal-entries')
      .set('Authorization', `Bearer ${accountantToken}`)
      .send(balancedBody())
      .expect(201);
    const draftId = (draftRes.body as { id: string }).id;

    // ACCOUNTANT tries to post — should be 403
    await request(app.getHttpServer() as App)
      .post(`/ledger/journal-entries/${draftId}/post`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(403);
  });

  it('ACCOUNTANT soft-deletes a DRAFT (204) then GET returns 404', async () => {
    // ACCOUNTANT creates draft
    const draftRes = await request(app.getHttpServer() as App)
      .post('/ledger/journal-entries')
      .set('Authorization', `Bearer ${accountantToken}`)
      .send(balancedBody())
      .expect(201);
    const draftId = (draftRes.body as { id: string }).id;

    // Delete it
    await request(app.getHttpServer() as App)
      .delete(`/ledger/journal-entries/${draftId}`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(204);

    // GET should 404
    await request(app.getHttpServer() as App)
      .get(`/ledger/journal-entries/${draftId}`)
      .set('Authorization', `Bearer ${accountantToken}`)
      .expect(404);
  });

  it('double-posting the same draft posts once with no number gap', async () => {
    const draftRes = await request(app.getHttpServer() as App)
      .post('/ledger/journal-entries')
      .set('Authorization', `Bearer ${accountantToken}`)
      .send(balancedBody())
      .expect(201);
    const draftId = (draftRes.body as { id: string }).id;

    const seqBefore = await prismaOverride.client.journalSequence.findUnique({
      where: { fiscalYear: 2026 },
    });
    const both = await Promise.allSettled([
      request(app.getHttpServer() as App)
        .post(`/ledger/journal-entries/${draftId}/post`)
        .set('Authorization', `Bearer ${approverToken}`),
      request(app.getHttpServer() as App)
        .post(`/ledger/journal-entries/${draftId}/post`)
        .set('Authorization', `Bearer ${approverToken}`),
    ]);
    const codes = both.map((r) =>
      r.status === 'fulfilled' ? r.value.status : 0,
    );
    expect(codes.filter((c) => c === 200)).toHaveLength(1); // exactly one wins
    expect(codes.some((c) => c >= 400 && c < 500)).toBe(true); // the other is a 4xx
    const seqAfter = await prismaOverride.client.journalSequence.findUnique({
      where: { fiscalYear: 2026 },
    });
    // Exactly one sequence number consumed — the loser burned none (no gap).
    expect(seqAfter!.nextNumber - seqBefore!.nextNumber).toBe(1);
  });
});
