import { execSync } from 'node:child_process';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { TestDb } from './testcontainers';
import { bootstrapTestApp } from './e2e-helpers';

/**
 * Migration 20261010000000_coretax on existing data: punctuated / legacy
 * 15-digit NPWPs are normalized to 16 digits (one MIGRATION audit row each),
 * an unfixable live NPWP fails the deploy with nothing changed. The container
 * is at head, so the pre-migration schema is restored by hand (the
 * migration's columns, types and constraints dropped) and its row forgotten.
 */
const MIGRATION = '20261010000000_coretax';

const DOWN = `
  DROP INDEX IF EXISTS sales_invoices_tax_invoice_number_live_key;
  ALTER TABLE company_settings DROP CONSTRAINT IF EXISTS company_settings_npwp_format,
    DROP CONSTRAINT IF EXISTS company_settings_coretax_codes_format,
    DROP COLUMN IF EXISTS nitku_suffix, DROP COLUMN IF EXISTS coretax_default_item_type,
    DROP COLUMN IF EXISTS coretax_default_item_code, DROP COLUMN IF EXISTS coretax_default_unit_code;
  ALTER TABLE business_partners DROP CONSTRAINT IF EXISTS business_partners_npwp_format,
    DROP CONSTRAINT IF EXISTS business_partners_coretax_format,
    DROP COLUMN IF EXISTS buyer_document_type, DROP COLUMN IF EXISTS buyer_document_number,
    DROP COLUMN IF EXISTS nitku_suffix, DROP COLUMN IF EXISTS country;
  ALTER TABLE tax_codes DROP CONSTRAINT IF EXISTS tax_codes_coretax_vat_rate_range,
    DROP COLUMN IF EXISTS dpp_nilai_lain, DROP COLUMN IF EXISTS coretax_vat_rate;
  ALTER TABLE sales_invoice_lines DROP CONSTRAINT IF EXISTS sales_invoice_lines_coretax_format,
    DROP COLUMN IF EXISTS coretax_item_type, DROP COLUMN IF EXISTS coretax_item_code,
    DROP COLUMN IF EXISTS coretax_unit_code;
  ALTER TABLE sales_invoices DROP CONSTRAINT IF EXISTS sales_invoices_coretax_format,
    DROP COLUMN IF EXISTS trx_code, DROP COLUMN IF EXISTS tax_invoice_number,
    DROP COLUMN IF EXISTS tax_invoice_date, DROP COLUMN IF EXISTS tax_invoice_status,
    DROP COLUMN IF EXISTS coretax_exported_at, DROP COLUMN IF EXISTS withholding_slip_number,
    DROP COLUMN IF EXISTS withholding_slip_date;
  ALTER TABLE purchase_bills DROP COLUMN IF EXISTS withholding_slip_number,
    DROP COLUMN IF EXISTS withholding_slip_date;
  ALTER TABLE sales_credit_notes DROP COLUMN IF EXISTS retur_number, DROP COLUMN IF EXISTS retur_date;
  ALTER TABLE purchase_debit_notes DROP COLUMN IF EXISTS retur_number, DROP COLUMN IF EXISTS retur_date;
  DROP TYPE IF EXISTS "CoretaxItemType";
  DROP TYPE IF EXISTS "CoretaxBuyerDocument";
  DROP TYPE IF EXISTS "TaxInvoiceStatus";
  DELETE FROM _prisma_migrations WHERE migration_name = '${MIGRATION}';`;

describe(`Migration ${MIGRATION} on existing NPWP data (e2e)`, () => {
  let prisma: PrismaService;
  let db: TestDb;
  let cleanup: () => Promise<void>;

  const deploy = () =>
    execSync('npx prisma migrate deploy', {
      env: { ...process.env, DATABASE_URL: db.url },
      encoding: 'utf8',
      stdio: 'pipe',
    });
  const down = async () => {
    for (const stmt of DOWN.split(';').filter((s) => s.trim()))
      await prisma.client.$executeRawUnsafe(stmt);
  };
  const partner = (code: string, npwp: string, deleted = false) =>
    prisma.client.$executeRawUnsafe(
      `INSERT INTO business_partners (id, code, name, npwp, is_customer, updated_at, deleted_at)
       VALUES (gen_random_uuid()::text, $1, $1, $2, true, now(), $3)`,
      code,
      npwp,
      deleted ? new Date() : null,
    );
  const npwpOf = async (code: string) =>
    (
      await prisma.client.$queryRawUnsafe<{ npwp: string | null }[]>(
        `SELECT npwp FROM business_partners WHERE code = $1`,
        code,
      )
    )[0].npwp;

  beforeAll(async () => {
    ({ prisma, db, cleanup } = await bootstrapTestApp({ pipe: false }));
  }, 120_000);

  afterAll(() => cleanup());

  it('fails loudly on an unfixable live NPWP, changing nothing', async () => {
    await down();
    await partner('MIG-OK', '01.234.567.8-901.000');
    await partner('MIG-BAD', '12-34');
    expect(deploy).toThrow(/MIG-BAD|12-34/);
    expect(await npwpOf('MIG-OK')).toBe('01.234.567.8-901.000');
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM _prisma_migrations WHERE migration_name = '${MIGRATION}'`,
    );
  });

  it('normalizes the rest to 16 digits with one audit row each', async () => {
    await prisma.client.$executeRawUnsafe(
      `UPDATE business_partners SET npwp = '1234567890123456' WHERE code = 'MIG-BAD'`,
    );
    await partner('MIG-16', '1234.5678.9012.3456');
    await partner('MIG-BLANK', '  ');
    await partner('MIG-DEL', 'garbage', true);
    expect(deploy()).toContain(MIGRATION);
    expect(await npwpOf('MIG-OK')).toBe('0012345678901000');
    expect(await npwpOf('MIG-BAD')).toBe('1234567890123456');
    expect(await npwpOf('MIG-16')).toBe('1234567890123456');
    expect(await npwpOf('MIG-BLANK')).toBeNull();
    expect(await npwpOf('MIG-DEL')).toBeNull();
    const rows = await prisma.client.auditLog.findMany({
      where: { method: 'MIGRATION', path: MIGRATION },
    });
    expect(rows).toHaveLength(4); // OK, 16, BLANK, DEL — BAD was already clean
    // The CHECK now holds.
    await expect(partner('MIG-NEW', '123')).rejects.toThrow();
  });
});
