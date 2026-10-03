import { execSync } from 'node:child_process';
import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { TestDb } from './testcontainers';
import { bootstrapTestApp } from './e2e-helpers';

/**
 * Migration 20261008100001_payment_advance_accounts must give an install
 * seeded BEFORE the advances feature (no 2-1300 / 1-1600) the two role-carrying
 * advance accounts, be a no-op when re-applied, and leave a taken code alone.
 * The container is at head, so the legacy state is rebuilt by hand and the
 * migration row forgotten first.
 */
const MIGRATION = '20261008100001_payment_advance_accounts';

describe(`Migration ${MIGRATION} on a pre-feature install (e2e)`, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let db: TestDb;
  let cleanup: () => Promise<void>;

  const deploy = () =>
    execSync('npx prisma migrate deploy', {
      env: { ...process.env, DATABASE_URL: db.url },
      encoding: 'utf8',
    });
  const forget = () =>
    prisma.client.$executeRawUnsafe(
      `DELETE FROM _prisma_migrations WHERE migration_name = '${MIGRATION}'`,
    );
  const legacy = () =>
    prisma.client.$executeRawUnsafe(
      `DELETE FROM accounts WHERE code IN ('2-1300', '1-1600')`,
    );
  const migrationRows = () =>
    prisma.client.auditLog.count({
      where: { method: 'MIGRATION', path: MIGRATION },
    });
  const byRole = (role: 'CUSTOMER_ADVANCE' | 'VENDOR_ADVANCE') =>
    prisma.client.account.findFirst({
      where: { role },
      include: { parent: true },
    });

  beforeAll(async () => {
    ({ app, prisma, db, cleanup } = await bootstrapTestApp({ pipe: false }));
    await app.get(AccountsService).seedIfEmpty();
  }, 120_000);

  afterAll(() => cleanup());

  it('creates both advance accounts with roles under their headers, then is a no-op', async () => {
    await legacy();
    await forget();
    expect(await byRole('CUSTOMER_ADVANCE')).toBeNull();

    expect(deploy()).toContain(MIGRATION);
    expect(await byRole('CUSTOMER_ADVANCE')).toMatchObject({
      code: '2-1300',
      name: 'Uang Muka Pelanggan',
      type: 'LIABILITY',
      subtype: 'CURRENT_LIABILITY',
      normalBalance: 'CREDIT',
      cashFlowCategory: 'OPERATING',
      isPostable: true,
      isActive: true,
      parent: { code: '2-0000' },
    });
    expect(await byRole('VENDOR_ADVANCE')).toMatchObject({
      code: '1-1600',
      name: 'Uang Muka Pembelian',
      type: 'ASSET',
      subtype: 'CURRENT_ASSET',
      normalBalance: 'DEBIT',
      cashFlowCategory: 'OPERATING',
      isPostable: true,
      parent: { code: '1-0000' },
    });
    expect(await migrationRows()).toBe(2);

    await forget();
    deploy();
    expect(
      await prisma.client.account.count({ where: { code: '2-1300' } }),
    ).toBe(1);
    expect(await migrationRows()).toBe(2);
  });

  it('leaves a taken code alone (no role account created) and creates the other', async () => {
    await legacy();
    // An operator already used 1-1600 for something else.
    await prisma.client.$executeRawUnsafe(`
      INSERT INTO accounts (id, code, name, type, subtype, normal_balance, is_postable, is_active, currency, updated_at)
      VALUES (gen_random_uuid()::text, '1-1600', 'Kas Kecil', 'ASSET', 'CURRENT_ASSET', 'DEBIT', true, true, 'IDR', now())`);
    await forget();
    deploy();
    expect(await byRole('VENDOR_ADVANCE')).toBeNull();
    expect(
      (await prisma.client.account.findFirst({ where: { code: '1-1600' } }))
        ?.name,
    ).toBe('Kas Kecil');
    expect((await byRole('CUSTOMER_ADVANCE'))?.code).toBe('2-1300');
    expect(await migrationRows()).toBe(3); // + the re-created 2-1300
  });

  it('keeps an operator-created role holder (any code)', async () => {
    await legacy();
    await prisma.client.$executeRawUnsafe(`
      INSERT INTO accounts (id, code, name, type, subtype, normal_balance, role, is_postable, is_active, currency, updated_at)
      VALUES (gen_random_uuid()::text, '2-1900', 'Uang Muka Diterima', 'LIABILITY', 'CURRENT_LIABILITY', 'CREDIT', 'CUSTOMER_ADVANCE', true, true, 'IDR', now())`);
    const before = await migrationRows();
    await forget();
    deploy();
    expect((await byRole('CUSTOMER_ADVANCE'))?.code).toBe('2-1900');
    expect(
      await prisma.client.account.count({ where: { code: '2-1300' } }),
    ).toBe(0);
    expect(await migrationRows()).toBe(before + 1); // only 1-1600
    expect((await byRole('VENDOR_ADVANCE'))?.code).toBe('1-1600');
  });
});
