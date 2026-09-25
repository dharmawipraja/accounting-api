import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, Matches } from 'class-validator';

/** Optional body for `POST /ledger/journal-entries/:id/reverse`. */
export class ReverseJournalEntryDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date',
    example: '2026-02-10',
    description:
      'Reversal date, YYYY-MM-DD. Defaults to the original entry date. Must be ' +
      'on/after the original date and fall in an OPEN period of a non-closed ' +
      'fiscal year.',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}
