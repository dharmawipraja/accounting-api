import { ServiceUnavailableException } from '@nestjs/common';

const verify = jest.fn();
const hash = jest.fn();
jest.mock('argon2', () => ({
  verify: (...a: unknown[]) => verify(...a) as unknown,
  hash: (...a: unknown[]) => hash(...a) as unknown,
}));

import { createPasswordHasher } from './password-hashing';

describe('createPasswordHasher (argon2 concurrency gate)', () => {
  beforeEach(() => {
    verify.mockReset();
    hash.mockReset();
  });

  it('delegates hash/verify to argon2', async () => {
    hash.mockResolvedValue('$argon2id$h');
    verify.mockResolvedValue(true);
    const h = createPasswordHasher(2, 1_000);
    await expect(h.hash('pw')).resolves.toBe('$argon2id$h');
    await expect(h.verify('$argon2id$h', 'pw')).resolves.toBe(true);
    expect(verify).toHaveBeenCalledWith('$argon2id$h', 'pw');
  });

  it('turns a permit wait beyond the bound into a 503', async () => {
    let release!: () => void;
    verify.mockImplementationOnce(
      () => new Promise<boolean>((r) => (release = () => r(true))),
    );
    const h = createPasswordHasher(1, 20);
    const first = h.verify('x', 'a');
    await expect(h.verify('x', 'b')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    release();
    await expect(first).resolves.toBe(true);
    expect(verify).toHaveBeenCalledTimes(1); // the timed-out call never ran argon2
  });

  it('propagates a genuine argon2 error unchanged', async () => {
    verify.mockRejectedValue(new TypeError('pchstr must be a valid hash'));
    const h = createPasswordHasher(1, 1_000);
    await expect(h.verify('bad', 'pw')).rejects.toBeInstanceOf(TypeError);
  });
});
