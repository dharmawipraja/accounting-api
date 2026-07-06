import { PrismaService } from '../src/common/prisma/prisma.service';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('DB runtime config (integration)', () => {
  let db: TestDb;
  let prisma: PrismaService;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = makePrismaOverride(db.url);
    await prisma.$connect();
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await db?.stop();
  });

  it('applies a 30s statement_timeout on pooled connections', async () => {
    const rows = await prisma.$queryRaw<
      { statement_timeout: string }[]
    >`SHOW statement_timeout`;
    expect(rows[0].statement_timeout).toBe('30s');
  });

  it('enforces the payment_allocations amount > 0 CHECK at the DB layer', async () => {
    const rows = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE conname = 'payment_allocations_amount_positive'`;
    expect(rows).toHaveLength(1);
  });
});
