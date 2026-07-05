import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { TaxService } from '../tax/tax.service';
import { PostingService } from '../ledger/posting/posting.service';
import { ValidationFailedError } from '../common/errors/domain-errors';
import { Money } from '../common/money/money';
import { findControlAccountId } from './document-helpers';
import { PAYMENT_TARGETS, buildPaymentLines, AllocationInput } from './payment-targets';
import { toPreview, JournalPreview, PreviewSourceLine } from './journal-preview.projection';
import { PreviewJournalEntryDto } from './dto/preview-journal-entry.dto';

@Injectable()
export class JournalPreviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tax: TaxService,
    private readonly posting: PostingService,
  ) {}

  async preview(dto: PreviewJournalEntryDto): Promise<JournalPreview> {
    const lines =
      dto.nature === 'PAYMENT' ? await this.paymentLines(dto) : await this.taxedLines(dto);
    const accounts = await this.posting.resolvePostableAccounts(lines.map((l) => l.accountId));
    return toPreview(lines, accounts);
  }

  /** SALE/PURCHASE: reuse TaxService.calculate — the exact derivation the post path uses. */
  private async taxedLines(dto: PreviewJournalEntryDto): Promise<PreviewSourceLine[]> {
    const calc = await this.tax.calculate({
      nature: dto.nature as 'SALE' | 'PURCHASE',
      settlementAccountId: dto.settlementAccountId!,
      lines: dto.lines!.map((l) => ({
        accountId: l.accountId,
        amount: l.amount,
        taxCodeIds: l.taxCodeIds,
      })),
    });
    return calc.journalLines;
  }

  /** PAYMENT: reuse buildPaymentLines + control-account-by-role — the exact
   *  derivation PaymentsService.post uses. The many allocations collapse into the
   *  single 2-line cash<->control entry for their total, exactly as posting does. */
  private async paymentLines(dto: PreviewJournalEntryDto): Promise<PreviewSourceLine[]> {
    const target = PAYMENT_TARGETS[dto.direction!];
    let total = Money.zero();
    for (const a of dto.allocations! as AllocationInput[]) {
      // Same allocation type-shape check as loadTarget (no DB read needed for the JE shape).
      if (!target.allocId(a) || target.otherId(a))
        throw new ValidationFailedError(
          `A ${dto.direction!.toLowerCase()} allocation must reference a ${target.label}`,
          {},
        );
      const amt = Money.of(a.amount);
      if (amt.isZero() || amt.isNegative())
        throw new ValidationFailedError('Allocation amount must be positive', {});
      total = total.add(amt);
    }
    const controlId = await findControlAccountId(this.prisma, target.controlRole);
    return buildPaymentLines(target, dto.cashAccountId!, controlId, total.toPersistence());
  }
}
