// src/ledger/journal/dto/journal-response.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { ApiMoney } from '../../../common/openapi/api-money.decorator';

const SOURCE_TYPES = [
  'MANUAL',
  'OPENING',
  'REVERSAL',
  'SALES_INVOICE',
  'PURCHASE_BILL',
  'PAYMENT',
  'CLOSING',
];
const STATUSES = ['DRAFT', 'POSTED', 'REVERSED'];

export class JournalLineResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) journalEntryId!: string;
  @ApiProperty({ example: 1 }) lineNo!: number;
  @ApiProperty({ format: 'uuid' }) accountId!: string;
  @ApiMoney() debit!: string;
  @ApiMoney() credit!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class JournalEntryResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true, example: 42 }) entryNumber!: number | null;
  @ApiProperty({ nullable: true, example: 'JE-2026-42' }) entryRef!:
    | string
    | null;
  @ApiProperty({ nullable: true, example: 2026 }) fiscalYear!: number | null;
  @ApiProperty({ type: String, format: 'date', example: '2026-01-15' })
  date!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) periodId!: string | null;
  @ApiProperty() description!: string;
  @ApiProperty({ enum: SOURCE_TYPES }) sourceType!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) sourceId!: string | null;
  @ApiProperty({ enum: STATUSES }) status!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) reversalOfId!: string | null;
  @ApiProperty({ format: 'uuid', nullable: true }) reversedById!: string | null;
  @ApiProperty({ format: 'uuid' }) createdBy!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) postedBy!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true }) postedAt!:
    | string
    | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty({ type: [JournalLineResponseDto] })
  lines!: JournalLineResponseDto[];
}

export class JournalEntryListItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true }) entryRef!: string | null;
  @ApiProperty({ nullable: true }) entryNumber!: number | null;
  @ApiProperty({ nullable: true }) fiscalYear!: number | null;
  @ApiProperty({ type: String, format: 'date', example: '2026-01-15' })
  date!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ enum: STATUSES }) status!: string;
  @ApiProperty({ enum: SOURCE_TYPES }) sourceType!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) sourceId!: string | null;
  @ApiMoney() totalDebit!: string;
  @ApiProperty({ example: 2 }) lineCount!: number;
}

export class JournalEntryListResponseDto {
  @ApiProperty({ type: [JournalEntryListItemDto] })
  data!: JournalEntryListItemDto[];
  @ApiProperty({ example: 137 }) total!: number;
  @ApiProperty({ example: 50 }) limit!: number;
  @ApiProperty({ example: 0 }) offset!: number;
}
