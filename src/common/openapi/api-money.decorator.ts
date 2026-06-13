// src/common/openapi/api-money.decorator.ts
import { ApiProperty, ApiPropertyOptions } from '@nestjs/swagger';

/**
 * Documents a monetary field. All money in this API serializes as a fixed
 * 4-decimal-place string (see common/money/money.ts) — never a JS number.
 */
export function ApiMoney(options: ApiPropertyOptions = {}): PropertyDecorator {
  return ApiProperty({
    type: String,
    example: '1000.0000',
    description: 'Decimal monetary amount as a string, fixed 4 decimal places.',
    ...options,
  });
}
