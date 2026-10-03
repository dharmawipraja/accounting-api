import { validate } from 'class-validator';
import { IsAuditInstant } from './is-audit-instant';
import { IsBusinessDate } from './is-business-date';
import { IsMoneyString } from './is-money-string';

class Dto {
  @IsMoneyString() amount!: string;
}

async function check(value: unknown): Promise<boolean> {
  const dto = new Dto();
  (dto as { amount: unknown }).amount = value;
  return (await validate(dto)).length === 0;
}

describe('IsMoneyString', () => {
  it('accepts up to 4 decimal places', async () => {
    expect(await check('1000')).toBe(true);
    expect(await check('1000.50')).toBe(true);
    expect(await check('0.0001')).toBe(true);
    expect(await check('0')).toBe(true); // zero allowed; rejected downstream by the CHECK
  });
  it('rejects bad values', async () => {
    expect(await check('1000.123456')).toBe(false);
    expect(await check('-5')).toBe(false);
    expect(await check('abc')).toBe(false);
    expect(await check(1000)).toBe(false);
    expect(await check(' 5 ')).toBe(false); // no surrounding whitespace
    expect(await check('')).toBe(false);
  });
  it('caps integer digits at 16 (the Decimal(20,4) column maximum)', async () => {
    expect(await check('9999999999999999')).toBe(true); // 16 digits — max storable
    expect(await check('9999999999999999.9999')).toBe(true);
    expect(await check('10000000000000000')).toBe(false); // 17 digits — would overflow
  });
  it('rejects exponents, signs, stray dots, whitespace and non-strings', async () => {
    for (const v of [
      '1e5',
      '1E5',
      '+5',
      '-0',
      '.5',
      '5.',
      '1.23456',
      '5\n',
      '\t5',
      '1,000',
      '١٢٣', // Arabic-Indic digits (\d is ASCII-only)
      null,
      undefined,
      ['5'],
      { toString: () => '5' },
    ]) {
      expect(await check(v)).toBe(false);
    }
  });
  it('keeps the exact message under the `matches` constraint', async () => {
    const dto = new Dto();
    (dto as { amount: unknown }).amount = 'x';
    const [err] = await validate(dto);
    expect(err.constraints).toEqual({
      matches:
        'amount must be a non-negative decimal string with up to 16 integer digits and 4 decimal places',
    });
  });
});

describe('IsBusinessDate / IsAuditInstant (ValidateBy)', () => {
  class Dates {
    @IsBusinessDate() d!: unknown;
    @IsAuditInstant() i!: unknown;
  }
  async function errs(d: unknown, i: unknown) {
    const dto = Object.assign(new Dates(), { d, i });
    return Object.fromEntries(
      (await validate(dto)).map((e) => [e.property, e.constraints]),
    );
  }

  it('accepts real dates; instant also takes a timestamp', async () => {
    expect(await errs('2024-02-29', '2026-01-31T23:59:59.123+07:00')).toEqual(
      {},
    );
  });

  it('rejects impossible days, timestamps for business dates, non-strings — same messages', async () => {
    for (const [d, i] of [
      ['2026-02-30', '2026-02-30'],
      ['2026-01-01T00:00:00Z', '0000-01-01'],
      ['', 'junk'],
      [20260101, 20260101],
    ]) {
      expect(await errs(d, i)).toEqual({
        d: {
          isBusinessDate:
            'd must be a real calendar date in YYYY-MM-DD form (no time)',
        },
        i: {
          isAuditInstant:
            'i must be a real ISO date or date-time (YYYY-MM-DD[THH:MM[:SS[.fff]]][Z|±HH:MM]) with a year in 1970-9999',
        },
      });
    }
  });
});
