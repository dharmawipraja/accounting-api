import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { UsersService } from '../src/users/users.service';
import { type TokenPair } from '../src/auth/auth.service';
import { bootstrapTestApp } from './e2e-helpers';

/** Access tokens die with their session family (`sid`), and the default
 *  REFRESH_REUSE_GRACE_MS (10s) absorbs concurrent refreshes. */
describe('Auth session revocation + concurrent refresh grace (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  const server = () => app.getHttpServer() as App;

  const login = async (email: string, password = 'secret123') =>
    (
      await request(server())
        .post('/v1/auth/login')
        .send({ email, password })
        .expect(200)
    ).body as TokenPair;
  const me = (accessToken: string) =>
    request(server())
      .get('/v1/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);
  const refresh = (refreshToken: string) =>
    request(server()).post('/v1/auth/refresh').send({ refreshToken });
  const newUser = (email: string) =>
    app.get(UsersService).create({
      email,
      password: 'secret123',
      name: 'S',
      role: 'ACCOUNTANT',
    });

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());
  }, 120_000);

  afterAll(() => cleanup());

  it('logout kills that session’s access token; other sessions keep working', async () => {
    await newUser('logout@sr.test');
    const a = await login('logout@sr.test');
    const b = await login('logout@sr.test');
    await me(a.accessToken).expect(200);

    await request(server())
      .post('/v1/auth/logout')
      .send({ refreshToken: a.refreshToken })
      .expect(201);

    await me(a.accessToken).expect(401);
    await me(b.accessToken).expect(200);
  });

  it('an access token survives its own refresh (family still live)', async () => {
    await newUser('rot@sr.test');
    const pair = await login('rot@sr.test');
    const next = (await refresh(pair.refreshToken).expect(200))
      .body as TokenPair;
    await me(pair.accessToken).expect(200);
    await me(next.accessToken).expect(200);
  });

  it('password change kills every outstanding access token, the caller’s too', async () => {
    await newUser('pw@sr.test');
    const a = await login('pw@sr.test');
    const b = await login('pw@sr.test');
    await request(server())
      .post('/v1/auth/change-password')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ currentPassword: 'secret123', newPassword: 'brand-new-pw-1' })
      .expect(200);

    await me(a.accessToken).expect(401);
    await me(b.accessToken).expect(401);
    const fresh = await login('pw@sr.test', 'brand-new-pw-1');
    await me(fresh.accessToken).expect(200);
  });

  it('rejects a correctly-signed access token without sid (pre-sid tokens → re-login)', async () => {
    const u = await newUser('nosid@sr.test');
    const token = await app.get(JwtService).signAsync(
      { sub: u.id, email: u.email, role: u.role, typ: 'access' },
      {
        secret: process.env.JWT_ACCESS_SECRET as string,
        expiresIn: '5m',
      },
    );
    await me(token).expect(401);
  });

  it('concurrent refresh of one token within the grace: both succeed, family stays alive', async () => {
    await newUser('tabs@sr.test');
    const pair = await login('tabs@sr.test');
    const [r1, r2] = await Promise.all([
      refresh(pair.refreshToken),
      refresh(pair.refreshToken),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const t1 = r1.body as TokenPair;
    const t2 = r2.body as TokenPair;
    expect(t1.refreshToken).not.toBe(t2.refreshToken);

    // Each tab keeps a working session in the same family.
    await me(pair.accessToken).expect(200);
    await me(t1.accessToken).expect(200);
    await me(t2.accessToken).expect(200);
    await refresh(t1.refreshToken).expect(200);
    await refresh(t2.refreshToken).expect(200);
  });

  it('a replay after the grace window is reuse: the family and its access tokens die', async () => {
    const u = await newUser('replay@sr.test');
    const pair = await login('replay@sr.test');
    const rotated = (await refresh(pair.refreshToken).expect(200))
      .body as TokenPair;
    // Age the rotation past REFRESH_REUSE_GRACE_MS (default 10s).
    await prisma.client.refreshToken.updateMany({
      where: { userId: u.id, status: 'CONSUMED' },
      data: { consumedAt: new Date(Date.now() - 11_000) },
    });

    await refresh(pair.refreshToken).expect(401);
    await refresh(rotated.refreshToken).expect(401);
    await me(rotated.accessToken).expect(401);
    expect(
      await prisma.client.refreshToken.count({
        where: { userId: u.id, status: { not: 'REVOKED' } },
      }),
    ).toBe(0);
  });
});
