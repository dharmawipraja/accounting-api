import { INestApplication } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AuthService } from '../src/auth/auth.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapAdmin } from '../scripts/create-admin';
import { bootstrapTestApp } from './e2e-helpers';

/**
 * scripts/create-admin.ts core (bootstrapAdmin) against a real DB: the
 * operator-chosen password is a temp password (mustChangePassword), and the
 * break-glass reset of an existing user revokes every refresh token.
 */
describe('create-admin bootstrap (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let pool: Pool;
  let client: PrismaClient;
  const server = () => app.getHttpServer() as App;

  beforeAll(async () => {
    let dbUrl: string;
    ({
      app,
      prisma,
      cleanup,
      db: { url: dbUrl },
    } = await bootstrapTestApp());
    await app.get(AccountsService).seedIfEmpty();
    pool = new Pool({ connectionString: dbUrl });
    client = new PrismaClient({ adapter: new PrismaPg(pool) });
  }, 120_000);

  afterAll(async () => {
    await client.$disconnect();
    await pool.end();
    await cleanup();
  });

  const expectChangeRequired = async (token: string) => {
    const res = await request(server())
      .get('/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect((res.body as { code: string }).code).toBe(
      'PASSWORD_CHANGE_REQUIRED',
    );
  };

  it('creates a new ADMIN that must change its password on first login', async () => {
    const r = await bootstrapAdmin(client, {
      email: '  First@Admin.Test ',
      password: 'operator-pw-1',
      name: 'First Admin',
    });
    expect(r).toMatchObject({ email: 'first@admin.test', created: true });
    const row = await prisma.client.user.findUniqueOrThrow({
      where: { id: r.id },
    });
    expect(row).toMatchObject({
      role: 'ADMIN',
      isActive: true,
      mustChangePassword: true,
    });

    const login = await request(server())
      .post('/v1/auth/login')
      .send({ email: 'first@admin.test', password: 'operator-pw-1' })
      .expect(200);
    const token = (login.body as { accessToken: string }).accessToken;
    await expectChangeRequired(token);
    await request(server())
      .post('/v1/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({
        currentPassword: 'operator-pw-1',
        newPassword: 'chosen-by-admin-1',
      })
      .expect(200);
    await request(server())
      .get('/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('resets an existing (demoted, deactivated) user: ADMIN + active + temp password, all refresh tokens revoked', async () => {
    const u = await app.get(UsersService).create({
      email: 'locked@admin.test',
      password: 'old-password-1',
      name: 'Locked',
      role: 'VIEWER',
    });
    const pair1 = await app
      .get(AuthService)
      .login('locked@admin.test', 'old-password-1');
    const pair2 = await app
      .get(AuthService)
      .login('locked@admin.test', 'old-password-1');
    await prisma.client.user.update({
      where: { id: u.id },
      data: { isActive: false },
    });

    const r = await bootstrapAdmin(client, {
      email: 'LOCKED@admin.test',
      password: 'break-glass-pw-1',
      name: 'Recovered Admin',
    });
    expect(r).toEqual({
      id: u.id,
      email: 'locked@admin.test',
      created: false,
    });

    const row = await prisma.client.user.findUniqueOrThrow({
      where: { id: u.id },
    });
    expect(row).toMatchObject({
      role: 'ADMIN',
      isActive: true,
      mustChangePassword: true,
      name: 'Recovered Admin',
    });
    const tokens = await prisma.client.refreshToken.findMany({
      where: { userId: u.id },
    });
    expect(tokens.length).toBeGreaterThanOrEqual(2);
    expect(tokens.every((t) => t.status === 'REVOKED')).toBe(true);
    for (const pair of [pair1, pair2]) {
      await request(server())
        .post('/v1/auth/refresh')
        .send({ refreshToken: pair.refreshToken })
        .expect(401);
    }

    // Old password is gone; the new one logs in but is a temp password.
    await request(server())
      .post('/v1/auth/login')
      .send({ email: 'locked@admin.test', password: 'old-password-1' })
      .expect(401);
    const login = await request(server())
      .post('/v1/auth/login')
      .send({ email: 'locked@admin.test', password: 'break-glass-pw-1' })
      .expect(200);
    const token = (login.body as { accessToken: string }).accessToken;
    await expectChangeRequired(token);
    await request(server())
      .post('/v1/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({
        currentPassword: 'break-glass-pw-1',
        newPassword: 'recovered-pw-99',
      })
      .expect(200);
    await request(server())
      .get('/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('rejects a password the login endpoint could never accept, writing nothing', async () => {
    await expect(
      bootstrapAdmin(client, {
        email: 'short@admin.test',
        password: 'short',
        name: 'S',
      }),
    ).rejects.toThrow(/8-128 characters/);
    expect(
      await prisma.client.user.count({ where: { email: 'short@admin.test' } }),
    ).toBe(0);
  });
});
