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
  let kasId: string; // 1-1000 Kas: CASH role (SYSTEM_ROLE for any tax kind)
  let headerAccountId: string; // 1-0000 non-postable header account
  let utangBankId: string; // 2-2000 CREDIT-normal NON_CURRENT_LIABILITY (not a tax subtype)

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
    utangBankId = accountsPage.data.find((a) => a.code === '2-2000')!.id;
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
  // Using a DEBIT-normal role-less account (1-1400 PPN Masukan) must reject at the
  // service layer (1-1000 Kas would trip SYSTEM_ROLE first — see the next test).
  it('rejects a PPN_OUTPUT code pointed at a DEBIT-normal account — wrong normalBalance (422)', async () => {
    const res = await post({
      code: 'BAD-SIDE',
      name: 'Wrong side',
      kind: 'PPN_OUTPUT',
      rate: '0.11',
      taxAccountId: ppnMasukanId,
    }).expect(422);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'NORMAL_BALANCE' },
    });
  });

  it('rejects a tax code pointed at a system-role (CASH) account (422 SYSTEM_ROLE)', async () => {
    const res = await post({
      code: 'BAD-ROLE',
      name: 'On cash',
      kind: 'PPN_INPUT',
      rate: '0.11',
      taxAccountId: kasId,
    }).expect(422);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'SYSTEM_ROLE', role: 'CASH' },
    });
  });

  it('rejects a tax code pointed at a non-tax subtype (e.g. bank loan) (422 SUBTYPE)', async () => {
    const res = await post({
      code: 'BAD-SUBTYPE',
      name: 'On bank loan',
      kind: 'PPH_PAYABLE',
      rate: '0.02',
      taxAccountId: utangBankId,
    }).expect(422);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'SUBTYPE', required: 'TAX_PAYABLE' },
    });
  });

  it('refuses the CASH role on an account used by a soft-deleted tax code (422 TAX_ACCOUNT)', async () => {
    const acct = await request(app.getHttpServer() as App)
      .post('/v1/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '1-1450',
        name: 'PPN Masukan Lain',
        type: 'ASSET',
        subtype: 'TAX_RECEIVABLE',
        normalBalance: 'DEBIT',
        parentCode: '1-0000',
      })
      .expect(201);
    const accountId = (acct.body as { id: string }).id;
    const code = await post({
      code: 'PPN-IN-X',
      name: 'Temp input',
      kind: 'PPN_INPUT',
      rate: '0.11',
      taxAccountId: accountId,
    }).expect(201);
    await request(app.getHttpServer() as App)
      .delete(`/v1/tax/codes/${(code.body as { id: string }).id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);
    const res = await request(app.getHttpServer() as App)
      .patch(`/v1/ledger/accounts/${accountId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'CASH' })
      .expect(422);
    expect(res.body).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'TAX_ACCOUNT' },
    });
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

  it('iter8: tax codes are unique case-insensitively after NFKC + trim (409); blank / zero-width codes are 400; a tombstoned code is reusable', async () => {
    const body = {
      name: 'PPN Kasus',
      kind: 'PPN_OUTPUT',
      rate: '0.04',
      taxAccountId: ppnKeluaranId,
    };
    const created = await post({ ...body, code: 'ppn-ci' }).expect(201);
    for (const code of ['PPN-CI', 'ppn-ci ', 'ＰＰＮ-ＣＩ']) {
      const res = await post({ ...body, code }).expect(409);
      expect((res.body as { code: string }).code).toBe('CONFLICT');
    }
    for (const code of ['', ' \t ', 'PPN\u200BCI', '\uFEFF']) {
      const res = await post({ ...body, code }).expect(400);
      expect((res.body as { code: string }).code).toBe('HTTP_400');
    }
    await post({ ...body, code: 'PPN-NM', name: '  ' }).expect(400);
    await request(app.getHttpServer() as App)
      .delete(`/v1/tax/codes/${(created.body as { id: string }).id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);
    const reused = await post({ ...body, code: ' PPN-CI ' }).expect(201);
    expect((reused.body as { code: string }).code).toBe('PPN-CI');
  });

  it('iter8-final: the service normalizes code / name itself (a caller bypassing the DTO)', async () => {
    const svc = app.get(TaxCodesService);
    const created = await svc.create({
      code: ' ＳＶＣ-ＴＸ ',
      name: '  Direct  ',
      kind: 'PPN_OUTPUT',
      rate: '0.02',
      taxAccountId: ppnKeluaranId,
    });
    expect(created.code).toBe('SVC-TX');
    expect(created.name).toBe('Direct');
    const renamed = await svc.update(created.id, { name: ' Renamed ' });
    expect(renamed.name).toBe('Renamed');
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
