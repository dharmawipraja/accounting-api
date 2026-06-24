import { IsDateString, IsIn, IsOptional, IsString } from 'class-validator';
import { MUTATING_METHODS } from '../mutating-methods';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class AuditQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() userId?: string;
  @IsOptional()
  @IsIn(MUTATING_METHODS)
  method?: (typeof MUTATING_METHODS)[number];
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}
