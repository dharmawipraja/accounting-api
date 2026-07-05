import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsUUID,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TaxableLineDto } from '../../tax/dto/calculate-tax.dto';
import { MAX_LINE_ITEMS } from '../../common/dto/limits';
import { AllocationDto } from './create-payment.dto';

export type PreviewNature = 'SALE' | 'PURCHASE' | 'PAYMENT';

/** Preview a document's journal entry, discriminated by `nature`:
 *  SALE/PURCHASE use the /tax/calculate shape; PAYMENT uses the payment shape. */
export class PreviewJournalEntryDto {
  @ApiProperty({ enum: ['SALE', 'PURCHASE', 'PAYMENT'] })
  @IsIn(['SALE', 'PURCHASE', 'PAYMENT'])
  nature!: PreviewNature;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    description:
      'Intended posting date. When present, the preview also reproduces the ' +
      '409 a real post would give for a closed period or closed fiscal year.',
  })
  @IsOptional()
  @IsDateString()
  date?: string;

  // --- SALE | PURCHASE ---
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Required for SALE/PURCHASE',
  })
  @ValidateIf((o: PreviewJournalEntryDto) => o.nature !== 'PAYMENT')
  @IsUUID()
  settlementAccountId?: string;

  @ApiPropertyOptional({
    type: [TaxableLineDto],
    description: 'Required for SALE/PURCHASE',
  })
  @ValidateIf((o: PreviewJournalEntryDto) => o.nature !== 'PAYMENT')
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LINE_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => TaxableLineDto)
  lines?: TaxableLineDto[];

  // --- PAYMENT ---
  @ApiPropertyOptional({
    enum: ['RECEIPT', 'DISBURSEMENT'],
    description: 'Required for PAYMENT',
  })
  @ValidateIf((o: PreviewJournalEntryDto) => o.nature === 'PAYMENT')
  @IsIn(['RECEIPT', 'DISBURSEMENT'])
  direction?: 'RECEIPT' | 'DISBURSEMENT';

  @ApiPropertyOptional({ format: 'uuid', description: 'Required for PAYMENT' })
  @ValidateIf((o: PreviewJournalEntryDto) => o.nature === 'PAYMENT')
  @IsUUID()
  cashAccountId?: string;

  @ApiPropertyOptional({
    type: [AllocationDto],
    description: 'Required for PAYMENT',
  })
  @ValidateIf((o: PreviewJournalEntryDto) => o.nature === 'PAYMENT')
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LINE_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => AllocationDto)
  allocations?: AllocationDto[];
}
