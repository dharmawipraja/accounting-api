import { ApiProperty } from '@nestjs/swagger';

export class AccountResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: '1-1000' }) code!: string;
  @ApiProperty({ example: 'Kas' }) name!: string;
  @ApiProperty({ enum: ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] })
  type!: string;
  @ApiProperty({
    enum: [
      'CURRENT_ASSET', 'NON_CURRENT_ASSET', 'FIXED_ASSET',
      'ACCUMULATED_DEPRECIATION', 'CURRENT_LIABILITY', 'NON_CURRENT_LIABILITY',
      'EQUITY', 'REVENUE', 'COGS', 'OPERATING_EXPENSE', 'OTHER_INCOME',
      'OTHER_EXPENSE', 'TAX_PAYABLE', 'TAX_RECEIVABLE',
    ],
  })
  subtype!: string;
  @ApiProperty({ enum: ['OPERATING', 'INVESTING', 'FINANCING', 'NONE'] })
  cashFlowCategory!: string;
  @ApiProperty({ enum: ['DEBIT', 'CREDIT'] }) normalBalance!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) parentId!: string | null;
  @ApiProperty({ example: true }) isPostable!: boolean;
  @ApiProperty({ example: true }) isActive!: boolean;
  @ApiProperty({ example: 'IDR' }) currency!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
