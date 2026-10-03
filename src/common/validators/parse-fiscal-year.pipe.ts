import { BadRequestException, PipeTransform } from '@nestjs/common';
import { FISCAL_YEAR_MAX, FISCAL_YEAR_MIN } from '../dto/limits';

/** Path/query fiscal year: an integer in [FISCAL_YEAR_MIN, FISCAL_YEAR_MAX],
 *  else 400 — the same bounds the body DTOs enforce. */
export class ParseFiscalYearPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    const year = /^\d{4}$/.test(value) ? Number(value) : NaN;
    if (year >= FISCAL_YEAR_MIN && year <= FISCAL_YEAR_MAX) return year;
    throw new BadRequestException(
      `fiscalYear must be an integer from ${FISCAL_YEAR_MIN} to ${FISCAL_YEAR_MAX}`,
    );
  }
}
