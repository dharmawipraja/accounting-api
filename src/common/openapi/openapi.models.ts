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
