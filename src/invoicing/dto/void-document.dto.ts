import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, Matches } from 'class-validator';

/** Optional body for `POST /…/:id/void` (sales invoice, purchase bill, payment). */
export class VoidDocumentDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date',
    example: '2026-02-10',
    description:
      'Void (reversal) date, YYYY-MM-DD. Defaults to the document date. Must be ' +
      'on/after the document date and fall in an OPEN period of a non-closed ' +
      'fiscal year — use it to void a document whose own period is closed.',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}
