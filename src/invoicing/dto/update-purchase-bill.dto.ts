import { IsBusinessDate } from '../../common/validators/is-business-date';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { DocumentLineDto } from './document-line.dto';
import { MAX_LINE_ITEMS } from '../../common/dto/limits';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdatePurchaseBillDto {
  @ApiPropertyOptional({
    type: String,
    maxLength: 64,
    nullable: true,
    description: 'Trimmed on write. Send `null` to clear it; omit to keep it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  vendorInvoiceNo?: string | null;
  @IsOptional() @IsDateString() @IsBusinessDate() date?: string;
  @ApiPropertyOptional({
    type: String,
    format: 'date',
    nullable: true,
    description: 'Send `null` to clear the due date; omit to keep it.',
  })
  @IsOptional()
  @IsDateString()
  @IsBusinessDate()
  dueDate?: string | null;
  @IsOptional() @IsString() @MaxLength(255) description?: string;
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LINE_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => DocumentLineDto)
  lines?: DocumentLineDto[];
}
