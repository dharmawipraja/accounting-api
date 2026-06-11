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
  });
  it('rejects bad values', async () => {
    expect(await check('1000.123456')).toBe(false);
    expect(await check('-5')).toBe(false);
    expect(await check('abc')).toBe(false);
    expect(await check(1000)).toBe(false);
  });
});
