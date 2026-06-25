import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { CompanyService } from '../src/company/company.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';

describe('Accounts (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let adminToken: string;

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());

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

  afterAll(() => cleanup());

  it('seeds the SAK chart with parent links resolved', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/v1/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as {
      data: { code: string; parentId: string | null }[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.total).toBeGreaterThanOrEqual(0);
    expect(body.limit).toBeGreaterThan(0);
    expect(body.offset).toBe(0);
    expect(Array.isArray(body.data)).toBe(true);
    const codes = body.data.map((a) => a.code);
    expect(codes).toContain('1-1000'); // Kas
    expect(codes).toContain('3-9000'); // Saldo Awal
    const kas = body.data.find((a) => a.code === '1-1000');
    expect(kas?.parentId).toBeTruthy();
  });

  it('seedIfEmpty is idempotent', async () => {
    await app.get(AccountsService).seedIfEmpty();
    const count = await prisma.client.account.count();
    expect(count).toBe(28);
  });

  it('seedIfEmpty assigns system-account roles', async () => {
    const byCode = async (code: string) =>
      prisma.client.account.findFirst({ where: { code } });
    expect((await byCode('1-1000'))?.role).toBe('CASH');
    expect((await byCode('1-1100'))?.role).toBe('CASH');
    expect((await byCode('1-1200'))?.role).toBe('AR_CONTROL');
    expect((await byCode('2-1000'))?.role).toBe('AP_CONTROL');
    expect((await byCode('3-2000'))?.role).toBe('RETAINED_EARNINGS');
    expect((await byCode('3-9000'))?.role).toBe('OPENING_BALANCE_EQUITY');
    expect((await byCode('5-9000'))?.role).toBe('TAX_EXPENSE');
    // a non-system account has no role
    expect((await byCode('1-1300'))?.role).toBeNull();
  });

  it('creates a postable account', async () => {
    await request(app.getHttpServer() as App)
      .post('/v1/ledger/accounts')
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
      .post('/v1/ledger/accounts')
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
    const res = await request(app.getHttpServer() as App)
      .post('/v1/ledger/accounts')
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
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('rejects incoherent type/subtype pair (422)', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/v1/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '1-9999',
        name: 'Incoherent',
        type: 'ASSET',
        subtype: 'TAX_PAYABLE',
        normalBalance: 'DEBIT',
      })
      .expect(422);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('deactivates an account (200, isActive false)', async () => {
    const created = await request(app.getHttpServer() as App)
      .post('/v1/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '1-1610',
        name: 'To Deactivate',
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        normalBalance: 'DEBIT',
        parentCode: '1-0000',
      })
      .expect(201);
    const id = (created.body as { id: string }).id;
    await request(app.getHttpServer() as App)
      .post(`/v1/ledger/accounts/${id}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200)
      .expect((r) =>
        expect((r.body as { isActive: boolean }).isActive).toBe(false),
      );
  });

  it('soft-deletes an account (204) then hides it (404)', async () => {
    const created = await request(app.getHttpServer() as App)
      .post('/v1/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '1-1620',
        name: 'To Delete',
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        normalBalance: 'DEBIT',
        parentCode: '1-0000',
      })
      .expect(201);
    const id = (created.body as { id: string }).id;
    await request(app.getHttpServer() as App)
      .delete(`/v1/ledger/accounts/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);
    await request(app.getHttpServer() as App)
      .get(`/v1/ledger/accounts/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('creates an account with a CASH role', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/v1/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '1-1700',
        name: 'Bank Ketiga',
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        normalBalance: 'DEBIT',
        role: 'CASH',
        parentCode: '1-0000',
      })
      .expect(201);
    expect((res.body as { role: string }).role).toBe('CASH');
  });

  it('rejects a second holder of a singleton role with 409', async () => {
    await request(app.getHttpServer() as App)
      .post('/v1/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '1-1250',
        name: 'AR Control 2',
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        normalBalance: 'DEBIT',
        role: 'AR_CONTROL',
        parentCode: '1-0000',
      })
      .expect(409);
  });

  it('rejects deleting an account that has posted journal lines (422 VALIDATION_FAILED)', async () => {
    // L-28: AccountsService.softDelete — account has posted lines
    const created = await request(app.getHttpServer() as App)
      .post('/v1/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '1-1910',
        name: 'Posted Account',
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        normalBalance: 'DEBIT',
        parentCode: '1-0000',
      })
      .expect(201);
    const id = (created.body as { id: string }).id;

    const { data: accounts } = await app.get(AccountsService).list();
    const modalId = accounts.find((a) => a.code === '3-1000')!.id;

    await app.get(CompanyService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2040);

    await app.get(PostingService).post(
      {
        date: new Date('2040-02-10'),
        description: 'L-28 posted line',
        sourceType: 'MANUAL',
        createdBy: 'a',
        lines: [
          { accountId: id, debit: '1000' },
          { accountId: modalId, credit: '1000' },
        ],
      },
      'p',
    );

    const res = await request(app.getHttpServer() as App)
      .delete(`/v1/ledger/accounts/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(422);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });
});
