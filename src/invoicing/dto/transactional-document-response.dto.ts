// src/invoicing/dto/transactional-document-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { ApiMoney } from '../../common/openapi/api-money.decorator';

/** Shared OpenAPI docs for the per-line discount fields of both line DTOs. */
const DISCOUNT_PERCENT_DOC = {
  nullable: true,
  example: '10.0000',
  description:
    'Discount percent as entered (4 dp string); null for a fixed or no discount.',
};
export const DISCOUNT_AMOUNT_DOC = {
  example: '0.0000',
  description:
    'Resolved line discount (4 dp string), taken off qty × unitPrice before tax.',
};
const LINE_AMOUNT_DOC = {
  description:
    'Net line amount = qty × unitPrice − discountAmount (4 dp): the tax base (DPP).',
};

/** Fields every document line response shares (invoice, bill, credit /
 *  debit note). Subclasses add their parent id and kind-specific fields, and
 *  may re-declare a field to give it a more specific description. */
export class DocumentLineResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 1 }) lineNo!: number;
  @ApiProperty() description!: string;
  @ApiProperty({ format: 'uuid' }) accountId!: string;
  @ApiMoney({ description: 'Quantity, 4 dp string' }) quantity!: string;
  @ApiMoney() unitPrice!: string;
  @ApiMoney(DISCOUNT_PERCENT_DOC) discountPercent!: string | null;
  @ApiMoney(DISCOUNT_AMOUNT_DOC) discountAmount!: string;
  @ApiMoney(LINE_AMOUNT_DOC) amount!: string;
  @ApiProperty({ type: [String], format: 'uuid' }) taxCodeIds!: string[];
}

/**
 * Shared fields between SalesInvoiceResponseDto and PurchaseBillResponseDto.
 * Each subclass adds its own document-number/ref fields and optional lines.
 */
export class TransactionalDocumentResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true }) fiscalYear!: number | null;
  @ApiProperty({ format: 'uuid' }) partnerId!: string;
  @ApiProperty({ type: String, format: 'date', example: '2026-01-15' })
  date!: string;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  dueDate!: string | null;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: ['DRAFT', 'POSTED', 'VOID'] }) status!: string;
  @ApiMoney({ description: 'Sum of the net (discounted) line amounts.' })
  subtotal!: string;
  @ApiMoney({
    example: '0.0000',
    description:
      'Sum of the lines’ discountAmount (already deducted from subtotal).',
  })
  discountTotal!: string;
  @ApiMoney() taxTotal!: string;
  @ApiMoney() withholdingTotal!: string;
  @ApiMoney() total!: string;
  @ApiMoney() amountPaid!: string;
  @ApiMoney({
    example: '0.0000',
    description:
      'Settled by POSTED sales credit notes / purchase debit notes against this document.',
  })
  creditedTotal!: string;
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
  @ApiMoney({ description: 'total − amountPaid − creditedTotal' })
  outstanding!: string;
  @ApiProperty({ enum: ['UNPAID', 'PARTIAL', 'PAID'] }) paymentStatus!: string;
}
