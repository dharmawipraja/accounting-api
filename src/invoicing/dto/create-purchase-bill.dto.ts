import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { DocumentLineDto } from './document-line.dto';

export class CreatePurchaseBillDto {
  @IsUUID() partnerId!: string;
  @IsOptional() @IsString() @MaxLength(64) vendorInvoiceNo?: string;
  @IsDateString() date!: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsString() @MaxLength(255) description?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => DocumentLineDto)
  lines!: DocumentLineDto[];
}
