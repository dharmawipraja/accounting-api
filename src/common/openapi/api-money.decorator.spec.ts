// src/common/openapi/api-money.decorator.spec.ts
import 'reflect-metadata';
import { ApiMoney } from './api-money.decorator';

class Sample {
  @ApiMoney() amount!: string;
  @ApiMoney({ description: 'Tax rate', example: '0.110000' }) rate!: string;
}

describe('ApiMoney', () => {
  it('registers the property in swagger metadata as a string', () => {
    const meta = Reflect.getMetadata(
      'swagger/apiModelPropertiesArray',
      Sample.prototype,
    ) as string[];
    expect(meta).toEqual(expect.arrayContaining([':amount', ':rate']));
  });

  it('defaults the example to a 4-dp string', () => {
    const props = Reflect.getMetadata(
      'swagger/apiModelProperties',
      Sample.prototype,
      'amount',
    ) as { type: unknown; example: string };
    expect(props.example).toBe('1000.0000');
  });
});
