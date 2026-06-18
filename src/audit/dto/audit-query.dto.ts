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

export class AuditQueryDto {
  @IsOptional() @IsString() userId?: string;
  @IsOptional()
  @IsIn(MUTATING_METHODS)
  method?: (typeof MUTATING_METHODS)[number];
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
