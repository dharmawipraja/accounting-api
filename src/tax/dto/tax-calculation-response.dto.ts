// src/tax/dto/tax-calculation-response.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiMoney } from '../../common/openapi/api-money.decorator';

export class TaxBreakdownRowDto {
  @ApiProperty({ format: 'uuid' }) taxCodeId!: string;
  @ApiProperty({ example: 'PPN-OUT' }) code!: string;
  @ApiProperty({
    enum: ['PPN_OUTPUT', 'PPN_INPUT', 'PPH_PAYABLE', 'PPH_PREPAID'],
  })
  kind!: string;
  @ApiMoney({ description: 'Tax base (DPP), 4 dp string' }) base!: string;
  @ApiMoney({ description: 'Tax amount, rounded to rupiah' }) amount!: string;
  @ApiProperty({ format: 'uuid' }) accountId!: string;
}

export class CalculatedLineDto {
  @ApiProperty({ format: 'uuid' }) accountId!: string;
  @ApiPropertyOptional({ type: String, example: '1000.0000' }) debit?: string;
  @ApiPropertyOptional({ type: String, example: '1000.0000' }) credit?: string;
  @ApiPropertyOptional() description?: string;
}

export class TaxCalculationDto {
  @ApiMoney({ description: 'Sum of tax-exclusive base line amounts' })
  subtotal!: string;
  @ApiProperty({ type: [TaxBreakdownRowDto] }) taxes!: TaxBreakdownRowDto[];
  @ApiMoney() settlementAmount!: string;
  @ApiProperty({ type: [CalculatedLineDto] })
  journalLines!: CalculatedLineDto[];
}
