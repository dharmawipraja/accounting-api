import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { UsersService } from '../src/users/users.service';
import { RefreshTokenService } from '../src/auth/refresh-token.service';
import { bootstrapTestApp } from './e2e-helpers';

describe('Auth Refresh Rotation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;

  function server(): App {
    return app.getHttpServer() as App;
  }

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());

    const users = app.get(UsersService);
    await users.create({
      email: 'rot@test.io',
      password: 'secret123',
      name: 'Rotation Tester',
      role: 'ACCOUNTANT',
    });
  }, 120_000);

  afterAll(() => cleanup());

  it('rotates the refresh token and invalidates the previous one', async () => {
    const login = await request(server())
      .post('/v1/auth/login')
      .send({ email: 'rot@test.io', password: 'secret123' })
      .expect(200);
    const first = (login.body as { refreshToken: string }).refreshToken;

    const refreshed = await request(server())
      .post('/v1/auth/refresh')
      .send({ refreshToken: first })
      .expect(200);
    const second = (refreshed.body as { refreshToken: string }).refreshToken;
    expect(second).not.toBe(first);

    // The new token works...
    await request(server())
      .post('/v1/auth/refresh')
      .send({ refreshToken: second })
      .expect(200);
  });

  it('detects reuse: replaying a consumed token revokes the family', async () => {
    const login = await request(server())
      .post('/v1/auth/login')
      .send({ email: 'rot@test.io', password: 'secret123' })
      .expect(200);
    const original = (login.body as { refreshToken: string }).refreshToken;

    const refreshed = await request(server())
      .post('/v1/auth/refresh')
      .send({ refreshToken: original })
      .expect(200);
    const rotated = (refreshed.body as { refreshToken: string }).refreshToken;

    // Replay the now-consumed original → 401 (reuse detected).
    await request(server())
      .post('/v1/auth/refresh')
      .send({ refreshToken: original })
      .expect(401);

    // The family is revoked, so the rotated token is now dead too.
    await request(server())
      .post('/v1/auth/refresh')
      .send({ refreshToken: rotated })
      .expect(401);
  });

  it('serializes concurrent rotation of one token (FOR UPDATE): one 200, one 401', async () => {
    const login = await request(server())
      .post('/v1/auth/login')
      .send({ email: 'rot@test.io', password: 'secret123' })
      .expect(200);
    const token = (login.body as { refreshToken: string }).refreshToken;
    const [r1, r2] = await Promise.all([
      request(server()).post('/v1/auth/refresh').send({ refreshToken: token }),
      request(server()).post('/v1/auth/refresh').send({ refreshToken: token }),
    ]);
    // FOR UPDATE serializes: the winner rotates (200); the loser blocks, then
    // sees CONSUMED → reuse detected → 401 (and the family is revoked).
    expect([r1.status, r2.status].sort()).toEqual([200, 401]);
  });

  it('logout revokes the session: the token can no longer refresh', async () => {
    const login = await request(server())
      .post('/v1/auth/login')
      .send({ email: 'rot@test.io', password: 'secret123' })
      .expect(200);
    const token = (login.body as { refreshToken: string }).refreshToken;

    await request(server())
      .post('/v1/auth/logout')
      .send({ refreshToken: token })
      .expect(201)
      .expect((r) => expect((r.body as { ok: boolean }).ok).toBe(true));

    await request(server())
      .post('/v1/auth/refresh')
      .send({ refreshToken: token })
      .expect(401);
  });

  it('logout-all revokes every session for the user', async () => {
    const a = await request(server())
      .post('/v1/auth/login')
      .send({ email: 'rot@test.io', password: 'secret123' })
      .expect(200);
    const b = await request(server())
      .post('/v1/auth/login')
      .send({ email: 'rot@test.io', password: 'secret123' })
      .expect(200);
    const tA = (a.body as { refreshToken: string }).refreshToken;
    const tB = (b.body as { refreshToken: string }).refreshToken;
    const access = (a.body as { accessToken: string }).accessToken;

    await request(server())
      .post('/v1/auth/logout-all')
      .set('Authorization', `Bearer ${access}`)
      .expect(201)
      .expect((r) => expect((r.body as { ok: boolean }).ok).toBe(true));

    await request(server())
      .post('/v1/auth/refresh')
      .send({ refreshToken: tA })
      .expect(401);
    await request(server())
      .post('/v1/auth/refresh')
      .send({ refreshToken: tB })
      .expect(401);
  });

  it('logout of one session leaves other sessions working', async () => {
    const a = await request(server())
      .post('/v1/auth/login')
      .send({ email: 'rot@test.io', password: 'secret123' })
      .expect(200);
    const b = await request(server())
      .post('/v1/auth/login')
      .send({ email: 'rot@test.io', password: 'secret123' })
      .expect(200);
    const tA = (a.body as { refreshToken: string }).refreshToken;
    const tB = (b.body as { refreshToken: string }).refreshToken;

    await request(server())
      .post('/v1/auth/logout')
      .send({ refreshToken: tA })
      .expect(201);

    await request(server())
      .post('/v1/auth/refresh')
      .send({ refreshToken: tA })
      .expect(401);
    await request(server())
      .post('/v1/auth/refresh')
      .send({ refreshToken: tB })
      .expect(200);
  });

  it('purgeExpired deletes only rows past their expiry', async () => {
    const svc = app.get(RefreshTokenService);
    const userId = (await prisma.client.user.findFirst({
      where: { email: 'rot@test.io' },
    }))!.id;
    await prisma.client.refreshToken.create({
      data: {
        id: 'expired-1',
        userId,
        familyId: 'fam-x',
        status: 'CONSUMED',
        expiresAt: new Date('2000-01-01'), // past
      },
    });
    await prisma.client.refreshToken.create({
      data: {
        id: 'fresh-1',
        userId,
        familyId: 'fam-y',
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 60_000), // future
      },
    });
    const deleted = await svc.purgeExpired();
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.client.refreshToken.findUnique({
        where: { id: 'expired-1' },
      }),
    ).toBeNull();
    expect(
      await prisma.client.refreshToken.findUnique({
        where: { id: 'fresh-1' },
      }),
    ).not.toBeNull();
  });
});
