import { IsDateString, IsIn, IsOptional, IsUUID } from 'class-validator';
import { AUDIT_METHODS } from '../mutating-methods';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { IsAuditInstant } from '../../common/validators/is-audit-instant';

export class AuditQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional()
  @IsIn(AUDIT_METHODS)
  method?: (typeof AUDIT_METHODS)[number];
  /** Strict ISO date / date-time, real day, year 1970–9999 (IsAuditInstant). */
  @IsOptional() @IsDateString() @IsAuditInstant() from?: string;
  /** Strict ISO date / date-time, real day, year 1970–9999 (IsAuditInstant). */
  @IsOptional() @IsDateString() @IsAuditInstant() to?: string;
}
