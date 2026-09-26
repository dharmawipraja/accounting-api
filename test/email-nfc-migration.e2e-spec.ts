import { execSync } from 'node:child_process';
import { INestApplication } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { AuthService } from '../src/auth/auth.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { UsersService } from '../src/users/users.service';
import { bootstrapAdmin } from '../scripts/create-admin';
import { TestDb } from './testcontainers';
import { bootstrapTestApp } from './e2e-helpers';

/**
 * Users created before email NFC normalization may have a DECOMPOSED (NFD)
 * email stored; the app now looks emails up in NFC form, so without a
 * backfill such a user could never log in again (and create-admin would
 * create a second user). The migration fails loudly on NFC collisions,
 * rewrites the rest to NFC and adds a CHECK so no non-NFC email is stored
 * again. Rolled back first (the container is migrated to head), legacy rows
 * are seeded by raw SQL, then `prisma migrate deploy` re-applies it.
 */
const MIGRATION = '20261005300000_users_email_nfc';
const NFC_E = 'é';
const NFD_E = 'é';

describe('Migration 20261005300000_users_email_nfc on legacy NFD emails (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let db: TestDb;
  let cleanup: () => Promise<void>;
  let pool: Pool;
  let client: PrismaClient;

  const deploy = () =>
    execSync('npx prisma migrate deploy', {
      env: { ...process.env, DATABASE_URL: db.url },
      encoding: 'utf8',
      stdio: 'pipe',
    });

  /** A user created through the app, then its email rewritten around it. */
  const legacyUser = async (tmp: string, storedEmail: string) => {
    const u = await app.get(UsersService).create({
      email: tmp,
      password: 'secret123',
      name: 'Legacy',
      role: 'VIEWER',
    });
    await prisma.client
      .$executeRaw`UPDATE users SET email = ${storedEmail} WHERE id = ${u.id}`;
    return u;
  };

  beforeAll(async () => {
    ({ app, prisma, db, cleanup } = await bootstrapTestApp());
    pool = new Pool({ connectionString: db.url });
    client = new PrismaClient({ adapter: new PrismaPg(pool) });
  }, 120_000);

  afterAll(async () => {
    await client.$disconnect();
    await pool.end();
    await cleanup();
  });

  it('aborts on NFC collisions, then rewrites NFD emails to NFC: login works with either form, create-admin resets the same user, the CHECK blocks non-NFC writes', async () => {
    await prisma.client.$executeRawUnsafe(
      'ALTER TABLE users DROP CONSTRAINT users_email_nfc',
    );
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM _prisma_migrations WHERE migration_name = '${MIGRATION}'`,
    );

    const composed = await legacyUser('c@nfc.test', `jos${NFC_E}@nfc.test`);
    const decomposed = await legacyUser('d@nfc.test', `jos${NFD_E}@nfc.test`);
    const nfdOnly = await legacyUser('r@nfc.test', `ren${NFD_E}@nfc.test`);

    let output = '';
    expect(() => {
      try {
        deploy();
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string };
        output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
        throw err;
      }
    }).toThrow();
    expect(output).toContain('users email NFC normalization aborted');
    expect(output).toContain(composed.id);
    expect(output).toContain(decomposed.id);
    expect(output).not.toContain(nfdOnly.id);
    // Nothing changed by the failed run.
    const [still] = await prisma.client.$queryRaw<{ email: string }[]>`
      SELECT email FROM users WHERE id = ${nfdOnly.id}`;
    expect(still.email).toBe(`ren${NFD_E}@nfc.test`);

    // Operator resolves the collision, then re-runs.
    await prisma.client
      .$executeRaw`UPDATE users SET email = 'dup2@nfc.test' WHERE id = ${decomposed.id}`;
    execSync(`npx prisma migrate resolve --rolled-back ${MIGRATION}`, {
      env: { ...process.env, DATABASE_URL: db.url },
      stdio: 'pipe',
    });
    expect(deploy()).toContain(MIGRATION);

    const [fixed] = await prisma.client.$queryRaw<{ email: string }[]>`
      SELECT email FROM users WHERE id = ${nfdOnly.id}`;
    expect(fixed.email).toBe(`ren${NFC_E}@nfc.test`);

    // The formerly-NFD user logs in with either form.
    const auth = app.get(AuthService);
    await expect(
      auth.login(`ren${NFD_E}@nfc.test`, 'secret123'),
    ).resolves.toHaveProperty('accessToken');
    await expect(
      auth.login(`REN${NFC_E.toUpperCase()}@nfc.test`, 'secret123'),
    ).resolves.toHaveProperty('accessToken');

    // create-admin with the decomposed form resets that user (no duplicate).
    const r = await bootstrapAdmin(client, {
      email: `ren${NFD_E}@nfc.test`,
      password: 'operator-pw-1',
      name: 'Rene',
    });
    expect(r).toMatchObject({ id: nfdOnly.id, created: false });

    // The CHECK refuses a non-NFC email from any writer.
    await expect(
      prisma.client
        .$executeRaw`UPDATE users SET email = ${`x${NFD_E}@nfc.test`} WHERE id = ${nfdOnly.id}`,
    ).rejects.toThrow(/users_email_nfc/);
  }, 180_000);
});
