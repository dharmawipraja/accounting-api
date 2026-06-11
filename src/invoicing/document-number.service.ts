import { Injectable } from '@nestjs/common';

/** The raw-SQL subset of an interactive-tx client (same shape PostingService uses). */
type RawTx = {
  $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<number>;
  $queryRaw: <T = unknown>(
    q: TemplateStringsArray,
    ...v: unknown[]
  ) => Promise<T>;
};

@Injectable()
export class DocumentNumberService {
  /** Lock-and-increment the per-(type, fiscal-year) counter inside the caller's
   *  transaction. Gapless because the increment and the document write share the tx. */
  async next(
    tx: RawTx,
    documentType: string,
    fiscalYear: number,
  ): Promise<number> {
    await tx.$executeRaw`INSERT INTO document_sequences (document_type, fiscal_year, next_number, updated_at)
      VALUES (${documentType}, ${fiscalYear}, 1, now()) ON CONFLICT (document_type, fiscal_year) DO NOTHING`;
    const rows = await tx.$queryRaw<{ next_number: number }[]>`
      SELECT next_number FROM document_sequences
      WHERE document_type = ${documentType} AND fiscal_year = ${fiscalYear} FOR UPDATE`;
    const current = rows[0].next_number;
    await tx.$executeRaw`UPDATE document_sequences SET next_number = ${current + 1}, updated_at = now()
      WHERE document_type = ${documentType} AND fiscal_year = ${fiscalYear}`;
    return current;
  }

  /** e.g. INV/2026/000042 */
  buildRef(prefix: string, fiscalYear: number, number: number): string {
    return `${prefix}/${fiscalYear}/${String(number).padStart(6, '0')}`;
  }
}
