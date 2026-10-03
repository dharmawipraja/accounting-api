// src/invoicing/dto/payment-response.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiMoney } from '../../common/openapi/api-money.decorator';
import { PaginatedDto } from '../../common/openapi/paginated-dto';

export class PaymentAllocationResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) paymentId!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) salesInvoiceId!:
    | string
    | null;
  @ApiProperty({ format: 'uuid', nullable: true }) purchaseBillId!:
    | string
    | null;
  @ApiMoney() amount!: string;
}

/** An application of unapplied credit — a payment's advance, or a sales
 *  credit note's / purchase debit note's excess (exactly one source id is set). */
export class PaymentApplicationResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description: 'Set when the applied credit is a payment advance.',
  })
  paymentId!: string | null;
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description: "Set when the applied credit is a sales credit note's excess.",
  })
  salesCreditNoteId!: string | null;
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description:
      "Set when the applied credit is a purchase debit note's excess.",
  })
  purchaseDebitNoteId!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true }) salesInvoiceId!:
    | string
    | null;
  @ApiProperty({ format: 'uuid', nullable: true }) purchaseBillId!:
    | string
    | null;
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description:
      'Set on a refund (the CASH-role account the credit was paid back through); null on an application.',
  })
  cashAccountId!: string | null;
  @ApiMoney() amount!: string;
  @ApiProperty({ type: String, format: 'date', example: '2026-03-01' })
  date!: string;
  @ApiProperty({ format: 'uuid' }) journalEntryId!: string;
  @ApiProperty({ format: 'uuid' }) createdBy!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    description: 'Reversal date; set iff the application was reversed.',
  })
  reversedOn!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true }) reversedBy!: string | null;
}

export class PaymentResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true }) number!: number | null;
  @ApiProperty({ nullable: true }) ref!: string | null;
  @ApiProperty({ nullable: true }) fiscalYear!: number | null;
  @ApiProperty({ enum: ['RECEIPT', 'DISBURSEMENT'] }) direction!: string;
  @ApiProperty({ format: 'uuid' }) partnerId!: string;
  @ApiProperty({ type: String, format: 'date', example: '2026-01-15' })
  date!: string;
  @ApiProperty({
    format: 'uuid',
    description:
      'Cash/bank account; for an `opening` credit, the Saldo Awal (OPENING_BALANCE_EQUITY) account.',
  })
  cashAccountId!: string;
  @ApiProperty({
    description:
      'Opening (go-live) customer deposit / vendor prepayment: booked against Saldo Awal, no cash moved.',
  })
  opening!: boolean;
  @ApiMoney() amount!: string;
  @ApiMoney({
    description:
      'Part of `amount` not (yet) settling a document — held on the customer/vendor advance account until applied or refunded. amount − allocations − live applications − live refunds; 0 once VOID.',
  })
  unappliedAmount!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: ['DRAFT', 'POSTED', 'VOID'] }) status!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) journalEntryId!:
    | string
    | null;
  @ApiProperty({ format: 'uuid' }) createdBy!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) postedBy!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true }) postedAt!:
    | string
    | null;
  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    description: 'Void (reversal) date; set iff status is VOID.',
  })
  voidedOn!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiPropertyOptional({ type: [PaymentAllocationResponseDto] })
  allocations?: PaymentAllocationResponseDto[];
  @ApiPropertyOptional({ type: [PaymentApplicationResponseDto] })
  applications?: PaymentApplicationResponseDto[];
  @ApiPropertyOptional({
    type: [PaymentApplicationResponseDto],
    description: 'Cash refunds of the unapplied amount (cashAccountId set).',
  })
  refunds?: PaymentApplicationResponseDto[];
}

export const PaymentListResponseDto = PaginatedDto(
  PaymentResponseDto,
  'PaymentListResponseDto',
  { totalExample: 310 },
);
