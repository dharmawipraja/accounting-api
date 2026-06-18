import { PrismaService } from '../src/common/prisma/prisma.service';
import { UsersService } from '../src/users/users.service';
import { ConflictDomainError } from '../src/common/errors/domain-errors';
import { makePrismaOverride } from './e2e-helpers';
import { startTestDb, TestDb } from './testcontainers';

describe('UsersService (e2e)', () => {
  let db: TestDb;
  let prisma: PrismaService;
  let users: UsersService;

  beforeAll(async () => {
    db = await startTestDb();
    prisma = makePrismaOverride(db.url);
    await prisma.$connect();
    users = new UsersService(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await db?.stop();
  });

  it('creates a user with a hashed password', async () => {
    const user = await users.create({
      email: 'a@example.com',
      password: 'secret123',
      name: 'Alice',
      role: 'ACCOUNTANT',
    });
    expect(user.email).toBe('a@example.com');
    expect((user as { passwordHash?: string }).passwordHash).toBeUndefined();
  });

  it('verifies a correct password and rejects a wrong one', async () => {
    const found = await users.findByEmailWithHash('a@example.com');
    expect(found).not.toBeNull();
    expect(await users.verifyPassword(found!, 'secret123')).toBe(true);
    expect(await users.verifyPassword(found!, 'wrong')).toBe(false);
  });

  it('rejects a duplicate active email', async () => {
    await expect(
      users.create({
        email: 'a@example.com',
        password: 'x12345678',
        name: 'Dup',
        role: 'VIEWER',
      }),
    ).rejects.toBeInstanceOf(ConflictDomainError);
  });

  it('soft-deletes a user', async () => {
    const user = await users.create({
      email: 'del@example.com',
      password: 'x12345678',
      name: 'Del',
      role: 'VIEWER',
    });
    await users.softDelete(user.id, 'admin-id');
    expect(await users.findByEmailWithHash('del@example.com')).toBeNull();
  });

  it('allows reusing a soft-deleted email (tombstone)', async () => {
    const first = await users.create({
      email: 'reuse@example.com',
      password: 'x12345678',
      name: 'First',
      role: 'VIEWER',
    });
    await users.softDelete(first.id, 'admin-id');
    const second = await users.create({
      email: 'reuse@example.com',
      password: 'x12345678',
      name: 'Second',
      role: 'VIEWER',
    });
    expect(second.id).not.toBe(first.id);
  });
});
