import { execSync } from 'node:child_process';
import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import { TaxCodesService } from '../src/tax/tax-codes.service';
import { TestDb } from './testcontainers';
import { bootstrapTestApp } from './e2e-helpers';

/**
 * Migration 20261006000000_pph42_final_expense_account must bring an install
 * seeded BEFORE the fix (no 5-9100, PPH42-PRE on 1-1500) to the new seed's
 * state, and be a no-op when re-applied. The container is at head, so the
 * legacy state is rebuilt by hand and the migration row forgotten first.
 */
const MIGRATION = '20261006000000_pph42_final_expense_account';

describe(`Migration ${MIGRATION} on a pre-fix install (e2e)`, () => {
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
  const pph42Account = async () => {
    const [row] = await prisma.client.$queryRaw<{ code: string }[]>`
      SELECT a.code FROM tax_codes t JOIN accounts a ON a.id = t.tax_account_id
      WHERE t.code = 'PPH42-PRE'`;
    return row.code;
  };
  const migrationRows = () =>
    prisma.client.auditLog.count({
      where: { method: 'MIGRATION', path: MIGRATION },
    });

  beforeAll(async () => {
    ({ app, prisma, db, cleanup } = await bootstrapTestApp({ pipe: false }));
    await app.get(AccountsService).seedIfEmpty();
    await app.get(TaxCodesService).seedIfEmpty();
  }, 120_000);

  afterAll(() => cleanup());

  it('creates 5-9100 and repoints PPH42-PRE from 1-1500, then is a no-op', async () => {
    // Legacy state: the pre-fix seed.
    await prisma.client.$executeRawUnsafe(`
      UPDATE tax_codes SET tax_account_id = (SELECT id FROM accounts WHERE code = '1-1500')
      WHERE code = 'PPH42-PRE'`);
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM accounts WHERE code = '5-9100'`,
    );
    await forget();
    expect(await pph42Account()).toBe('1-1500');

    expect(deploy()).toContain(MIGRATION);
    expect(await pph42Account()).toBe('5-9100');
    const created = await prisma.client.account.findFirstOrThrow({
      where: { code: '5-9100' },
      include: { parent: true },
    });
    expect(created).toMatchObject({
      type: 'EXPENSE',
      subtype: 'OTHER_EXPENSE',
      normalBalance: 'DEBIT',
      isPostable: true,
      role: null,
    });
    expect(created.parent?.code).toBe('5-0000');
    expect(await migrationRows()).toBe(2); // account created + code repointed

    // Re-applied on the fixed state: nothing changes, no new audit rows.
    await forget();
    deploy();
    expect(await pph42Account()).toBe('5-9100');
    expect(await migrationRows()).toBe(2);
  });

  it('leaves PPH42-PRE alone when an operator already moved it elsewhere', async () => {
    const other = await prisma.client.account.findFirstOrThrow({
      where: { code: '5-9000' },
    });
    await prisma.client.$executeRawUnsafe(
      `UPDATE tax_codes SET tax_account_id = $1 WHERE code = 'PPH42-PRE'`,
      other.id,
    );
    await forget();
    deploy();
    expect(await pph42Account()).toBe('5-9000');
  });
});
