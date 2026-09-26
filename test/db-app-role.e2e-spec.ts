import { INestApplication } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { CompanyService } from '../src/company/company.service';
import { UsersService } from '../src/users/users.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';
import { RefreshTokenService } from '../src/auth/refresh-token.service';
import { IdempotencyService } from '../src/common/idempotency/idempotency.service';
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

  const runEnsure = (env: Record<string, string>, args: string[] = []) => {
    try {
      execFileSync('node', ['scripts/db/ensure-app-role.js', ...args], {
        env: { ...process.env, DATABASE_URL: db.url, ...env },
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return { ok: true, stderr: '' };
    } catch (err) {
      return { ok: false, stderr: String((err as { stderr?: string }).stderr) };
    }
  };

  it('ensure-app-role also refuses a non-URL-safe POSTGRES_PASSWORD, and --check-only validates without connecting', () => {
    const bad = runEnsure(
      { APP_DB_PASSWORD: APP_PW, POSTGRES_PASSWORD: 'own@er' },
      ['--check-only'],
    );
    expect(bad.ok).toBe(false);
    expect(bad.stderr).toMatch(/POSTGRES_PASSWORD must be URL-safe/);
    const good = runEnsure(
      {
        APP_DB_PASSWORD: APP_PW,
        POSTGRES_PASSWORD: 'owner-pw_1.2~x',
        DATABASE_URL: 'postgresql://nobody:x@127.0.0.1:1/none',
      },
      ['--check-only'],
    );
    expect(good).toEqual({ ok: true, stderr: '' });
  });

  it('ensure-app-role refuses an APP_DB_PASSWORD that is not URL-safe (it is interpolated raw into the api DATABASE_URL)', () => {
    for (const bad of ['p@ss', 'a/b', 'x:y', 'has space', '100%', 'q?z#']) {
      let stderr = '';
      expect(() => {
        try {
          execFileSync('node', ['scripts/db/ensure-app-role.js'], {
            env: {
              ...process.env,
              DATABASE_URL: db.url,
              APP_DB_PASSWORD: bad,
            },
            encoding: 'utf8',
            stdio: 'pipe',
          });
        } catch (err) {
          stderr = String((err as { stderr?: string }).stderr);
          throw err;
        }
      }).toThrow();
      expect(stderr).toMatch(/URL-safe/);
    }
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
    // Multi-query reports run in a READ ONLY REPEATABLE READ snapshot
    // transaction — which accounting_app must be able to open.
    for (const url of [
      '/v1/reports/cash-flow?from=2026-01-01&to=2026-12-31',
      '/v1/reports/balance-sheet?asOf=2026-12-31',
      `/v1/reports/general-ledger?accountId=${kas}&from=2026-01-01&to=2026-12-31`,
    ]) {
      await request(server)
        .get(url)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
    }

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

  it('scripts/create-admin runs as accounting_app (create, then break-glass reset revoking sessions)', async () => {
    // The production procedure runs the script inside the api container with
    // the api's own (least-privilege) DATABASE_URL: it needs SELECT/INSERT/
    // UPDATE on users, UPDATE on refresh_tokens, row locks and advisory locks.
    const createAdmin = () =>
      execFileSync(
        'npx',
        [
          'ts-node',
          'scripts/create-admin.ts',
          'Break@Glass.Test',
          'Break Glass',
        ],
        {
          env: {
            ...process.env,
            DATABASE_URL: appUrl,
            ADMIN_PASSWORD: 'operator-pw-1',
          },
          encoding: 'utf8',
          stdio: 'pipe',
        },
      );
    expect(createAdmin()).toMatch(/ADMIN ready: break@glass\.test .*created/);

    const server = app.getHttpServer() as App;
    const login = await request(server)
      .post('/v1/auth/login')
      .send({ email: 'break@glass.test', password: 'operator-pw-1' })
      .expect(200);
    const { refreshToken } = login.body as { refreshToken: string };

    expect(createAdmin()).toMatch(/existing user reset, all sessions revoked/);
    await request(server)
      .post('/v1/auth/refresh')
      .send({ refreshToken })
      .expect(401);
    const row = await appClient.query<{ role: string; mcp: boolean }>(
      `SELECT role::text AS role, must_change_password AS mcp FROM users
       WHERE email = 'break@glass.test' AND deleted_at IS NULL`,
    );
    expect(row.rows).toEqual([{ role: 'ADMIN', mcp: true }]);
  }, 120_000);

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
      // Default privileges carry no DELETE: a new table is protected from hard
      // deletes until it is deliberately added to app-role.sql's allow-list.
      await expectDenied('DELETE FROM future_migration_tbl');
      await expectDenied('TRUNCATE future_migration_tbl');
    } finally {
      await db.prisma.$executeRawUnsafe('DROP TABLE future_migration_tbl');
    }
  });

  // AUDIT3 iteration-2 (Task 16): DELETE is granted only on the tables the app
  // really hard-deletes (grep of every .delete/.deleteMany/DELETE FROM in src/).
  // `DELETE ... WHERE false` checks the privilege without touching rows.
  const DELETE_PROTECTED = [
    'users',
    'company_settings',
    'accounts',
    'journal_sequences',
    'journal_entries',
    'journal_lines',
    'tax_codes',
    'business_partners',
    'sales_invoices',
    'purchase_bills',
    'payments',
    'payment_allocations',
    'document_sequences',
    'year_end_closings',
    'audit_log',
  ];
  const DELETE_ALLOWED = [
    'sales_invoice_lines', // draft line replacement (PATCH)
    'purchase_bill_lines', // draft line replacement (PATCH)
    'accounting_periods', // OPEN-period regeneration on fiscalYearStartMonth change
    'idempotency_keys', // release / stale reclaim / retention purge
    'refresh_tokens', // expiry purge
  ];

  it.each(DELETE_PROTECTED)('DELETE on %s is denied', async (table) => {
    await expectDenied(`DELETE FROM ${table} WHERE false`);
  });

  it.each(DELETE_ALLOWED)(
    'DELETE on %s (a table the app hard-deletes) is allowed',
    async (table) => {
      await expect(
        appClient.query(`DELETE FROM ${table} WHERE false`),
      ).resolves.toBeDefined();
    },
  );

  it('every public table is classified (protected or allow-listed)', async () => {
    const { rows } = await appClient.query<{ t: string }>(
      `SELECT tablename AS t FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
        ORDER BY 1`,
    );
    expect(rows.map((r) => r.t).sort()).toEqual(
      [...DELETE_PROTECTED, ...DELETE_ALLOWED].sort(),
    );
  });

  it('ensure-app-role re-revokes a DELETE left over from an older deploy (it granted DELETE on everything)', async () => {
    await db.prisma.$executeRawUnsafe(
      'GRANT DELETE ON TABLE accounts, journal_entries TO accounting_app',
    );
    await db.prisma.$executeRawUnsafe(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT DELETE ON TABLES TO accounting_app',
    );
    expect(ensureAppRole(db.url)).toContain('up to date');
    await expectDenied('DELETE FROM accounts WHERE false');
    await expectDenied('DELETE FROM journal_entries WHERE false');
    const { rows } = await appClient.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_default_acl d
         CROSS JOIN LATERAL aclexplode(d.defaclacl) a
        WHERE d.defaclobjtype = 'r' AND a.privilege_type = 'DELETE'
          AND a.grantee = 'accounting_app'::regrole`,
    );
    expect(rows[0].n).toBe('0');
  });

  it('document flows that hard-delete only allow-listed rows work as accounting_app (draft PATCH, post, pay, void, soft-delete drafts, purges)', async () => {
    const server = app.getHttpServer() as App;
    const token = (
      (
        await request(server)
          .post('/v1/auth/login')
          .send({ email: 'approver@approle.test', password: 'secret123' })
          .expect(200)
      ).body as { accessToken: string }
    ).accessToken;
    const auth = (r: request.Test) =>
      r
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', randomUUID());
    const { data: accounts } = await app.get(AccountsService).list();
    const acc = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
    const partner = await app.get(BusinessPartnersService).create({
      code: 'APPROLE-1',
      name: 'App Role Partner',
      isCustomer: true,
      isVendor: true,
    });
    const line = (accountId: string, unitPrice: string) => ({
      description: 'Line',
      accountId,
      quantity: '1',
      unitPrice,
      taxCodeIds: [],
    });

    // Sales invoice: draft → PATCH lines (hard-deletes the draft's lines) → post.
    const inv = (
      await auth(request(server).post('/v1/sales-invoices'))
        .send({
          partnerId: partner.id,
          date: '2026-03-10',
          lines: [line(acc['4-1000'], '100000')],
        })
        .expect(201)
    ).body as { id: string };
    await auth(request(server).patch(`/v1/sales-invoices/${inv.id}`))
      .send({ lines: [line(acc['4-1000'], '250000')] })
      .expect(200);
    await auth(
      request(server).post(`/v1/sales-invoices/${inv.id}/post`),
    ).expect(200);

    // Receipt: draft → post → void; then the invoice can be voided.
    const pay = (
      await auth(request(server).post('/v1/payments'))
        .send({
          direction: 'RECEIPT',
          partnerId: partner.id,
          date: '2026-03-12',
          cashAccountId: acc['1-1000'],
          allocations: [{ salesInvoiceId: inv.id, amount: '250000' }],
        })
        .expect(201)
    ).body as { id: string };
    await auth(request(server).post(`/v1/payments/${pay.id}/post`)).expect(200);
    await auth(request(server).post(`/v1/payments/${pay.id}/void`)).expect(200);
    await auth(
      request(server).post(`/v1/sales-invoices/${inv.id}/void`),
    ).expect(200);

    // Purchase bill: draft → PATCH lines → soft-delete (an UPDATE).
    const bill = (
      await auth(request(server).post('/v1/purchase-bills'))
        .send({
          partnerId: partner.id,
          date: '2026-03-10',
          vendorInvoiceNo: 'APPROLE-VI-1',
          lines: [line(acc['5-2000'], '50000')],
        })
        .expect(201)
    ).body as { id: string };
    await auth(request(server).patch(`/v1/purchase-bills/${bill.id}`))
      .send({ lines: [line(acc['5-2000'], '60000')] })
      .expect(200);
    await auth(request(server).delete(`/v1/purchase-bills/${bill.id}`)).expect(
      204,
    );

    // Draft journal entry soft-delete (an UPDATE).
    const je = (
      await auth(request(server).post('/v1/ledger/journal-entries'))
        .send({
          date: '2026-03-10',
          description: 'draft (app role)',
          lines: [
            { accountId: acc['1-1000'], debit: '1000' },
            { accountId: acc['3-1000'], credit: '1000' },
          ],
        })
        .expect(201)
    ).body as { id: string };
    await auth(
      request(server).delete(`/v1/ledger/journal-entries/${je.id}`),
    ).expect(204);

    // Housekeeping purges hard-delete allow-listed tables.
    await expect(app.get(RefreshTokenService).purgeExpired()).resolves.toEqual(
      expect.any(Number),
    );
    await expect(
      app.get(IdempotencyService).purgeCompleted(0),
    ).resolves.toEqual(expect.any(Number));
  });

  it('a failing CREATE/ALTER ROLE never echoes the password in the error (message, detail or CONTEXT)', async () => {
    const secret = `leak-${randomUUID()}`;
    // A role that may run the script but lacks CREATEROLE: ALTER ROLE fails.
    await db.prisma.$executeRawUnsafe(
      "CREATE ROLE weak_owner LOGIN PASSWORD 'weak-pw'",
    );
    const u = new URL(db.url);
    u.username = 'weak_owner';
    u.password = 'weak-pw';
    const weak = new Client({ connectionString: u.toString() });
    await weak.connect();
    try {
      await weak.query(
        "SELECT set_config('accounting.app_db_password', $1, false)",
        [secret],
      );
      const sql = readFileSync(
        join(__dirname, '..', 'scripts', 'db', 'app-role.sql'),
        'utf8',
      );
      const err = (await weak.query(sql).catch((e: unknown) => e)) as {
        message: string;
        detail?: string;
        where?: string;
      };
      expect(err.message).toMatch(/accounting_app role create\/alter failed/);
      const surfaced = [err.message, err.detail, err.where].join(' | ');
      expect(surfaced).not.toContain(secret);
    } finally {
      await weak.end();
      await db.prisma.$executeRawUnsafe('DROP ROLE weak_owner');
    }
  });
});
