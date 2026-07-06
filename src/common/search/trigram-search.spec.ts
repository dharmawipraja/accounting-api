import { Prisma } from '@prisma/client';
import {
  escapeLikePattern,
  MIN_QUERY_LENGTH,
  trigramSearch,
} from './trigram-search';
import { PrismaService } from '../prisma/prisma.service';

/** Capture Prisma.Sql objects passed to $queryRaw by trigramSearch. */
function makePrismaMock(): {
  prisma: PrismaService;
  getCaptured: () => Prisma.Sql[];
} {
  const captured: Prisma.Sql[] = [];
  const prisma = {
    $queryRaw: jest.fn((sql: Prisma.Sql) => {
      captured.push(sql);
      // trigramSearch calls $queryRaw twice in parallel: id query first, count query second.
      // Detect by checking if the SQL contains COUNT(*).
      if (sql.sql.includes('COUNT(*)')) {
        return Promise.resolve([{ total: BigInt(0) }]);
      }
      return Promise.resolve([]);
    }),
  } as unknown as PrismaService;
  return { prisma, getCaptured: () => captured };
}

describe('trigramSearch constants', () => {
  it('exposes sane MIN_QUERY_LENGTH', () => {
    expect(MIN_QUERY_LENGTH).toBe(2);
  });
});

describe('escapeLikePattern', () => {
  it('escapes ILIKE metacharacters so they match literally', () => {
    expect(escapeLikePattern('CUST_001')).toBe('CUST\\_001');
    expect(escapeLikePattern('50% off')).toBe('50\\% off');
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
    expect(escapeLikePattern('plain')).toBe('plain');
  });
});

describe('trigramSearch — ILIKE wildcard escaping', () => {
  it('binds the escaped q for the ILIKE arm and the raw q for similarity()', async () => {
    const { prisma, getCaptured } = makePrismaMock();
    await trigramSearch(prisma, {
      table: 'business_partners',
      alias: 't',
      ownColumns: ['code'],
      filters: [],
      q: 'CUST_001',
      limit: 20,
      offset: 0,
    });
    const idQuery = getCaptured()[0];
    // The ILIKE bound value must be the escaped form; similarity() keeps raw q.
    expect(idQuery.values).toContain('CUST\\_001');
    expect(idQuery.values).toContain('CUST_001');
  });
});

describe('trigramSearch — id query SQL structure', () => {
  it('parameterizes the query value (never interpolates it) and inlines identifiers', async () => {
    const { prisma, getCaptured } = makePrismaMock();
    await trigramSearch(prisma, {
      table: 'business_partners',
      alias: 't',
      ownColumns: ['name', 'code'],
      filters: [],
      q: "bo'bby", // contains a quote — must NOT appear inline
      limit: 20,
      offset: 0,
    });

    const [idSql] = getCaptured();
    // Identifiers are inlined (constants); the user value is bound, not inlined.
    expect(idSql.sql).toContain('business_partners');
    expect(idSql.sql).toContain('t.name');
    expect(idSql.sql).toContain('t.code');
    expect(idSql.sql).toContain('deleted_at IS NULL');
    expect(idSql.sql).toContain('GREATEST');
    // id query selects only id — COUNT(*) OVER() was moved to the count query
    expect(idSql.sql).not.toContain('COUNT(*) OVER()');
    expect(idSql.sql).not.toContain("bo'bby");
    expect(idSql.values).toContain("bo'bby");
    expect(idSql.values).toContain(20); // limit
    expect(idSql.values).toContain(0); // offset
    // Must still have ORDER BY and LIMIT/OFFSET for ranking + pagination
    expect(idSql.sql).toContain('ORDER BY');
    expect(idSql.sql).toContain('LIMIT');
    expect(idSql.sql).toContain('OFFSET');
  });

  it('adds a JOIN and joined column refs when a join is given', async () => {
    const { prisma, getCaptured } = makePrismaMock();
    await trigramSearch(prisma, {
      table: 'sales_invoices',
      alias: 't',
      ownColumns: ['invoice_ref', 'description'],
      join: {
        table: 'business_partners',
        alias: 'p',
        onColumn: 'partner_id',
        columns: ['name'],
      },
      filters: [Prisma.sql`t.status::text = ${'POSTED'}`],
      q: 'budi',
      limit: 50,
      offset: 0,
    });

    const [idSql] = getCaptured();
    expect(idSql.sql).toContain('JOIN business_partners p');
    expect(idSql.sql).toContain('p.name');
    expect(idSql.sql).toContain('t.partner_id');
    expect(idSql.values).toContain('POSTED'); // filter value bound
    expect(idSql.values).toContain('budi');
  });
});

describe('trigramSearch — count query SQL structure', () => {
  it('selects COUNT(*), includes deleted_at IS NULL and bound q, but has no LIMIT/OFFSET/ORDER BY', async () => {
    const { prisma, getCaptured } = makePrismaMock();
    await trigramSearch(prisma, {
      table: 'business_partners',
      alias: 't',
      ownColumns: ['name', 'code'],
      filters: [],
      q: "bo'bby",
      limit: 20,
      offset: 0,
    });

    const [, countSql] = getCaptured();
    // Must count all matches regardless of pagination
    expect(countSql.sql).toContain('COUNT(*)');
    expect(countSql.sql).toContain('deleted_at IS NULL');
    // The match group (ILIKE / similarity) must be present
    expect(countSql.sql).toContain('ILIKE');
    // User value must be parameterized, never inlined
    expect(countSql.sql).not.toContain("bo'bby");
    expect(countSql.values).toContain("bo'bby");
    // No pagination clauses — count must reflect the full match set
    expect(countSql.sql).not.toContain('ORDER BY');
    expect(countSql.sql).not.toContain('LIMIT');
    expect(countSql.sql).not.toContain('OFFSET');
  });

  it('includes filter values as bound parameters', async () => {
    const { prisma, getCaptured } = makePrismaMock();
    await trigramSearch(prisma, {
      table: 'sales_invoices',
      alias: 't',
      ownColumns: ['invoice_ref', 'description'],
      join: {
        table: 'business_partners',
        alias: 'p',
        onColumn: 'partner_id',
        columns: ['name'],
      },
      filters: [Prisma.sql`t.status::text = ${'POSTED'}`],
      q: 'budi',
      limit: 50,
      offset: 0,
    });

    const [, countSql] = getCaptured();
    expect(countSql.sql).toContain('COUNT(*)');
    expect(countSql.sql).toContain('JOIN business_partners p');
    expect(countSql.values).toContain('POSTED');
    expect(countSql.values).toContain('budi');
  });
});
