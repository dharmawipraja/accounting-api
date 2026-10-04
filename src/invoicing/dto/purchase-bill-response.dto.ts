// src/invoicing/dto/purchase-bill-response.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginatedDto } from '../../common/openapi/paginated-dto';
import {
  DocumentLineResponseDto,
  TransactionalDocumentResponseDto,
} from './transactional-document-response.dto';

class PurchaseBillLineResponseDto extends DocumentLineResponseDto {
  @ApiProperty({ format: 'uuid' }) purchaseBillId!: string;
}

export class PurchaseBillResponseDto extends TransactionalDocumentResponseDto {
  @ApiProperty({ nullable: true }) billNumber!: number | null;
  @ApiProperty({ nullable: true }) billRef!: string | null;
  @ApiProperty({ nullable: true }) vendorInvoiceNo!: string | null;
  @ApiProperty({
    nullable: true,
    description:
      'Bukti potong (BPPU) number Coretax issued (PATCH …/withholding-slip).',
  })
  withholdingSlipNumber!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  withholdingSlipDate!: string | null;
  @ApiPropertyOptional({ type: [PurchaseBillLineResponseDto] })
  lines?: PurchaseBillLineResponseDto[];
}

export const PurchaseBillListResponseDto = PaginatedDto(
  PurchaseBillResponseDto,
  'PurchaseBillListResponseDto',
);
