import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MUTATING_METHODS } from '../mutating-methods';
import { MAX_LIMIT } from '../../common/pagination/pagination.constants';

export class AuditQueryDto {
  @IsOptional() @IsString() userId?: string;
  @IsOptional()
  @IsIn(MUTATING_METHODS)
  method?: (typeof MUTATING_METHODS)[number];
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  // Reconciled to the shared MAX_LIMIT (was @Max(500)) so the cap can't drift again.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
