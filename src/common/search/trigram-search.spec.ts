import { Prisma } from '@prisma/client';
import {
  buildTrigramIdQuery,
  buildTrigramCountQuery,
  MIN_QUERY_LENGTH,
  SIMILARITY_THRESHOLD,
} from './trigram-search';

describe('buildTrigramIdQuery', () => {
  it('exposes sane constants', () => {
    expect(MIN_QUERY_LENGTH).toBe(2);
    expect(SIMILARITY_THRESHOLD).toBeGreaterThan(0);
    expect(SIMILARITY_THRESHOLD).toBeLessThan(1);
  });

  it('parameterizes the query value (never interpolates it) and inlines identifiers', () => {
    const sql = buildTrigramIdQuery({
      table: 'business_partners',
      alias: 't',
      ownColumns: ['name', 'code'],
      filters: [],
      q: "bo'bby", // contains a quote — must NOT appear inline
      limit: 20,
      offset: 0,
    });
    // Identifiers are inlined (constants); the user value is bound, not inlined.
    expect(sql.sql).toContain('business_partners');
    expect(sql.sql).toContain('t.name');
    expect(sql.sql).toContain('t.code');
    expect(sql.sql).toContain('deleted_at IS NULL');
    expect(sql.sql).toContain('GREATEST');
    // id query selects only id — COUNT(*) OVER() was moved to buildTrigramCountQuery
    expect(sql.sql).not.toContain('COUNT(*) OVER()');
    expect(sql.sql).not.toContain("bo'bby");
    expect(sql.values).toContain("bo'bby");
    expect(sql.values).toContain(20); // limit
    expect(sql.values).toContain(0); // offset
    // Must still have ORDER BY and LIMIT/OFFSET for ranking + pagination
    expect(sql.sql).toContain('ORDER BY');
    expect(sql.sql).toContain('LIMIT');
    expect(sql.sql).toContain('OFFSET');
  });

  it('adds a JOIN and joined column refs when a join is given', () => {
    const sql = buildTrigramIdQuery({
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
    expect(sql.sql).toContain('JOIN business_partners p');
    expect(sql.sql).toContain('p.name');
    expect(sql.sql).toContain('t.partner_id');
    expect(sql.values).toContain('POSTED'); // filter value bound
    expect(sql.values).toContain('budi');
  });
});

describe('buildTrigramCountQuery', () => {
  it('selects COUNT(*), includes deleted_at IS NULL and bound q, but has no LIMIT/OFFSET/ORDER BY', () => {
    const sql = buildTrigramCountQuery({
      table: 'business_partners',
      alias: 't',
      ownColumns: ['name', 'code'],
      filters: [],
      q: "bo'bby",
      limit: 20,
      offset: 0,
    });
    // Must count all matches regardless of pagination
    expect(sql.sql).toContain('COUNT(*)');
    expect(sql.sql).toContain('deleted_at IS NULL');
    // The match group (ILIKE / similarity) must be present
    expect(sql.sql).toContain('ILIKE');
    // User value must be parameterized, never inlined
    expect(sql.sql).not.toContain("bo'bby");
    expect(sql.values).toContain("bo'bby");
    // No pagination clauses — count must reflect the full match set
    expect(sql.sql).not.toContain('ORDER BY');
    expect(sql.sql).not.toContain('LIMIT');
    expect(sql.sql).not.toContain('OFFSET');
  });

  it('includes filter values as bound parameters', () => {
    const sql = buildTrigramCountQuery({
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
    expect(sql.sql).toContain('COUNT(*)');
    expect(sql.sql).toContain('JOIN business_partners p');
    expect(sql.values).toContain('POSTED');
    expect(sql.values).toContain('budi');
  });
});
