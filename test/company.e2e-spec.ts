import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { CompanyService } from '../src/company/company.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { fiscalYearForDate } from '../src/common/dates/fiscal-year';
import { asOfOrToday } from '../src/common/dates/query-dates';
import { bootstrapTestApp } from './e2e-helpers';

describe('Company settings (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let adminToken: string;
  let accountantToken: string;
  let approverToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());

    await app.get(CompanyService).seedIfEmpty();
    const users = app.get(UsersService);
    await users.create({
      email: 'admin@x.com',
      password: 'secret123',
      name: 'A',
      role: 'ADMIN',
    });
    adminToken = (await app.get(AuthService).login('admin@x.com', 'secret123'))
      .accessToken;

    const mkToken = async (
      email: string,
      role: 'ACCOUNTANT' | 'APPROVER' | 'VIEWER',
    ) => {
      await users.create({ email, password: 'secret123', name: role, role });
      return (await app.get(AuthService).login(email, 'secret123')).accessToken;
    };
    accountantToken = await mkToken('acct@x.com', 'ACCOUNTANT');
    approverToken = await mkToken('appr@x.com', 'APPROVER');
    viewerToken = await mkToken('view@x.com', 'VIEWER');
  }, 120_000);

  afterAll(() => cleanup());

  it('returns the seeded singleton with SoD enabled by default', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/v1/company/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as {
      segregationOfDutiesEnabled: boolean;
      baseCurrency: string;
      fiscalYearStartMonth: number;
    };
    expect(body.segregationOfDutiesEnabled).toBe(true);
    expect(body.baseCurrency).toBe('IDR');
    expect(body.fiscalYearStartMonth).toBe(1);
  });

  it('lets an admin toggle segregation of duties', async () => {
    await request(app.getHttpServer() as App)
      .patch('/v1/company/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ segregationOfDutiesEnabled: false })
      .expect(200)
      .expect((r) => {
        const body = r.body as { segregationOfDutiesEnabled: boolean };
        expect(body.segregationOfDutiesEnabled).toBe(false);
      });
  });

  it('seedIfEmpty is idempotent (still one row)', async () => {
    await app.get(CompanyService).seedIfEmpty();
    const count = await prisma.client.companySettings.count();
    expect(count).toBe(1);
  });

  it('AUDIT3-7: company settings GET is readable by every authenticated role; PATCH stays ADMIN', async () => {
    const get = (token: string) =>
      request(app.getHttpServer() as App)
        .get('/v1/company/settings')
        .set('Authorization', `Bearer ${token}`);
    await get(adminToken).expect(200);
    await get(accountantToken).expect(200);
    await get(approverToken).expect(200);
    await get(viewerToken).expect(200);
    await request(app.getHttpServer() as App)
      .patch('/v1/company/settings')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ segregationOfDutiesEnabled: true })
      .expect(403);
  });

  describe('fiscalYearStartMonth change', () => {
    const patchMonth = (m: number) =>
      request(app.getHttpServer() as App)
        .patch('/v1/company/settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ fiscalYearStartMonth: m });
    const periods = () =>
      prisma.client.accountingPeriod.findMany({
        orderBy: [{ fiscalYear: 'asc' }, { sequence: 'asc' }],
      });

    it('on a fresh deployment (boot periods, no JEs) is allowed and regenerates current + next FY for the new month', async () => {
      expect((await periods()).length).toBeGreaterThan(0); // boot generated them
      const res = await patchMonth(4).expect(200);
      expect(
        (res.body as { fiscalYearStartMonth: number }).fiscalYearStartMonth,
      ).toBe(4);
      const fy = fiscalYearForDate(asOfOrToday(), 4);
      const after = await periods();
      expect(after).toHaveLength(24);
      expect(after.map((p) => p.fiscalYear)).toEqual([
        ...Array<number>(12).fill(fy),
        ...Array<number>(12).fill(fy + 1),
      ]);
      expect(after[0].startDate.toISOString().slice(0, 10)).toBe(`${fy}-04-01`);
      expect(after[23].endDate.toISOString().slice(0, 10)).toBe(
        `${fy + 2}-03-31`,
      );
    });

    it('re-sending the unchanged month is a no-op (200, periods untouched)', async () => {
      const before = (await periods()).map((p) => p.id);
      await patchMonth(4).expect(200);
      expect((await periods()).map((p) => p.id)).toEqual(before);
    });

    it('rejects a change while any period is CLOSED (422)', async () => {
      const first = (await periods())[0];
      await prisma.client.accountingPeriod.update({
        where: { id: first.id },
        data: { status: 'CLOSED' },
      });
      const res = await patchMonth(1).expect(422);
      expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
      await prisma.client.accountingPeriod.update({
        where: { id: first.id },
        data: { status: 'OPEN' },
      });
    });

    it('can be changed back while still unused (200)', async () => {
      await patchMonth(1).expect(200);
      const fy = fiscalYearForDate(asOfOrToday(), 1);
      expect((await periods())[0].name).toBe(`${fy}-01`);
    });

    it('rejects a change while a year_end_closings row exists (422)', async () => {
      // An entry-less (empty-year) close: no journal entry, no closed period.
      await prisma.client.yearEndClosing.create({
        data: {
          fiscalYear: 2020,
          status: 'OPEN',
          closedAt: new Date(),
          closedBy: 'admin',
        },
      });
      const res = await patchMonth(7).expect(422);
      const body = res.body as {
        code: string;
        details: {
          journalEntriesExist: boolean;
          closedPeriodsExist: boolean;
          yearEndClosingsExist: boolean;
        };
      };
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.details).toMatchObject({
        journalEntriesExist: false,
        closedPeriodsExist: false,
        yearEndClosingsExist: true,
      });
      await prisma.client.yearEndClosing.delete({
        where: { fiscalYear: 2020 },
      });
    });

    it('a start-month change blocked on its table locks gives up after lock_timeout with a retryable 409', async () => {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let locked!: () => void;
      const isLocked = new Promise<void>((r) => (locked = r));
      // Another session holds a lock that conflicts with the change's
      // SHARE ROW EXCLUSIVE lock on journal_entries (e.g. a long write).
      const holder = prisma.transaction(
        async (tx) => {
          await tx.$executeRaw`LOCK TABLE journal_entries IN ROW EXCLUSIVE MODE`;
          locked();
          await held;
        },
        { timeout: 30_000 },
      );
      await isLocked;
      try {
        const started = Date.now();
        const res = await patchMonth(7);
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
          code: 'CONFLICT',
          details: { retryable: true },
        });
        expect(Date.now() - started).toBeLessThan(15_000);
      } finally {
        release();
        await holder;
      }
    }, 30_000);

    it('rejects a change once a journal entry exists, even a draft (422)', async () => {
      await prisma.client.journalEntry.create({
        data: {
          date: new Date('2026-01-05'),
          description: 'draft',
          sourceType: 'MANUAL',
          createdBy: 'someone',
        },
      });
      const res = await patchMonth(7).expect(422);
      expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
      expect(
        (res.body as { details: { journalEntriesExist: boolean } }).details
          .journalEntriesExist,
      ).toBe(true);
    });
  });
});
