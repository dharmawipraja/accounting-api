import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { IsMoneyString } from '../../common/validators/is-money-string';
import { MAX_LINE_ITEMS } from '../../common/dto/limits';

export class AllocationDto {
  @IsOptional() @IsUUID() salesInvoiceId?: string;
  @IsOptional() @IsUUID() purchaseBillId?: string;
  @IsMoneyString() amount!: string;
}

export class CreatePaymentDto {
  @IsIn(['RECEIPT', 'DISBURSEMENT']) direction!: 'RECEIPT' | 'DISBURSEMENT';
  @IsUUID() partnerId!: string;
  @IsDateString() date!: string;
  @IsUUID() cashAccountId!: string;
  @IsOptional() @IsString() @MaxLength(255) description?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LINE_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => AllocationDto)
  allocations!: AllocationDto[];
}
