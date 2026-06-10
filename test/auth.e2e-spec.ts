import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { UsersService } from '../src/users/users.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { type TokenPair } from '../src/auth/auth.service';
import { type AuthenticatedUser } from '../src/auth/strategies/jwt.strategy';
import { startTestDb, TestDb } from './testcontainers';

/**
 * NestJS evaluates @Module({ imports: [ConfigModule.forRoot(...)] }) once at
 * require() time, so ConfigModule's internalConfig is frozen with whatever
 * DATABASE_URL was in process.env when app.module.ts was first imported.
 * Overriding PrismaService bypasses that cache and points every layer of the
 * stack (UsersService, AuthService) at the testcontainer URL directly.
 */
function makePrismaOverride(url: string): PrismaService {
  const mockConfig = {
    getOrThrow: (key: string) =>
      key === 'DATABASE_URL' ? url : (process.env[key] as string),
    get: (key: string) => (key === 'DATABASE_URL' ? url : process.env[key]),
  } as unknown as ConfigService;
  return new PrismaService(mockConfig);
}

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prismaOverride: PrismaService;

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
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    const users = app.get(UsersService);
    await users.create({
      email: 'login@example.com',
      password: 'secret123',
      name: 'Login',
      role: 'ACCOUNTANT',
    });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prismaOverride.$disconnect();
    await db?.stop();
  });

  it('rejects login with wrong password (401)', () => {
    return request(app.getHttpServer() as App)
      .post('/auth/login')
      .send({ email: 'login@example.com', password: 'wrongpass' })
      .expect(401);
  });

  it('logs in and accesses a protected route', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/auth/login')
      .send({ email: 'login@example.com', password: 'secret123' })
      .expect(200);
    const tokens = res.body as TokenPair;
    expect(tokens.accessToken).toBeDefined();
    expect(tokens.refreshToken).toBeDefined();

    await request(app.getHttpServer() as App)
      .get('/auth/me')
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
      .get('/auth/me')
      .expect(401);
  });
});
