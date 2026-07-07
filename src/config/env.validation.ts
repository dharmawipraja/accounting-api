// Loaded here (not only in main.ts) so unit tests can exercise the decorators
// in isolation, without NestJS bootstrapping reflect-metadata for us.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
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
  ValidateIf,
  validateSync,
} from 'class-validator';

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
  JWT_REFRESH_SECRET!: string;

  @IsString()
  @IsNotEmpty()
  JWT_ACCESS_TTL!: string;

  @IsString()
  @IsNotEmpty()
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
  THROTTLE_REFRESH_LIMIT?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  THROTTLE_CHANGE_PASSWORD_LIMIT?: number;

  @ValidateIf((o: EnvVars) => o.NODE_ENV !== NodeEnv.Test)
  @IsString()
  @IsNotEmpty()
  REDIS_URL?: string;

  @IsOptional()
  @IsString()
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
    throw new Error(`Invalid environment configuration: ${errors.toString()}`);
  }
  return validated;
}
