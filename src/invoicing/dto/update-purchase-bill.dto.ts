import { IsBusinessDate } from '../../common/validators/is-business-date';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { DocumentLineDto } from './document-line.dto';

export class UpdatePurchaseBillDto {
  @IsOptional() @IsString() @MaxLength(64) vendorInvoiceNo?: string;
  @IsOptional() @IsDateString() @IsBusinessDate() date?: string;
  @IsOptional() @IsDateString() @IsBusinessDate() dueDate?: string;
  @IsOptional() @IsString() @MaxLength(255) description?: string;
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DocumentLineDto)
  lines?: DocumentLineDto[];
}
