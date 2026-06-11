import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { IsMoneyString } from '../../common/validators/is-money-string';
import { TaxNature } from '../tax.service';

export class TaxableLineDto {
  @IsUUID() accountId!: string;
  @IsMoneyString() amount!: string;
  @IsArray() @IsUUID('all', { each: true }) taxCodeIds!: string[];
}

export class CalculateTaxDto {
  @IsIn(['SALE', 'PURCHASE']) nature!: TaxNature;
  @IsUUID() settlementAccountId!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TaxableLineDto)
  lines!: TaxableLineDto[];
}
