import { IsBusinessDate } from '../../common/validators/is-business-date';
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
  @IsDateString() @IsBusinessDate() date!: string;
  @IsUUID() cashAccountId!: string;
  @IsOptional() @IsString() @MaxLength(255) description?: string;
  /** Total amount. Defaults to the allocation sum; any excess over the
   *  allocations is posted to the customer/vendor advance account
   *  (`unappliedAmount`) and can be applied later via POST /payments/:id/apply. */
  @IsOptional()
  @IsMoneyString()
  amount?: string;
  /** Documents this payment settles now. May be empty/omitted when `amount`
   *  is given (a pure advance). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LINE_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => AllocationDto)
  allocations?: AllocationDto[];
}

/** POST /payments/:id/apply — move unapplied (advance) amount onto documents. */
export class ApplyPaymentDto {
  /** Application date: on/after the payment date and every document date,
   *  in an open period of an open fiscal year. */
  @IsDateString()
  @IsBusinessDate()
  date!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LINE_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => AllocationDto)
  allocations!: AllocationDto[];
}
