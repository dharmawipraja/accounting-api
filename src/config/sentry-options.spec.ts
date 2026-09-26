import { sentryOptions } from './sentry-options';

describe('sentryOptions', () => {
  it('is disabled (null) when SENTRY_DSN is unset or empty', () => {
    expect(sentryOptions({})).toBeNull();
    // docker compose passes `${SENTRY_DSN:-}` → '' when the operator left it out.
    expect(sentryOptions({ SENTRY_DSN: '' })).toBeNull();
  });

  it('uses SENTRY_ENVIRONMENT / SENTRY_RELEASE when set', () => {
    expect(
      sentryOptions({
        SENTRY_DSN: 'https://k@o.ingest.sentry.io/1',
        SENTRY_ENVIRONMENT: 'staging',
        SENTRY_RELEASE: 'v1.2.3',
        NODE_ENV: 'production',
      }),
    ).toEqual({
      dsn: 'https://k@o.ingest.sentry.io/1',
      environment: 'staging',
      release: 'v1.2.3',
    });
  });

  it('treats an empty SENTRY_ENVIRONMENT / SENTRY_RELEASE like unset', () => {
    // Compose's `${VAR:-}` passthrough yields '' — Sentry must fall back to
    // NODE_ENV and send no release tag, not an empty-string one.
    expect(
      sentryOptions({
        SENTRY_DSN: 'https://k@o.ingest.sentry.io/1',
        SENTRY_ENVIRONMENT: '',
        SENTRY_RELEASE: '',
        NODE_ENV: 'production',
      }),
    ).toEqual({
      dsn: 'https://k@o.ingest.sentry.io/1',
      environment: 'production',
      release: undefined,
    });
  });
});
