import { Injectable, OnModuleInit } from '@nestjs/common';
import { Account, AccountSubtype, AccountType, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { listPaginated, Paginated } from '../../common/pagination/paginated';
import {
  ConflictDomainError,
  NotFoundDomainError,
  ValidationFailedError,
} from '../../common/errors/domain-errors';
import { CHART_OF_ACCOUNTS } from './chart-of-accounts.seed';

export interface CreateAccountInput {
  code: string;
  name: string;
  type: Account['type'];
  subtype: Account['subtype'];
  normalBalance: Account['normalBalance'];
  cashFlowCategory?: Account['cashFlowCategory'];
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
      await this.prisma.client.$transaction(async (tx) => {
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

  async findById(id: string): Promise<Account> {
    const account = await this.prisma.client.account.findFirst({
      where: { id },
    });
    if (!account) throw new NotFoundDomainError('Account not found', { id });
    return account;
  }

  async create(input: CreateAccountInput): Promise<Account> {
    // Type/subtype coherence check
    const validSubtypes = TYPE_SUBTYPES[input.type];
    if (!validSubtypes.includes(input.subtype)) {
      throw new ValidationFailedError(
        `Subtype ${input.subtype} is not valid for account type ${input.type}`,
        { type: input.type, subtype: input.subtype },
      );
    }

    const existing = await this.prisma.client.account.findFirst({
      where: { code: input.code },
    });
    if (existing) {
      throw new ConflictDomainError('Account code already exists', {
        code: input.code,
      });
    }

    let parentId: string | null = null;
    if (input.parentCode) {
      const parent = await this.prisma.client.account.findFirst({
        where: { code: input.parentCode },
      });
      if (!parent) {
        throw new ValidationFailedError('Parent account not found', {
          parentCode: input.parentCode,
        });
      }
      if (parent.isPostable) {
        throw new ValidationFailedError(
          'Parent account must be a non-postable header',
          { parentCode: input.parentCode },
        );
      }
      parentId = parent.id;
    }

    try {
      return await this.prisma.client.account.create({
        data: {
          code: input.code,
          name: input.name,
          type: input.type,
          subtype: input.subtype,
          normalBalance: input.normalBalance,
          cashFlowCategory: input.cashFlowCategory ?? 'NONE',
          isPostable: input.isPostable ?? true,
          parentId,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictDomainError('Account code already exists', {
          code: input.code,
        });
      }
      throw err;
    }
  }

  async update(
    id: string,
    data: Partial<Pick<Account, 'name' | 'cashFlowCategory' | 'isActive'>>,
  ): Promise<Account> {
    await this.findById(id);
    return this.prisma.client.account.update({ where: { id }, data });
  }

  async deactivate(id: string): Promise<Account> {
    await this.findById(id);
    return this.prisma.client.account.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async softDelete(id: string, deletedBy: string): Promise<void> {
    const account = await this.findById(id);
    // Only POSTED/REVERSED lines block deletion — a soft-deleted draft's lines
    // must not pin the account forever.
    const postedLineCount = await this.prisma.client.journalLine.count({
      where: {
        accountId: id,
        entry: { status: { in: ['POSTED', 'REVERSED'] } },
      },
    });
    if (postedLineCount > 0) {
      throw new ValidationFailedError(
        'Cannot delete an account with posted lines; deactivate instead',
        { id },
      );
    }
    await this.prisma.client.account.update({
      where: { id },
      data: {
        code: `${account.code}#deleted-${id}`,
        deletedAt: new Date(),
        deletedBy,
      },
    });
  }
}
