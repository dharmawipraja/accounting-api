import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsIn, IsUUID } from 'class-validator';
import { ApiMoney } from '../../common/openapi/api-money.decorator';
import { IsBusinessDate } from '../../common/validators/is-business-date';
import { ExportFormatField, type ExportFormat } from '../export/render';

export class PartnerStatementQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  partnerId!: string;
  @ApiProperty({
    enum: ['customer', 'vendor'],
    description:
      'customer = kartu piutang (sales invoices, receipts, credit notes); vendor = kartu hutang (purchase bills, disbursements, debit notes).',
  })
  @IsIn(['customer', 'vendor'])
  side!: 'customer' | 'vendor';
  @IsDateString() @IsBusinessDate() from!: string;
  @IsDateString() @IsBusinessDate() to!: string;
  @ExportFormatField() format?: ExportFormat;
}

export const STATEMENT_LINE_TYPES = [
  'INVOICE',
  'INVOICE_VOID',
  'BILL',
  'BILL_VOID',
  'PAYMENT',
  'PAYMENT_VOID',
  'OPENING_CREDIT',
  'OPENING_CREDIT_VOID',
  'CREDIT_NOTE',
  'CREDIT_NOTE_VOID',
  'DEBIT_NOTE',
  'DEBIT_NOTE_VOID',
  'CREDIT_APPLICATION',
  'CREDIT_APPLICATION_REVERSAL',
  'REFUND',
  'REFUND_REVERSAL',
] as const;

export class PartnerStatementPartnerDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'C-001' }) code!: string;
  @ApiProperty() name!: string;
}

export class PartnerStatementLineDto {
  @ApiProperty({ type: String, format: 'date' }) date!: string;
  @ApiProperty({
    enum: STATEMENT_LINE_TYPES,
    description:
      '*_VOID / *_REVERSAL lines reverse an earlier line, dated on the void / reversal date.',
  })
  type!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Number of the document / payment / note the line is about (for credit applications and refunds: the credit source — payment or note).',
  })
  ref!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Number of the invoice / bill the line is or settles (null for payments, opening credit and refunds).',
  })
  documentRef!: string | null;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiMoney({
    description:
      'Movement of the AR/AP balance. Customer: debit increases what the partner owes us. Vendor: credit increases what we owe them.',
  })
  debit!: string;
  @ApiMoney() credit!: string;
  @ApiMoney({ description: 'Running AR/AP (open-document) balance.' })
  balance!: string;
  @ApiMoney({
    description:
      'Signed change of the unapplied credit (advance / note excess): + adds credit, − applies or refunds it.',
  })
  unappliedCreditChange!: string;
  @ApiMoney({ description: 'Running unapplied credit.' })
  unappliedCredit!: string;
  @ApiMoney({ description: 'Running balance − unappliedCredit.' })
  netBalance!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  documentId!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  paymentId!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  noteId!: string | null;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The credit application / refund id.',
  })
  applicationId!: string | null;
}

export class PartnerStatementResponseDto {
  @ApiProperty({ type: PartnerStatementPartnerDto })
  partner!: PartnerStatementPartnerDto;
  @ApiProperty({ enum: ['customer', 'vendor'] }) side!: string;
  @ApiProperty({ type: String, format: 'date' }) from!: string;
  @ApiProperty({ type: String, format: 'date' }) to!: string;
  @ApiMoney({
    description:
      'AR/AP balance as of the day before `from` (customer: the partner owes us; vendor: we owe them).',
  })
  openingBalance!: string;
  @ApiMoney() openingUnappliedCredit!: string;
  @ApiMoney() openingNetBalance!: string;
  @ApiProperty({ type: [PartnerStatementLineDto] })
  lines!: PartnerStatementLineDto[];
  @ApiMoney() totalDebit!: string;
  @ApiMoney() totalCredit!: string;
  @ApiMoney({
    description:
      "AR/AP balance as of `to` = openingBalance + the lines' movements = the partner's AR/AP aging total as of `to`.",
  })
  closingBalance!: string;
  @ApiMoney({
    description:
      "Unapplied credit as of `to` (customer advances + credit-note excess / our vendor prepayments + debit-note excess) — the partner's share of the advance account.",
  })
  unappliedCredit!: string;
  @ApiMoney({ description: 'closingBalance − unappliedCredit.' })
  netBalance!: string;
}
