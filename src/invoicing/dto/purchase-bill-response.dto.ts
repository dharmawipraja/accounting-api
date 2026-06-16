// src/invoicing/dto/purchase-bill-response.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiMoney } from '../../common/openapi/api-money.decorator';

export class PurchaseBillLineResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) purchaseBillId!: string;
  @ApiProperty({ example: 1 }) lineNo!: number;
  @ApiProperty() description!: string;
  @ApiProperty({ format: 'uuid' }) accountId!: string;
  @ApiMoney({ description: 'Quantity, 4 dp string' }) quantity!: string;
  @ApiMoney() unitPrice!: string;
  @ApiMoney() amount!: string;
  @ApiProperty({ type: [String], format: 'uuid' }) taxCodeIds!: string[];
}

export class PurchaseBillResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true }) billNumber!: number | null;
  @ApiProperty({ nullable: true }) billRef!: string | null;
  @ApiProperty({ nullable: true }) fiscalYear!: number | null;
  @ApiProperty({ format: 'uuid' }) partnerId!: string;
  @ApiProperty({ nullable: true }) vendorInvoiceNo!: string | null;
  @ApiProperty({ type: String, format: 'date', example: '2026-01-15' })
  date!: string;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  dueDate!: string | null;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: ['DRAFT', 'POSTED', 'VOID'] }) status!: string;
  @ApiMoney() subtotal!: string;
  @ApiMoney() taxTotal!: string;
  @ApiMoney() withholdingTotal!: string;
  @ApiMoney() total!: string;
  @ApiMoney() amountPaid!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) journalEntryId!:
    | string
    | null;
  @ApiProperty({ format: 'uuid' }) createdBy!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) postedBy!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true }) postedAt!:
    | string
    | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiMoney({ description: 'total − amountPaid' }) outstanding!: string;
  @ApiProperty({ enum: ['UNPAID', 'PARTIAL', 'PAID'] }) paymentStatus!: string;
  @ApiPropertyOptional({ type: [PurchaseBillLineResponseDto] })
  lines?: PurchaseBillLineResponseDto[];
}

export class PurchaseBillListResponseDto {
  @ApiProperty({ type: [PurchaseBillResponseDto] })
  data!: PurchaseBillResponseDto[];
  @ApiProperty({ example: 240 }) total!: number;
  @ApiProperty({ example: 50 }) limit!: number;
  @ApiProperty({ example: 0 }) offset!: number;
}
