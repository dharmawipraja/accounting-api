/**
 * One-off admin bootstrap.
 *
 * The API has no user-registration endpoint, so the first ADMIN must be
 * inserted directly. This hashes the password with argon2 (matching
 * UsersService) and upserts the user, then exits.
 *
 * Usage (loads DATABASE_URL from .env.development):
 *   npm run create-admin -- <email> <password> "<name>"
 *
 * e.g.  npm run create-admin -- admin@acme.co 's3cret!' "Budi Admin"
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Role } from '@prisma/client';
import { Pool } from 'pg';
import * as argon2 from 'argon2';

async function main(): Promise<void> {
  const [rawEmail, password, name] = process.argv.slice(2);
  if (!rawEmail || !password || !name) {
    console.error('Usage: npm run create-admin -- <email> <password> "<name>"');
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(
      'DATABASE_URL is not set. Run via: npm run create-admin -- ... (it loads .env.development)',
    );
    process.exit(1);
  }

  // Same canonical form as the app (src/users/normalize-email.ts): the DB
  // enforces uniqueness on lower(email).
  const email = rawEmail.trim().toLowerCase();
  const pool = new Pool({ connectionString });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const passwordHash = await argon2.hash(password);
    const user = await prisma.user.upsert({
      where: { email },
      update: { passwordHash, name, role: Role.ADMIN, isActive: true },
      create: { email, passwordHash, name, role: Role.ADMIN },
    });
    console.log(`✓ ADMIN ready: ${user.email} (id ${user.id})`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
