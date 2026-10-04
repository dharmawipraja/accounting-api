// src/invoicing/dto/purchase-bill-response.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiMoney } from '../../common/openapi/api-money.decorator';
import { PaginatedDto } from '../../common/openapi/paginated-dto';
import {
  DISCOUNT_AMOUNT_DOC,
  DISCOUNT_PERCENT_DOC,
  LINE_AMOUNT_DOC,
  TransactionalDocumentResponseDto,
} from './transactional-document-response.dto';

class PurchaseBillLineResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) purchaseBillId!: string;
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
