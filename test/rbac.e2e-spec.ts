import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { UsersService } from '../src/users/users.service';
import { AuthService } from '../src/auth/auth.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('RBAC (e2e)', () => {
  let app: INestApplication;
  let db: TestDb;
  let prismaOverride: PrismaService;
  let adminToken: string;
  let viewerToken: string;

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

    const users = app.get(UsersService);
    const auth = app.get(AuthService);
    await users.create({
      email: 'admin@x.com',
      password: 'secret123',
      name: 'A',
      role: 'ADMIN',
    });
    await users.create({
      email: 'viewer@x.com',
      password: 'secret123',
      name: 'V',
      role: 'VIEWER',
    });
    adminToken = (await auth.login('admin@x.com', 'secret123')).accessToken;
    viewerToken = (await auth.login('viewer@x.com', 'secret123')).accessToken;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await prismaOverride.$disconnect();
    await db?.stop();
  });

  it('allows an ADMIN to access an admin-only route', () => {
    return request(app.getHttpServer() as App)
      .get('/auth/admin-only')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('forbids a VIEWER from an admin-only route (403)', () => {
    return request(app.getHttpServer() as App)
      .get('/auth/admin-only')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403)
      .expect((r) => {
        const body = r.body as { code: string };
        expect(body.code).toBe('FORBIDDEN');
      });
  });
});
