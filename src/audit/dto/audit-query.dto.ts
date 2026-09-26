import { IsDateString, IsIn, IsOptional, IsUUID } from 'class-validator';
import { AUDIT_METHODS } from '../mutating-methods';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class AuditQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional()
  @IsIn(AUDIT_METHODS)
  method?: (typeof AUDIT_METHODS)[number];
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}
