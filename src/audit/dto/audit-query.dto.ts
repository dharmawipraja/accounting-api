import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { AUDIT_METHODS } from '../mutating-methods';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { IsAuditInstant } from '../../common/validators/is-audit-instant';

// from / to use @IsAuditInstant ALONE: it subsumes @IsDateString, and pairing
// them would emit two messages for one bad value.
export class AuditQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional()
  @IsIn(AUDIT_METHODS)
  method?: (typeof AUDIT_METHODS)[number];
  /** Strict ISO date / date-time, real day, year 1970–9999 (IsAuditInstant). */
  @IsOptional() @IsAuditInstant() from?: string;
  /** Strict ISO date / date-time, real day, year 1970–9999 (IsAuditInstant). */
  @IsOptional() @IsAuditInstant() to?: string;
}
