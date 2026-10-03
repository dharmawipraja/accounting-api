import { Injectable } from '@nestjs/common';
import { TaxKind } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ExtendedPrismaClient } from '../common/prisma/soft-delete.extension';
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
  /** Credit/debit notes only: an INACTIVE (not deleted) code is accepted —
   *  a note returns the original's codes even after a rate change retired
   *  them. Kind/nature/PKP rules still apply. */
  allowInactiveCodes?: boolean;
  /** Credit/debit notes only: replaces the rupiah-rounded amount of the codes
   *  it returns a value for (see noteTaxAmounts), BEFORE the journal and
   *  totals are built — so the entry stays balanced. Must be ≥ 0. */
  overrideAmounts?: (raw: readonly TaxBreakdownRow[]) => Record<string, string>;
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
}

export interface TaxCalculation {
  subtotal: string;
  taxes: TaxBreakdownRow[];
  settlementAmount: string;
  journalLines: CalculatedLine[];
  /** PPN (value-added) bucket total — the document's `taxTotal`. */
  taxTotal: string;
  /** PPh (withholding) bucket total — the document's `withholdingTotal`. */
  withholdingTotal: string;
}

const ALLOWED_KINDS: Record<TaxNature, TaxKind[]> = {
  SALE: ['PPN_OUTPUT', 'PPH_PREPAID'],
  PURCHASE: ['PPN_INPUT', 'PPH_PAYABLE'],
};

const taxBucket = (kind: TaxKind): 'PPN' | 'PPH' =>
  kind === 'PPN_OUTPUT' || kind === 'PPN_INPUT' ? 'PPN' : 'PPH';

/** DPP per tax code: the sum of the amounts of the lines that carry it.
 *  Each code's tax is then base × rate rounded ONCE to whole rupiah. */
export function taxBases(
  lines: readonly { amount: string; taxCodeIds: readonly string[] }[],
): Map<string, Money> {
  const baseByCode = new Map<string, Money>();
  for (const line of lines)
    for (const id of line.taxCodeIds)
      baseByCode.set(
        id,
        (baseByCode.get(id) ?? Money.zero()).add(Money.of(line.amount)),
      );
  return baseByCode;
}

@Injectable()
export class TaxService {
  constructor(private readonly prisma: PrismaService) {}

  /** `db` lets a caller run the tax-code read inside its own transaction (e.g.
   *  a draft edit under the document row lock) instead of taking a second pool
   *  connection; defaults to the shared client. */
  async calculate(
    input: TaxableTransaction,
    db: Pick<ExtendedPrismaClient, 'taxCode' | 'companySettings'> = this.prisma
      .client,
  ): Promise<TaxCalculation> {
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
    // `deletedAt: null` is explicit (not left to the soft-delete extension)
    // because `db` may be any caller-supplied client/tx: a tombstoned code
    // must read as unknown whatever connection the lookup runs on.
    const codes = await db.taxCode.findMany({
      where: { id: { in: ids }, deletedAt: null },
    });
    const byId = new Map(codes.map((c) => [c.id, c]));

    for (const id of ids) {
      const c = byId.get(id);
      if (!c) {
        throw new ValidationFailedError('Unknown tax code', { taxCodeId: id });
      }
      if (!c.isActive && !input.allowInactiveCodes) {
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

    // At most one PPN and one PPh code per line: two codes of the same bucket
    // (PPh 23 + PPh 4(2), or two PPN rates) tax the same DPP twice.
    for (const line of input.lines) {
      const buckets = line.taxCodeIds.map((id) =>
        taxBucket(byId.get(id)!.kind),
      );
      if (new Set(buckets).size !== buckets.length) {
        throw new ValidationFailedError(
          'A line may carry at most one PPN code and one PPh code',
          { accountId: line.accountId, taxCodeIds: line.taxCodeIds },
        );
      }
    }

    // Only a PKP (VAT-registered) company may charge PPN Output or credit PPN
    // Input. Checked here so every document path — create, update, post,
    // preview, /tax/calculate — enforces it identically. (The kind filter
    // above already ties PPN_OUTPUT to SALE and PPN_INPUT to PURCHASE.)
    // Settings are read only when it matters.
    const ppn = [...byId.values()].find(
      (c) => c.kind === 'PPN_OUTPUT' || c.kind === 'PPN_INPUT',
    );
    if (ppn) {
      // Through `db` so an in-tx caller reads settings on its own connection.
      const settings = await db.companySettings.findFirst({
        select: { isPkp: true },
      });
      if (settings && !settings.isPkp)
        throw new ValidationFailedError(
          ppn.kind === 'PPN_OUTPUT'
            ? 'PPN Output can only be charged by a PKP company (companySettings.isPkp is false)'
            : 'PPN Input can only be credited by a PKP company (companySettings.isPkp is false)',
          { taxCodeId: ppn.id, kind: ppn.kind },
        );
    }

    // Subtotal: sum of all base line amounts (tax-exclusive).
    const subtotal = Money.sum(input.lines.map((l) => Money.of(l.amount)));

    // Compute tax amounts: round each code's total ONCE to whole rupiah.
    const taxes: TaxBreakdownRow[] = [...taxBases(input.lines).entries()]
      .map(([id, base]) => {
        const c = byId.get(id)!;
        // Exact base × rate, rounded once (no intermediate 4dp rounding).
        const amount = base.multiplyToRupiah(c.rate);
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
    if (input.overrideAmounts) {
      const over = input.overrideAmounts(taxes);
      for (const t of taxes) {
        const v = over[t.taxCodeId];
        if (v === undefined) continue;
        if (Money.of(v).isNegative())
          throw new Error(`Negative tax override for ${t.taxCodeId}`);
        t.amount = Money.of(v).toPersistence();
      }
    }

    // Build journal lines.
    const journalLines: CalculatedLine[] = [];

    // Base lines: SALE → credit revenue; PURCHASE → debit expense. A zero
    // amount (a free item) is part of the document but carries no ledger
    // effect, so it gets no journal line (a 0/0 line is invalid double entry).
    for (const line of input.lines) {
      if (Money.of(line.amount).isZero()) continue;
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
      const amt = Money.of(t.amount);
      // A code whose DPP is only free items rounds to 0: breakdown row, no JE line.
      if (amt.isZero()) continue;
      // PPN_INPUT and PPH_PREPAID go on the debit side; OUTPUT/PAYABLE on credit.
      const isDebit = t.kind === 'PPN_INPUT' || t.kind === 'PPH_PREPAID';
      journalLines.push(
        isDebit
          ? { accountId: t.accountId, debit: t.amount }
          : { accountId: t.accountId, credit: t.amount },
      );
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
    if (subtotal.isZero()) {
      // Every line is free: there is nothing to post (and the settlement
      // side would be a zero line). Rejected on create/update/post/preview.
      throw new ValidationFailedError(
        'Document total must be greater than zero',
        { subtotal: subtotal.toPersistence() },
      );
    }
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
      taxTotal: ppnTotal.toPersistence(),
      withholdingTotal: pphTotal.toPersistence(),
    };
  }
}
