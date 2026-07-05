import { Money } from '../common/money/money';

/** A raw journal line as produced by the posting derivation (exactly one side set). */
export interface PreviewSourceLine {
  accountId: string;
  debit?: string;
  credit?: string;
}

/** An enriched, fully-normalized preview line (both sides present, 4dp strings). */
export interface PreviewLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: string;
  credit: string;
}

export interface JournalPreview {
  lines: PreviewLine[];
  totalDebit: string;
  totalCredit: string;
  balanced: boolean;
}

/** Pure projection: enrich each derived journal line with its account code/name,
 *  normalize both sides to 4dp strings (inactive side "0.0000"), and total the
 *  entry. `accounts` must contain every line's accountId — the caller validates
 *  and fetches via PostingService.resolvePostableAccounts. */
export function toPreview(
  lines: PreviewSourceLine[],
  accounts: Map<string, { id: string; code: string; name: string }>,
): JournalPreview {
  const previewLines: PreviewLine[] = lines.map((l) => {
    const a = accounts.get(l.accountId);
    if (!a)
      throw new Error(
        `Account ${l.accountId} missing from preview account map`,
      );
    return {
      accountId: l.accountId,
      accountCode: a.code,
      accountName: a.name,
      debit: Money.of(l.debit ?? '0').toPersistence(),
      credit: Money.of(l.credit ?? '0').toPersistence(),
    };
  });
  const totalDebit = Money.sum(previewLines.map((l) => Money.of(l.debit)));
  const totalCredit = Money.sum(previewLines.map((l) => Money.of(l.credit)));
  return {
    lines: previewLines,
    totalDebit: totalDebit.toPersistence(),
    totalCredit: totalCredit.toPersistence(),
    balanced: totalDebit.equals(totalCredit),
  };
}
