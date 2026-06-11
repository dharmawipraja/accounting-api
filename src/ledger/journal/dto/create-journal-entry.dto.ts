import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsString,
  ValidateNested,
} from 'class-validator';
import { JournalLineDto } from './journal-line.dto';

export class CreateJournalEntryDto {
  @IsDateString() date!: string;
  @IsString() description!: string;
  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => JournalLineDto)
  lines!: JournalLineDto[];
}
