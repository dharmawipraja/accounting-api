import { IsBusinessDate } from '../../common/validators/is-business-date';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsMoneyString } from '../../common/validators/is-money-string';
import { MAX_LINE_ITEMS } from '../../common/dto/limits';
import { businessDate } from '../../common/dates/business-date';
import type { CreditRefundInput } from '../credit-application';

export class AllocationDto {
  @IsOptional() @IsUUID() salesInvoiceId?: string;
  @IsOptional() @IsUUID() purchaseBillId?: string;
  @IsMoneyString() amount!: string;
}

export class CreatePaymentDto {
  @IsIn(['RECEIPT', 'DISBURSEMENT']) direction!: 'RECEIPT' | 'DISBURSEMENT';
  @IsUUID() partnerId!: string;
  @IsDateString() @IsBusinessDate() date!: string;
  /** CASH-role account the money moves through. Required, except for an
   *  `opening` credit (which must omit it). */
  @ValidateIf(
    (o: CreatePaymentDto) => !o.opening || o.cashAccountId !== undefined,
  )
  @IsUUID()
  cashAccountId?: string;
  /** Go-live customer deposit / vendor prepayment (opening credit): no cash
   *  moves — the journal is Dr Saldo Awal / Cr Uang Muka Pelanggan (RECEIPT)
   *  or Dr Uang Muka Pembelian / Cr Saldo Awal (DISBURSEMENT). Requires
   *  `amount`, no `cashAccountId`, no `allocations`; the whole amount becomes
   *  `unappliedAmount`, applied or refunded after posting. */
  @IsOptional() @IsBoolean() opening?: boolean;
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

/** POST /payments/:id/refunds (and the note equivalents) — pay unapplied
 *  credit back in cash. */
export class RefundCreditDto {
  /** Refund date: on/after the holder's date, not after today (WIB), in an
   *  open period of an open fiscal year. */
  @IsDateString()
  @IsBusinessDate()
  date!: string;
  /** Positive; at most the holder's `unappliedAmount`. */
  @IsMoneyString() amount!: string;
  /** CASH-role (cash/bank) account the refund moves through. */
  @IsUUID() cashAccountId!: string;
  @IsOptional() @IsString() @MaxLength(255) description?: string;
}

/** RefundCreditDto → the service input (business date parsed). */
export function refundInput(dto: RefundCreditDto): CreditRefundInput {
  return {
    date: businessDate(dto.date),
    amount: dto.amount,
    cashAccountId: dto.cashAccountId,
    description: dto.description,
  };
}
