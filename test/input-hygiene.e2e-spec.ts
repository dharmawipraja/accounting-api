import { INestApplication, Logger } from '@nestjs/common';
import request from 'supertest';
import { type App } from 'supertest/types';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import {
  isUnstorableCharacters,
  statusFromException,
} from '../src/common/errors/exception-status';

/**
 * Audit7 P1: a lone UTF-16 surrogate (or NUL) in request input made the
 * domain write succeed (node-pg stores U+FFFD / Postgres rejects NUL) while
 * the jsonb audit insert failed and was only logged — a write with NO audit
 * row. Now: such input is a 400 INVALID_CHARACTERS from the global
 * InputHygieneGuard (JwtAuthGuard → UserThrottlerGuard → InputHygieneGuard →
 * RolesGuard → PasswordChangeGuard), the rejection is audited under the
 * normal authenticated / anonymous rules, and the audit path itself never
 * drops a row because of content (sanitize + `_unstorable` fallback row).
 */
describe('Input hygiene + audit robustness (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let adminToken: string;

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());
    await app.get(UsersService).create({
      email: 'admin@hyg.test',
      password: 'secret123',
      name: 'Admin',
      role: 'ADMIN',
    });
    adminToken = (
      await app.get(AuthService).login('admin@hyg.test', 'secret123')
    ).accessToken;
  }, 120_000);

  afterAll(() => cleanup());
  afterEach(() => jest.restoreAllMocks());

  /** Rejection rows are written fire-and-forget AFTER the response. */
  async function waitForRows(where: Prisma.AuditLogWhereInput, n = 1) {
    for (let i = 0; i < 100; i++) {
      const rows = await prisma.client.auditLog.findMany({ where });
      if (rows.length >= n) return rows;
      await new Promise((r) => setTimeout(r, 20));
    }
    return prisma.client.auditLog.findMany({ where });
  }

  const http = () => request(app.getHttpServer() as App);

  /** Raw JSON (so `\ud800` / `\u0000` escapes reach the server verbatim). */
  function postRaw(path: string, json: string, id: string, auth = true) {
    let r = http()
      .post(path)
      .set('Content-Type', 'application/json')
      .set('X-Request-Id', id);
    if (auth) r = r.set('Authorization', `Bearer ${adminToken}`);
    return r.send(json);
  }

  it('P1: a lone surrogate in POST /v1/partners name is a 400 INVALID_CHARACTERS, nothing is written, and the rejection is audited', async () => {
    const res = await postRaw(
      '/v1/partners',
      '{"code":"HYG-LONE","name":"Bad \\ud800 name","isCustomer":true}',
      'hyg-lone-surrogate',
    );
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('INVALID_CHARACTERS');
    expect(
      await prisma.client.businessPartner.count({
        where: { code: 'HYG-LONE' },
      }),
    ).toBe(0);
    const rows = await waitForRows({ clientRequestId: 'hyg-lone-surrogate' });
    expect(rows).toHaveLength(1);
    const admin = await prisma.client.user.findFirstOrThrow({
      where: { email: 'admin@hyg.test' },
    });
    // The guard runs AFTER JwtAuthGuard: the row carries the caller, and the
    // (8 KiB-capped, sanitized) body is stored — repaired to storable JSON.
    expect(rows[0]).toMatchObject({
      method: 'POST',
      path: '/v1/partners',
      statusCode: 400,
      userId: admin.id,
      userRole: 'ADMIN',
      requestId: res.headers['x-request-id'],
      body: { code: 'HYG-LONE', name: 'Bad \ufffd name', isCustomer: true },
    });
  });

  it('an UNAUTHENTICATED bad-character write is a 401 first (JwtAuthGuard runs before the hygiene guard)', async () => {
    const res = await postRaw(
      '/v1/partners',
      '{"code":"HYG-ANON","name":"Bad \\ud800","isCustomer":true}',
      'hyg-anon-401',
      false,
    );
    expect(res.status).toBe(401);
  });

  it('an unknown route with %00 is a 404 (no route matched, so no guard ran)', async () => {
    const res = await http()
      .get('/v1/no-such-route/%00')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it('a lone LOW surrogate and a reversed pair are rejected too', async () => {
    for (const [i, name] of ['x \\udc00 y', 'x \\ude00\\ud83d y'].entries()) {
      const res = await postRaw(
        '/v1/partners',
        `{"code":"HYG-LOW-${i}","name":"${name}","isCustomer":true}`,
        `hyg-low-${i}`,
      );
      expect(res.status).toBe(400);
      expect((res.body as { code: string }).code).toBe('INVALID_CHARACTERS');
    }
  });

  it('NUL in a body string value is a 400 INVALID_CHARACTERS (audited)', async () => {
    const res = await postRaw(
      '/v1/partners',
      '{"code":"HYG-NUL","name":"a\\u0000b","isCustomer":true}',
      'hyg-nul-value',
    );
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('INVALID_CHARACTERS');
    const rows = await waitForRows({ clientRequestId: 'hyg-nul-value' });
    expect(rows).toHaveLength(1);
    expect(rows[0].statusCode).toBe(400);
  });

  it('NUL (or a lone surrogate) in a nested body KEY is a 400 INVALID_CHARACTERS (audited)', async () => {
    for (const [i, key] of ['a\\u0000b', 'k\\ud800'].entries()) {
      const id = `hyg-key-${i}`;
      const res = await postRaw(
        '/v1/ledger/journal-entries',
        `{"date":"2026-01-15","lines":[{"${key}":1}]}`,
        id,
      );
      expect(res.status).toBe(400);
      expect((res.body as { code: string }).code).toBe('INVALID_CHARACTERS');
      const rows = await waitForRows({ clientRequestId: id });
      expect(rows).toHaveLength(1);
    }
  });

  it('%00 in a route param is a 400 INVALID_CHARACTERS (audited on a mutating route)', async () => {
    const res = await http()
      .patch('/v1/partners/%00')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Request-Id', 'hyg-param-nul')
      .send({ name: 'x' });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('INVALID_CHARACTERS');
    const rows = await waitForRows({ clientRequestId: 'hyg-param-nul' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ method: 'PATCH', statusCode: 400 });
    expect(rows[0].path).toBe('/v1/partners/%00');
  });

  it('%00 in a query-string value or key is a 400 INVALID_CHARACTERS', async () => {
    for (const qs of ['q=ab%00cd', 'a%00b=1', 'q[x]=%00']) {
      const res = await http()
        .get(`/v1/partners?${qs}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(400);
      expect((res.body as { code: string }).code).toBe('INVALID_CHARACTERS');
    }
  });

  it('a lone surrogate in the login email is a 400 INVALID_CHARACTERS (not a 500 / Sentry), after the throttle, audited anonymously with the repaired { email }', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error');
    const res = await postRaw(
      '/v1/auth/login',
      '{"email":"a\\ud800@hyg.test","password":"secret123"}',
      'hyg-login-lone',
      false,
    );
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe('INVALID_CHARACTERS');
    const [row] = await waitForRows({ clientRequestId: 'hyg-login-lone' });
    expect(row).toMatchObject({ statusCode: 400, userId: null });
    // Rejected by the hygiene guard AFTER UserThrottlerGuard marked the
    // request as a login attempt: an anonymous 4xx row keeping only the
    // forensic email, repaired to storable text (lone surrogate → U+FFFD).
    expect(row.body).toEqual({ email: 'a\ufffd@hyg.test' });
    expect(
      errorSpy.mock.calls.some((c) =>
        String(c[0]).includes('Unhandled exception'),
      ),
    ).toBe(false);
  });

  it('valid emoji (surrogate PAIRS), ZWJ sequences and Indonesian / multilingual text are accepted and audited verbatim', async () => {
    const name = 'PT Kopi Nusantara — café ☕ 😀 👨‍👩‍👧 日本語 Ñandú';
    const address =
      'Jl. Jend. Sudirman Kav. 52-53, Kec. Kebayoran Baru, Jakarta Selatan 12190 🇮🇩';
    const res = await http()
      .post('/v1/partners')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Request-Id', 'hyg-emoji')
      .send({ code: 'HYG-EMOJI', name, address, isCustomer: true })
      .expect(201);
    expect((res.body as { name: string }).name).toBe(name);
    const [row] = await waitForRows({ clientRequestId: 'hyg-emoji' });
    expect(row.body).toMatchObject({ name, address });
    await http()
      .get(`/v1/partners?q=${encodeURIComponent('Kopi 😀')}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('fallback: when the audit insert fails on content, a `{ _unstorable: true }` row still records method/path/user/status/requestId', async () => {
    // Force the FIRST insert to fail (a trigger rejecting this probe body);
    // the fallback row (body replaced by the marker) passes it.
    await prisma.client.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION hyg_reject_probe() RETURNS trigger AS $$
      BEGIN
        IF NEW.body ? 'hygFailProbe' THEN
          RAISE EXCEPTION 'hyg probe: forced audit insert failure'
            USING ERRCODE = '22P05';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.client.$executeRawUnsafe(`
      CREATE TRIGGER hyg_reject_probe BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION hyg_reject_probe()`);
    try {
      const res = await http()
        .post('/v1/partners')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Request-Id', 'hyg-fallback')
        .send({ code: 'HYG-FB', name: 'F', isCustomer: true, hygFailProbe: 1 })
        .expect(400);
      const rows = await waitForRows({ clientRequestId: 'hyg-fallback' });
      expect(rows).toHaveLength(1);
      const admin = await prisma.client.user.findFirstOrThrow({
        where: { email: 'admin@hyg.test' },
      });
      expect(rows[0]).toMatchObject({
        method: 'POST',
        path: '/v1/partners',
        statusCode: 400,
        userId: admin.id,
        userRole: 'ADMIN',
        requestId: res.headers['x-request-id'],
        params: {},
        body: { _unstorable: true },
      });
    } finally {
      await prisma.client.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS hyg_reject_probe ON audit_log',
      );
      await prisma.client.$executeRawUnsafe(
        'DROP FUNCTION IF EXISTS hyg_reject_probe()',
      );
    }
  });

  it('a NON-content audit insert failure (not a content SQLSTATE) is logged once and NOT retried', async () => {
    await prisma.client.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION hyg_reject_all() RETURNS trigger AS $$
      BEGIN
        IF NEW.client_request_id = 'hyg-no-retry' THEN
          RAISE EXCEPTION 'hyg probe: forced non-content failure'
            USING ERRCODE = '57014';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.client.$executeRawUnsafe(`
      CREATE TRIGGER hyg_reject_all BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION hyg_reject_all()`);
    const errorSpy = jest.spyOn(Logger.prototype, 'error');
    try {
      await http()
        .post('/v1/partners')
        .set('Authorization', `Bearer ${adminToken}`)
        .set('X-Request-Id', 'hyg-no-retry')
        .send({ code: 'HYG-NR', name: 'N', isCustomer: true, junk: 1 })
        .expect(400);
      const logged = () =>
        errorSpy.mock.calls.filter((c) =>
          String(c[0]).includes('Failed to write'),
        );
      for (let i = 0; i < 100 && logged().length === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 200));
      expect(logged()).toHaveLength(1);
      expect(String(logged()[0][0])).not.toContain('retrying');
    } finally {
      await prisma.client.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS hyg_reject_all ON audit_log',
      );
      await prisma.client.$executeRawUnsafe(
        'DROP FUNCTION IF EXISTS hyg_reject_all()',
      );
    }
  });

  it('backstop: a NUL that bypasses the edge (service call) surfaces in a shape isUnstorableCharacters maps to 400', async () => {
    const err: unknown = await app
      .get(BusinessPartnersService)
      .create({ code: 'HYG-DB-NUL', name: 'a\u0000b', isCustomer: true })
      .catch((e: unknown) => e);
    expect(isUnstorableCharacters(err)).toBe(true);
    expect(statusFromException(err)).toBe(400);
  });
});
