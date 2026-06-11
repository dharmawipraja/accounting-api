import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Accounts (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prismaOverride: PrismaService;
  let adminToken: string;

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

    await app.get(AccountsService).seedIfEmpty();
    const users = app.get(UsersService);
    await users.create({
      email: 'admin@x.com',
      password: 'secret123',
      name: 'A',
      role: 'ADMIN',
    });
    adminToken = (await app.get(AuthService).login('admin@x.com', 'secret123'))
      .accessToken;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prismaOverride.$disconnect();
    await db?.stop();
  });

  it('seeds the SAK chart with parent links resolved', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const codes = (res.body as { code: string }[]).map((a) => a.code);
    expect(codes).toContain('1-1000'); // Kas
    expect(codes).toContain('3-9000'); // Saldo Awal
    const kas = (res.body as { code: string; parentId: string | null }[]).find(
      (a) => a.code === '1-1000',
    );
    expect(kas?.parentId).toBeTruthy();
  });

  it('seedIfEmpty is idempotent', async () => {
    await app.get(AccountsService).seedIfEmpty();
    const count = await prismaOverride.client.account.count();
    expect(count).toBe(28);
  });

  it('creates a postable account', async () => {
    await request(app.getHttpServer() as App)
      .post('/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '1-1600',
        name: 'Kas Kecil',
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        normalBalance: 'DEBIT',
        parentCode: '1-0000',
      })
      .expect(201);
  });

  it('rejects a duplicate active code (409)', async () => {
    await request(app.getHttpServer() as App)
      .post('/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '1-1000',
        name: 'Dup',
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        normalBalance: 'DEBIT',
      })
      .expect(409);
  });

  it('rejects posting-account parent (422)', async () => {
    await request(app.getHttpServer() as App)
      .post('/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '1-1700',
        name: 'Bad Parent',
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        normalBalance: 'DEBIT',
        parentCode: '1-1000',
      })
      .expect(422);
  });

  it('rejects incoherent type/subtype pair (422)', async () => {
    await request(app.getHttpServer() as App)
      .post('/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '1-9999',
        name: 'Incoherent',
        type: 'ASSET',
        subtype: 'TAX_PAYABLE',
        normalBalance: 'DEBIT',
      })
      .expect(422);
  });
});
