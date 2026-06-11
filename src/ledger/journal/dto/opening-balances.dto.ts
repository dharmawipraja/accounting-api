import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  ValidateNested,
} from 'class-validator';
import { JournalLineDto } from './journal-line.dto';

export class OpeningBalancesDto {
  @IsDateString() date!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => JournalLineDto)
  balances!: JournalLineDto[];
}
