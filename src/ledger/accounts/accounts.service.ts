import { Injectable, OnModuleInit } from '@nestjs/common';
import { Account, AccountSubtype, AccountType, Prisma } from '@prisma/client';
import { LedgerTx, PrismaService } from '../../common/prisma/prisma.service';
import { tombstoneData } from '../../common/prisma/tombstone';
import { listPaginated, Paginated } from '../../common/pagination/paginated';
import {
  ConflictDomainError,
  NotFoundDomainError,
  ValidationFailedError,
} from '../../common/errors/domain-errors';
import {
  mapUniqueViolation,
  uniqueViolationIndex,
} from '../../common/errors/map-unique-violation';
import { CHART_OF_ACCOUNTS } from './chart-of-accounts.seed';
import { Money } from '../../common/money/money';
import { POSTED_JE } from '../balances/posted-entry.sql';
import { assertCashAssignable } from './cash-role';
import {
  normalizeDisplayName,
  normalizeIdentifierCode,
} from '../../common/text/identifier';

/**
 * Transaction-scoped advisory lock serializing CASH-account retirements, so
 * two concurrent retirements of the last two CASH accounts can't both pass the
 * "another active CASH account remains" check. Kept out of the fiscal-year
 * range and the other 71_00x_001 keys (see domain-glossary.md lock table).
 */
export const CASH_RETIRE_LOCK_KEY = 71_003_001;

/** Partial unique index (migration 20260618000000_account_role) allowing one
 *  holder per singleton role (every role except CASH). */
const SINGLETON_ROLE_INDEX = 'accounts_singleton_role';

export interface UpdateAccountInput {
  name?: string;
  cashFlowCategory?: Account['cashFlowCategory'];
  isActive?: boolean;
  /** Only CASH is assignable after creation (a set-valued role); singleton
   *  roles stay create-only. */
  role?: 'CASH';
}

export interface CreateAccountInput {
  code: string;
  name: string;
  type: Account['type'];
  subtype: Account['subtype'];
  normalBalance: Account['normalBalance'];
  cashFlowCategory?: Account['cashFlowCategory'];
  role?: Account['role'];
  isPostable?: boolean;
  parentCode?: string;
}

/**
 * Coherence map: for each AccountType, the set of valid AccountSubtypes.
 * Incoherent pairs (e.g. ASSET + TAX_PAYABLE) are rejected with a 422.
 */
const TYPE_SUBTYPES: Record<AccountType, AccountSubtype[]> = {
  ASSET: [
    'CURRENT_ASSET',
    'NON_CURRENT_ASSET',
    'FIXED_ASSET',
    'ACCUMULATED_DEPRECIATION',
    'TAX_RECEIVABLE',
  ],
  LIABILITY: ['CURRENT_LIABILITY', 'NON_CURRENT_LIABILITY', 'TAX_PAYABLE'],
  EQUITY: ['EQUITY'],
  REVENUE: ['REVENUE', 'OTHER_INCOME'],
  EXPENSE: ['COGS', 'OPERATING_EXPENSE', 'OTHER_EXPENSE'],
};

