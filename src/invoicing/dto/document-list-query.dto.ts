import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { DocumentStatus, TaxInvoiceStatus } from '@prisma/client';
import { SearchQueryDto } from '../../common/dto/search-query.dto';

/** Shared list query for sales invoices & purchase bills (q + pagination + partner/status filters). */
export class DocumentListQueryDto extends SearchQueryDto {
  @IsOptional() @IsUUID() partnerId?: string;
  @IsOptional() @IsEnum(DocumentStatus) status?: DocumentStatus;
}

/** Sales invoice list: the shared filters + the Coretax faktur status. */
export class SalesInvoiceListQueryDto extends DocumentListQueryDto {
  @IsOptional() @IsEnum(TaxInvoiceStatus) taxInvoiceStatus?: TaxInvoiceStatus;
}
