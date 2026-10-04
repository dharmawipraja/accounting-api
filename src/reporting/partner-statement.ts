// Pure part of the partner statement (kartu piutang / kartu hutang): running
// balances over an already-ordered event list. No I/O.
import { Money } from '../common/money/money';

export type StatementSide = 'customer' | 'vendor';

/** One statement event as read from the DB (see PartnerStatementService).
 *  `docDelta`: change of the AR/AP (open-document) balance the partner owes us
 *  (customer) / we owe them (vendor), + = increases it. `creditDelta`: change
 *  of the partner's unapplied credit (customer advances + credit-note excess /
 *  our vendor prepayments + debit-note excess), + = increases it. */
export interface StatementEvent {
  date: string; // YYYY-MM-DD
  type: string;
  ref: string | null;
  documentRef: string | null;
  description: string | null;
  docDelta: string;
  creditDelta: string;
  documentId: string | null;
  paymentId: string | null;
  noteId: string | null;
  applicationId: string | null;
}

export interface StatementLine {
  date: string;
  type: string;
  ref: string | null;
  documentRef: string | null;
  description: string | null;
  debit: string;
  credit: string;
  balance: string;
  unappliedCreditChange: string;
  unappliedCredit: string;
  netBalance: string;
  documentId: string | null;
  paymentId: string | null;
  noteId: string | null;
  applicationId: string | null;
}

export interface StatementTotals {
  openingBalance: string;
  openingUnappliedCredit: string;
  openingNetBalance: string;
  lines: StatementLine[];
  totalDebit: string;
  totalCredit: string;
  closingBalance: string;
  unappliedCredit: string;
  netBalance: string;
}

/** Running balances. The balance (AR/AP) increases on the debit side for a
 *  customer and on the credit side for a vendor (kartu piutang / hutang
 *  convention); netBalance = balance − unappliedCredit. Closing = opening +
 *  every line's movement. */
export function runStatement(
  side: StatementSide,
  opening: { docBalance: string; unappliedCredit: string },
  events: readonly StatementEvent[],
): StatementTotals {
  let bal = Money.of(opening.docBalance);
  let cred = Money.of(opening.unappliedCredit);
  let totalDebit = Money.zero();
  let totalCredit = Money.zero();
  const zero = Money.zero().toPersistence();
  const lines = events.map((e) => {
    const delta = Money.of(e.docDelta);
    const up = !delta.isNegative();
    const abs = up ? delta : Money.zero().subtract(delta);
    const isDebit = up === (side === 'customer');
    if (isDebit) totalDebit = totalDebit.add(abs);
    else totalCredit = totalCredit.add(abs);
    bal = bal.add(delta);
    cred = cred.add(Money.of(e.creditDelta));
    return {
      date: e.date,
      type: e.type,
      ref: e.ref,
      documentRef: e.documentRef,
      description: e.description,
      debit: isDebit ? abs.toPersistence() : zero,
      credit: isDebit ? zero : abs.toPersistence(),
      balance: bal.toPersistence(),
      unappliedCreditChange: Money.of(e.creditDelta).toPersistence(),
      unappliedCredit: cred.toPersistence(),
      netBalance: bal.subtract(cred).toPersistence(),
      documentId: e.documentId,
      paymentId: e.paymentId,
      noteId: e.noteId,
      applicationId: e.applicationId,
    };
  });
  const openBal = Money.of(opening.docBalance);
  const openCred = Money.of(opening.unappliedCredit);
  return {
    openingBalance: openBal.toPersistence(),
    openingUnappliedCredit: openCred.toPersistence(),
    openingNetBalance: openBal.subtract(openCred).toPersistence(),
    lines,
    totalDebit: totalDebit.toPersistence(),
    totalCredit: totalCredit.toPersistence(),
    closingBalance: bal.toPersistence(),
    unappliedCredit: cred.toPersistence(),
    netBalance: bal.subtract(cred).toPersistence(),
  };
}

/** A DB code as a filename-safe fragment ([A-Za-z0-9_-] only). */
export const safeFilePart = (s: string): string =>
  s.replace(/[^A-Za-z0-9_-]/g, '_');
