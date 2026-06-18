import 'reflect-metadata';
import { IdempotentWrite } from './idempotent-write.decorator';
import { IDEMPOTENT_KEY } from './idempotent.decorator';

class Sample {
  @IdempotentWrite()
  create() {}
}

describe('IdempotentWrite', () => {
  it('marks the handler idempotent (IDEMPOTENT_KEY = true)', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(Reflect.getMetadata(IDEMPOTENT_KEY, Sample.prototype.create)).toBe(
      true,
    );
  });

  it('registers the required Idempotency-Key api header', () => {
    const params = Reflect.getMetadata(
      'swagger/apiParameters',
      // eslint-disable-next-line @typescript-eslint/unbound-method
      Sample.prototype.create,
    ) as { name: string; in: string; required: boolean }[] | undefined;
    expect(params).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
        }),
      ]),
    );
  });
});
