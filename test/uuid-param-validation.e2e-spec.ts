import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { CompanyService } from '../src/company/company.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';

describe('UUID param validation (e2e)', () => {
  let app: INestApplication;
  let cleanup: () => Promise<void>;
  let token: string; // viewer token

  const server = () => app.getHttpServer() as App;
  const get = (url: string) =>
    request(server()).get(url).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    ({ app, cleanup } = await bootstrapTestApp());
    await app.get(CompanyService).seedIfEmpty();
    await app.get(AccountsService).seedIfEmpty();
    await app.get(TaxCodesService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    const users = app.get(UsersService);
    await users.create({
      email: 'viewer@uuid.test',
      password: 'secret123',
      name: 'Viewer',
      role: 'VIEWER',
    });
    token = (await app.get(AuthService).login('viewer@uuid.test', 'secret123'))
      .accessToken;
  }, 120_000);

  afterAll(() => cleanup());

  // --- sales-invoices ---
  it('rejects a malformed :id with 400', () =>
    get('/v1/sales-invoices/not-a-uuid').expect(400));

  it('returns 404 for a well-formed but missing id', () =>
    get('/v1/sales-invoices/00000000-0000-0000-0000-000000000000').expect(404));

  // --- spot-check one per controller family ---
  it('accounts: malformed id -> 400', () =>
    get('/v1/ledger/accounts/not-a-uuid').expect(400));

  it('tax-codes: malformed id -> 400', () =>
    get('/v1/tax/codes/not-a-uuid').expect(400));

  it('payments: malformed id -> 400', () =>
    get('/v1/payments/not-a-uuid').expect(400));
});
