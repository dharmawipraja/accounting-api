import { Injectable } from '@nestjs/common';
import { nextSequenceNumber, SqlTx } from '../common/db/sequence';
import { buildDocRef } from '../common/db/doc-ref';

@Injectable()
export class DocumentNumberService {
  /** Lock-and-increment the per-(type, fiscal-year) counter inside the caller's
   *  transaction. Gapless because the increment and the document write share the tx. */
  next(tx: SqlTx, documentType: string, fiscalYear: number): Promise<number> {
    return nextSequenceNumber(tx, 'document_sequences', {
      document_type: documentType,
      fiscal_year: fiscalYear,
    });
  }

  /** e.g. INV/2026/000042 */
  buildRef(prefix: string, fiscalYear: number, number: number): string {
    return buildDocRef(prefix, fiscalYear, number);
  }
}
