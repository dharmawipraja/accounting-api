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
