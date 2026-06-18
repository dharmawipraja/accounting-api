// src/invoicing/dto/purchase-bill-response.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiMoney } from '../../common/openapi/api-money.decorator';
import { PaginatedDto } from '../../common/openapi/paginated-dto';
import { TransactionalDocumentResponseDto } from './transactional-document-response.dto';

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

export class PurchaseBillResponseDto extends TransactionalDocumentResponseDto {
  @ApiProperty({ nullable: true }) billNumber!: number | null;
  @ApiProperty({ nullable: true }) billRef!: string | null;
  @ApiProperty({ nullable: true }) vendorInvoiceNo!: string | null;
  @ApiPropertyOptional({ type: [PurchaseBillLineResponseDto] })
  lines?: PurchaseBillLineResponseDto[];
}

export const PurchaseBillListResponseDto = PaginatedDto(
  PurchaseBillResponseDto,
  'PurchaseBillListResponseDto',
);
