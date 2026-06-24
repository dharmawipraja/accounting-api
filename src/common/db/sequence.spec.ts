import { Prisma } from '@prisma/client';
import { nextSequenceNumber, SqlTx } from './sequence';

function mockTx() {
  const executed: Prisma.Sql[] = [];
  const queried: Prisma.Sql[] = [];
  const tx: SqlTx = {
    $executeRaw: (q: Prisma.Sql) => {
      executed.push(q);
      return Promise.resolve(1);
    },
    $queryRaw: ((q: Prisma.Sql) => {
      queried.push(q);
      return Promise.resolve([{ next_number: 7 }]);
    }) as SqlTx['$queryRaw'],
  };
  return { tx, executed, queried };
}

describe('nextSequenceNumber', () => {
  it('single-key (journal_sequences): gapless lock-and-increment, returns current', async () => {
    const { tx, executed, queried } = mockTx();
    const n = await nextSequenceNumber(tx, 'journal_sequences', {
      fiscal_year: 2026,
    });
    expect(n).toBe(7);
    // INSERT … ON CONFLICT, keyed on fiscal_year, value bound
    expect(executed[0].sql).toContain('journal_sequences');
    expect(executed[0].sql).toContain('fiscal_year');
    expect(executed[0].sql).toContain('ON CONFLICT');
    expect(executed[0].values).toEqual([2026]);
    // SELECT … FOR UPDATE
    expect(queried[0].sql).toContain('FOR UPDATE');
    expect(queried[0].sql).toContain('journal_sequences');
    expect(queried[0].values).toEqual([2026]);
    // UPDATE next_number = current + 1 (8), predicate value follows
    expect(executed[1].sql).toContain('UPDATE');
    expect(executed[1].values).toEqual([8, 2026]);
  });

  it('two-key (document_sequences): keyed on document_type + fiscal_year', async () => {
    const { tx, executed, queried } = mockTx();
    const n = await nextSequenceNumber(tx, 'document_sequences', {
      document_type: 'INV',
      fiscal_year: 2026,
    });
    expect(n).toBe(7);
    expect(executed[0].sql).toContain('document_sequences');
    expect(executed[0].sql).toContain('document_type');
    expect(executed[0].values).toEqual(['INV', 2026]);
    expect(queried[0].sql).toContain('document_type');
    expect(queried[0].values).toEqual(['INV', 2026]);
    expect(executed[1].values).toEqual([8, 'INV', 2026]);
  });
});
