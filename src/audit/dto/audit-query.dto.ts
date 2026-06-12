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

// Only mutating verbs are ever recorded by the audit interceptor (GET/HEAD are
// skipped), so constrain the filter to them — a bad value is a 400, not a
// silently-empty result.
const LOGGED_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE'] as const;

export class AuditQueryDto {
  @IsOptional() @IsString() userId?: string;
  @IsOptional() @IsIn(LOGGED_METHODS) method?: (typeof LOGGED_METHODS)[number];
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}
