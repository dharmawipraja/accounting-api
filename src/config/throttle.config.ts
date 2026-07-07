/**
 * Single source for the rate-limit / request-timeout knobs.
 *
 * Read from `process.env` at module load — NOT via `ConfigService` — because the
 * `@Throttle()` decorators in `auth.controller.ts` that consume these evaluate at
 * class-load time, before Nest's DI container exists. `EnvVars`
 * (`src/config/env.validation.ts`) still validates the raw overrides at startup
 * (`@IsOptional @IsInt @Min`); the values here are the resolved operative limits
 * plus their defaults, defined in exactly one place.
 */

/** Window for every rate-limit bucket (ms). */
export const THROTTLE_TTL_MS = 60_000;

/** Per-bucket request limits within `THROTTLE_TTL_MS`. */
export const THROTTLE = {
  global: Number(process.env.THROTTLE_LIMIT) || 300,
  login: Number(process.env.THROTTLE_LOGIN_LIMIT) || 10,
  refresh: Number(process.env.THROTTLE_REFRESH_LIMIT) || 30,
  // Bounds stolen-token password guessing AND per-request argon2 work.
  changePassword: Number(process.env.THROTTLE_CHANGE_PASSWORD_LIMIT) || 10,
} as const;

/** Per-request timeout (ms) for the RequestTimeoutInterceptor.
 *  Deliberately ABOVE the 30s DB statement timeout: the RxJS timeout can only
 *  stop observing the handler (the query keeps running server-side), so the
 *  DB — which genuinely aborts the statement — must get to fire first. Keep
 *  this between DB_STATEMENT_TIMEOUT_MS and main.ts's server.requestTimeout. */
export const REQUEST_TIMEOUT_MS =
  Number(process.env.REQUEST_TIMEOUT_MS) || 35_000;
