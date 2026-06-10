import { startTestDb, TestDb } from './testcontainers';
import { applySoftDelete } from '../src/common/prisma/soft-delete.extension';

describe('Soft delete extension (e2e)', () => {
  let db: TestDb;
  let client: ReturnType<typeof applySoftDelete>;

  beforeAll(async () => {
    db = await startTestDb();
    client = applySoftDelete(db.prisma);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  it('hides soft-deleted rows from findMany/findFirst/count', async () => {
    const user = await client.user.create({
      data: {
        email: 'sd1@example.com',
        passwordHash: 'x',
        name: 'SD One',
        role: 'VIEWER',
      },
    });
    await client.user.softDelete({ id: user.id }, 'tester');
    expect(
      await client.user.findMany({ where: { email: 'sd1@example.com' } }),
    ).toEqual([]);
    expect(await client.user.findFirst({ where: { id: user.id } })).toBeNull();
    expect(
      await client.user.count({ where: { email: 'sd1@example.com' } }),
    ).toBe(0);
  });

  it('findUnique returns null for a soft-deleted row', async () => {
    const user = await client.user.create({
      data: {
        email: 'sd2@example.com',
        passwordHash: 'x',
        name: 'SD Two',
        role: 'VIEWER',
      },
    });
    await client.user.softDelete({ id: user.id }, 'tester');
    expect(await client.user.findUnique({ where: { id: user.id } })).toBeNull();
  });

  it('forbids hard delete on a soft-delete model', async () => {
    const user = await client.user.create({
      data: {
        email: 'sd3@example.com',
        passwordHash: 'x',
        name: 'SD Three',
        role: 'VIEWER',
      },
    });
    await expect(
      client.user.delete({ where: { id: user.id } }),
    ).rejects.toThrow(/Hard delete forbidden/);
  });
});
