import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { randomUUID } from 'crypto';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';

describe('TaxCodes (e2e)', () => {
  let app: INestApplication;
  let cleanup: () => Promise<void>;
  let adminToken: string;
  let ppnKeluaranId: string; // 2-1100 CREDIT-normal (suits PPN_OUTPUT / PPH_COLLECTED)
  let ppnMasukanId: string; // 1-1400 DEBIT-normal (suits PPN_INPUT / PPH_PREPAID)
  let kasId: string; // 1-1000 DEBIT-normal (wrong side for PPN_OUTPUT)
  let headerAccountId: string; // 1-0000 non-postable header account

  const post = (body: object) =>
    request(app.getHttpServer() as App)
      .post('/v1/tax/codes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body);

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
    ppnMasukanId = accountsPage.data.find((a) => a.code === '1-1400')!.id;
    kasId = accountsPage.data.find((a) => a.code === '1-1000')!.id;
    headerAccountId = accountsPage.data.find((a) => a.code === '1-0000')!.id;
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
    const res = await post({
      code: 'PPN-OUT-12',
      name: 'PPN Keluaran 12%',
      kind: 'PPN_OUTPUT',
      rate: '0.12',
      taxAccountId: ppnKeluaranId,
    }).expect(201);
    expect((res.body as { kind: string }).kind).toBe('PPN_OUTPUT');
  });

  // T-1 (CREDIT arm of requiredNormalBalance): PPN_OUTPUT requires CREDIT-normal account.
  // Using a DEBIT-normal account (1-1000 Kas) must reject at the service layer.
  it('rejects a PPN_OUTPUT code pointed at a DEBIT-normal account — wrong normalBalance (422)', async () => {
    const res = await post({
      code: 'BAD-SIDE',
      name: 'Wrong side',
      kind: 'PPN_OUTPUT',
      rate: '0.11',
      taxAccountId: kasId,
    }).expect(422);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  // T-1 (CREDIT arm positive path): PPN_INPUT requires DEBIT-normal; PPN_OUTPUT + CREDIT-normal succeeds — already tested above.
  // This also exercises requiredNormalBalance CREDIT arm via PPN_OUTPUT+ppnKeluaranId (2-1100).

  // T-2: rate >= 1 passes DTO regex (\d+ matches '5') but service rejects with 422.
  it('rejects a rate >= 1 — service guard "rate not in (0,1)" (422)', async () => {
    const res = await post({
      code: 'BAD-RATE-HIGH',
      name: 'Bad rate high',
      kind: 'PPN_OUTPUT',
      rate: '5',
      taxAccountId: ppnKeluaranId,
    }).expect(422);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  // T-2: rate = 0 passes DTO regex but is rejected at the service "not in (0,1)" guard.
  it('rejects rate = 0 — service guard "rate not in (0,1)" (422)', async () => {
    const res = await post({
      code: 'BAD-RATE-ZERO',
      name: 'Bad rate zero',
      kind: 'PPN_INPUT',
      rate: '0',
      taxAccountId: ppnMasukanId,
    }).expect(422);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  // NOTE — DTO-shadowed guards (effectively (b)):
  // - rate with non-numeric chars (e.g. "abc"): DTO @Matches rejects with 400 before service.
  // - rate with > 6 decimal places (e.g. "0.1234567"): DTO @Matches rejects with 400 before service.
  // Both are confirmed DTO-shadowed; the service branches at lines 46-50 and 57-62 are unreachable via HTTP.

  // T-3: non-postable (header) account — service validates isPostable in validateAccountForKind.
  it('rejects a tax code linked to a non-postable header account (422)', async () => {
    const res = await post({
      code: 'BAD-ACCT',
      name: 'Non-postable account',
      kind: 'PPN_INPUT',
      rate: '0.11',
      taxAccountId: headerAccountId,
    }).expect(422);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  // T-4: findById on unknown id returns 404.
  it('GET /tax-codes/:nonexistent returns 404', async () => {
    const res = await request(app.getHttpServer() as App)
      .get(`/v1/tax/codes/${randomUUID()}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
    expect((res.body as { code: string }).code).toBe('NOT_FOUND');
  });

  // T-5: update with an invalid rate — the rate-validation branch in update().
  // rate='1' passes DTO regex but service rejects with 422.
  it('PATCH /tax-codes/:id with rate >= 1 triggers update rate-validation branch (422)', async () => {
    const created = await post({
      code: 'UPDATE-RATE-TEST',
      name: 'Rate update test',
      kind: 'PPN_OUTPUT',
      rate: '0.05',
      taxAccountId: ppnKeluaranId,
    }).expect(201);
    const id = (created.body as { id: string }).id;
    const res = await request(app.getHttpServer() as App)
      .patch(`/v1/tax/codes/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ rate: '2' })
      .expect(422);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('rejects a duplicate code (409)', async () => {
    const body = {
      code: 'DUP-CODE',
      name: 'Dup',
      kind: 'PPN_OUTPUT',
      rate: '0.03',
      taxAccountId: ppnKeluaranId,
    };
    await post(body).expect(201);
    const res = await post(body).expect(409);
    expect((res.body as { code: string }).code).toBe('CONFLICT');
  });

  it('soft-deletes a tax code (204) then it disappears from the list', async () => {
    const created = await post({
      code: 'TEMP-DEL',
      name: 'Temp',
      kind: 'PPN_OUTPUT',
      rate: '0.05',
      taxAccountId: ppnKeluaranId,
    }).expect(201);
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
