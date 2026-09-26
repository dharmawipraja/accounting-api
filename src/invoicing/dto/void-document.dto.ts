import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, Matches } from 'class-validator';

/** Optional body for `POST /…/:id/void` (sales invoice, purchase bill, payment). */
export class VoidDocumentDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date',
    example: '2026-02-10',
    description:
      'Void (reversal) date, YYYY-MM-DD. Defaults to the document date. Must ' +
      'satisfy originalDate ≤ date ≤ max(today WIB, originalDate) — a ' +
      'future-dated document may be voided on its own date (422 ' +
      '{ date, today[, originalDate] }; originalDate is present when it, not ' +
      'today, is the ceiling) — and fall in an OPEN period of a non-closed ' +
      'fiscal year; use it to void a document whose own period is closed.',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}
