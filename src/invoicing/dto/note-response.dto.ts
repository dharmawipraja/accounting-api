// src/invoicing/dto/note-response.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApiMoney } from '../../common/openapi/api-money.decorator';
import { PaginatedDto } from '../../common/openapi/paginated-dto';
import {
  DISCOUNT_AMOUNT_DOC,
  DISCOUNT_PERCENT_DOC,
  LINE_AMOUNT_DOC,
} from './transactional-document-response.dto';
import { PaymentApplicationResponseDto } from './payment-response.dto';

class NoteLineResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) noteId!: string;
  @ApiProperty({ example: 1 }) lineNo!: number;
  @ApiProperty({ format: 'uuid', description: 'The returned original line.' })
  originalLineId!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ format: 'uuid' }) accountId!: string;
  @ApiMoney({ description: 'Returned quantity, 4 dp string' })
  quantity!: string;
  @ApiMoney() unitPrice!: string;
  @ApiMoney(DISCOUNT_PERCENT_DOC) discountPercent!: string | null;
  @ApiMoney({
    ...DISCOUNT_AMOUNT_DOC,
    description:
      'Resolved discount: the original percent on the returned gross, or the original fixed amount pro-rated by quantity (rounded once to 4 dp half-up).',
  })
  discountAmount!: string;
  @ApiMoney(LINE_AMOUNT_DOC) amount!: string;
  @ApiProperty({ type: [String], format: 'uuid' }) taxCodeIds!: string[];
}

/** A sales credit note (CN/…) or purchase debit note (DN/…). */
export class NoteResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true, example: 1 }) number!: number | null;
  @ApiProperty({ nullable: true, example: 'CN/2026/000001' }) ref!:
    | string
    | null;
  @ApiProperty({ nullable: true }) fiscalYear!: number | null;
  @ApiProperty({ format: 'uuid' }) partnerId!: string;
  @ApiProperty({
    format: 'uuid',
    description: 'The sales invoice / purchase bill this note returns part of.',
  })
  originalId!: string;
  @ApiProperty({ type: String, format: 'date', example: '2026-01-20' })
  date!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ enum: ['DRAFT', 'POSTED', 'VOID'] }) status!: string;
  @ApiProperty({
    nullable: true,
    description: 'Coretax retur reference number (PATCH …/retur-reference).',
  })
  returNumber!: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  returDate!: string | null;
  @ApiMoney() subtotal!: string;
  @ApiMoney() discountTotal!: string;
  @ApiMoney() taxTotal!: string;
  @ApiMoney() withholdingTotal!: string;
  @ApiMoney({ description: 'Settlement amount (subtotal + PPN − PPh).' })
  total!: string;
  @ApiMoney({
    description:
      'Part of total that settled the original (its creditedTotal); fixed at post, 0 for a draft. Kept on a VOID note (its credit then ended on voidedOn).',
  })
  creditedAmount!: string;
  @ApiMoney({
    description:
      'Partner credit not yet applied: total − creditedAmount − live applications − live refunds, held on the customer/vendor advance account; apply it via POST /…/:id/apply or refund it via POST /…/:id/refunds. 0 once VOID.',
  })
  unappliedAmount!: string;
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
  @ApiPropertyOptional({ type: [NoteLineResponseDto] })
  lines?: NoteLineResponseDto[];
  @ApiPropertyOptional({ type: [PaymentApplicationResponseDto] })
  applications?: PaymentApplicationResponseDto[];
  @ApiPropertyOptional({
    type: [PaymentApplicationResponseDto],
    description: 'Cash refunds of the unapplied excess (cashAccountId set).',
  })
  refunds?: PaymentApplicationResponseDto[];
}

export const NoteListResponseDto = PaginatedDto(
  NoteResponseDto,
  'NoteListResponseDto',
);
