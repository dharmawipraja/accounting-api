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
  // Per-client-IP ceiling on login, independent of the per-email bucket, so
  // rotating emails cannot buy unlimited argon2 work / password spraying.
  loginIp: Number(process.env.THROTTLE_LOGIN_IP_LIMIT) || 30,
  refresh: Number(process.env.THROTTLE_REFRESH_LIMIT) || 30,
  // Bounds stolen-token password guessing AND per-request argon2 work.
  changePassword: Number(process.env.THROTTLE_CHANGE_PASSWORD_LIMIT) || 10,
  // Per-user Coretax XML export (builds up to 1000 invoices x 100 lines in
  // memory per call).
  coretaxExport: Number(process.env.THROTTLE_CORETAX_EXPORT_LIMIT) || 10,
} as const;

/** Per-account failed-login ceiling (LoginFailureLimiter): after `limit`
 *  failures within `windowMs`, the account refuses logins from IPs it has never
 *  logged in from (known IPs are remembered for `knownIpTtlMs`). After
 *  `hardLimit` failures it refuses EVERY IP, known or not. */
export const LOGIN_FAILURE = {
  limit: Number(process.env.LOGIN_FAILURE_LIMIT) || 20,
  hardLimit: Number(process.env.LOGIN_FAILURE_HARD_LIMIT) || 100,
  windowMs: 15 * 60_000,
  knownIpTtlMs: 30 * 24 * 60 * 60_000,
} as const;

/** Per-request timeout (ms) for the RequestTimeoutInterceptor.
 *  Deliberately ABOVE the 30s DB statement timeout: the RxJS timeout can only
 *  stop observing the handler (the query keeps running server-side), so the
 *  DB — which genuinely aborts the statement — must get to fire first. Keep
 *  this between DB_STATEMENT_TIMEOUT_MS and main.ts's server.requestTimeout. */
export const REQUEST_TIMEOUT_MS =
  Number(process.env.REQUEST_TIMEOUT_MS) || 35_000;
