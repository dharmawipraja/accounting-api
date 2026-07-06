import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsString,
  ValidateNested,
} from 'class-validator';
import { JournalLineDto } from './journal-line.dto';
import { MAX_LINE_ITEMS } from '../../../common/dto/limits';

export class CreateJournalEntryDto {
  @IsDateString() date!: string;
  @IsString() description!: string;
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(MAX_LINE_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => JournalLineDto)
  lines!: JournalLineDto[];
}
