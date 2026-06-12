import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { DocumentStatus } from '@prisma/client';

export class SalesInvoiceListQueryDto {
  @IsOptional() @IsUUID() partnerId?: string;
  @IsOptional() @IsEnum(DocumentStatus) status?: DocumentStatus;
}
