import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  ValidateNested,
} from 'class-validator';
import { JournalLineDto } from './journal-line.dto';
import { MAX_LINE_ITEMS } from '../../../common/dto/limits';

export class OpeningBalancesDto {
  @IsDateString() date!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LINE_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => JournalLineDto)
  balances!: JournalLineDto[];
}
