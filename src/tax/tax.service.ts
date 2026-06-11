import { Injectable } from '@nestjs/common';
import { TaxKind } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { Money } from '../common/money/money';
import { ValidationFailedError } from '../common/errors/domain-errors';

export type TaxNature = 'SALE' | 'PURCHASE';

export interface TaxableLineInput {
  accountId: string;
  amount: string;
  taxCodeIds: string[];
}

export interface TaxableTransaction {
  nature: TaxNature;
  settlementAccountId: string;
  lines: TaxableLineInput[];
}

export interface TaxBreakdownRow {
  taxCodeId: string;
  code: string;
  kind: TaxKind;
  base: string;
  amount: string;
  accountId: string;
}

export interface CalculatedLine {
  accountId: string;
  debit?: string;
  credit?: string;
  description?: string;
}

export interface TaxCalculation {
  subtotal: string;
  taxes: TaxBreakdownRow[];
  settlementAmount: string;
  journalLines: CalculatedLine[];
}

const ALLOWED_KINDS: Record<TaxNature, TaxKind[]> = {
  SALE: ['PPN_OUTPUT', 'PPH_PREPAID'],
  PURCHASE: ['PPN_INPUT', 'PPH_PAYABLE'],
};

@Injectable()
export class TaxService {
  constructor(private readonly prisma: PrismaService) {}

  async calculate(input: TaxableTransaction): Promise<TaxCalculation> {
    if (input.lines.length === 0) {
      throw new ValidationFailedError(
        'A taxable transaction needs at least one line',
      );
    }

    // A code may appear at most once per line — a duplicate would double-count
    // that line's DPP and silently inflate the tax (reject rather than swallow).
    for (const line of input.lines) {
      if (new Set(line.taxCodeIds).size !== line.taxCodeIds.length) {
        throw new ValidationFailedError(
          'A tax code may not be repeated within a single line',
          { accountId: line.accountId },
        );
      }
    }

    const ids = [...new Set(input.lines.flatMap((l) => l.taxCodeIds))];
    const codes = await this.prisma.client.taxCode.findMany({
      where: { id: { in: ids } },
    });
    const byId = new Map(codes.map((c) => [c.id, c]));

    for (const id of ids) {
      const c = byId.get(id);
      if (!c) {
        throw new ValidationFailedError('Unknown tax code', { taxCodeId: id });
      }
      if (!c.isActive) {
        throw new ValidationFailedError('Tax code is inactive', {
          taxCodeId: id,
        });
      }
    }

    const allowed = ALLOWED_KINDS[input.nature];
    for (const c of byId.values()) {
      if (!allowed.includes(c.kind)) {
        throw new ValidationFailedError(
          `Tax kind ${c.kind} is not allowed for a ${input.nature}`,
          { taxCodeId: c.id, kind: c.kind, nature: input.nature },
        );
      }
    }

    // Subtotal: sum of all base line amounts (tax-exclusive).
    const subtotal = Money.sum(input.lines.map((l) => Money.of(l.amount)));

    // Aggregate DPP per tax code across all lines that carry it.
    const baseByCode = new Map<string, Money>();
    for (const line of input.lines) {
      for (const id of line.taxCodeIds) {
        baseByCode.set(
          id,
          (baseByCode.get(id) ?? Money.zero()).add(Money.of(line.amount)),
        );
      }
    }

    // Compute tax amounts: round each code's total ONCE to whole rupiah.
    const taxes: TaxBreakdownRow[] = [...baseByCode.entries()]
      .map(([id, base]) => {
        const c = byId.get(id)!;
        const amount = base.multiply(c.rate).roundToRupiah();
        return {
          taxCodeId: id,
          code: c.code,
          kind: c.kind,
          base: base.toPersistence(),
          amount: amount.toPersistence(),
          accountId: c.taxAccountId,
        };
      })
      .sort((a, b) => a.code.localeCompare(b.code));

    // Build journal lines.
    const journalLines: CalculatedLine[] = [];

    // Base lines: SALE → credit revenue; PURCHASE → debit expense.
    for (const line of input.lines) {
      const amt = Money.of(line.amount).toPersistence();
      journalLines.push(
        input.nature === 'SALE'
          ? { accountId: line.accountId, credit: amt }
          : { accountId: line.accountId, debit: amt },
      );
    }

    // Tax lines and settlement totals.
    let ppnTotal = Money.zero();
    let pphTotal = Money.zero();

    for (const t of taxes) {
      // PPN_INPUT and PPH_PREPAID go on the debit side; OUTPUT/PAYABLE on credit.
      const isDebit = t.kind === 'PPN_INPUT' || t.kind === 'PPH_PREPAID';
      journalLines.push(
        isDebit
          ? { accountId: t.accountId, debit: t.amount }
          : { accountId: t.accountId, credit: t.amount },
      );
      const amt = Money.of(t.amount);
      if (t.kind === 'PPN_OUTPUT' || t.kind === 'PPN_INPUT') {
        ppnTotal = ppnTotal.add(amt);
      } else {
        pphTotal = pphTotal.add(amt);
      }
    }

    // Settlement = subtotal + PPN − PPh. Withholding that meets or exceeds the
    // gross would yield a zero/negative settlement line — structurally invalid
    // (the ledger's one-sided CHECK requires a positive amount). Reject at the
    // preview boundary with a clean 422 rather than letting Phase 4 hit a 500.
    const settlement = subtotal.add(ppnTotal).subtract(pphTotal);
    if (settlement.isZero() || settlement.isNegative()) {
      throw new ValidationFailedError(
        'Total withholding leaves a non-positive settlement amount',
        {
          subtotal: subtotal.toPersistence(),
          totalWithheld: pphTotal.toPersistence(),
        },
      );
    }
    journalLines.push(
      input.nature === 'SALE'
        ? {
            accountId: input.settlementAccountId,
            debit: settlement.toPersistence(),
          }
        : {
            accountId: input.settlementAccountId,
            credit: settlement.toPersistence(),
          },
    );

    // Safety-net balance assertion.
    const totalDebit = Money.sum(
      journalLines.map((l) => Money.of(l.debit ?? '0')),
    );
    const totalCredit = Money.sum(
      journalLines.map((l) => Money.of(l.credit ?? '0')),
    );
    if (!totalDebit.equals(totalCredit)) {
      throw new Error(
        `Tax calculation did not balance: ${totalDebit.toString()} != ${totalCredit.toString()}`,
      );
    }

    return {
      subtotal: subtotal.toPersistence(),
      taxes,
      settlementAmount: settlement.toPersistence(),
      journalLines,
    };
  }
}
