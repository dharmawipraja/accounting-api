import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { DocumentStatus } from '@prisma/client';
import { SearchQueryDto } from '../../common/dto/search-query.dto';

export class SalesInvoiceListQueryDto extends SearchQueryDto {
  @IsOptional() @IsUUID() partnerId?: string;
  @IsOptional() @IsEnum(DocumentStatus) status?: DocumentStatus;
}
