import { IsBusinessDate } from '../../common/validators/is-business-date';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsMoneyString } from '../../common/validators/is-money-string';
import { OptionalNonNull } from '../../common/validators/optional-non-null';
import { MAX_LINE_ITEMS } from '../../common/dto/limits';

/** One returned line: which original line, how many. Price, discount
 *  (pro-rated), account and tax codes are copied from the original line. */
class NoteLineDto {
  /** A line of the note's original invoice / bill. */
  @IsUUID() originalLineId!: string;
  /** Returned quantity, > 0 and ≤ the original quantity minus what other
   *  live (draft/posted) notes already return (4 dp string). */
  @IsMoneyString() quantity!: string;
}

/** POST /sales-credit-notes and /purchase-debit-notes. */
export class CreateNoteDto {
  /** The POSTED sales invoice (credit note) / purchase bill (debit note) this
   *  note returns part of; the note's partner is the original's. */
  @IsUUID() originalId!: string;
  /** On/after the original's date. */
  @IsDateString() @IsBusinessDate() date!: string;
  @IsOptional() @IsString() @MaxLength(255) description?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LINE_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => NoteLineDto)
  lines!: NoteLineDto[];
}

/** PATCH of a DRAFT note (the original is fixed). */
export class UpdateNoteDto {
  @OptionalNonNull() @IsDateString() @IsBusinessDate() date?: string;
  @ApiPropertyOptional({
    type: String,
    maxLength: 255,
    nullable: true,
    description: 'Send `null` to clear the description; omit to keep it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string | null;
  @OptionalNonNull()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LINE_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => NoteLineDto)
  lines?: NoteLineDto[];
}
