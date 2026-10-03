import { Prisma } from '@prisma/client';

/**
 * The canonical "this journal entry counts toward balances" predicate: posted and
 * not soft-deleted. Interpolate into any balances/reporting raw query so the rule
 * lives in exactly one place (trial balance, account balance, general ledger).
 *
 * CONTRACT: the consuming query must alias `journal_entries` as `je`.
 *
 * Account soft-delete is enforced separately, not here: `a.deleted_at IS NULL`
 * where accounts are joined (grouped balances), or an upfront `findById` for
 * account-scoped queries (account balance, general ledger).
 */
export const POSTED_JE = Prisma.sql`je.posted_at IS NOT NULL AND je.deleted_at IS NULL`;

/**
 * `je` is an entry of `sourceType` OR the REVERSAL of one (e.g. the reversal a
 * year-end reopen posts for its CLOSING entry). Pairs an entry with its reversal
 * so excluding one never leaves the other dangling in a report.
 * CONTRACT: `journal_entries` aliased as `je`.
 */
function isSourceOrItsReversal(sourceType: 'CLOSING' | 'OPENING'): Prisma.Sql {
  // EXISTS, not `reversal_of_id IN (…)`: for the (usual) NULL reversal_of_id,
  // IN over a non-empty set yields NULL and `NOT (…)` would drop the entry.
  return Prisma.sql`(je.source_type = ${sourceType}::"JournalSourceType" OR EXISTS (SELECT 1 FROM journal_entries s WHERE s.id = je.reversal_of_id AND s.source_type = ${sourceType}::"JournalSourceType"))`;
}

/**
 * Excludes year-end CLOSING entries and their reopen REVERSALs — the P&L-view
 * predicate (Laba Rugi, Arus Kas, Neraca current-year earnings). With `from`,
 * only those dated on/after `from` are excluded (pre-closing Neraca view, and
 * the trial balance under `?preClosing=true`). The default trial balance /
 * general ledger / account balance deliberately do NOT use it.
 */
export function excludeClosingJe(from?: Date): Prisma.Sql {
  const closing = isSourceOrItsReversal('CLOSING');
  return from
    ? Prisma.sql`NOT (${closing} AND je.date >= ${from})`
    : Prisma.sql`NOT ${closing}`;
}

/** Excludes OPENING entries (and their reversals) — cash flow treats them as
 *  beginning balances, not flows. Opening-credit payments (go-live deposits /
 *  prepayments, Saldo Awal ↔ Uang Muka, no cash) are beginning balances too:
 *  their own entry and its void reversal are excluded — matched by the
 *  payment's journal_entry_id, so their later applications and cash refunds
 *  (same source id) still count as flows. */
export const EXCLUDE_OPENING_JE = Prisma.sql`NOT ${isSourceOrItsReversal('OPENING')} AND NOT EXISTS (SELECT 1 FROM payments op WHERE op.opening AND op.journal_entry_id IN (je.id, je.reversal_of_id))`;
