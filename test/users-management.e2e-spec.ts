import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { UserAdminService } from '../src/users/user-admin.service';
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

  describe('ADMIN user management', () => {
    it('non-ADMIN gets 403 on /v1/users', async () => {
      const t = await (async () => {
        await app.get(UsersService).create({
          email: 'acct@um.test',
          password: 'secret123',
          name: 'A',
          role: 'ACCOUNTANT',
        });
        return login('acct@um.test', 'secret123');
      })();
      await request(server())
        .get('/v1/users')
        .set('Authorization', `Bearer ${t}`)
        .expect(403);
    });

    it('creates a user, returns the temp password once, and forces change on first login', async () => {
      const res = await request(server())
        .post('/v1/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: 'new@um.test', name: 'New', role: 'APPROVER' })
        .expect(201);
      const body = res.body as {
        user: {
          id: string;
          email: string;
          role: string;
          mustChangePassword: boolean;
        };
        tempPassword: string;
      };
      expect(body.user.email).toBe('new@um.test');
      expect(body.user.mustChangePassword).toBe(true);
      expect(body.tempPassword).toHaveLength(16);
      expect(JSON.stringify(body)).not.toContain('passwordHash');
      // Temp password logs in but is immediately gated.
      const t = await login('new@um.test', body.tempPassword);
      const gated = await request(server())
        .get('/v1/ledger/accounts')
        .set('Authorization', `Bearer ${t}`)
        .expect(403);
      expect((gated.body as { code: string }).code).toBe(
        'PASSWORD_CHANGE_REQUIRED',
      );
    });

    it('duplicate email → 409; lists come enveloped with filters', async () => {
      await request(server())
        .post('/v1/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: 'new@um.test', name: 'Dup', role: 'VIEWER' })
        .expect(409);
      const list = await request(server())
        .get('/v1/users?role=APPROVER&isActive=true')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const body = list.body as {
        data: { role: string }[];
        total: number;
        limit: number;
        offset: number;
      };
      expect(body.limit).toBe(50);
      expect(body.data.every((u) => u.role === 'APPROVER')).toBe(true);
      expect(body.total).toBeGreaterThanOrEqual(1);
    });

    it('gets one user by id; 404 for unknown', async () => {
      await request(server())
        .get(`/v1/users/${adminId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      await request(server())
        .get('/v1/users/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });

    it('PATCH updates name/role/isActive; role change revokes refresh tokens', async () => {
      const created = await request(server())
        .post('/v1/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: 'patch@um.test', name: 'P', role: 'VIEWER' })
        .expect(201);
      const { user, tempPassword } = created.body as {
        user: { id: string };
        tempPassword: string;
      };
      const pair = await app
        .get(AuthService)
        .login('patch@um.test', tempPassword);
      const res = await request(server())
        .patch(`/v1/users/${user.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'ACCOUNTANT', name: 'Patched' })
        .expect(200);
      expect((res.body as { role: string; name: string }).role).toBe(
        'ACCOUNTANT',
      );
      // Refresh family revoked by the role change:
      await request(server())
        .post('/v1/auth/refresh')
        .send({ refreshToken: pair.refreshToken })
        .expect(401);
    });

    it('self-guards: cannot change own role or deactivate self (422)', async () => {
      await request(server())
        .patch(`/v1/users/${adminId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'VIEWER' })
        .expect(422);
      await request(server())
        .patch(`/v1/users/${adminId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: false })
        .expect(422);
      // Changing own NAME is allowed.
      await request(server())
        .patch(`/v1/users/${adminId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Root Admin' })
        .expect(200);
    });

    it('last-admin guard: an update that would leave zero active ADMINs is refused', async () => {
      // The HTTP self-guard fires before the last-admin count when an admin
      // targets themselves, so exercise the last-admin branch at the service
      // layer with a DIFFERENT actor id (roles are enforced at HTTP, not in
      // the service — this is the exact code path a second admin would hit).
      const svc = app.get(UserAdminService);
      const other = await app.get(UsersService).create({
        email: 'actor@um.test',
        password: 'secret123',
        name: 'Actor',
        role: 'ADMIN',
      });
      // Demote the extra admin back down so exactly one active ADMIN remains…
      await svc.update(adminId, other.id, { role: 'VIEWER' });
      // …then any non-self attempt to demote or deactivate the last one → 422.
      await expect(
        svc.update(other.id, adminId, { role: 'VIEWER' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        svc.update(other.id, adminId, { isActive: false }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('reset-password returns a new temp password, forces change, revokes sessions', async () => {
      const created = await request(server())
        .post('/v1/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: 'reset@um.test', name: 'R', role: 'VIEWER' })
        .expect(201);
      const id = (created.body as { user: { id: string } }).user.id;
      const oldTemp = (created.body as { tempPassword: string }).tempPassword;
      const pair = await app.get(AuthService).login('reset@um.test', oldTemp);

      const reset = await request(server())
        .post(`/v1/users/${id}/reset-password`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const newTemp = (reset.body as { tempPassword: string }).tempPassword;
      expect(newTemp).toHaveLength(16);
      expect(newTemp).not.toBe(oldTemp);
      await request(server())
        .post('/v1/auth/refresh')
        .send({ refreshToken: pair.refreshToken })
        .expect(401); // sessions revoked
      await request(server())
        .post('/v1/auth/login')
        .send({ email: 'reset@um.test', password: oldTemp })
        .expect(401); // old password dead
      await app.get(AuthService).login('reset@um.test', newTemp); // new one works
    });

    it('DELETE soft-deletes (404 afterwards, email reusable), self/last-admin refused', async () => {
      const created = await request(server())
        .post('/v1/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: 'del@um.test', name: 'D', role: 'VIEWER' })
        .expect(201);
      const id = (created.body as { user: { id: string } }).user.id;
      await request(server())
        .delete(`/v1/users/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(204);
      await request(server())
        .get(`/v1/users/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
      // Email reusable after tombstone:
      await request(server())
        .post('/v1/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: 'del@um.test', name: 'D2', role: 'VIEWER' })
        .expect(201);
      // Self-delete refused:
      await request(server())
        .delete(`/v1/users/${adminId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(422);
    });

    it('last-admin guard: deleting the only active ADMIN is refused (422)', async () => {
      // Service-level with a second actor id (roles are enforced at HTTP):
      // by this point in the suite adminId is the sole active ADMIN.
      const svc = app.get(UserAdminService);
      const viewer = await app.get(UsersService).create({
        email: 'delactor@um.test',
        password: 'secret123',
        name: 'DelActor',
        role: 'VIEWER',
      });
      await expect(svc.remove(viewer.id, adminId)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    });

    it('reset-password on a soft-deleted user is 404 (guarded write, no read-then-write race)', async () => {
      const created = await request(server())
        .post('/v1/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: 'gone@um.test', name: 'G', role: 'VIEWER' })
        .expect(201);
      const id = (created.body as { user: { id: string } }).user.id;
      await request(server())
        .delete(`/v1/users/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(204);
      await request(server())
        .post(`/v1/users/${id}/reset-password`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(404);
    });
  });

  describe('change-password throttle', () => {
    it('rate-limits change-password attempts (429 after the per-route budget)', async () => {
      await app.get(UsersService).create({
        email: 'brute@um.test',
        password: 'secret123',
        name: 'B',
        role: 'VIEWER',
      });
      const token = await login('brute@um.test', 'secret123');
      // Per-route budget is 10/min per user: 10 wrong-password attempts pass
      // through (401), the 11th is throttled (429) before reaching argon2.
      for (let i = 0; i < 10; i++) {
        await request(server())
          .post('/v1/auth/change-password')
          .set('Authorization', `Bearer ${token}`)
          .send({
            currentPassword: 'wrong-guess',
            newPassword: 'long-enough-pw',
          })
          .expect(401);
      }
      await request(server())
        .post('/v1/auth/change-password')
        .set('Authorization', `Bearer ${token}`)
        .send({
          currentPassword: 'wrong-guess',
          newPassword: 'long-enough-pw',
        })
        .expect(429);
    });
  });
});
