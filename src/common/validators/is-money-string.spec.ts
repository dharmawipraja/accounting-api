import { validate } from 'class-validator';
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
});
