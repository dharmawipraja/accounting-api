import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { TaxableLineDto } from '../../tax/dto/calculate-tax.dto';

export type PreviewNature = 'SALE' | 'PURCHASE';

/** Preview a document's journal entry. SALE/PURCHASE use the /tax/calculate shape. */
export class PreviewJournalEntryDto {
  @ApiProperty({ enum: ['SALE', 'PURCHASE'] })
  @IsIn(['SALE', 'PURCHASE'])
  nature!: PreviewNature;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  settlementAccountId!: string;

  @ApiProperty({ type: [TaxableLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TaxableLineDto)
  lines!: TaxableLineDto[];
}
