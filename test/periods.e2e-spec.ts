import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('Periods (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prismaOverride: PrismaService;
  let adminToken: string;
  let periodsService: PeriodsService;

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

    periodsService = app.get(PeriodsService);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prismaOverride.$disconnect();
    await db?.stop();
  });

  it('generates 12 periods for fiscal year 2026', async () => {
    await request(app.getHttpServer() as App)
      .post('/ledger/periods/generate')
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

  it('closes a period (200) and then findOpenPeriodForDate returns null', async () => {
    const periods = await periodsService.list(2026);
    const march = periods.find((p) => p.name === '2026-03')!;

    await request(app.getHttpServer() as App)
      .post(`/ledger/periods/${march.id}/close`)
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
      .post(`/ledger/periods/${march.id}/reopen`)
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
      .post('/ledger/periods/generate')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ fiscalYear: 2026 })
      .expect(201);

    const periods = await periodsService.list(2026);
    expect(periods).toHaveLength(12);
  });
});
