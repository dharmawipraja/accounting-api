// Loaded here (not only in main.ts) so unit tests can exercise the decorators
// in isolation, without NestJS bootstrapping reflect-metadata for us.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import ms from 'ms';
import { productionCorsViolations } from './cors-origins';
import type { StringValue } from 'ms';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateBy,
  ValidateIf,
  ValidationOptions,
  validateSync,
} from 'class-validator';

/** Parse an `ms`-style duration ('900s', '15m', '7d') to milliseconds. */
export function parseDurationMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  try {
    const out = ms(value as StringValue) as number | undefined;
    return typeof out === 'number' && Number.isFinite(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

/** An integer followed by exactly one unit: seconds, minutes, hours or days. */
const DURATION_WITH_UNIT = /^\d+[smhd]$/;

/** A positive `ms` duration (with a unit) no longer than `maxMs`. */
function IsDurationAtMost(maxMs: number, opts?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isDurationAtMost',
      constraints: [maxMs],
      validator: {
        validate: (value: unknown) => {
          // A unit suffix is REQUIRED: jsonwebtoken reads a unitless string
          // ('900') as milliseconds, silently minting sub-second tokens.
          if (typeof value !== 'string' || !DURATION_WITH_UNIT.test(value))
            return false;
          const parsed = parseDurationMs(value);
          return parsed !== undefined && parsed > 0 && parsed <= maxMs;
        },
        defaultMessage: (args) =>
          `${args?.property} must be a positive whole-number duration with a unit s/m/h/d (e.g. '900s', '7d') of at most ${maxMs / 1000}s`,
      },
    },
    opts,
  );
}

/** The value must differ from the sibling property `other`. */
function IsDifferentFrom(other: string, opts?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isDifferentFrom',
      constraints: [other],
      validator: {
        validate: (value: unknown, args) =>
          value !== (args?.object as Record<string, unknown>)[other],
        defaultMessage: (args) => `${args?.property} must differ from ${other}`,
      },
    },
    opts,
  );
}

/** In production every CORS_ORIGIN entry must be a public `https://` origin
 *  (no `*`, no localhost/loopback). Empty = CORS off, allowed. */
function IsProductionSafeCors(opts?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isProductionSafeCors',
      validator: {
        validate: (value: unknown, args) =>
          (args?.object as { NODE_ENV?: string }).NODE_ENV !==
            NodeEnv.Production ||
          typeof value !== 'string' ||
          productionCorsViolations(value).length === 0,
        defaultMessage: (args) =>
          `CORS_ORIGIN has entries not allowed in production: ${productionCorsViolations(
            String(args?.value),
          ).join(
            ', ',
          )} — each must be the real frontend's public https origin (e.g. https://app.example.com; no *, localhost or loopback), or leave CORS_ORIGIN empty to disable CORS. See docs/runbooks/deploy.md (Prerequisites → Optional).`,
      },
    },
    opts,
  );
}

/** Access tokens: ≤ 1h (revocation is also checked per request via `sid`). */
export const MAX_ACCESS_TTL_MS = 3_600_000;
/** Refresh tokens: ≤ 30 days. */
export const MAX_REFRESH_TTL_MS = 30 * 86_400_000;

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvVars {
  @IsEnum(NodeEnv)
  NODE_ENV!: NodeEnv;

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT!: number;

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @MinLength(32)
  @IsDifferentFrom('JWT_ACCESS_SECRET')
  JWT_REFRESH_SECRET!: string;

  @IsString()
  @IsNotEmpty()
  @IsDurationAtMost(MAX_ACCESS_TTL_MS)
  JWT_ACCESS_TTL!: string;

  @IsString()
  @IsNotEmpty()
  @IsDurationAtMost(MAX_REFRESH_TTL_MS)
  JWT_REFRESH_TTL!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  DB_POOL_MAX?: number;

  @IsOptional()
  @IsInt()
  @Min(1000)
  DB_STATEMENT_TIMEOUT_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(1000)
  IDEMPOTENCY_INFLIGHT_TTL_MS?: number;

  @IsOptional()
  @IsInt()
  @Min(60000)
  IDEMPOTENCY_COMPLETED_TTL_MS?: number;

  @IsOptional()
  @IsString()
  METRICS_TOKEN?: string;

  @IsOptional()
  @IsString()
  SENTRY_DSN?: string;

  @IsOptional()
  @IsString()
  SENTRY_ENVIRONMENT?: string;

  @IsOptional()
  @IsString()
  SENTRY_RELEASE?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  THROTTLE_LIMIT?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  THROTTLE_LOGIN_LIMIT?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  THROTTLE_LOGIN_IP_LIMIT?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  LOGIN_FAILURE_LIMIT?: number;

  /** Absolute per-account failure ceiling (15 min) — known IPs are refused too. */
  @IsOptional()
  @IsInt()
  @Min(1)
  LOGIN_FAILURE_HARD_LIMIT?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  THROTTLE_REFRESH_LIMIT?: number;

  /** Window (ms) after a refresh token's rotation in which a replay of it is
   *  treated as a concurrent refresh (ONE sibling issued), not reuse. 0 = off. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30_000)
  REFRESH_REUSE_GRACE_MS?: number;

  /** Max concurrent argon2 hash/verify operations per process (64 MiB each). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(64)
  ARGON2_MAX_CONCURRENCY?: number;

  /** Express `trust proxy` hops (default: 1 in production behind Caddy, else 0). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  TRUST_PROXY_HOPS?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  THROTTLE_CHANGE_PASSWORD_LIMIT?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  THROTTLE_CORETAX_EXPORT_LIMIT?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  THROTTLE_REPORT_EXPORT_LIMIT?: number;

  @ValidateIf((o: EnvVars) => o.NODE_ENV !== NodeEnv.Test)
  @IsString()
  @IsNotEmpty()
  REDIS_URL?: string;

  @IsOptional()
  @IsString()
  @IsProductionSafeCors()
  CORS_ORIGIN?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  ENABLE_SWAGGER?: string;

  @IsOptional()
  @IsIn(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
  LOG_LEVEL?: string;

  @IsOptional()
  @IsInt()
  @Min(1000)
  REQUEST_TIMEOUT_MS?: number;

  /** Minutes east of UTC for defaulted report "today" (WIB = 420). */
  @IsOptional()
  @IsInt()
  @Min(-720)
  @Max(840)
  REPORT_UTC_OFFSET_MINUTES?: number;
}

export function validate(config: Record<string, unknown>): EnvVars {
  const validated = plainToInstance(EnvVars, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, {
    skipMissingProperties: false,
  });
  if (errors.length > 0) {
    // Include each constraint's message (class-validator's toString() lists
    // only constraint names) so an operator sees WHY a var was rejected.
    const details = errors
      .map(
        (e) =>
          ` - ${e.property}: ${Object.values(e.constraints ?? {}).join('; ')}`,
      )
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return validated;
}
