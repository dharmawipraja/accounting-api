import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';

describe('TaxCodes (e2e)', () => {
  let app: INestApplication;
  let cleanup: () => Promise<void>;
  let adminToken: string;
  let ppnKeluaranId: string; // 2-1100 CREDIT
  let kasId: string; // 1-1000 DEBIT (wrong side for PPN_OUTPUT)

  beforeAll(async () => {
    ({ app, cleanup } = await bootstrapTestApp());
    await app.get(AccountsService).seedIfEmpty();
    await app.get(UsersService).create({
      email: 'admin@tax.test',
      password: 'secret123',
      name: 'Admin',
      role: 'ADMIN',
    });
    adminToken = (
      await app.get(AuthService).login('admin@tax.test', 'secret123')
    ).accessToken;
    const accountsPage = await app.get(AccountsService).list({});
    ppnKeluaranId = accountsPage.data.find((a) => a.code === '2-1100')!.id;
    kasId = accountsPage.data.find((a) => a.code === '1-1000')!.id;
  }, 120_000);

  afterAll(() => cleanup());

  it('seeds the 6 standard tax codes on boot (idempotent)', async () => {
    await app.get(TaxCodesService).seedIfEmpty();
    const res = await request(app.getHttpServer() as App)
      .get('/v1/tax/codes')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as {
      data: { code: string }[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.total).toBeGreaterThanOrEqual(0);
    expect(body.limit).toBeGreaterThan(0);
    expect(body.offset).toBe(0);
    expect(Array.isArray(body.data)).toBe(true);
    const codes = body.data;
    expect(codes).toHaveLength(6);
    expect(codes.map((c) => c.code).sort()).toEqual([
      'PPH23-PAY',
      'PPH23-PRE',
      'PPH42-PAY',
      'PPH42-PRE',
      'PPN-IN-11',
      'PPN-OUT-11',
    ]);
  });

  it('creates a tax code with a matching-normal-balance account (201)', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/v1/tax/codes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: 'PPN-OUT-12',
        name: 'PPN Keluaran 12%',
        kind: 'PPN_OUTPUT',
        rate: '0.12',
        taxAccountId: ppnKeluaranId,
      })
      .expect(201);
    expect((res.body as { kind: string }).kind).toBe('PPN_OUTPUT');
  });

  it('rejects a PPN_OUTPUT code pointed at a DEBIT-normal account (422)', async () => {
    await request(app.getHttpServer() as App)
      .post('/v1/tax/codes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: 'BAD-SIDE',
        name: 'Wrong side',
        kind: 'PPN_OUTPUT',
        rate: '0.11',
        taxAccountId: kasId,
      })
      .expect(422);
  });

  it('rejects a rate outside (0,1) (422)', async () => {
    await request(app.getHttpServer() as App)
      .post('/v1/tax/codes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: 'BAD-RATE',
        name: 'Bad rate',
        kind: 'PPN_OUTPUT',
        rate: '1.5',
        taxAccountId: ppnKeluaranId,
      })
      .expect(422);
  });

  it('rejects a duplicate code (409)', async () => {
    const body = {
      code: 'DUP-CODE',
      name: 'Dup',
      kind: 'PPN_OUTPUT',
      rate: '0.03',
      taxAccountId: ppnKeluaranId,
    };
    await request(app.getHttpServer() as App)
      .post('/v1/tax/codes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body)
      .expect(201);
    await request(app.getHttpServer() as App)
      .post('/v1/tax/codes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body)
      .expect(409);
  });

  it('soft-deletes a tax code (204) then it disappears from the list', async () => {
    const created = await request(app.getHttpServer() as App)
      .post('/v1/tax/codes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: 'TEMP-DEL',
        name: 'Temp',
        kind: 'PPN_OUTPUT',
        rate: '0.05',
        taxAccountId: ppnKeluaranId,
      })
      .expect(201);
    const id = (created.body as { id: string }).id;
    await request(app.getHttpServer() as App)
      .delete(`/v1/tax/codes/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);
    const list = await request(app.getHttpServer() as App)
      .get('/v1/tax/codes')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const listBody = list.body as { data: { id: string }[] };
    expect(listBody.data.some((c) => c.id === id)).toBe(false);
  });
});
