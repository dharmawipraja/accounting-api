import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AccountsService } from '../src/ledger/accounts/accounts.service';
import {
  CODE_INVISIBLE,
  normalizeIdentifierCode,
} from '../src/common/text/identifier';
import { TestDb } from './testcontainers';
import { bootstrapTestApp } from './e2e-helpers';
import { INestApplication } from '@nestjs/common';

/**
 * Review focus 1 (iteration 8): the case-insensitive code-uniqueness migration
 * must apply on real data or fail LOUDLY with actionable output, and
 * tombstoned rows must never collide.
 *
 * The container is migrated to head, so the migration under test is rolled
 * back first (drop its three indexes + forget its _prisma_migrations row),
 * legacy rows the new API would refuse are written straight to the DB, and
 * `prisma migrate deploy` re-applies it. Mechanically fixable codes
 * (untrimmed incl. edge tabs / newlines, NFKC-different) are auto-normalized; case collisions, blank
 * codes and codes holding invisible characters (format / control /
 * default-ignorable / line separators) block the deploy. Every auto-fix is
 * recorded as an audit_log row (method MIGRATION); a clean run writes none.
 */
const MIGRATION = '20261005000000_identifier_code_ci_unique';
const INDEXES = [
  'accounts_code_lower_live_key',
  'business_partners_code_lower_live_key',
  'tax_codes_code_lower_live_key',
];

