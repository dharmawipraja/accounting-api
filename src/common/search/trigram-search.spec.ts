import { Prisma } from '@prisma/client';
import {
  buildTrigramIdQuery,
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
    expect(sql.sql).toContain('COUNT(*) OVER()');
    expect(sql.sql).not.toContain("bo'bby");
    expect(sql.values).toContain("bo'bby");
    expect(sql.values).toContain(20); // limit
    expect(sql.values).toContain(0); // offset
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
