import { validate } from './env.validation';

const validEnv = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  JWT_ACCESS_TTL: '900s',
  JWT_REFRESH_TTL: '7d',
};

describe('env validation', () => {
  it('accepts a valid environment', () => {
    expect(() => validate(validEnv)).not.toThrow();
  });

  it('rejects a missing DATABASE_URL', () => {
    const { DATABASE_URL: _db, ...rest } = validEnv;
    expect(() => validate(rest)).toThrow();
  });

  it('rejects a short JWT secret', () => {
    expect(() =>
      validate({ ...validEnv, JWT_ACCESS_SECRET: 'short' }),
    ).toThrow();
  });

  it('coerces PORT to a number', () => {
    const result = validate(validEnv);
    expect(result.PORT).toBe(3000);
  });
});
