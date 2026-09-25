import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { UsersService } from '../src/users/users.service';
import { type TokenPair } from '../src/auth/auth.service';
import { type AuthenticatedUser } from '../src/auth/strategies/jwt.strategy';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { bootstrapTestApp } from './e2e-helpers';

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ app, cleanup } = await bootstrapTestApp());

    const users = app.get(UsersService);
    await users.create({
      email: 'login@example.com',
      password: 'secret123',
      name: 'Login',
      role: 'ACCOUNTANT',
    });
  }, 120_000);

  afterAll(() => cleanup());

  it('rejects login with wrong password (401)', () => {
    return request(app.getHttpServer() as App)
      .post('/v1/auth/login')
      .send({ email: 'login@example.com', password: 'wrongpass' })
      .expect(401);
  });

  it('logs in and accesses a protected route', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/v1/auth/login')
      .send({ email: 'login@example.com', password: 'secret123' })
      .expect(200);
    const tokens = res.body as TokenPair;
    expect(tokens.accessToken).toBeDefined();
    expect(tokens.refreshToken).toBeDefined();

    await request(app.getHttpServer() as App)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200)
      .expect((r) => {
        const me = r.body as AuthenticatedUser;
        expect(me.email).toBe('login@example.com');
        expect(me.role).toBe('ACCOUNTANT');
      });
  });

  it('blocks a protected route without a token (401)', () => {
    return request(app.getHttpServer() as App)
      .get('/v1/auth/me')
      .expect(401);
  });

  it('rejects login for an unknown email (401)', () => {
    return request(app.getHttpServer() as App)
      .post('/v1/auth/login')
      .send({ email: 'nobody@example.com', password: 'secret123' })
      .expect(401);
  });

  it('refreshes tokens with a valid refresh token (200)', async () => {
    const login = await request(app.getHttpServer() as App)
      .post('/v1/auth/login')
      .send({ email: 'login@example.com', password: 'secret123' })
      .expect(200);
    const { refreshToken } = login.body as TokenPair;

    const res = await request(app.getHttpServer() as App)
      .post('/v1/auth/refresh')
      .send({ refreshToken })
      .expect(200);
    const tokens = res.body as TokenPair;
    expect(tokens.accessToken).toBeDefined();
    expect(tokens.refreshToken).toBeDefined();

    await request(app.getHttpServer() as App)
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);
  });

  it('rejects an invalid refresh token (401)', () => {
    return request(app.getHttpServer() as App)
      .post('/v1/auth/refresh')
      .send({ refreshToken: 'not-a-valid-token' })
      .expect(401);
  });

  describe('AUDIT3-7 hardening', () => {
    const accessSecret = () => process.env.JWT_ACCESS_SECRET as string;
    const refreshSecret = () => process.env.JWT_REFRESH_SECRET as string;
    const jwt = () => app.get(JwtService);
    const me = (token: string) =>
      request(app.getHttpServer() as App)
        .get('/v1/auth/me')
        .set('Authorization', `Bearer ${token}`);
    const loginPair = async (email = 'login@example.com') =>
      (
        await request(app.getHttpServer() as App)
          .post('/v1/auth/login')
          .send({ email, password: 'secret123' })
          .expect(200)
      ).body as TokenPair;
    let userId: string;

    beforeAll(async () => {
      userId = (await app
        .get(UsersService)
        .findByEmailWithHash('login@example.com'))!.id;
    });

    it('issued tokens carry typ access / refresh', async () => {
      const pair = await loginPair();
      expect(jwt().decode<{ typ?: string }>(pair.accessToken).typ).toBe(
        'access',
      );
      expect(jwt().decode<{ typ?: string }>(pair.refreshToken).typ).toBe(
        'refresh',
      );
    });

    it('rejects a correctly-signed access token without typ (401)', async () => {
      const token = await jwt().signAsync(
        { sub: userId, email: 'login@example.com', role: 'ACCOUNTANT' },
        { secret: accessSecret(), expiresIn: '5m' },
      );
      await me(token).expect(401);
    });

    it('rejects a typ=refresh token presented as a bearer (401)', async () => {
      const token = await jwt().signAsync(
        { sub: userId, typ: 'refresh', jti: 'x' },
        { secret: accessSecret(), expiresIn: '5m' },
      );
      await me(token).expect(401);
    });

    it('pins HS256: an HS512 token with a valid secret is rejected (401)', async () => {
      const token = await jwt().signAsync(
        { sub: userId, typ: 'access' },
        { secret: accessSecret(), expiresIn: '5m', algorithm: 'HS512' },
      );
      await me(token).expect(401);
    });

    it('refresh requires typ=refresh (a re-signed token without typ is 401)', async () => {
      const pair = await loginPair();
      const { sub, jti } = jwt().decode<{ sub: string; jti: string }>(
        pair.refreshToken,
      );
      const untyped = await jwt().signAsync(
        { sub, jti },
        { secret: refreshSecret(), expiresIn: '1d' },
      );
      await request(app.getHttpServer() as App)
        .post('/v1/auth/refresh')
        .send({ refreshToken: untyped })
        .expect(401);
      // ...and the genuine one (untouched jti) still rotates.
      await request(app.getHttpServer() as App)
        .post('/v1/auth/refresh')
        .send({ refreshToken: pair.refreshToken })
        .expect(200);
    });

    it('emails are case-insensitive and trimmed at login', async () => {
      await loginPair('  LOGIN@Example.COM ');
    });

    it('stores new users lowercased; a case-variant duplicate is a 409', async () => {
      const u = await app.get(UsersService).create({
        email: 'Mixed.Case@Example.com',
        password: 'secret123',
        name: 'M',
        role: 'VIEWER',
      });
      expect(u.email).toBe('mixed.case@example.com');
      await expect(
        app.get(UsersService).create({
          email: 'MIXED.CASE@example.com',
          password: 'secret123',
          name: 'M2',
          role: 'VIEWER',
        }),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('the DB enforces lower(email) uniqueness even for raw writes', async () => {
      const prisma = app.get(PrismaService);
      await expect(
        prisma.client
          .$executeRaw`INSERT INTO users (id, email, password_hash, name, role, updated_at)
          VALUES (gen_random_uuid(), 'Login@Example.com', 'x', 'dup', 'VIEWER', now())`,
      ).rejects.toThrow(/users_email_lower_key|unique/i);
    });

    it('caps password length at 128 (400)', async () => {
      await request(app.getHttpServer() as App)
        .post('/v1/auth/login')
        .send({ email: 'login@example.com', password: 'x'.repeat(129) })
        .expect(400);
      const { accessToken } = await loginPair();
      await request(app.getHttpServer() as App)
        .post('/v1/auth/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: 'x'.repeat(129), newPassword: 'new-pass-123' })
        .expect(400);
    });

    it('change-password rejects new == current with 422', async () => {
      const { accessToken } = await loginPair();
      const res = await request(app.getHttpServer() as App)
        .post('/v1/auth/change-password')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ currentPassword: 'secret123', newPassword: 'secret123' })
        .expect(422);
      expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
    });
  });
});
