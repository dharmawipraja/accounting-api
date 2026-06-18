import { DocumentNumberService } from './document-number.service';

describe('DocumentNumberService', () => {
  const svc = new DocumentNumberService();

  it('returns the current counter and increments under the lock (gapless)', async () => {
    const executed: string[] = [];
    const tx = {
      $executeRaw: jest.fn((strings: TemplateStringsArray) => {
        executed.push(strings.join('?'));
        return Promise.resolve(1);
      }),
      $queryRaw: jest.fn(() => Promise.resolve([{ next_number: 7 }])),
    } as unknown as Parameters<DocumentNumberService['next']>[0];

    const n = await svc.next(tx, 'INV', 2026);

    expect(n).toBe(7);
    // insert-on-conflict (seed) → select FOR UPDATE → update to current+1
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(executed[0]).toContain('INSERT INTO document_sequences');
    expect(executed[1]).toContain('UPDATE document_sequences');
  });

  it('formats a zero-padded ref', () => {
    expect(svc.buildRef('INV', 2026, 42)).toBe('INV/2026/000042');
  });
});
