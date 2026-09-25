import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { IsMoneyString } from '../../common/validators/is-money-string';
import {
  MAX_LINE_ITEMS,
  MAX_TAX_CODES_PER_LINE,
} from '../../common/dto/limits';
import { TaxNature } from '../tax.service';

export class TaxableLineDto {
  @IsUUID() accountId!: string;
  @IsMoneyString() amount!: string;
  @IsArray()
  @ArrayMaxSize(MAX_TAX_CODES_PER_LINE)
  @IsUUID('all', { each: true })
  taxCodeIds!: string[];
}

export class CalculateTaxDto {
  @IsIn(['SALE', 'PURCHASE']) nature!: TaxNature;
  @IsUUID() settlementAccountId!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LINE_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => TaxableLineDto)
  lines!: TaxableLineDto[];
}
