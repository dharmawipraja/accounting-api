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

  it('rejects unitless JWT TTLs (jsonwebtoken would read "900" as 900 ms)', () => {
    expect(() => validate({ ...validEnv, JWT_ACCESS_TTL: '900' })).toThrow(
      /JWT_ACCESS_TTL/,
    );
    expect(() => validate({ ...validEnv, JWT_REFRESH_TTL: '604800' })).toThrow(
      /JWT_REFRESH_TTL/,
    );
    expect(() => validate({ ...validEnv, JWT_ACCESS_TTL: '1.5h' })).toThrow();
    expect(() =>
      validate({ ...validEnv, JWT_ACCESS_TTL: '15m' }),
    ).not.toThrow();
    expect(() =>
      validate({ ...validEnv, JWT_REFRESH_TTL: '720h' }),
    ).not.toThrow();
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

  it('bounds REFRESH_REUSE_GRACE_MS to 0..60000 ms', () => {
    expect(
      validate({ ...validEnv, REFRESH_REUSE_GRACE_MS: '0' })
        .REFRESH_REUSE_GRACE_MS,
    ).toBe(0);
    expect(() =>
      validate({ ...validEnv, REFRESH_REUSE_GRACE_MS: '60000' }),
    ).not.toThrow();
    expect(() =>
      validate({ ...validEnv, REFRESH_REUSE_GRACE_MS: '60001' }),
    ).toThrow();
    expect(() =>
      validate({ ...validEnv, REFRESH_REUSE_GRACE_MS: '-1' }),
    ).toThrow();
  });

  // docker-compose.yml (+ docker-compose.prod.yml for DB_* and the Caddy hop
  // TRUST_PROXY_HOPS=1) passes optional vars as `${VAR:-<default>}`. With the
  // operator's .env silent, these are exactly the values the prod api receives.
  const composeUnsetDefaults = {
    NODE_ENV: 'production',
    REDIS_URL: 'redis://redis:6379',
    THROTTLE_LIMIT: '300',
    THROTTLE_LOGIN_LIMIT: '10',
    THROTTLE_LOGIN_IP_LIMIT: '30',
    THROTTLE_REFRESH_LIMIT: '30',
    REFRESH_REUSE_GRACE_MS: '10000',
    THROTTLE_CHANGE_PASSWORD_LIMIT: '10',
    ARGON2_MAX_CONCURRENCY: '8',
    TRUST_PROXY_HOPS: '1',
    REQUEST_TIMEOUT_MS: '35000',
    REPORT_UTC_OFFSET_MINUTES: '420',
    IDEMPOTENCY_INFLIGHT_TTL_MS: '120000',
    IDEMPOTENCY_COMPLETED_TTL_MS: '86400000',
    LOG_LEVEL: 'info',
    ENABLE_SWAGGER: 'false',
    DB_POOL_MAX: '15',
    DB_STATEMENT_TIMEOUT_MS: '30000',
    CORS_ORIGIN: '',
    METRICS_TOKEN: '',
    SENTRY_DSN: '',
    SENTRY_ENVIRONMENT: '',
    SENTRY_RELEASE: '',
  };

  it('accepts the docker-compose passthrough values when the operator sets none', () => {
    expect(() =>
      validate({ ...validEnv, ...composeUnsetDefaults }),
    ).not.toThrow();
    // The base file alone (no Caddy in front) defaults TRUST_PROXY_HOPS to 0.
    expect(() =>
      validate({ ...validEnv, ...composeUnsetDefaults, TRUST_PROXY_HOPS: '0' }),
    ).not.toThrow();
  });

  it.each([
    'REQUEST_TIMEOUT_MS',
    'IDEMPOTENCY_INFLIGHT_TTL_MS',
    'IDEMPOTENCY_COMPLETED_TTL_MS',
    'DB_STATEMENT_TIMEOUT_MS',
    'DB_POOL_MAX',
    'THROTTLE_LIMIT',
    'ARGON2_MAX_CONCURRENCY',
    'LOG_LEVEL',
    'ENABLE_SWAGGER',
  ])(
    'rejects an empty %s (why compose gives it an explicit default, not ${VAR:-})',
    (key) => {
      expect(() =>
        validate({ ...validEnv, ...composeUnsetDefaults, [key]: '' }),
      ).toThrow();
    },
  );

  // REPORT_UTC_OFFSET_MINUTES is NOT in the list above: an empty value passes
  // validation (implicit conversion turns '' into 0, a valid @IsInt), yet the
  // runtime reader (query-dates.ts) treats '' as UNSET → 420 (WIB), not 0
  // (UTC) — see query-dates.spec.ts. Compose still passes `:-420` so the
  // validated value and the runtime value agree.
  it('accepts an empty REPORT_UTC_OFFSET_MINUTES (validated as 0; the runtime reads it as unset → 420)', () => {
    const v = validate({
      ...validEnv,
      ...composeUnsetDefaults,
      REPORT_UTC_OFFSET_MINUTES: '',
    });
    expect(v.REPORT_UTC_OFFSET_MINUTES).toBe(0);
  });

  describe('CORS_ORIGIN in production', () => {
    const prod = { ...validEnv, ...composeUnsetDefaults };
    it('rejects a localhost origin (the .env.example value)', () => {
      expect(() =>
        validate({ ...prod, CORS_ORIGIN: 'http://localhost:5173' }),
      ).toThrow(/CORS_ORIGIN.*deploy\.md/s);
    });
    it('rejects the * wildcard', () => {
      expect(() => validate({ ...prod, CORS_ORIGIN: '*' })).toThrow(
        /CORS_ORIGIN/,
      );
    });
    it('accepts a public https origin', () => {
      expect(() =>
        validate({ ...prod, CORS_ORIGIN: 'https://app.example.com' }),
      ).not.toThrow();
    });
    it('accepts empty (CORS off — server-to-server only)', () => {
      expect(() => validate({ ...prod, CORS_ORIGIN: '' })).not.toThrow();
    });
    it('does not restrict development', () => {
      expect(() =>
        validate({
          ...validEnv,
          NODE_ENV: 'development',
          REDIS_URL: 'redis://localhost:6379',
          CORS_ORIGIN: 'http://localhost:5173',
        }),
      ).not.toThrow();
    });
  });
});
