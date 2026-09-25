import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { CompanyService } from '../src/company/company.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { asOfOrToday } from '../src/common/dates/query-dates';
import { bootstrapTestApp } from './e2e-helpers';

describe('Periods (e2e)', () => {
  let app: INestApplication;
  let cleanup: () => Promise<void>;
  let adminToken: string;
  let periodsService: PeriodsService;
  let prisma: PrismaService;

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

  describe('auto-generation', () => {
    let current: number;
    let acc: Record<string, string>;
    const entry = (date: string) => ({
      date: new Date(date),
      description: 'auto-gen probe',
      sourceType: 'MANUAL' as const,
      createdBy: 'creator',
      lines: [
        { accountId: acc['1-1000'], debit: '1000' },
        { accountId: acc['4-1000'], credit: '1000' },
      ],
    });

    beforeAll(async () => {
      // "Today" is the WIB calendar day (REPORT_UTC_OFFSET_MINUTES), not UTC.
      current = await app.get(CompanyService).fiscalYearFor(asOfOrToday());
      const { data } = await app.get(AccountsService).list({ limit: 200 });
      acc = Object.fromEntries(data.map((a) => [a.code, a.id]));
    });

    it('boot generated the current AND the next fiscal year', async () => {
      expect(await periodsService.list(current)).toHaveLength(12);
      expect(await periodsService.list(current + 1)).toHaveLength(12);
    });

    it('posting into next year with no periods generates that year, then posts', async () => {
      await prisma.client.accountingPeriod.deleteMany({
        where: { fiscalYear: current + 1 },
      });
      const je = await app
        .get(PostingService)
        .post(entry(`${current + 1}-02-10`), 'poster');
      expect(je.status).toBe('POSTED');
      expect(await periodsService.list(current + 1)).toHaveLength(12);
    });

    it('posting into an earlier year with no periods generates it too', async () => {
      expect(await periodsService.list(current - 1)).toHaveLength(0);
      const je = await app
        .get(PostingService)
        .post(entry(`${current - 1}-05-10`), 'poster');
      expect(je.fiscalYear).toBe(current - 1);
      expect(await periodsService.list(current - 1)).toHaveLength(12);
    });

    it('a date beyond next year is still rejected (CLOSED_PERIOD) and generates nothing', async () => {
      await expect(
        app.get(PostingService).post(entry(`${current + 2}-01-15`), 'poster'),
      ).rejects.toMatchObject({ code: 'CLOSED_PERIOD' });
      expect(await periodsService.list(current + 2)).toHaveLength(0);
    });

    it('a CLOSED period is not regenerated: posting there stays rejected', async () => {
      const p = (await periodsService.list(current - 1))[4]; // month 5
      await periodsService.close(p.id, 'closer');
      await expect(
        app.get(PostingService).post(entry(`${current - 1}-05-20`), 'poster'),
      ).rejects.toMatchObject({ code: 'CLOSED_PERIOD' });
      expect(await periodsService.list(current - 1)).toHaveLength(12);
    });
  });
});
