import { Test } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { startTestDb, TestDb } from './testcontainers';
import { makePrismaOverride } from './e2e-helpers';

describe('Auth Refresh Rotation (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prismaOverride: PrismaService;

  function server(): App {
    return app.getHttpServer() as App;
  }

  beforeAll(async () => {
    db = await startTestDb();

    prismaOverride = makePrismaOverride(db.url);
    await prismaOverride.$connect();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaOverride)
      .compile();

    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    const users = app.get(UsersService);
    await users.create({
      email: 'rot@test.io',
      password: 'secret123',
      name: 'Rotation Tester',
      role: 'ACCOUNTANT',
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prismaOverride.$disconnect();
    await db?.stop();
  });

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
});