@Injectable()
export class AccountsService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.seedIfEmpty();
  }

  /** Idempotent and race-safe: seeds the SAK chart only when no accounts exist. */
  async seedIfEmpty(): Promise<void> {
    const count = await this.prisma.client.account.count();
    if (count > 0) return;
    // Insert headers first (no parent), then leaves, resolving parentCode → id.
    const ordered = [...CHART_OF_ACCOUNTS].sort(
      (a, b) => Number(b.isPostable === false) - Number(a.isPostable === false),
    );
    try {
      // One transaction so a lost boot race rolls back cleanly (no partial chart).
      await this.prisma.transaction(async (tx) => {
        const idByCode = new Map<string, string>();
        for (const a of ordered) {
          let parentId: string | null = null;
          if (a.parentCode) {
            parentId = idByCode.get(a.parentCode) ?? null;
            if (!parentId) {
              throw new Error(
                `Seed: parent code '${a.parentCode}' not found for '${a.code}'`,
              );
            }
          }
          const created = await tx.account.create({
            data: {
              code: a.code,
              name: a.name,
              type: a.type,
              subtype: a.subtype,
              normalBalance: a.normalBalance,
              cashFlowCategory: a.cashFlowCategory ?? 'NONE',
              role: a.role ?? null,
              isPostable: a.isPostable ?? true,
              parentId,
            },
          });
          idByCode.set(a.code, created.id);
        }
      });
    } catch (err) {
      // Another instance seeded first (whole transaction rolled back); chart exists.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return;
      }
      throw err;
    }
  }

  async list(
    q: {
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<Paginated<Account>> {
    return listPaginated({
      limit: q.limit,
      offset: q.offset,
      present: (r: Account) => r,
      page: async ({ limit, offset }) => {
        const [rows, total] = await Promise.all([
          this.prisma.client.account.findMany({
            orderBy: { code: 'asc' },
            take: limit,
            skip: offset,
          }),
          this.prisma.client.account.count(),
        ]);
        return { rows, total };
      },
    });
  }

  /** Full chart of accounts (unpaginated) — for internal lookups that scan all accounts. */
  async listAll(): Promise<Account[]> {
    return this.prisma.client.account.findMany({ orderBy: { code: 'asc' } });
  }

  /** `db`: a transaction client to read on (e.g. a report snapshot) — keeps
   *  the lookup on the caller's connection instead of a second pooled one. */
  async findById(
    id: string,
    db: LedgerTx = this.prisma.client,
  ): Promise<Account> {
    const account = await db.account.findFirst({
      where: { id },
    });
    if (!account) throw new NotFoundDomainError('Account not found', { id });
    return account;
  }

  /** The live account whose code equals `code` case-insensitively — the same
   *  rule as the `accounts_code_lower_live_key` unique index (raw, so it bypasses
   *  the soft-delete extension: `deleted_at IS NULL` is explicit). */
  private async findLiveByCode(
    code: string,
  ): Promise<{ id: string } | undefined> {
    const rows = await this.prisma.client.$queryRaw<{ id: string }[]>`
      SELECT id FROM accounts
      WHERE lower(code) = lower(${code}) AND deleted_at IS NULL
      LIMIT 1`;
    return rows[0];
  }

  async create(raw: CreateAccountInput): Promise<Account> {
    // code / name / parentCode are stored and matched normalized (NFKC + trim
    // / trim) — the DTO already normalized them; re-applied here so a caller
    // bypassing the DTO gets the same rule (idempotent).
    const input: CreateAccountInput = {
      ...raw,
      code: normalizeIdentifierCode(raw.code),
      name: normalizeDisplayName(raw.name),
      parentCode:
        raw.parentCode === undefined
          ? undefined
          : normalizeIdentifierCode(raw.parentCode),
    };
    // Type/subtype coherence check
    const validSubtypes = TYPE_SUBTYPES[input.type];
    if (!validSubtypes.includes(input.subtype)) {
      throw new ValidationFailedError(
        `Subtype ${input.subtype} is not valid for account type ${input.type}`,
        { type: input.type, subtype: input.subtype },
      );
    }

    // Case-insensitive, like the unique index (which still backstops a race).
    const existing = await this.findLiveByCode(input.code);
    if (existing) {
      throw new ConflictDomainError('Account code already exists', {
        code: input.code,
      });
    }

    // CASH: the same shape rule as PATCH role=CASH (postable, debit-normal ASSET).
    if (input.role === 'CASH')
      assertCashAssignable({
        type: input.type,
        normalBalance: input.normalBalance,
        isPostable: input.isPostable ?? true,
        role: null,
      });

    // Singleton roles (everything except CASH) may be held by at most one account.
    // This CASH carve-out MUST stay in sync with the partial-unique index in
    // migration 20260618000000_account_role (`WHERE role IS NOT NULL AND role <> 'CASH'`):
    // if a second set-valued (non-singleton) role is ever added, update BOTH.
    if (input.role && input.role !== 'CASH') {
      const roleHolder = await this.prisma.client.account.findFirst({
        where: { role: input.role },
      });
      if (roleHolder) {
        throw new ConflictDomainError('That account role is already assigned', {
          role: input.role,
        });
      }
    }

    try {
      // One tx: the parent header is read FOR SHARE, so a concurrent
      // delete / deactivate of it (FOR UPDATE in lockForRetire, which then
      // counts children) serializes with this insert — either it sees the
      // new child (422 HAS_CHILDREN) or this create sees the header retired.
      return await this.prisma.transaction(async (tx) => {
        const parentId = input.parentCode
          ? await this.lockParentHeader(tx, input.parentCode)
          : null;
        return tx.account.create({
          data: {
            code: input.code,
            name: input.name,
            type: input.type,
            subtype: input.subtype,
            normalBalance: input.normalBalance,
            cashFlowCategory: input.cashFlowCategory ?? 'NONE',
            role: input.role ?? null,
            isPostable: input.isPostable ?? true,
            parentId,
          },
        });
      });
    } catch (err) {
      // The role pre-check above lost a race with a concurrent create of the
      // same singleton role: answer the role conflict, not a code conflict.
      if (uniqueViolationIndex(err) === SINGLETON_ROLE_INDEX)
        throw new ConflictDomainError('That account role is already assigned', {
          role: input.role,
        });
      mapUniqueViolation(err, 'Account code already exists', {
        code: input.code,
      });
    }
  }

  /** The live, ACTIVE, non-postable header `parentCode` names (matched
   *  case-insensitively, like code uniqueness), read FOR SHARE; 422
   *  otherwise. Returns its id. */
  private async lockParentHeader(
    tx: LedgerTx,
    parentCode: string,
  ): Promise<string> {
    const [parent] = await tx.$queryRaw<
      { id: string; is_postable: boolean; is_active: boolean }[]
    >`
      SELECT id, is_postable, is_active FROM accounts
      WHERE lower(code) = lower(${parentCode}) AND deleted_at IS NULL
      LIMIT 1 FOR SHARE`;
    if (!parent)
      throw new ValidationFailedError('Parent account not found', {
        parentCode,
      });
    if (parent.is_postable)
      throw new ValidationFailedError(
        'Parent account must be a non-postable header',
        { parentCode },
      );
    if (!parent.is_active)
      throw new ValidationFailedError('Parent account must be active', {
        parentCode,
      });
    return parent.id;
  }

  async update(id: string, raw: UpdateAccountInput): Promise<Account> {
    const input =
      raw.name === undefined
        ? raw
        : { ...raw, name: normalizeDisplayName(raw.name) };
    const { role, ...data } = input;
    if (data.isActive === false || role !== undefined) {
      return this.prisma.transaction(async (tx) => {
        // A deactivation — same lock + role rule as POST :id/deactivate.
        if (data.isActive === false)
          await this.lockForRetire(tx, id, 'deactivate');
        if (role !== undefined) await this.lockCashCandidate(tx, id);
        return tx.account.update({
          where: { id },
          data: role !== undefined ? { ...data, role } : data,
        });
      });
    }
    await this.findById(id);
    return this.prisma.client.account.update({ where: { id }, data });
  }

  /** CASH may be added to an existing account (e.g. a bank account created
   *  before roles existed) so payments can use it. Locks the row FOR UPDATE and
   *  applies the shared shape rule (`assertCashAssignable`, also used by create). */
  private async lockCashCandidate(tx: LedgerTx, id: string): Promise<void> {
    const rows = await tx.$queryRaw<
      {
        type: string;
        normal_balance: string;
        role: string | null;
        is_postable: boolean;
      }[]
    >`
      SELECT type::text AS type, normal_balance::text AS normal_balance,
             role::text AS role, is_postable
      FROM accounts WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
    if (rows.length === 0)
      throw new NotFoundDomainError('Account not found', { id });
    const a = rows[0];
    // Raw on purpose: soft-deleted tax codes count too (their posted history
    // still sits on the account). Serializes with tax-code create, which
    // reads the account FOR SHARE before inserting.
    const [{ used }] = await tx.$queryRaw<{ used: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM tax_codes WHERE tax_account_id = ${id}) AS used`;
    assertCashAssignable({
      id,
      type: a.type,
      normalBalance: a.normal_balance,
      isPostable: a.is_postable,
      role: a.role,
      usedByTaxCode: used,
    });
  }

  /** Deactivate under a FOR UPDATE row lock: posting re-reads its accounts
   *  FOR SHARE inside the posting tx, so a deactivation and a post serialize
   *  (a post that commits first stands; one that waits sees isActive=false). */
  async deactivate(id: string): Promise<Account> {
    return this.prisma.transaction(async (tx) => {
      await this.lockForRetire(tx, id, 'deactivate');
      return tx.account.update({ where: { id }, data: { isActive: false } });
    });
  }

  /** Soft-delete under the same FOR UPDATE lock, counting posted lines INSIDE
   *  the tx: a concurrent post either committed its lines before the lock (the
   *  count sees them → 422) or blocks on its FOR SHARE and then finds the
   *  account deleted (→ INVALID_ACCOUNT). */
  async softDelete(id: string, deletedBy: string): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      const account = await this.lockForRetire(tx, id, 'delete');
      // Only POSTED/REVERSED lines block deletion — a soft-deleted draft's lines
      // must not pin the account forever.
      const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.journal_entry_id
        WHERE jl.account_id = ${id} AND je.status IN ('POSTED', 'REVERSED')`;
      if (n > 0) {
        throw new ValidationFailedError(
          'Cannot delete an account with posted lines; deactivate instead',
          { id },
        );
      }
      await tx.account.update({
        where: { id },
        data: tombstoneData('code', account.code, id, deletedBy),
      });
    });
  }

  /** FOR UPDATE the live account row (404 if missing/deleted) and refuse to
   *  retire a singleton system account: AR/AP control, retained earnings,
   *  opening-balance equity and tax expense are resolved by role at post/close
   *  time, so deactivating or deleting one would break documents and year-end
   *  close. CASH is a set, so one CASH account may be retired as long as
   *  `assertCashRetirable` holds. */
  private async lockForRetire(
    tx: LedgerTx,
    id: string,
    action: 'deactivate' | 'delete',
  ): Promise<{ code: string }> {
    const rows = await tx.$queryRaw<{ code: string; role: string | null }[]>`
      SELECT code, role::text AS role FROM accounts
      WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
    if (rows.length === 0)
      throw new NotFoundDomainError('Account not found', { id });
    // A header must not be retired over live children: deleting it would
    // orphan them (parent_id → a tombstone), deactivating it over ACTIVE
    // children would leave active accounts under an inactive header.
    // Children are created under the header's FOR SHARE lock
    // (lockParentHeader), so this count under FOR UPDATE is race-free.
    const [{ children }] = await tx.$queryRaw<{ children: number }[]>`
      SELECT COUNT(*)::int AS children FROM accounts
      WHERE parent_id = ${id} AND deleted_at IS NULL
        AND (${action === 'delete'} OR is_active)`;
    // 422 HAS_CHILDREN — the VALIDATION_FAILED + details.reason shape of
    // OPEN_ITEMS / TAX_ACCOUNT.
    if (children > 0)
      throw new ValidationFailedError(
        action === 'delete'
          ? 'Cannot delete an account that still has child accounts; delete them first'
          : 'Cannot deactivate an account that still has active child accounts; deactivate them first',
        { id, reason: 'HAS_CHILDREN', children },
      );
    if (rows[0].role === 'CASH') {
      await this.assertCashRetirable(tx, id, action);
    } else if (rows[0].role !== null) {
      throw new ValidationFailedError(
        `Cannot ${action} a system account (role ${rows[0].role})`,
        { id, role: rows[0].role },
      );
    }
    return rows[0];
  }

  /** A CASH account may be retired only when (a) its posted balance is zero —
   *  read under the row lock, which a concurrent post's FOR SHARE re-read
   *  serializes against — and (b) at least one OTHER active, postable CASH
   *  account remains (a non-postable legacy CASH row can't take payments, so it
   *  doesn't count), checked under CASH_RETIRE_LOCK_KEY so two concurrent
   *  retirements can't both see the other as the survivor. */
  private async assertCashRetirable(
    tx: LedgerTx,
    id: string,
    action: 'deactivate' | 'delete',
  ): Promise<void> {
    const [{ balance }] = await tx.$queryRaw<{ balance: string }[]>`
      SELECT (COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0))::text AS balance
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.account_id = ${id} AND ${POSTED_JE}`;
    const net = Money.of(balance);
    if (!net.isZero())
      throw new ValidationFailedError(
        `Cannot ${action} a CASH account with a non-zero balance; move the balance to another cash account first`,
        { id, role: 'CASH', balance: net.toPersistence() },
      );
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CASH_RETIRE_LOCK_KEY})`;
    const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM accounts
      WHERE role = 'CASH' AND id <> ${id} AND is_active AND is_postable
        AND deleted_at IS NULL`;
    if (n === 0)
      throw new ValidationFailedError(
        `Cannot ${action} the last active CASH account; payments need at least one`,
        { id, role: 'CASH', otherActiveCashAccounts: 0 },
      );
  }
}
