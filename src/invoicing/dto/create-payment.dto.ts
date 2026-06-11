import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class AllocationDto {
  @IsOptional() @IsUUID() salesInvoiceId?: string;
  @IsOptional() @IsUUID() purchaseBillId?: string;
  @Matches(/^\d+(\.\d{1,4})?$/, {
    message: 'amount must be a positive decimal',
  })
  amount!: string;
}

export class CreatePaymentDto {
  @IsIn(['RECEIPT', 'DISBURSEMENT']) direction!: 'RECEIPT' | 'DISBURSEMENT';
  @IsUUID() partnerId!: string;
  @IsDateString() date!: string;
  @IsUUID() cashAccountId!: string;
  @IsOptional() @IsString() @MaxLength(255) description?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AllocationDto)
  allocations!: AllocationDto[];
}
