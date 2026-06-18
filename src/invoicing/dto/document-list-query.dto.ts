import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { DocumentStatus } from '@prisma/client';
import { SearchQueryDto } from '../../common/dto/search-query.dto';

/** Shared list query for sales invoices & purchase bills (q + pagination + partner/status filters). */
export class DocumentListQueryDto extends SearchQueryDto {
  @IsOptional() @IsUUID() partnerId?: string;
  @IsOptional() @IsEnum(DocumentStatus) status?: DocumentStatus;
}
