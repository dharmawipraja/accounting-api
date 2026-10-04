// src/invoicing/dto/sales-invoice-response.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginatedDto } from '../../common/openapi/paginated-dto';
import {
  DocumentLineResponseDto,
  TransactionalDocumentResponseDto,
} from './transactional-document-response.dto';

class SalesInvoiceLineResponseDto extends DocumentLineResponseDto {
  @ApiProperty({ format: 'uuid' }) salesInvoiceId!: string;
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
