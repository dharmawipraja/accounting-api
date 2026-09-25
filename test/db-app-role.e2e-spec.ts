import { INestApplication } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';
import type { TestDb } from './testcontainers';

/**
 * AUDIT3-10: least-privilege runtime DB role. The migrate step
 * (scripts/db/ensure-app-role.js — exactly what the prod `migrate` service runs
 * after `prisma migrate deploy`) creates `accounting_app`; the whole app then
 * boots and serves real traffic AS that role, while DDL/TRUNCATE/ownership and
 * the append-only/migration tables stay out of its reach.
 */
describe('DB app role — accounting_app is least-privilege and runs the app (e2e)', () => {
  const APP_PW = 'app-role-test-pw';
  let app: INestApplication;
  let db: TestDb;
  let cleanup: () => Promise<void>;
  let appUrl: string;
  let appClient: Client;

  const ensureAppRole = (ownerUrl: string) =>
    execFileSync('node', ['scripts/db/ensure-app-role.js'], {
      env: { ...process.env, DATABASE_URL: ownerUrl, APP_DB_PASSWORD: APP_PW },
      encoding: 'utf8',
    });

  const asAppRole = (url: string) => {
    const u = new URL(url);
    u.username = 'accounting_app';
    u.password = APP_PW;
    return u.toString();
  };

  const expectDenied = (sql: string) =>
    expect(appClient.query(sql)).rejects.toThrow(
      /permission denied|must be owner/,
    );

  beforeAll(async () => {
    ({ app, db, cleanup } = await bootstrapTestApp({
      appDbUrl: (testDb) => {
        // Run twice: the step must be idempotent (it runs on every deploy).
        ensureAppRole(testDb.url);
        expect(ensureAppRole(testDb.url)).toContain('up to date');
        appUrl = asAppRole(testDb.url);
        return appUrl;
      },
    }));
    appClient = new Client({ connectionString: appUrl });
    await appClient.connect();

    // Seeding goes through the app's PrismaService → runs as accounting_app.
    await app.get(CompanyService).seedIfEmpty();
    await app.get(AccountsService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2026);
    await app.get(CompanyService).update({ segregationOfDutiesEnabled: false });
    await app.get(UsersService).create({
      email: 'approver@approle.test',
      password: 'secret123',
      name: 'Approver',
      role: 'APPROVER',
    });
  }, 180_000);

  afterAll(async () => {
    await appClient?.end();
    await cleanup();
  });

  it('the app connects as accounting_app', async () => {
    const { rows } = await appClient.query<{ u: string }>(
      'SELECT current_user AS u',
    );
    expect(rows[0].u).toBe('accounting_app');
  });

  it('role attributes: LOGIN, not superuser/createdb/createrole, owns nothing', async () => {
    const { rows } = await appClient.query<{
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolcanlogin: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolbypassrls
         FROM pg_roles WHERE rolname = 'accounting_app'`,
    );
    expect(rows[0]).toEqual({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolcanlogin: true,
      rolbypassrls: false,
    });
    const owned = await appClient.query(
      `SELECT c.relname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
        WHERE r.rolname = 'accounting_app'`,
    );
    expect(owned.rowCount).toBe(0);
  });

  it('serves real traffic as accounting_app: /ready, login, post a journal entry, read a report', async () => {
    const server = app.getHttpServer() as App;
    await request(server).get('/ready').expect(200);

    const login = await request(server)
      .post('/v1/auth/login')
      .send({ email: 'approver@approle.test', password: 'secret123' })
      .expect(200);
    const token = (login.body as { accessToken: string }).accessToken;

    const { data: accounts } = await app.get(AccountsService).list();
    const kas = accounts.find((a) => a.code === '1-1000')!.id;
    const modal = accounts.find((a) => a.code === '3-1000')!.id;
    const posted = await request(server)
      .post('/v1/ledger/journal-entries?post=true')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        date: '2026-02-10',
        description: 'Capital (app role)',
        lines: [
          { accountId: kas, debit: '1000000' },
          { accountId: modal, credit: '1000000' },
        ],
      })
      .expect(201);
    expect((posted.body as { status: string }).status).toBe('POSTED');

    await request(server)
      .get('/v1/ledger/trial-balance?asOf=2026-12-31')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    // The audit interceptor INSERTed as accounting_app (fire-and-forget → poll).
    let auditRows = 0;
    for (let i = 0; i < 40 && auditRows === 0; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 50));
      auditRows =
        (await appClient.query('SELECT 1 FROM audit_log LIMIT 1')).rowCount ??
        0;
    }
    expect(auditRows).toBe(1);
  });

  it('denies TRUNCATE and every kind of DDL', async () => {
    await expectDenied('TRUNCATE journal_lines');
    await expectDenied('CREATE TABLE app_role_probe (id int)');
    await expectDenied('ALTER TABLE accounts ADD COLUMN probe int');
    await expectDenied('DROP TABLE accounts');
    await expectDenied('CREATE INDEX app_role_probe_idx ON accounts (code)');
    await expectDenied('ALTER TABLE audit_log DISABLE TRIGGER ALL');
  });

  it('cannot touch _prisma_migrations, nor UPDATE/DELETE the append-only audit_log', async () => {
    await expectDenied('SELECT 1 FROM _prisma_migrations');
    await expectDenied('UPDATE audit_log SET method = method');
    await expectDenied('DELETE FROM audit_log');
  });

  it('default privileges: a table a later migration creates (as the owner) is usable by the app', async () => {
    await db.prisma.$executeRawUnsafe(
      'CREATE TABLE future_migration_tbl (id serial PRIMARY KEY, v text)',
    );
    try {
      await appClient.query(
        "INSERT INTO future_migration_tbl (v) VALUES ('x')",
      );
      await appClient.query("UPDATE future_migration_tbl SET v = 'y'");
      const r = await appClient.query('SELECT v FROM future_migration_tbl');
      expect(r.rows).toEqual([{ v: 'y' }]);
      await appClient.query('DELETE FROM future_migration_tbl');
      await expectDenied('TRUNCATE future_migration_tbl');
    } finally {
      await db.prisma.$executeRawUnsafe('DROP TABLE future_migration_tbl');
    }
  });
});
