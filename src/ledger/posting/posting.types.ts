import { JournalSourceType } from '@prisma/client';

export interface PostLineInput {
  accountId: string;
  /** decimal strings; exactly one of debit/credit is > 0 */
  debit?: string;
  credit?: string;
  description?: string;
}

export interface PostEntryInput {
  date: Date;
  description: string;
  sourceType: JournalSourceType;
  sourceId?: string;
  createdBy: string;
  lines: PostLineInput[];
}
