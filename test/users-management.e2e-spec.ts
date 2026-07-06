import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';

describe('User management (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let adminToken: string;
  let adminId: string;
  const server = () => app.getHttpServer() as App;

  const login = async (email: string, password: string) =>
    (await app.get(AuthService).login(email, password)).accessToken;

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());
    await app.get(AccountsService).seedIfEmpty();
    const admin = await app.get(UsersService).create({
      email: 'admin@um.test',
      password: 'secret123',
      name: 'Admin',
      role: 'ADMIN',
    });
    adminId = admin.id;
    adminToken = await login('admin@um.test', 'secret123');
  }, 120_000);

  afterAll(() => cleanup());

  it('bootstrap sanity: the admin token resolves to the admin user via /auth/me', async () => {
    const res = await request(server())
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((res.body as { id: string }).id).toBe(adminId);
  });

  describe('per-request freshness', () => {
    it('a deactivated user is rejected on the very next request (401)', async () => {
      const u = await app.get(UsersService).create({
        email: 'fresh@um.test',
        password: 'secret123',
        name: 'F',
        role: 'VIEWER',
      });
      const token = await login('fresh@um.test', 'secret123');
      await request(server())
        .get('/v1/ledger/accounts')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      await prisma.client.user.update({
        where: { id: u.id },
        data: { isActive: false },
      });
      // Same still-valid access token — must now be rejected immediately.
      await request(server())
        .get('/v1/ledger/accounts')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('a role change takes effect on the next request without re-login', async () => {
      const u = await app.get(UsersService).create({
        email: 'promo@um.test',
        password: 'secret123',
        name: 'P',
        role: 'VIEWER',
      });
      const token = await login('promo@um.test', 'secret123');
      // VIEWER cannot create a partner (ACCOUNTANT+ write) → 403.
      await request(server())
        .post('/v1/partners')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: 'UM-P1', name: 'X', isCustomer: true })
        .expect(403);
      await prisma.client.user.update({
        where: { id: u.id },
        data: { role: 'ACCOUNTANT' },
      });
      // Same token, live role → allowed now.
      await request(server())
        .post('/v1/partners')
        .set('Authorization', `Bearer ${token}`)
        .send({ code: 'UM-P1', name: 'X', isCustomer: true })
        .expect(201);
    });
  });

  describe('forced password change', () => {
    let uid: string;
    let token: string;

    beforeAll(async () => {
      const u = await app.get(UsersService).create({
        email: 'temp@um.test',
        password: 'temp-pass-123',
        name: 'T',
        role: 'ACCOUNTANT',
      });
      uid = u.id;
      await prisma.client.user.update({
        where: { id: uid },
        data: { mustChangePassword: true },
      });
      token = await login('temp@um.test', 'temp-pass-123');
    });

    it('blocks business endpoints with 403 PASSWORD_CHANGE_REQUIRED', async () => {
      const res = await request(server())
        .get('/v1/ledger/accounts')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
      expect((res.body as { code: string }).code).toBe(
        'PASSWORD_CHANGE_REQUIRED',
      );
    });

    it('still allows /auth/me while pending', async () => {
      const res = await request(server())
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(
        (res.body as { mustChangePassword: boolean }).mustChangePassword,
      ).toBe(true);
    });

    it('rejects a wrong current password (401) and a short new one (400)', async () => {
      await request(server())
        .post('/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: 'wrong', newPassword: 'long-enough-pw' })
        .expect(401);
      await request(server())
        .post('/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ currentPassword: 'temp-pass-123', newPassword: 'short' })
        .expect(400);
    });

    it('change-password unblocks the user and revokes refresh tokens', async () => {
      const pair = await app
        .get(AuthService)
        .login('temp@um.test', 'temp-pass-123');
      await request(server())
        .post('/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({
          currentPassword: 'temp-pass-123',
          newPassword: 'brand-new-pw-9',
        })
        .expect(200);
      // Unblocked on the next request (flag cleared, fresh read per request).
      await request(server())
        .get('/v1/ledger/accounts')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      // Old refresh token is revoked.
      await request(server())
        .post('/v1/auth/refresh')
        .send({ refreshToken: pair.refreshToken })
        .expect(401);
      // New password works; old one doesn't.
      await request(server())
        .post('/v1/auth/login')
        .send({ email: 'temp@um.test', password: 'temp-pass-123' })
        .expect(401);
      token = await login('temp@um.test', 'brand-new-pw-9');
    });
  });
});
