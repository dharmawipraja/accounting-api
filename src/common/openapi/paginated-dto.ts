import { Type } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';

export interface PaginatedDtoOptions {
  /** Override the example value for the `total` field (default: 240). */
  totalExample?: number;
}

/**
 * Builds a named paginated-envelope class for OpenAPI. Pass `schemaName` to
 * preserve an existing schema name (avoids renaming already-published schemas);
 * defaults to `Paginated<Model>` for genuinely new endpoints.
 */
export function PaginatedDto<TModel extends Type<unknown>>(
  model: TModel,
  schemaName?: string,
  options: PaginatedDtoOptions = {},
) {
  const { totalExample = 240 } = options;

  class PaginatedResponseDto {
    @ApiProperty({ type: [model] }) data!: InstanceType<TModel>[];
    @ApiProperty({ example: totalExample }) total!: number;
    @ApiProperty({ example: 50 }) limit!: number;
    @ApiProperty({ example: 0 }) offset!: number;
  }
  Object.defineProperty(PaginatedResponseDto, 'name', {
    value: schemaName ?? `Paginated${model.name}`,
  });
  return PaginatedResponseDto;
}
