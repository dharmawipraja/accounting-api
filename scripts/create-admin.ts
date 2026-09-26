/**
 * One-off admin bootstrap / break-glass reset.
 *
 * The API has no user-registration endpoint, so the first ADMIN must be
 * inserted directly. This hashes the password with argon2 (as UsersService
 * does) and creates the user — or, for an existing email, resets it — then exits.
 *
 * Same semantics as the app's admin password reset: the operator-chosen
 * password is a TEMPORARY one (`mustChangePassword: true` — login works, every
 * other route answers 403 PASSWORD_CHANGE_REQUIRED until POST
 * /v1/auth/change-password), and for an existing user every refresh token is
 * revoked in the same transaction (stale sessions die with the reset).
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
import {
  REFRESH_SESSION_LOCK_NS,
  USER_ADMIN_LOCK_KEY,
} from '../src/common/concurrency/advisory-lock-keys';

const USAGE =
  'Usage: create-admin <email> <password> "<name>"\n' +
  '   or: ADMIN_PASSWORD=... create-admin <email> "<name>"';

// Same bounds as LoginDto: a password outside them could never log in.
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export interface BootstrapAdminInput {
  email: string;
  password: string;
  name: string;
}

export interface BootstrapAdminResult {
  id: string;
  email: string;
  /** false = an existing user was reset (sessions revoked). */
  created: boolean;
}

/**
 * Create the ADMIN, or reset the existing live user with that email to ADMIN +
 * active + new temp password, revoking all its refresh tokens atomically.
 *
 * Lock order: admin-pool lock (71_001_001, as UserAdminService) → per-user
 * session lock (71_002, hashtext(user_id), as RefreshTokenService) → user row
 * FOR UPDATE → token rows. The session lock precedes the row lock because a
 * session-lock holder (login/refresh) INSERTs a refresh token whose FK check
 * takes FOR KEY SHARE on the user row; holding the row FOR UPDATE while waiting
 * for the session lock could deadlock with it.
 */
export async function bootstrapAdmin(
  prisma: PrismaClient,
  input: BootstrapAdminInput,
): Promise<BootstrapAdminResult> {
  if (
    input.password.length < PASSWORD_MIN ||
    input.password.length > PASSWORD_MAX
  ) {
    throw new Error(
      `Password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters (the login endpoint rejects anything else).`,
    );
  }
  // Same canonical form as the app (src/users/normalize-email.ts): the DB
  // enforces uniqueness on lower(email).
  const email = input.email.trim().toLowerCase();
  const name = input.name;
  const passwordHash = await argon2.hash(input.password);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${USER_ADMIN_LOCK_KEY})`;
    // Email → id is stable under the admin-pool lock (tombstoning takes it too;
    // email is not updatable).
    const existing = await tx.user.findFirst({
      where: { email, deletedAt: null },
      select: { id: true },
    });
    if (!existing) {
      const user = await tx.user.create({
        data: {
          email,
          passwordHash,
          name,
          role: Role.ADMIN,
          mustChangePassword: true,
        },
      });
      return { id: user.id, email: user.email, created: true };
    }
    const id = existing.id;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REFRESH_SESSION_LOCK_NS}::int4, hashtext(${id}))`;
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${id} FOR UPDATE`;
    const user = await tx.user.update({
      where: { id },
      data: {
        passwordHash,
        name,
        role: Role.ADMIN,
        isActive: true,
        mustChangePassword: true,
      },
    });
    await tx.refreshToken.updateMany({
      where: { userId: id },
      data: { status: 'REVOKED' },
    });
    return { id: user.id, email: user.email, created: false };
  });
}

function parseArgs(
  args: string[],
  envPassword: string | undefined,
): BootstrapAdminInput | null {
  if (envPassword && args.length === 2) {
    const [email, name] = args;
    return { email, password: envPassword, name };
  }
  if (args.length === 3) {
    const [email, password, name] = args;
    return { email, password, name };
  }
  return null;
}

async function main(): Promise<void> {
  const input = parseArgs(process.argv.slice(2), process.env.ADMIN_PASSWORD);
  if (!input || !input.email || !input.password || !input.name) {
    console.error(USAGE);
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

  const pool = new Pool({ connectionString });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const r = await bootstrapAdmin(prisma, input);
    console.log(
      `✓ ADMIN ready: ${r.email} (id ${r.id}; ${r.created ? 'created' : 'existing user reset, all sessions revoked'}). ` +
        'The first login must change this password (POST /v1/auth/change-password).',
    );
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
