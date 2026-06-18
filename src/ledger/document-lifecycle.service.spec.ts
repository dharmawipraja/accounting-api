import { DocumentLifecycleService } from './document-lifecycle.service';
import { ValidationFailedError } from '../common/errors/domain-errors';

describe('DocumentLifecycleService.softDeleteDraft', () => {
  const svc = new DocumentLifecycleService({} as never, {} as never);

  it('soft-deletes when exactly one DRAFT row matches', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    await expect(svc.softDeleteDraft({ updateMany }, 'id-1', 'user-1', 'invoice')).resolves.toBeUndefined();
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'id-1', status: 'DRAFT', deletedAt: null },
      data: expect.objectContaining({ deletedBy: 'user-1' }),
    });
  });

  it('throws ValidationFailedError when no DRAFT row matches (count !== 1)', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    await expect(svc.softDeleteDraft({ updateMany }, 'id-1', 'user-1', 'bill')).rejects.toBeInstanceOf(ValidationFailedError);
  });
});
