import { Money } from '../../common/money/money';
import { UnbalancedEntryError } from '../../common/errors/domain-errors';
import { PostLineInput } from './posting.types';

/** Double-entry invariant: ≥2 lines, each line exactly one of debit/credit > 0,
 *  and total debits == total credits. (Extracted from PostingService for unit testing.) */
export function assertBalanced(lines: PostLineInput[]): void {
  if (lines.length < 2) {
    throw new UnbalancedEntryError('An entry needs at least two lines');
  }
  let debit = Money.zero();
  let credit = Money.zero();
  for (const l of lines) {
    const d = Money.of(l.debit ?? '0');
    const c = Money.of(l.credit ?? '0');
    const dPos = !d.isZero();
    const cPos = !c.isZero();
    if (dPos === cPos) {
      throw new UnbalancedEntryError(
        'Each line must have exactly one of debit or credit > 0',
      );
    }
    debit = debit.add(d);
    credit = credit.add(c);
  }
  if (!debit.equals(credit)) {
    throw new UnbalancedEntryError('Total debits must equal total credits', {
      debit: debit.toString(),
      credit: credit.toString(),
    });
  }
}
