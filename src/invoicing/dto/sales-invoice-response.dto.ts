// src/invoicing/dto/sales-invoice-response.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiMoney } from '../../common/openapi/api-money.decorator';
import { PaginatedDto } from '../../common/openapi/paginated-dto';
import {
  DISCOUNT_AMOUNT_DOC,
  DISCOUNT_PERCENT_DOC,
  LINE_AMOUNT_DOC,
  TransactionalDocumentResponseDto,
} from './transactional-document-response.dto';

export class SalesInvoiceLineResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) salesInvoiceId!: string;
  @ApiProperty({ example: 1 }) lineNo!: number;
  @ApiProperty() description!: string;
  @ApiProperty({ format: 'uuid' }) accountId!: string;
  @ApiMoney({ description: 'Quantity, 4 dp string' }) quantity!: string;
  @ApiMoney() unitPrice!: string;
  @ApiMoney(DISCOUNT_PERCENT_DOC) discountPercent!: string | null;
  @ApiMoney(DISCOUNT_AMOUNT_DOC) discountAmount!: string;
  @ApiMoney(LINE_AMOUNT_DOC) amount!: string;
  @ApiProperty({ type: [String], format: 'uuid' }) taxCodeIds!: string[];
}

export class SalesInvoiceResponseDto extends TransactionalDocumentResponseDto {
  @ApiProperty({ nullable: true }) invoiceNumber!: number | null;
  @ApiProperty({ nullable: true }) invoiceRef!: string | null;
  @ApiPropertyOptional({ type: [SalesInvoiceLineResponseDto] })
  lines?: SalesInvoiceLineResponseDto[];
}

export const SalesInvoiceListResponseDto = PaginatedDto(
  SalesInvoiceResponseDto,
  'SalesInvoiceListResponseDto',
);
