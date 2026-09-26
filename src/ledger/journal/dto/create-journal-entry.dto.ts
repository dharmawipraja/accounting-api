import { IsBusinessDate } from '../../../common/validators/is-business-date';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { JournalLineDto } from './journal-line.dto';
import { MAX_LINE_ITEMS } from '../../../common/dto/limits';

export class CreateJournalEntryDto {
  @IsDateString() @IsBusinessDate() date!: string;
  @IsString() @MaxLength(500) description!: string;
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(MAX_LINE_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => JournalLineDto)
  lines!: JournalLineDto[];
}
