/** Sentry.init options from the env, or `null` when reporting is disabled.
 *  An empty value counts as unset: docker compose passes these through as
 *  `${VAR:-}`, i.e. '' when the operator left them out — so '' must disable
 *  Sentry (DSN), fall back to NODE_ENV (environment) and send no release tag. */
export function sentryOptions(env: {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
  NODE_ENV?: string;
}): { dsn: string; environment?: string; release?: string } | null {
  if (!env.SENTRY_DSN) return null;
  return {
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV,
    release: env.SENTRY_RELEASE || undefined,
  };
}
