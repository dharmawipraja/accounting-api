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

  it('rejects an out-of-range PORT', () => {
    expect(() => validate({ ...validEnv, PORT: '0' })).toThrow();
    expect(() => validate({ ...validEnv, PORT: '99999' })).toThrow();
  });

  it('rejects an empty DATABASE_URL', () => {
    expect(() => validate({ ...validEnv, DATABASE_URL: '' })).toThrow();
  });

  it('rejects an invalid NODE_ENV', () => {
    expect(() => validate({ ...validEnv, NODE_ENV: 'staging' })).toThrow();
  });

  it('rejects empty JWT TTLs', () => {
    expect(() => validate({ ...validEnv, JWT_ACCESS_TTL: '' })).toThrow();
    expect(() => validate({ ...validEnv, JWT_REFRESH_TTL: '' })).toThrow();
  });

  it('requires REDIS_URL when NODE_ENV is not test', () => {
    expect(() => validate({ ...validEnv, NODE_ENV: 'production' })).toThrow(); // no REDIS_URL → invalid in prod
    expect(() =>
      validate({
        ...validEnv,
        NODE_ENV: 'production',
        REDIS_URL: 'redis://localhost:6379',
      }),
    ).not.toThrow();
  });

  it('does NOT require REDIS_URL when NODE_ENV is test', () => {
    expect(() => validate(validEnv)).not.toThrow(); // test env, no REDIS_URL
  });

  it('accepts valid optional ops vars', () => {
    expect(() =>
      validate({
        ...validEnv,
        CORS_ORIGIN: 'https://app.example.com',
        ENABLE_SWAGGER: 'true',
        LOG_LEVEL: 'debug',
      }),
    ).not.toThrow();
  });

  it('rejects a malformed ENABLE_SWAGGER', () => {
    expect(() => validate({ ...validEnv, ENABLE_SWAGGER: 'yes' })).toThrow();
  });

  it('rejects an invalid LOG_LEVEL', () => {
    expect(() => validate({ ...validEnv, LOG_LEVEL: 'verbose' })).toThrow();
  });

  it('rejects identical access and refresh JWT secrets', () => {
    expect(() =>
      validate({ ...validEnv, JWT_REFRESH_SECRET: validEnv.JWT_ACCESS_SECRET }),
    ).toThrow(/JWT_REFRESH_SECRET/);
  });

  it('upper-bounds JWT_ACCESS_TTL at 3600s', () => {
    expect(() => validate({ ...validEnv, JWT_ACCESS_TTL: '1h' })).not.toThrow();
    expect(() => validate({ ...validEnv, JWT_ACCESS_TTL: '3601s' })).toThrow(
      /JWT_ACCESS_TTL/,
    );
    expect(() => validate({ ...validEnv, JWT_ACCESS_TTL: '2d' })).toThrow();
  });

  it('upper-bounds JWT_REFRESH_TTL at 30d', () => {
    expect(() =>
      validate({ ...validEnv, JWT_REFRESH_TTL: '30d' }),
    ).not.toThrow();
    expect(() => validate({ ...validEnv, JWT_REFRESH_TTL: '31d' })).toThrow(
      /JWT_REFRESH_TTL/,
    );
  });

  it('rejects an unparseable or non-positive TTL', () => {
    expect(() =>
      validate({ ...validEnv, JWT_ACCESS_TTL: 'fifteen minutes' }),
    ).toThrow();
    expect(() => validate({ ...validEnv, JWT_ACCESS_TTL: '0s' })).toThrow();
    expect(() => validate({ ...validEnv, JWT_REFRESH_TTL: '-1d' })).toThrow();
  });

  it('validates the login-IP throttle, argon2 concurrency and trust-proxy knobs', () => {
    expect(() =>
      validate({
        ...validEnv,
        THROTTLE_LOGIN_IP_LIMIT: '30',
        ARGON2_MAX_CONCURRENCY: '8',
        TRUST_PROXY_HOPS: '1',
      }),
    ).not.toThrow();
    expect(() =>
      validate({ ...validEnv, THROTTLE_LOGIN_IP_LIMIT: '0' }),
    ).toThrow();
    expect(() =>
      validate({ ...validEnv, ARGON2_MAX_CONCURRENCY: '0' }),
    ).toThrow();
    expect(() =>
      validate({ ...validEnv, ARGON2_MAX_CONCURRENCY: '1000' }),
    ).toThrow();
    expect(() => validate({ ...validEnv, TRUST_PROXY_HOPS: '-1' })).toThrow();
    expect(() => validate({ ...validEnv, TRUST_PROXY_HOPS: 'yes' })).toThrow();
  });
});
