import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { type App } from 'supertest/types';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { PeriodsService } from '../src/ledger/periods/periods.service';
import { PostingService } from '../src/ledger/posting/posting.service';
import { CompanyService } from '../src/company/company.service';
import { AuthService } from '../src/auth/auth.service';
import { UsersService } from '../src/users/users.service';
import { uniqueViolationIndex } from '../src/common/errors/map-unique-violation';
import { bootstrapTestApp } from './e2e-helpers';

describe('Accounts (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cleanup: () => Promise<void>;
  let adminToken: string;

  beforeAll(async () => {
    ({ app, prisma, cleanup } = await bootstrapTestApp());

    await app.get(AccountsService).seedIfEmpty();
    const users = app.get(UsersService);
    await users.create({
      email: 'admin@x.com',
      password: 'secret123',
      name: 'A',
      role: 'ADMIN',
    });
    adminToken = (await app.get(AuthService).login('admin@x.com', 'secret123'))
      .accessToken;
  }, 120_000);

  afterAll(() => cleanup());

  it('seeds the SAK chart with parent links resolved', async () => {
    const res = await request(app.getHttpServer() as App)
      .get('/v1/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as {
      data: { code: string; parentId: string | null }[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.total).toBeGreaterThanOrEqual(0);
    expect(body.limit).toBeGreaterThan(0);
    expect(body.offset).toBe(0);
    expect(Array.isArray(body.data)).toBe(true);
    const codes = body.data.map((a) => a.code);
    expect(codes).toContain('1-1000'); // Kas
    expect(codes).toContain('3-9000'); // Saldo Awal
    const kas = body.data.find((a) => a.code === '1-1000');
    expect(kas?.parentId).toBeTruthy();
  });

  it('seedIfEmpty is idempotent', async () => {
    await app.get(AccountsService).seedIfEmpty();
    const count = await prisma.client.account.count();
    expect(count).toBe(28);
  });

  it('seedIfEmpty assigns system-account roles', async () => {
    const byCode = async (code: string) =>
      prisma.client.account.findFirst({ where: { code } });
    expect((await byCode('1-1000'))?.role).toBe('CASH');
    expect((await byCode('1-1100'))?.role).toBe('CASH');
    expect((await byCode('1-1200'))?.role).toBe('AR_CONTROL');
    expect((await byCode('2-1000'))?.role).toBe('AP_CONTROL');
    expect((await byCode('3-2000'))?.role).toBe('RETAINED_EARNINGS');
    expect((await byCode('3-9000'))?.role).toBe('OPENING_BALANCE_EQUITY');
    expect((await byCode('5-9000'))?.role).toBe('TAX_EXPENSE');
    // a non-system account has no role
    expect((await byCode('1-1300'))?.role).toBeNull();
  });

  it('creates a postable account', async () => {
    await request(app.getHttpServer() as App)
      .post('/v1/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '1-1600',
        name: 'Kas Kecil',
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        normalBalance: 'DEBIT',
        parentCode: '1-0000',
      })
      .expect(201);
  });

  it('rejects a duplicate active code (409)', async () => {
    await request(app.getHttpServer() as App)
      .post('/v1/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '1-1000',
        name: 'Dup',
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        normalBalance: 'DEBIT',
      })
      .expect(409);
  });

  it('iter8: account codes are unique case-insensitively after NFKC + trim (409); blank / zero-width codes and names are 400; parentCode is normalized', async () => {
    const post = (body: object) =>
      request(app.getHttpServer() as App)
        .post('/v1/ledger/accounts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          name: 'Kas Cabang',
          type: 'ASSET',
          subtype: 'CURRENT_ASSET',
          normalBalance: 'DEBIT',
          ...body,
        });
    const created = await post({
      code: 'kc-1',
      name: '  Kas Cabang  ',
      parentCode: ' １-0000 ',
    }).expect(201);
    const body = created.body as {
      code: string;
      name: string;
      parentId: string;
    };
    expect(body.name).toBe('Kas Cabang');
    expect(body.parentId).toBeTruthy();
    for (const code of ['KC-1', 'kc-1 ', 'ＫＣ-１']) {
      const res = await post({ code }).expect(409);
      expect((res.body as { code: string }).code).toBe('CONFLICT');
    }
    for (const bad of [
      { code: '' },
      { code: '   ' },
      { code: 'KC\u200B2' },
      { code: 'KC-3', name: ' ' },
      { code: 'KC-4', name: 'Kas\u200D' },
    ]) {
      const res = await post(bad).expect(400);
      expect((res.body as { code: string }).code).toBe('HTTP_400');
    }
    // PATCH name is trimmed / rejects zero-width characters too.
    const id = (created.body as { id: string }).id;
    const renamed = await request(app.getHttpServer() as App)
      .patch(`/v1/ledger/accounts/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: ' Kas Cabang Bali ' })
      .expect(200);
    expect((renamed.body as { name: string }).name).toBe('Kas Cabang Bali');
    await request(app.getHttpServer() as App)
      .patch(`/v1/ledger/accounts/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '\uFEFF' })
      .expect(400);
  });

  it('iter8-final: parentCode matches the header case-insensitively ("hdr-1" finds "HDR-1")', async () => {
    const base = {
      type: 'ASSET',
      subtype: 'CURRENT_ASSET',
      normalBalance: 'DEBIT',
    };
    const header = await request(app.getHttpServer() as App)
      .post('/v1/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ...base, code: 'HDR-1', name: 'Header', isPostable: false })
      .expect(201);
    const child = await request(app.getHttpServer() as App)
      .post('/v1/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ ...base, code: 'HDR-1-01', name: 'Child', parentCode: 'hdr-1' })
      .expect(201);
    expect((child.body as { parentId: string }).parentId).toBe(
      (header.body as { id: string }).id,
    );
  });

  it('iter8-final: the service normalizes code / name / parentCode itself (a caller bypassing the DTO)', async () => {
    const svc = app.get(AccountsService);
    const created = await svc.create({
      code: ' ＳＶＣ-1 ',
      name: '  Service Direct  ',
      type: 'ASSET',
      subtype: 'CURRENT_ASSET',
      normalBalance: 'DEBIT',
      parentCode: ' hdr-1 ',
    });
    expect(created.code).toBe('SVC-1');
    expect(created.name).toBe('Service Direct');
    expect(created.parentId).toBeTruthy();
    await expect(
      svc.create({
        code: 'svc-1',
        name: 'Dup',
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        normalBalance: 'DEBIT',
      }),
    ).rejects.toMatchObject({ message: 'Account code already exists' });
    const renamed = await svc.update(created.id, { name: ' Renamed ' });
    expect(renamed.name).toBe('Renamed');
  });

  it('rejects posting-account parent (422)', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/v1/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '1-1700',
        name: 'Bad Parent',
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        normalBalance: 'DEBIT',
        parentCode: '1-1000',
      })
      .expect(422);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('rejects incoherent type/subtype pair (422)', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/v1/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '1-9999',
        name: 'Incoherent',
        type: 'ASSET',
        subtype: 'TAX_PAYABLE',
        normalBalance: 'DEBIT',
      })
      .expect(422);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  it('deactivates an account (200, isActive false)', async () => {
    const created = await request(app.getHttpServer() as App)
      .post('/v1/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '1-1610',
        name: 'To Deactivate',
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        normalBalance: 'DEBIT',
        parentCode: '1-0000',
      })
      .expect(201);
    const id = (created.body as { id: string }).id;
    await request(app.getHttpServer() as App)
      .post(`/v1/ledger/accounts/${id}/deactivate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200)
      .expect((r) =>
        expect((r.body as { isActive: boolean }).isActive).toBe(false),
      );
  });

  it('soft-deletes an account (204) then hides it (404)', async () => {
    const created = await request(app.getHttpServer() as App)
      .post('/v1/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '1-1620',
        name: 'To Delete',
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        normalBalance: 'DEBIT',
        parentCode: '1-0000',
      })
      .expect(201);
    const id = (created.body as { id: string }).id;
    await request(app.getHttpServer() as App)
      .delete(`/v1/ledger/accounts/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);
    await request(app.getHttpServer() as App)
      .get(`/v1/ledger/accounts/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('creates an account with a CASH role', async () => {
    const res = await request(app.getHttpServer() as App)
      .post('/v1/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '1-1700',
        name: 'Bank Ketiga',
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        normalBalance: 'DEBIT',
        role: 'CASH',
        parentCode: '1-0000',
      })
      .expect(201);
    expect((res.body as { role: string }).role).toBe('CASH');
  });

  it('rejects a second holder of a singleton role with 409', async () => {
    await request(app.getHttpServer() as App)
      .post('/v1/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '1-1250',
        name: 'AR Control 2',
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        normalBalance: 'DEBIT',
        role: 'AR_CONTROL',
        parentCode: '1-0000',
      })
      .expect(409);
  });

  it('iter9: a singleton-role race (pre-check passed, unique index fires) is the role 409, not "code already exists"', async () => {
    // A live violation carries the index name where uniqueViolationIndex
    // reads it.
    const err: unknown = await prisma.client.account
      .create({
        data: {
          code: 'RACE-RAW',
          name: 'Raw',
          type: 'ASSET',
          subtype: 'CURRENT_ASSET',
          normalBalance: 'DEBIT',
          role: 'AR_CONTROL',
        },
      })
      .catch((e: unknown) => e);
    expect(uniqueViolationIndex(err)).toBe('accounts_singleton_role');

    // The race itself: the role pre-check sees no holder (another request
    // has not committed yet), then the insert hits accounts_singleton_role.
    const spy = jest
      .spyOn(prisma.client.account, 'findFirst')
      .mockResolvedValueOnce(null);
    try {
      const res = await request(app.getHttpServer() as App)
        .post('/v1/ledger/accounts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          code: 'RACE-AR',
          name: 'AR Control race',
          type: 'ASSET',
          subtype: 'CURRENT_ASSET',
          normalBalance: 'DEBIT',
          role: 'AR_CONTROL',
        })
        .expect(409);
      expect(spy).toHaveBeenCalled();
      expect(res.body).toMatchObject({
        code: 'CONFLICT',
        message: 'That account role is already assigned',
        details: { role: 'AR_CONTROL' },
      });
    } finally {
      spy.mockRestore();
    }
  });

  describe('iter9: account hierarchy — headers with live children, parentCode must be an active header', () => {
    const base = {
      type: 'ASSET',
      subtype: 'CURRENT_ASSET',
      normalBalance: 'DEBIT',
    };
    const post = (body: Record<string, unknown>) =>
      request(app.getHttpServer() as App)
        .post('/v1/ledger/accounts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ ...base, ...body });
    const del = (id: string) =>
      request(app.getHttpServer() as App)
        .delete(`/v1/ledger/accounts/${id}`)
        .set('Authorization', `Bearer ${adminToken}`);
    const deactivate = (id: string) =>
      request(app.getHttpServer() as App)
        .post(`/v1/ledger/accounts/${id}/deactivate`)
        .set('Authorization', `Bearer ${adminToken}`);

    it('refuses to delete / deactivate a header with live children (422 reason HAS_CHILDREN) until they are gone', async () => {
      const header = (
        await post({ code: 'TREE-H', name: 'Tree', isPostable: false }).expect(
          201,
        )
      ).body as { id: string };
      const child = (
        await post({
          code: 'TREE-C',
          name: 'Leaf',
          parentCode: 'TREE-H',
        }).expect(201)
      ).body as { id: string };

      for (const res of [
        await del(header.id),
        await deactivate(header.id),
        await request(app.getHttpServer() as App)
          .patch(`/v1/ledger/accounts/${header.id}`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({ isActive: false }),
      ]) {
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({
          code: 'VALIDATION_FAILED',
          details: { id: header.id, reason: 'HAS_CHILDREN', children: 1 },
        });
      }

      // An inactive child still blocks deletion (it would be orphaned under
      // a deleted header) but no longer blocks deactivation.
      await deactivate(child.id).expect(200);
      expect((await del(header.id)).body).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { reason: 'HAS_CHILDREN' },
      });
      await deactivate(header.id).expect(200);

      await del(child.id).expect(204);
      await del(header.id).expect(204);
    });

    it('parentCode must name an active, live header (422 otherwise)', async () => {
      const header = (
        await post({ code: 'TREE-I', name: 'Idle', isPostable: false }).expect(
          201,
        )
      ).body as { id: string };
      await deactivate(header.id).expect(200);
      const inactive = await post({
        code: 'TREE-I-1',
        name: 'Under inactive',
        parentCode: 'tree-i',
      }).expect(422);
      expect(inactive.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        message: 'Parent account must be active',
        details: { parentCode: 'tree-i' },
      });

      await del(header.id).expect(204);
      const gone = await post({
        code: 'TREE-I-2',
        name: 'Under deleted',
        parentCode: 'TREE-I',
      }).expect(422);
      expect(gone.body).toMatchObject({
        message: 'Parent account not found',
      });
    });
  });

  it('rejects deleting an account that has posted journal lines (422 VALIDATION_FAILED)', async () => {
    // L-28: AccountsService.softDelete — account has posted lines
    const created = await request(app.getHttpServer() as App)
      .post('/v1/ledger/accounts')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        code: '1-1910',
        name: 'Posted Account',
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        normalBalance: 'DEBIT',
        parentCode: '1-0000',
      })
      .expect(201);
    const id = (created.body as { id: string }).id;

    const { data: accounts } = await app.get(AccountsService).list();
    const modalId = accounts.find((a) => a.code === '3-1000')!.id;

    await app.get(CompanyService).seedIfEmpty();
    await app.get(PeriodsService).generatePeriods(2040);

    await app.get(PostingService).post(
      {
        date: new Date('2040-02-10'),
        description: 'L-28 posted line',
        sourceType: 'MANUAL',
        createdBy: 'a',
        lines: [
          { accountId: id, debit: '1000' },
          { accountId: modalId, credit: '1000' },
        ],
      },
      'p',
    );

    const res = await request(app.getHttpServer() as App)
      .delete(`/v1/ledger/accounts/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(422);
    expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
  });

  describe('system (role) accounts cannot be retired', () => {
    const roleAccountId = async (role: 'CASH' | 'AR_CONTROL' | 'TAX_EXPENSE') =>
      (await prisma.client.account.findFirst({ where: { role } }))!.id;

    it('rejects deactivating an account with a role (422 VALIDATION_FAILED)', async () => {
      const id = await roleAccountId('AR_CONTROL');
      const res = await request(app.getHttpServer() as App)
        .post(`/v1/ledger/accounts/${id}/deactivate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(422);
      expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
      expect(
        (await prisma.client.account.findFirst({ where: { id } }))!.isActive,
      ).toBe(true);
    });

    it('rejects PATCH isActive=false on an account with a singleton role (422)', async () => {
      const id = await roleAccountId('TAX_EXPENSE');
      const res = await request(app.getHttpServer() as App)
        .patch(`/v1/ledger/accounts/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isActive: false })
        .expect(422);
      expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
    });

    it('still allows renaming an account with a role (200)', async () => {
      const id = await roleAccountId('CASH');
      await request(app.getHttpServer() as App)
        .patch(`/v1/ledger/accounts/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Kas Kecil' })
        .expect(200);
    });

    it('rejects deleting an account with a role even with no posted lines (422)', async () => {
      const id = await roleAccountId('TAX_EXPENSE');
      const res = await request(app.getHttpServer() as App)
        .delete(`/v1/ledger/accounts/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(422);
      expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
      expect(await prisma.client.account.count({ where: { id } })).toBe(1);
    });
  });

  describe('CASH accounts: retirable when zero-balance and not the last; role assignable by PATCH', () => {
    const server = () => app.getHttpServer() as App;
    const createAccount = async (body: Record<string, unknown>) =>
      (
        (
          await request(server())
            .post('/v1/ledger/accounts')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ parentCode: '1-0000', ...body })
            .expect(201)
        ).body as { id: string }
      ).id;
    const cashAccount = (code: string) =>
      createAccount({
        code,
        name: `Bank ${code}`,
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        normalBalance: 'DEBIT',
        role: 'CASH',
      });
    const postCash = async (cashId: string, side: 'debit' | 'credit') => {
      const { data: accounts } = await app.get(AccountsService).list();
      const modalId = accounts.find((a) => a.code === '3-1000')!.id;
      await app.get(CompanyService).seedIfEmpty();
      await app.get(PeriodsService).generatePeriods(2040);
      await app.get(PostingService).post(
        {
          date: new Date('2040-03-10'),
          description: `cash ${side}`,
          sourceType: 'MANUAL',
          createdBy: 'a',
          lines:
            side === 'debit'
              ? [
                  { accountId: cashId, debit: '1000' },
                  { accountId: modalId, credit: '1000' },
                ]
              : [
                  { accountId: modalId, debit: '1000' },
                  { accountId: cashId, credit: '1000' },
                ],
        },
        'p',
      );
    };

    it('deactivates a zero-balance secondary CASH account (200)', async () => {
      const id = await cashAccount('1-1810');
      const res = await request(server())
        .post(`/v1/ledger/accounts/${id}/deactivate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect((res.body as { isActive: boolean }).isActive).toBe(false);
    });

    it('rejects retiring a CASH account with a non-zero balance (422), allows it once the balance nets to zero', async () => {
      const id = await cashAccount('1-1820');
      await postCash(id, 'debit');
      const res = await request(server())
        .post(`/v1/ledger/accounts/${id}/deactivate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(422);
      expect(res.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { id, role: 'CASH', balance: '1000.0000' },
      });
      await request(server())
        .delete(`/v1/ledger/accounts/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(422);
      await postCash(id, 'credit');
      await request(server())
        .post(`/v1/ledger/accounts/${id}/deactivate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    });

    it('soft-deletes a zero-balance CASH account with no posted lines (204)', async () => {
      const id = await cashAccount('1-1825');
      await request(server())
        .delete(`/v1/ledger/accounts/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(204);
    });

    it('PATCH role=CASH on a debit-normal ASSET account without a role (200)', async () => {
      const id = await createAccount({
        code: '1-1830',
        name: 'Rekening Lama',
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        normalBalance: 'DEBIT',
      });
      const res = await request(server())
        .patch(`/v1/ledger/accounts/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'CASH' })
        .expect(200);
      expect((res.body as { role: string }).role).toBe('CASH');
    });

    it('rejects PATCH role=CASH on a credit-normal (contra) asset (422)', async () => {
      const id = await createAccount({
        code: '1-1840',
        name: 'Akumulasi Penyusutan X',
        type: 'ASSET',
        subtype: 'ACCUMULATED_DEPRECIATION',
        normalBalance: 'CREDIT',
      });
      const res = await request(server())
        .patch(`/v1/ledger/accounts/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'CASH' })
        .expect(422);
      expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
    });

    it('rejects PATCH role=CASH on a non-ASSET account (422)', async () => {
      const id = await createAccount({
        code: '2-1830',
        name: 'Utang Lain',
        type: 'LIABILITY',
        subtype: 'CURRENT_LIABILITY',
        normalBalance: 'CREDIT',
        parentCode: '2-0000',
      });
      await request(server())
        .patch(`/v1/ledger/accounts/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'CASH' })
        .expect(422);
    });

    it('rejects PATCH role=CASH on an account holding a singleton role (422)', async () => {
      const ar = (await prisma.client.account.findFirst({
        where: { role: 'AR_CONTROL' },
      }))!.id;
      await request(server())
        .patch(`/v1/ledger/accounts/${ar}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'CASH' })
        .expect(422);
      expect(
        (await prisma.client.account.findFirst({ where: { id: ar } }))!.role,
      ).toBe('AR_CONTROL');
    });

    it('rejects PATCH of a singleton role (create-only) with 400', async () => {
      const id = await createAccount({
        code: '1-1850',
        name: 'Piutang Lain',
        type: 'ASSET',
        subtype: 'CURRENT_ASSET',
        normalBalance: 'DEBIT',
      });
      await request(server())
        .patch(`/v1/ledger/accounts/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'AR_CONTROL' })
        .expect(400);
    });

    it.each([
      [
        'a credit-normal (contra) asset',
        '1-1901',
        { subtype: 'ACCUMULATED_DEPRECIATION', normalBalance: 'CREDIT' },
      ],
      [
        'a non-ASSET account',
        '2-1901',
        {
          type: 'LIABILITY',
          subtype: 'CURRENT_LIABILITY',
          normalBalance: 'CREDIT',
          parentCode: '2-0000',
        },
      ],
      ['a non-postable header', '1-1902', { isPostable: false }],
    ])(
      'rejects CREATE with role=CASH on %s (422, same rule as PATCH)',
      async (_label, code, patch) => {
        const res = await request(server())
          .post('/v1/ledger/accounts')
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            parentCode: '1-0000',
            code,
            name: `Bad cash ${code}`,
            type: 'ASSET',
            subtype: 'CURRENT_ASSET',
            normalBalance: 'DEBIT',
            role: 'CASH',
            ...patch,
          })
          .expect(422);
        expect((res.body as { code: string }).code).toBe('VALIDATION_FAILED');
        expect(await prisma.client.account.count({ where: { code } })).toBe(0);
      },
    );

    it('rejects PATCH role=null with 400 (role cannot be cleared)', async () => {
      const id = await cashAccount('1-1860');
      await request(server())
        .patch(`/v1/ledger/accounts/${id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: null })
        .expect(400);
      expect(
        (await prisma.client.account.findFirst({ where: { id } }))!.role,
      ).toBe('CASH');
    });

    it('rejects retiring the last active CASH account (422)', async () => {
      const kas = (await prisma.client.account.findFirst({
        where: { code: '1-1000' },
      }))!.id;
      const others = await prisma.client.account.findMany({
        where: { role: 'CASH', isActive: true, id: { not: kas } },
      });
      for (const o of others) {
        await request(server())
          .post(`/v1/ledger/accounts/${o.id}/deactivate`)
          .set('Authorization', `Bearer ${adminToken}`)
          .expect(200);
      }
      // A legacy non-postable CASH row (unreachable through the API now) must
      // not count as the "other active CASH account" — payments can't use it.
      await prisma.client.account.create({
        data: {
          code: '1-1899',
          name: 'Legacy header cash',
          type: 'ASSET',
          subtype: 'CURRENT_ASSET',
          normalBalance: 'DEBIT',
          role: 'CASH',
          isPostable: false,
        },
      });
      const res = await request(server())
        .post(`/v1/ledger/accounts/${kas}/deactivate`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(422);
      expect(res.body).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { id: kas, role: 'CASH', otherActiveCashAccounts: 0 },
      });
      await request(server())
        .delete(`/v1/ledger/accounts/${kas}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(422);
      expect(
        (await prisma.client.account.findFirst({ where: { id: kas } }))!
          .isActive,
      ).toBe(true);
    });
  });
});
