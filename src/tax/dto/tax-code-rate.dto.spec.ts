import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateTaxCodeDto } from './create-tax-code.dto';
import { UpdateTaxCodeDto } from './update-tax-code.dto';

/** iter6: tax-code `rate` is bounded — at most 3 integer digits and 6
 *  decimals (`^\d{1,3}(\.\d{1,6})?$`) and at most 10 characters — on both
 *  create and update, so an unbounded digit string never reaches Decimal /
 *  the NUMERIC(9,6) column (range (0,1) is still checked in the service). */
describe('tax-code rate bounds (create / update DTOs)', () => {
  const create = (rate: unknown) =>
    validateSync(
      plainToInstance(CreateTaxCodeDto, {
        code: 'PPN',
        name: 'PPN',
        kind: 'PPN_OUTPUT',
        rate,
        taxAccountId: '11111111-1111-4111-8111-111111111111',
      }),
    ).filter((e) => e.property === 'rate');
  const update = (rate: unknown) =>
    validateSync(plainToInstance(UpdateTaxCodeDto, { rate })).filter(
      (e) => e.property === 'rate',
    );

  it.each(['0.11', '0.025', '1', '0.123456', '100', '999.123456', '0'])(
    'accepts %s',
    (rate) => {
      expect(create(rate)).toEqual([]);
      expect(update(rate)).toEqual([]);
    },
  );

  it.each([
    '1'.repeat(1000),
    '1'.repeat(1000) + '.5',
    '1000',
    '0.1234567',
    '.11',
    '1.',
    '-0.11',
    '0,11',
    ' 0.11',
    '1e-2',
  ])('rejects %s', (rate) => {
    expect(create(rate)).not.toEqual([]);
    expect(update(rate)).not.toEqual([]);
  });
});
