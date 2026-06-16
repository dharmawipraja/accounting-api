import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { DocumentStatus } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class SalesInvoiceListQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() partnerId?: string;
  @IsOptional() @IsEnum(DocumentStatus) status?: DocumentStatus;
}
