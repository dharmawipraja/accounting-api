/**
 * One-off admin bootstrap.
 *
 * The API has no user-registration endpoint, so the first ADMIN must be
 * inserted directly. This hashes the password with argon2 (matching
 * UsersService) and upserts the user, then exits.
 *
 * It reads ONLY `process.env` (never a dotenv file itself): DATABASE_URL is
 * required, and the password may come from ADMIN_PASSWORD instead of argv
 * (keeps it out of shell history and `ps`).
 *
 * Local dev (the npm script loads .env.development):
 *   npm run create-admin -- <email> <password> "<name>"
 *   e.g.  npm run create-admin -- admin@acme.co 's3cret-pw' "Budi Admin"
 *
 * Production (compiled into the api image as dist/scripts/create-admin.js;
 * DATABASE_URL comes from the api service's compose environment):
 *   read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD
 *   $COMPOSE run --rm --no-deps -e ADMIN_PASSWORD api \
 *     node dist/scripts/create-admin.js <email> "<name>"
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Role } from '@prisma/client';
import { Pool } from 'pg';
import * as argon2 from 'argon2';

const USAGE =
  'Usage: create-admin <email> <password> "<name>"\n' +
  '   or: ADMIN_PASSWORD=... create-admin <email> "<name>"';

// Same bounds as LoginDto: a password outside them could never log in.
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const envPassword = process.env.ADMIN_PASSWORD;
  let rawEmail: string | undefined;
  let password: string | undefined;
  let name: string | undefined;
  if (envPassword && args.length === 2) {
    [rawEmail, name] = args;
    password = envPassword;
  } else if (args.length === 3) {
    [rawEmail, password, name] = args;
  }
  if (!rawEmail || !password || !name) {
    console.error(USAGE);
    process.exit(1);
  }
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    console.error(
      `Password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters (the login endpoint rejects anything else).`,
    );
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(
      'DATABASE_URL is not set. Locally use `npm run create-admin -- ...` (it loads .env.development); ' +
        'in production run it inside the api container (see docs/runbooks/deploy.md).',
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
