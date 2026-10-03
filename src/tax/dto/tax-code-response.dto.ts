// src/tax/dto/tax-code-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';

export class TaxCodeResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'PPN-OUT' }) code!: string;
  @ApiProperty({ example: 'PPN Keluaran 11%' }) name!: string;
  @ApiProperty({
    enum: ['PPN_OUTPUT', 'PPN_INPUT', 'PPH_PAYABLE', 'PPH_PREPAID'],
  })
  kind!: string;
  @ApiProperty({
    type: String,
    example: '0.110000',
    description: 'Rate as a 6-dp decimal string (e.g. 0.110000 = 11%).',
  })
  rate!: string;
  @ApiProperty({ format: 'uuid' }) taxAccountId!: string;
  @ApiProperty({
    example: false,
    description: 'Coretax: DPP Nilai Lain 11/12 (PPN Output).',
  })
  dppNilaiLain!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    example: '12',
    description: 'Coretax statutory VATRate %; null = derived from rate.',
  })
  coretaxVatRate!: string | null;
  @ApiProperty({ example: true }) isActive!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
