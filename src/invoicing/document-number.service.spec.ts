import { Prisma } from '@prisma/client';
import { SqlTx } from '../common/db/sequence';
import { DocumentNumberService } from './document-number.service';

describe('DocumentNumberService', () => {
  const svc = new DocumentNumberService();

  it('delegates to nextSequenceNumber with the correct key shape (document_type, fiscal_year)', async () => {
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

    const n = await svc.next(tx, 'INV', 2026);

    expect(n).toBe(7);
    // INSERT seeds the row if absent
    expect(executed[0].sql).toContain('document_sequences');
    expect(executed[0].sql).toContain('document_type');
    expect(executed[0].sql).toContain('ON CONFLICT');
    expect(executed[0].values).toEqual(['INV', 2026]);
    // SELECT FOR UPDATE locks the row
    expect(queried[0].sql).toContain('FOR UPDATE');
    expect(queried[0].values).toEqual(['INV', 2026]);
    // UPDATE increments to current+1
    expect(executed[1].sql).toContain('UPDATE');
    expect(executed[1].values).toEqual([8, 'INV', 2026]);
  });

  it('formats a zero-padded ref', () => {
    expect(svc.buildRef('INV', 2026, 42)).toBe('INV/2026/000042');
  });
});
