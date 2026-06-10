import { startTestDb, TestDb } from './testcontainers';

describe('Prisma connection (e2e)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('can query the users table on a migrated database', async () => {
    const count = await db.prisma.user.count();
    expect(count).toBe(0);
  });
});
