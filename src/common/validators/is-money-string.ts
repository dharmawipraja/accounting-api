import { Matches, ValidationOptions } from 'class-validator';

// Max 16 integer digits: the ledger columns are Decimal(20,4), so a longer
// value would overflow at the DB layer (P2020) instead of failing validation.
const MONEY_RE = /^\d{1,16}(\.\d{1,4})?$/;

/** `@Matches` (non-strings fail it) with the money message; a caller-supplied
 *  `message` still wins. Its constraint key is `matches`, so never stack it
 *  with another `@Matches` on the same property. */
export const IsMoneyString = (options?: ValidationOptions): PropertyDecorator =>
  Matches(MONEY_RE, {
    message:
      '$property must be a non-negative decimal string with up to 16 integer digits and 4 decimal places',
    ...options,
  });
