import * as request from 'supertest';
import { type App } from 'supertest/types';
import { INestApplication } from '@nestjs/common';
import { UsersService } from '../src/users/users.service';
import { AuthService } from '../src/auth/auth.service';
import { bootstrapTestApp } from './e2e-helpers';

describe('RBAC (e2e)', () => {
  let app: INestApplication;
  let cleanup: () => Promise<void>;
  let adminToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    ({ app, cleanup } = await bootstrapTestApp());

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

  afterAll(() => cleanup());

  it('allows an ADMIN to access an admin-only route', () => {
    return request(app.getHttpServer() as App)
      .get('/v1/auth/admin-only')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('forbids a VIEWER from an admin-only route (403)', () => {
    return request(app.getHttpServer() as App)
      .get('/v1/auth/admin-only')
      .set('Authorization', `Bearer ${viewerToken}`)
      .expect(403)
      .expect((r) => {
        const body = r.body as { code: string };
        expect(body.code).toBe('FORBIDDEN');
      });
  });

  it('returns 401 (not 403) when no token is sent to an admin-only route', () => {
    return request(app.getHttpServer() as App)
      .get('/v1/auth/admin-only')
      .expect(401);
  });
});
