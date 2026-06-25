import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';

describe('Periods (e2e)', () => {
  let app: INestApplication;
  let cleanup: () => Promise<void>;
  let adminToken: string;
  let periodsService: PeriodsService;

  beforeAll(async () => {
    ({ app, cleanup } = await bootstrapTestApp());

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

    periodsService = app.get(PeriodsService);
  }, 120_000);

  afterAll(() => cleanup());

  it('generates 12 periods for fiscal year 2026', async () => {
    await request(app.getHttpServer() as App)
      .post('/v1/ledger/periods/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fiscalYear: 2026 })
      .expect(201);

    const periods = await periodsService.list(2026);
    expect(periods).toHaveLength(12);
    expect(periods[0].name).toBe('2026-01');
  });

  it('findOpenPeriodForDate returns the correct open period', async () => {
    const period = await periodsService.findOpenPeriodForDate(
      new Date('2026-03-15'),
    );
    expect(period).not.toBeNull();
    expect(period!.name).toBe('2026-03');
  });

  it('findOpenPeriodForDate is inclusive on month boundaries and ignores time-of-day', async () => {
    const first = await periodsService.findOpenPeriodForDate(
      new Date(Date.UTC(2026, 0, 1)), // 1 Jan
    );
    expect(first!.name).toBe('2026-01');
    const last = await periodsService.findOpenPeriodForDate(
      new Date(Date.UTC(2026, 11, 31)), // 31 Dec
    );
    expect(last!.name).toBe('2026-12');
    // A date carrying a time-of-day on the last day of February still resolves.
    const timed = await periodsService.findOpenPeriodForDate(
      new Date('2026-02-28T18:30:00Z'),
    );
    expect(timed!.name).toBe('2026-02');
  });

  it('closes a period (200) and then findOpenPeriodForDate returns null', async () => {
    const periods = await periodsService.list(2026);
    const march = periods.find((p) => p.name === '2026-03')!;

    await request(app.getHttpServer() as App)
      .post(`/v1/ledger/periods/${march.id}/close`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const found = await periodsService.findOpenPeriodForDate(
      new Date('2026-03-15'),
    );
    expect(found).toBeNull();
  });

  it('reopens a period (200) and findOpenPeriodForDate returns the period again', async () => {
    const periods = await periodsService.list(2026);
    const march = periods.find((p) => p.name === '2026-03')!;

    await request(app.getHttpServer() as App)
      .post(`/v1/ledger/periods/${march.id}/reopen`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const found = await periodsService.findOpenPeriodForDate(
      new Date('2026-03-15'),
    );
    expect(found).not.toBeNull();
    expect(found!.name).toBe('2026-03');
  });

  it('generatePeriods is idempotent (still 12 periods after second call)', async () => {
    await request(app.getHttpServer() as App)
      .post('/v1/ledger/periods/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fiscalYear: 2026 })
      .expect(201);

    const periods = await periodsService.list(2026);
    expect(periods).toHaveLength(12);
  });

  it('rejects closing a non-existent period id (404 NOT_FOUND)', async () => {
    // L-21: PeriodsService.close — period not found
    const res = await request(app.getHttpServer() as App)
      .post('/v1/ledger/periods/00000000-0000-0000-0000-000000000000/close')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
    expect((res.body as { code: string }).code).toBe('NOT_FOUND');
  });

  it('rejects closing an already-closed period (409 CONFLICT)', async () => {
    // L-22: PeriodsService.close — period is already CLOSED
    const periods = await periodsService.list(2026);
    const june = periods.find((p) => p.name === '2026-06')!;
    await request(app.getHttpServer() as App)
      .post(`/v1/ledger/periods/${june.id}/close`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const res = await request(app.getHttpServer() as App)
      .post(`/v1/ledger/periods/${june.id}/close`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409);
    expect((res.body as { code: string }).code).toBe('CONFLICT');
  });

  it('rejects reopening a non-existent period id (404 NOT_FOUND)', async () => {
    // L-23: PeriodsService.reopen — period not found
    const res = await request(app.getHttpServer() as App)
      .post('/v1/ledger/periods/00000000-0000-0000-0000-000000000000/reopen')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
    expect((res.body as { code: string }).code).toBe('NOT_FOUND');
  });

  it('rejects reopening an already-open period (409 CONFLICT)', async () => {
    // L-24: PeriodsService.reopen — period is already OPEN
    const periods = await periodsService.list(2026);
    const july = periods.find((p) => p.name === '2026-07')!;
    const res = await request(app.getHttpServer() as App)
      .post(`/v1/ledger/periods/${july.id}/reopen`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(409);
    expect((res.body as { code: string }).code).toBe('CONFLICT');
  });
});
