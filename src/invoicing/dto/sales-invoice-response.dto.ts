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

class SalesInvoiceLineResponseDto {
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
  @ApiProperty({ enum: ['A', 'B'], nullable: true }) coretaxItemType!:
    | string
    | null;
  @ApiProperty({ nullable: true, example: '000000' }) coretaxItemCode!:
    | string
    | null;
  @ApiProperty({ nullable: true, example: 'UM.0018' }) coretaxUnitCode!:
    | string
    | null;
}

export class SalesInvoiceResponseDto extends TransactionalDocumentResponseDto {
  @ApiProperty({ nullable: true }) invoiceNumber!: number | null;
  @ApiProperty({ nullable: true }) invoiceRef!: string | null;
  @ApiProperty({
    nullable: true,
    example: '04',
    description: 'Coretax kode transaksi override (null = derived at export).',
  })
  trxCode!: string | null;
  @ApiProperty({
    nullable: true,
    example: '04002500000348920',
    description: 'NSFP: the 17-digit faktur pajak number Coretax assigned.',
  })
  taxInvoiceNumber!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  taxInvoiceDate!: string | null;
  @ApiProperty({ enum: ['NONE', 'EXPORTED', 'APPROVED', 'CANCELLED'] })
  taxInvoiceStatus!: string;
  @ApiProperty({ format: 'date-time', nullable: true })
  coretaxExportedAt!: string | null;
  @ApiProperty({
    nullable: true,
    description: 'Bukti potong PPh number (PATCH …/withholding-slip).',
  })
  withholdingSlipNumber!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  withholdingSlipDate!: string | null;
  @ApiPropertyOptional({ type: [SalesInvoiceLineResponseDto] })
  lines?: SalesInvoiceLineResponseDto[];
}

export const SalesInvoiceListResponseDto = PaginatedDto(
  SalesInvoiceResponseDto,
  'SalesInvoiceListResponseDto',
);