describe('Migration 20261005000000_identifier_code_ci_unique on legacy data (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let db: TestDb;
  let cleanup: () => Promise<void>;

  const presentIndexes = async () =>
    (
      await prisma.client.$queryRaw<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE indexname IN (
          'accounts_code_lower_live_key',
          'business_partners_code_lower_live_key',
          'tax_codes_code_lower_live_key')
        ORDER BY indexname`
    ).map((r) => r.indexname);

  const migrationAudit = () =>
    prisma.client.auditLog.findMany({
      where: { method: 'MIGRATION', path: MIGRATION },
      orderBy: { entityId: 'asc' },
    });

  /** Roll the migration under test back (the container is at head). */
  const rollBack = async () => {
    for (const ix of INDEXES)
      await prisma.client.$executeRawUnsafe(`DROP INDEX "${ix}"`);
    await prisma.client.$executeRawUnsafe(
      `DELETE FROM _prisma_migrations WHERE migration_name = '${MIGRATION}'`,
    );
    expect(await presentIndexes()).toEqual([]);
  };

  // Bounded: a raw U+2028 in the migration's error text once made the CLI
  // hang (it broke the JSON-RPC with the schema engine) — fail, don't stall.
  const deploy = () =>
    execSync('npx prisma migrate deploy', {
      env: { ...process.env, DATABASE_URL: db.url },
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 90_000,
    });

  beforeAll(async () => {
    ({ app, prisma, db, cleanup } = await bootstrapTestApp({ pipe: false }));
    await app.get(AccountsService).seedIfEmpty();
  }, 120_000);

  afterAll(() => cleanup());

  it('blocks on collisions / blank / invisible-character codes (listing them, tombstones ignored), then auto-normalizes padded and full-width codes, one MIGRATION audit row per fix', async () => {
    await rollBack();

    // Legacy rows written around the API (the base client — no DTO / service
    // normalization).
    const bp = prisma.client.businessPartner;
    const dupA = await bp.create({
      data: { code: 'LEG-DUP', name: 'A', isCustomer: true },
    });
    const dupB = await bp.create({
      data: { code: 'leg-dup ', name: 'B', isCustomer: true },
    });
    const padded = await bp.create({
      data: { code: '  LEG-PAD ', name: 'C', isCustomer: true },
    });
    // Tab / CR / LF at the EDGES are white space the API trims: auto-fixed,
    // not blocking. A control character INSIDE the code still blocks.
    const tabPadded = await bp.create({
      data: { code: '\tLEG-TAB\r\n', name: 'J', isCustomer: true },
    });
    const innerTab = await bp.create({
      data: { code: 'LEG\tMID', name: 'K', isCustomer: true },
    });
    // iter9: invisible non-Cf characters INSIDE a code block too (combining
    // grapheme joiner, a tag character, a line separator)...
    const innerCgj = await bp.create({
      data: { code: 'LEG\u034FCGJ', name: 'L', isCustomer: true },
    });
    const innerTag = await bp.create({
      data: { code: 'LEG-TAG\u{E0041}', name: 'M', isCustomer: true },
    });
    const innerLs = await bp.create({
      data: { code: 'LEG\u2028LS', name: 'N', isCustomer: true },
    });
    // ...while NEL / Ogham space / U+2028 at the EDGES are JS White_Space
    // the API trims: auto-fixed.
    const exoticEdges = await bp.create({
      data: { code: '\u0085\u1680LEG-NEL\u2028', name: 'O', isCustomer: true },
    });
    const blank = await bp.create({
      data: { code: '\u3000 ', name: 'G', isCustomer: true },
    });
    // A tombstoned row sharing a live code's lower() form (even un-renamed)
    // is outside the partial index and the pre-check.
    const tomb = await bp.create({
      data: { code: 'LEG-TOMB', name: 'D', isCustomer: true },
    });
    await prisma.client.$executeRaw`
      INSERT INTO business_partners (id, code, name, is_customer, updated_at, deleted_at)
      VALUES (gen_random_uuid()::text, 'leg-tomb', 'E', true, now(), now())`;
    // A padded live code whose normalized form equals an UN-renamed
    // tombstone's exact code: the rewrite would hit <table>_code_key → blocks.
    const shadowed = await bp.create({
      data: { code: ' LEG-SHADOW', name: 'H', isCustomer: true },
    });
    await prisma.client.$executeRaw`
      INSERT INTO business_partners (id, code, name, is_customer, updated_at, deleted_at)
      VALUES (gen_random_uuid()::text, 'LEG-SHADOW', 'I', true, now(), now())`;
    const kas = await prisma.client.account.findFirstOrThrow({
      where: { code: '1-1000' },
    });
    const fw = await prisma.client.account.create({
      data: {
        code: 'ＦＷ-9',
        name: 'Full width',
        type: kas.type,
        subtype: kas.subtype,
        normalBalance: kas.normalBalance,
      },
    });
    const ppnOut = await prisma.client.account.findFirstOrThrow({
      where: { code: '2-1100' },
    });
    const zw = await prisma.client.taxCode.create({
      data: {
        code: 'TX\u200B1',
        name: 'Zero width',
        kind: 'PPN_OUTPUT',
        rate: '0.01',
        taxAccountId: ppnOut.id,
      },
    });

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
    expect(output).toContain(
      'identifier code case-insensitive uniqueness aborted',
    );
    expect(output).toMatch(/business_partners: live codes collide/);
    expect(output).toMatch(/business_partners: live codes that cannot be/);
    expect(output).toMatch(/tax_codes: live codes that cannot be/);
    expect(output).toMatch(/equals a soft-deleted row's code/);
    // Invisible characters are shown escaped (and never printed raw — see
    // `deploy`).
    expect(output).toContain(String.raw`'LEG\u034FCGJ'`);
    expect(output).toContain(String.raw`'LEG-TAG\U000E0041'`);
    expect(output).toContain(String.raw`'LEG\u2028LS'`);
    expect(output).not.toMatch(/[\u2028\u2029]/);
    for (const blocking of [
      dupA,
      dupB,
      blank,
      zw,
      shadowed,
      innerTab,
      innerCgj,
      innerTag,
      innerLs,
    ])
      expect(output).toContain(blocking.id);
    // Fixable-only rows are not blocking; tombstones are ignored.
    for (const fine of [padded, fw, tomb, tabPadded, exoticEdges])
      expect(output).not.toContain(fine.id);
    expect(await presentIndexes()).toEqual([]);
    expect(await migrationAudit()).toEqual([]);
    // The failed run changed nothing (the auto-fix runs only once the
    // blocking checks pass).
    expect(
      (
        await prisma.client.businessPartner.findFirstOrThrow({
          where: { id: padded.id },
        })
      ).code,
    ).toBe('  LEG-PAD ');

    // The operator fixes the blocking rows, marks the failed attempt rolled
    // back and re-runs.
    await prisma.client.businessPartner.update({
      where: { id: dupB.id },
      data: { code: 'LEG-DUP-2' },
    });
    await prisma.client.businessPartner.update({
      where: { id: blank.id },
      data: { code: 'LEG-BLANK' },
    });
    await prisma.client.businessPartner.update({
      where: { id: innerTab.id },
      data: { code: 'LEG-MID' },
    });
    await prisma.client.businessPartner.update({
      where: { id: shadowed.id },
      data: { code: 'LEG-SHADOW-2' },
    });
    await prisma.client.taxCode.update({
      where: { id: zw.id },
      data: { code: 'TX1' },
    });
    for (const [row, code] of [
      [innerCgj, 'LEG-CGJ'],
      [innerTag, 'LEG-TAG'],
      [innerLs, 'LEG-LS'],
    ] as const)
      await prisma.client.businessPartner.update({
        where: { id: row.id },
        data: { code },
      });
    execSync(`npx prisma migrate resolve --rolled-back ${MIGRATION}`, {
      env: { ...process.env, DATABASE_URL: db.url },
      stdio: 'pipe',
    });
    const out = deploy();
    expect(out).toContain(MIGRATION);
    expect(await presentIndexes()).toEqual(INDEXES);

    // Padded and full-width codes were normalized in place (case kept).
    expect(
      (
        await prisma.client.businessPartner.findFirstOrThrow({
          where: { id: padded.id },
        })
      ).code,
    ).toBe('LEG-PAD');
    expect(
      (
        await prisma.client.businessPartner.findFirstOrThrow({
          where: { id: tabPadded.id },
        })
      ).code,
    ).toBe('LEG-TAB');
    expect(
      (await prisma.client.account.findFirstOrThrow({ where: { id: fw.id } }))
        .code,
    ).toBe('FW-9');
    expect(
      (
        await prisma.client.businessPartner.findFirstOrThrow({
          where: { id: exoticEdges.id },
        })
      ).code,
    ).toBe('LEG-NEL');

    // One audit row per auto-fixed row — the seeded chart and the rows the
    // operator fixed by hand were already normalized, so they have none.
    const fixes = [
      [padded.id, 'business_partners', '  LEG-PAD ', 'LEG-PAD'],
      [tabPadded.id, 'business_partners', '\tLEG-TAB\r\n', 'LEG-TAB'],
      [
        exoticEdges.id,
        'business_partners',
        '\u0085\u1680LEG-NEL\u2028',
        'LEG-NEL',
      ],
      [fw.id, 'accounts', 'ＦＷ-9', 'FW-9'],
    ].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const audit = await migrationAudit();
    expect(
      audit.map((r) => [r.entityId, r.method, r.statusCode, r.userId, r.body]),
    ).toEqual(
      fixes.map(([id, table, old, now]) => [
        id,
        'MIGRATION',
        200,
        null,
        { table, id, old, new: now },
      ]),
    );

    // The live-only case-insensitive index now rejects a case variant...
    await expect(
      prisma.client.businessPartner.create({
        data: { code: 'leg-pad', name: 'F', isVendor: true },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    // ...while the tombstoned 'leg-tomb' still coexists with live 'LEG-TOMB'.
    expect(
      await prisma.client.businessPartner.findFirst({
        where: { id: tomb.id },
      }),
    ).not.toBeNull();
  }, 180_000);
  it('re-applied on already-normalized data it changes nothing and writes no audit row', async () => {
    const before = (await migrationAudit()).length;
    await rollBack();
    expect(deploy()).toContain(MIGRATION);
    expect(await presentIndexes()).toEqual(INDEXES);
    expect((await migrationAudit()).length).toBe(before);
  }, 180_000);

  it("the migration's invisible class and trim match the API rule code point by code point", async () => {
    const sql = readFileSync(
      join(__dirname, `../prisma/migrations/${MIGRATION}/migration.sql`),
      'utf8',
    );
    const invisible = /invisible constant text := '([^']+)'/.exec(sql)?.[1];
    const trimSet = /ws constant text := \$w\$E'([^']+)'\$w\$/.exec(sql)?.[1];
    expect(invisible).toBeDefined();
    expect(trimSet).toBeDefined();
    const all = (max: number, test: (ch: string) => boolean) => {
      const out: number[] = [];
      for (let cp = 1; cp <= max; cp++)
        if ((cp < 0xd800 || cp > 0xdfff) && test(String.fromCodePoint(cp)))
          out.push(cp);
      return out;
    };
    const pg = async (max: number, predicate: string, param: string) =>
      (
        await prisma.client.$queryRawUnsafe<{ cp: number }[]>(
          `SELECT cp FROM generate_series(1, ${max}) cp
           WHERE (cp < 55296 OR cp > 57343) AND ${predicate} ORDER BY cp`,
          param,
        )
      ).map((r) => r.cp);

    expect(await pg(0x10ffff, 'chr(cp) ~ $1', invisible!)).toEqual(
      all(0x10ffff, (ch) => CODE_INVISIBLE.test(ch)),
    );
    // Every White_Space code point is in the BMP.
    const chars = trimSet!.replace(/\\u([0-9A-F]{4})/g, (_m, h: string) =>
      String.fromCharCode(parseInt(h, 16)),
    );
    expect(await pg(0xffff, "btrim(chr(cp), $1) = ''", chars)).toEqual(
      all(0xffff, (ch) => /^\p{White_Space}$/u.test(ch)),
    );
    // And the composed normalization agrees on every lone code point that
    // normalizes to nothing (NFKC maps e.g. U+2000 / U+3000 to a space).
    expect(
      await pg(0xffff, `btrim(normalize(chr(cp), NFKC), $1) = ''`, chars),
    ).toEqual(all(0xffff, (ch) => normalizeIdentifierCode(ch) === ''));
  }, 120_000);
});
