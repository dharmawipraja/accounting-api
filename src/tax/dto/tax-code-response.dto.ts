// src/tax/dto/tax-code-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';

export class TaxCodeResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'PPN-OUT' }) code!: string;
  @ApiProperty({ example: 'PPN Keluaran 11%' }) name!: string;
  @ApiProperty({ enum: ['PPN_OUTPUT', 'PPN_INPUT', 'PPH_PAYABLE', 'PPH_PREPAID'] })
  kind!: string;
  @ApiProperty({
    type: String,
    example: '0.110000',
    description: 'Rate as a 6-dp decimal string (e.g. 0.110000 = 11%).',
  })
  rate!: string;
  @ApiProperty({ format: 'uuid' }) taxAccountId!: string;
  @ApiProperty({ example: true }) isActive!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
