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

  it('findUnique does not leak a soft-deleted row when select omits deletedAt', async () => {
    const user = await client.user.create({
      data: {
        email: 'sd4@example.com',
        passwordHash: 'x',
        name: 'SD Four',
        role: 'VIEWER',
      },
    });
    await client.user.softDelete({ id: user.id }, 'tester');
    const found = await client.user.findUnique({
      where: { id: user.id },
      select: { id: true, email: true },
    });
    expect(found).toBeNull();
  });

  it('findUniqueOrThrow throws P2025 for a soft-deleted row', async () => {
    const user = await client.user.create({
      data: {
        email: 'sd5@example.com',
        passwordHash: 'x',
        name: 'SD Five',
        role: 'VIEWER',
      },
    });
    await client.user.softDelete({ id: user.id }, 'tester');
    await expect(
      client.user.findUniqueOrThrow({ where: { id: user.id } }),
    ).rejects.toMatchObject({ code: 'P2025' });
  });

  it('findUnique still returns requested fields for a live row (deletedAt stripped when not requested)', async () => {
    const user = await client.user.create({
      data: {
        email: 'sd6@example.com',
        passwordHash: 'x',
        name: 'SD Six',
        role: 'VIEWER',
      },
    });
    const found = await client.user.findUnique({
      where: { id: user.id },
      select: { id: true, email: true },
    });
    expect(found).toEqual({ id: user.id, email: 'sd6@example.com' });
  });
});
