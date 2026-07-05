import { Injectable } from '@nestjs/common';
import { TaxService } from '../tax/tax.service';
import { PostingService } from '../ledger/posting/posting.service';
import {
  toPreview,
  JournalPreview,
  PreviewSourceLine,
} from './journal-preview.projection';
import { PreviewJournalEntryDto } from './dto/preview-journal-entry.dto';

@Injectable()
export class JournalPreviewService {
  constructor(
    private readonly tax: TaxService,
    private readonly posting: PostingService,
  ) {}

  async preview(dto: PreviewJournalEntryDto): Promise<JournalPreview> {
    const lines = await this.taxedLines(dto);
    const accounts = await this.posting.resolvePostableAccounts(
      lines.map((l) => l.accountId),
    );
    return toPreview(lines, accounts);
  }

  /** SALE/PURCHASE: reuse TaxService.calculate — the exact derivation the post path uses. */
  private async taxedLines(
    dto: PreviewJournalEntryDto,
  ): Promise<PreviewSourceLine[]> {
    const calc = await this.tax.calculate({
      nature: dto.nature,
      settlementAccountId: dto.settlementAccountId,
      lines: dto.lines.map((l) => ({
        accountId: l.accountId,
        amount: l.amount,
        taxCodeIds: l.taxCodeIds,
      })),
    });
    return calc.journalLines;
  }
}
