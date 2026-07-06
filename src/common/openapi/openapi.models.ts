import { ApiProperty } from '@nestjs/swagger';

/** The uniform error envelope returned by AllExceptionsFilter for every 4xx/5xx. */
export class ErrorEnvelopeDto {
  @ApiProperty({ example: 'NOT_FOUND' }) code!: string;
  @ApiProperty({ example: 'Resource not found' }) message!: string;
  @ApiProperty({ required: false, description: 'Optional structured detail' })
  details?: Record<string, unknown>;
  @ApiProperty({
    required: false,
    description: 'Correlates with the X-Request-Id response header',
  })
  traceId?: string;
}

/** Access + refresh token pair from /auth/login and /auth/refresh. */
export class TokenPairDto {
  @ApiProperty() accessToken!: string;
  @ApiProperty() refreshToken!: string;
}

/** GET /health */
export class HealthStatusDto {
  @ApiProperty({ example: 'ok' }) status!: string;
}

/** GET /ready */
export class ReadinessStatusDto {
  @ApiProperty({ example: 'ok' }) status!: string;
  @ApiProperty({ example: 'up' }) db!: string;
}

/** GET /auth/me — the authenticated principal derived from the JWT. */
export class AuthenticatedUserDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'admin@x.com' }) email!: string;
  @ApiProperty({ enum: ['ADMIN', 'ACCOUNTANT', 'APPROVER', 'VIEWER'] })
  role!: string;
  @ApiProperty() mustChangePassword!: boolean;
}

/** GET /auth/admin-only — RBAC smoke surface. */
export class OkFlagDto {
  @ApiProperty({ example: true }) ok!: boolean;
}
