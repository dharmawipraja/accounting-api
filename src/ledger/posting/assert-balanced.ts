import { Money } from '../../common/money/money';
import { UnbalancedEntryError } from '../../common/errors/domain-errors';
import { PostLineInput } from './posting.types';

/** Per-line rule: every line carries exactly one of debit / credit > 0.
 *  Shared by assertBalanced (post) and MANUAL draft create, where totals may
 *  still be unbalanced but a two-sided or empty line is never valid. */
export function assertLinesOneSided(lines: PostLineInput[]): void {
  for (const l of lines) {
    const dPos = !Money.of(l.debit ?? '0').isZero();
    const cPos = !Money.of(l.credit ?? '0').isZero();
    if (dPos === cPos) {
      throw new UnbalancedEntryError(
        'Each line must have exactly one of debit or credit > 0',
      );
    }
  }
}

/** Double-entry invariant: ≥2 lines, each line exactly one of debit/credit > 0,
 *  and total debits == total credits. (Extracted from PostingService for unit testing.) */
export function assertBalanced(lines: PostLineInput[]): void {
  if (lines.length < 2) {
    throw new UnbalancedEntryError('An entry needs at least two lines');
  }
  assertLinesOneSided(lines);
  let debit = Money.zero();
  let credit = Money.zero();
  for (const l of lines) {
    debit = debit.add(Money.of(l.debit ?? '0'));
    credit = credit.add(Money.of(l.credit ?? '0'));
  }
  if (!debit.equals(credit)) {
    throw new UnbalancedEntryError('Total debits must equal total credits', {
      debit: debit.toString(),
      credit: credit.toString(),
    });
  }
}
