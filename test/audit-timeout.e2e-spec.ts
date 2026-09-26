import './audit-timeout-env';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { bootstrapTestApp } from './e2e-helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** AUDIT3-IT2: a request cut off by RequestTimeoutInterceptor (408) must still
 *  write exactly ONE audit row; a normal success must also write exactly one. */
describe('Audit covers timed-out requests (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let token: string;

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());
    await app.get(UsersService).create({
      email: 'admin@audit-timeout.test',
      password: 'secret123',
      name: 'Admin',
      role: 'ADMIN',
    });
    token = (
      await app.get(AuthService).login('admin@audit-timeout.test', 'secret123')
    ).accessToken;
  }, 120_000);

  afterAll(() => cleanup());
  afterEach(() => jest.restoreAllMocks());

  it('a 408 mutating request writes exactly one audit row with status 408', async () => {
    const partners = app.get(BusinessPartnersService);
    jest.spyOn(partners, 'create').mockImplementation(async () => {
      await sleep(2_500); // slower than REQUEST_TIMEOUT_MS (1500)
      throw new Error('stub handler should have been cut off');
    });
    const before = await prisma.client.auditLog.count();
    await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'TMO-1', name: 'Slow', isCustomer: true })
      .expect(408);
    // Let the stub settle — a late handler completion must not add a 2nd row.
    await sleep(1_500);
    const rows = await prisma.client.auditLog.findMany({
      where: { path: '/v1/partners', method: 'POST' },
      orderBy: { timestamp: 'asc' },
    });
    expect(await prisma.client.auditLog.count()).toBe(before + 1);
    expect(rows[rows.length - 1].statusCode).toBe(408);
  }, 20_000);

  it('a successful mutating request still writes exactly one row', async () => {
    const before = await prisma.client.auditLog.count();
    await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'TMO-2', name: 'Fast', isCustomer: true })
      .expect(201);
    expect(await prisma.client.auditLog.count()).toBe(before + 1);
  });
});
