import { TaxCodesService } from './tax-codes.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { AccountsService } from '../ledger/accounts/accounts.service';
import { ValidationFailedError } from '../common/errors/domain-errors';

// validateRate runs first in create(), before any dependency is touched, so we
// can pass undefined deps and assert purely on rate validation.
function makeService(): TaxCodesService {
  return new TaxCodesService(
    undefined as unknown as PrismaService,
    undefined as unknown as AccountsService,
  );
}
const base = {
  code: 'X',
  name: 'X',
  kind: 'PPN_OUTPUT' as const,
  taxAccountId: 'acct',
};

describe('TaxCodesService.validateRate (via create)', () => {
  it('rejects a rate with more than 6 decimal places', async () => {
    await expect(
      makeService().create({ ...base, rate: '0.1234567' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });

  it('rejects a rate of 0 or >= 1', async () => {
    await expect(
      makeService().create({ ...base, rate: '0' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      makeService().create({ ...base, rate: '1' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      makeService().create({ ...base, rate: '1.5' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
  });
});
