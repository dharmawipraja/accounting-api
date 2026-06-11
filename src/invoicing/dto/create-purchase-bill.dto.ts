import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class PurchaseBillLineDto {
  @IsString() @MaxLength(255) description!: string;
  @IsUUID() accountId!: string;
  @Matches(/^\d+(\.\d{1,4})?$/, {
    message: 'quantity must be a positive decimal',
  })
  quantity!: string;
  @Matches(/^\d+(\.\d{1,4})?$/, { message: 'unitPrice must be a decimal' })
  unitPrice!: string;
  @IsArray() @IsUUID('all', { each: true }) taxCodeIds!: string[];
}

export class CreatePurchaseBillDto {
  @IsUUID() partnerId!: string;
  @IsOptional() @IsString() @MaxLength(64) vendorInvoiceNo?: string;
  @IsDateString() date!: string;
  @IsOptional() @IsDateString() dueDate?: string;
  @IsOptional() @IsString() @MaxLength(255) description?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PurchaseBillLineDto)
  lines!: PurchaseBillLineDto[];
}
