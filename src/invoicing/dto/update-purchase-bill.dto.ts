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
import { PurchaseBillLineDto } from './create-purchase-bill.dto';

export class UpdatePurchaseBillDto {
  @IsOptional() @IsString() @MaxLength(64) vendorInvoiceNo?: string;
  @IsOptional() @IsDateString() date?: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsString() @MaxLength(255) description?: string;
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseBillLineDto)
  lines?: PurchaseBillLineDto[];
}
