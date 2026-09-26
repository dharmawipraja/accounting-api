import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapTestApp } from './e2e-helpers';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { BusinessPartnersService } from '../src/invoicing/business-partners.service';

describe('BusinessPartners (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let token: string;

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());
    await app.get(UsersService).create({
      email: 'a@p.test',
      password: 'secret123',
      name: 'A',
      role: 'ADMIN',
    });
    token = (await app.get(AuthService).login('a@p.test', 'secret123'))
      .accessToken;
  }, 120_000);

  afterAll(() => cleanup());

  /** Poll pg_stat_activity until `n` backends running a statement matching
   *  `pattern` are waiting on a lock (bounded: throws after ~10 s). */
  async function waitForLockWaiters(pattern: string, n: number): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const [{ w }] = await prisma.client.$queryRaw<{ w: number }[]>`
        SELECT count(*)::int AS w FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE ${pattern}`;
      if (w >= n) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`expected ${n} lock waiter(s) matching ${pattern}`);
  }

  it('creates a customer partner (201)', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${token}`)
      .send({
        code: 'CUST-1',
        name: 'PT Pelanggan',
        npwp: '01.234.567.8-901.000',
        isCustomer: true,
      })
      .expect(201);
    expect((res.body as { isCustomer: boolean }).isCustomer).toBe(true);
  });

  it('rejects a partner that is neither customer nor vendor (422)', async () => {
    await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'NEITHER', name: 'X', isCustomer: false, isVendor: false })
      .expect(422);
  });

  it('iter6: a blank / whitespace-only code or name is a 400 on create and update', async () => {
    for (const bad of [
      { code: '   ', name: 'Ok' },
      { code: 'BLANK-1', name: '' },
      { code: 'BLANK-2', name: ' \t\n ' },
      { code: '', name: 'Ok' },
    ]) {
      await request(app.getHttpServer() as App)
        .post('/v1/partners')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...bad, isCustomer: true })
        .expect(400);
    }
    const created = await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'BLANK-OK', name: 'Ok', isCustomer: true })
      .expect(201);
    const id = (created.body as { id: string }).id;
    for (const name of ['', '   ']) {
      await request(app.getHttpServer() as App)
        .patch(`/v1/partners/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ name })
        .expect(400);
    }
  });

  it('iter6: concurrent role PATCHes cannot leave a partner neither customer nor vendor (row lock re-check)', async () => {
    const created = await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${token}`)
      .send({
        code: 'ROLE-RACE',
        name: 'Both',
        isCustomer: true,
        isVendor: true,
      })
      .expect(201);
    const id = (created.body as { id: string }).id;
    // Each PATCH alone is valid against the unlocked read (the other flag is
    // still true); together they would clear both. Hold the row lock so both
    // are queued behind it, then release.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = prisma.client.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM business_partners WHERE id = ${id} FOR UPDATE`;
        locked();
        await gate;
      },
      { maxWait: 5000, timeout: 20000 },
    );
    await isLocked;
    const a = request(app.getHttpServer() as App)
      .patch(`/v1/partners/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isCustomer: false })
      .then((r) => r.status);
    const b = request(app.getHttpServer() as App)
      .patch(`/v1/partners/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isVendor: false })
      .then((r) => r.status);
    // Both PATCHes must be parked behind the holder's row lock before it is
    // released — otherwise the test would pass without ever racing them.
    await waitForLockWaiters(
      '%is_customer, is_vendor FROM business_partners%',
      2,
    );
    release();
    await holder;
    const statuses = (await Promise.all([a, b])).sort();
    expect(statuses).toEqual([200, 422]);
    const row = await prisma.client.businessPartner.findUniqueOrThrow({
      where: { id },
    });
    expect(row.isCustomer || row.isVendor).toBe(true);
  });

  it('final: a partner PATCH holding its row lock does not block an FK insert referencing the partner, but still serializes with FOR SHARE readers', async () => {
    const partners = app.get(BusinessPartnersService);
    const p = await partners.create({
      code: 'LOCK-MODE',
      name: 'Before',
      isCustomer: true,
    });
    const admin = await prisma.client.user.findFirstOrThrow({
      where: { email: 'a@p.test' },
    });
    // Park the real PATCH transaction after its lock + UPDATE, before commit.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const isHeld = new Promise<void>((r) => (held = r));
    const original = prisma.transaction.bind(prisma);
    const spy = jest
      .spyOn(prisma, 'transaction')
      .mockImplementationOnce((fn, opts) =>
        original(async (tx) => {
          const r = await fn(tx);
          held();
          await gate;
          return r;
        }, opts),
      );
    try {
      const patch = partners.update(p.id, { name: 'After' });
      await isHeld;
      // An FK insert takes FOR KEY SHARE on the partner row: compatible with
      // FOR NO KEY UPDATE, so it completes while the PATCH is still open.
      // lock_timeout turns a regression (blocked insert) into a fast failure.
      const inserted = await prisma.client.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        return tx.$executeRaw`
          INSERT INTO sales_invoices (id, partner_id, date, created_by, updated_at)
          VALUES (gen_random_uuid()::text, ${p.id}, '2026-01-15', ${admin.id}, now())`;
      });
      expect(inserted).toBe(1);
      // A FOR SHARE reader (draft create / payment post) still waits for it.
      let shareDone = false;
      const share = prisma.client
        .$transaction(async (tx) => {
          const rows = await tx.$queryRaw<{ name: string }[]>`
            SELECT name FROM business_partners WHERE id = ${p.id} FOR SHARE`;
          return rows[0].name;
        })
        .then((name) => {
          shareDone = true;
          return name;
        });
      await waitForLockWaiters(
        '%FROM business_partners WHERE id = $1 FOR SHARE%',
        1,
      );
      expect(shareDone).toBe(false);
      release();
      expect((await patch).name).toBe('After');
      expect(await share).toBe('After');
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it('iter6: the DB rejects a partner row that is neither customer nor vendor (CHECK)', async () => {
    await expect(
      prisma.client.$executeRaw`
        INSERT INTO business_partners (id, code, name, is_customer, is_vendor, updated_at)
        VALUES (gen_random_uuid()::text, 'CHK-NEITHER', 'X', false, false, now())`,
    ).rejects.toThrow(/business_partners_customer_or_vendor/);
  });

  it('rejects a duplicate code (409)', async () => {
    const body = { code: 'DUP', name: 'Y', isVendor: true };
    await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201);
    await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(409);
  });

  it('soft-deletes a partner (204) then it is gone from the list', async () => {
    const created = await request(app.getHttpServer() as App)
      .post('/v1/partners')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'DEL-1', name: 'Z', isCustomer: true })
      .expect(201);
    const id = (created.body as { id: string }).id;
    await request(app.getHttpServer() as App)
      .delete(`/v1/partners/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    const list = await request(app.getHttpServer() as App)
      .get('/v1/partners')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(
      (list.body as { data: { id: string }[] }).data.some((p) => p.id === id),
    ).toBe(false);
  });

  // ── Guard-branch coverage (I-26) ──────────────────────────────────────────

  it('I-26: GET /partners/:nonexistent → 404 (!p guard in findById)', async () => {
    // if (!p) NotFoundDomainError in findById() when partner id does not exist.
    const res = await request(app.getHttpServer() as App)
      .get('/v1/partners/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    expect((res.body as { code: string }).code).toBe('NOT_FOUND');
  });

  describe('search (?q=)', () => {
    it('fuzzy-matches a typo, ranks the closer name first, and excludes non-matches', async () => {
      const partners = app.get(BusinessPartnersService);
      await partners.create({
        code: 'SR-BUDI',
        name: 'PT Budi Jaya',
        isCustomer: true,
      });
      await partners.create({
        code: 'SR-SINAR',
        name: 'CV Sinar Abadi',
        isCustomer: true,
      });
      const res = await request(app.getHttpServer() as App)
        .get('/v1/partners?q=budih') // typo for "Budi"
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const body = res.body as { data: { name: string }[]; total: number };
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      expect(body.data[0].name).toBe('PT Budi Jaya');
      expect(body.data.every((p) => p.name !== 'CV Sinar Abadi')).toBe(true);
    });

    it('finds a code containing a literal underscore (ILIKE metachars are escaped)', async () => {
      const partners = app.get(BusinessPartnersService);
      await partners.create({
        code: 'CUST_UND',
        name: 'PT Garis Bawah',
        isCustomer: true,
      });
      const res = await request(app.getHttpServer() as App)
        .get('/v1/partners?q=CUST_UND')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const body = res.body as { data: { code: string }[] };
      expect(body.data.some((p) => p.code === 'CUST_UND')).toBe(true);
    });

    it('ignores a sub-min-length q (returns the normal list)', async () => {
      const res = await request(app.getHttpServer() as App)
        .get('/v1/partners?q=a&limit=5')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const body = res.body as { data: unknown[]; limit: number };
      expect(body.limit).toBe(5);
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('excludes a soft-deleted partner from search results', async () => {
      const partners = app.get(BusinessPartnersService);
      // Create a partner with a highly distinctive name to isolate this test
      const created = await partners.create({
        code: 'SRCH-DEL-BP',
        name: 'PT Zarthronex Deleted',
        isCustomer: true,
      });
      const id = created.id;

      // Confirm it appears in search before deletion
      const before = await request(app.getHttpServer() as App)
        .get('/v1/partners?q=Zarthronex')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const bodyBefore = before.body as {
        data: { id: string }[];
        total: number;
      };
      expect(bodyBefore.data.some((p) => p.id === id)).toBe(true);
      expect(bodyBefore.total).toBeGreaterThanOrEqual(1);

      // Soft-delete via the DELETE endpoint (same path as existing soft-delete test)
      await request(app.getHttpServer() as App)
        .delete(`/v1/partners/${id}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(204);

      // Confirm it no longer appears in search results after deletion
      const after = await request(app.getHttpServer() as App)
        .get('/v1/partners?q=Zarthronex')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const bodyAfter = after.body as {
        data: { id: string }[];
        total: number;
      };
      expect(bodyAfter.data.some((p) => p.id === id)).toBe(false);
      expect(bodyAfter.total).toBe(0);
    });
  });
});
