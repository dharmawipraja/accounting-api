import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  AccountRole,
  AccountSubtype,
  NormalBalance,
  Prisma,
  TaxCode,
  TaxKind,
} from '@prisma/client';
import { Decimal } from 'decimal.js';
import { LedgerTx, PrismaService } from '../common/prisma/prisma.service';
import { taxAccountViolation } from './tax-account-rule';
import { listPaginated, Paginated } from '../common/pagination/paginated';
import { AccountsService } from '../ledger/accounts/accounts.service';
import {
  ConflictDomainError,
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';
import { mapUniqueViolation } from '../common/errors/map-unique-violation';
import { TAX_CODE_SEED } from './tax-codes.seed';

export interface CreateTaxCodeInput {
  code: string;
  name: string;
  kind: TaxKind;
  rate: string;
  taxAccountId: string;
}

export interface UpdateTaxCodeInput {
  name?: string;
  rate?: string;
  isActive?: boolean;
}

@Injectable()
export class TaxCodesService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seedIfEmpty();
  }

  private validateRate(rate: string): void {
    let r: Decimal;
    try {
      r = new Decimal(rate);
    } catch {
      throw new ValidationFailedError('Rate must be a valid decimal', { rate });
    }
    if (!(r.greaterThan(0) && r.lessThan(1))) {
      throw new ValidationFailedError(
        'Rate must be greater than 0 and less than 1',
        { rate },
      );
    }
    if (r.decimalPlaces() > 6) {
      throw new ValidationFailedError(
        'Rate must have at most 6 decimal places',
        { rate },
      );
    }
  }

  /** Read the tax account FOR SHARE inside `tx` (so a concurrent PATCH
   *  role=CASH, which locks it FOR UPDATE and checks tax-code usage, serializes
   *  with this insert) and apply the pure tax-account rule. 404 if missing. */
  private async lockAndValidateAccount(
    tx: LedgerTx,
    taxAccountId: string,
    kind: TaxKind,
  ): Promise<void> {
    const rows = await tx.$queryRaw<
      {
        role: AccountRole | null;
        subtype: AccountSubtype;
        normal_balance: NormalBalance;
        is_postable: boolean;
      }[]
    >`
      SELECT role::text AS role, subtype::text AS subtype,
             normal_balance::text AS normal_balance, is_postable
      FROM accounts WHERE id = ${taxAccountId} AND deleted_at IS NULL FOR SHARE`;
    if (rows.length === 0)
      throw new NotFoundDomainError('Account not found', { id: taxAccountId });
    const a = rows[0];
    const v = taxAccountViolation(kind, {
      id: taxAccountId,
      role: a.role,
      subtype: a.subtype,
      normalBalance: a.normal_balance,
      isPostable: a.is_postable,
    });
    if (v) throw new ValidationFailedError(v.message, v.details);
  }

  async create(input: CreateTaxCodeInput): Promise<TaxCode> {
    this.validateRate(input.rate);
    try {
      return await this.prisma.transaction(async (tx) => {
        await this.lockAndValidateAccount(tx, input.taxAccountId, input.kind);
        const existing = await tx.taxCode.findFirst({
          where: { code: input.code },
        });
        if (existing) {
          throw new ConflictDomainError('Tax code already exists', {
            code: input.code,
          });
        }
        return tx.taxCode.create({
          data: {
            code: input.code,
            name: input.name,
            kind: input.kind,
            rate: input.rate,
            taxAccountId: input.taxAccountId,
          },
        });
      });
    } catch (err) {
      // A concurrent create with the same code lost the race past the pre-check.
      mapUniqueViolation(err, 'Tax code already exists', { code: input.code });
    }
  }

  async list(
    q: {
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<Paginated<TaxCode>> {
    return listPaginated({
      limit: q.limit,
      offset: q.offset,
      present: (r: TaxCode) => r,
      page: async ({ limit, offset }) => {
        const [rows, total] = await Promise.all([
          this.prisma.client.taxCode.findMany({
            orderBy: { code: 'asc' },
            take: limit,
            skip: offset,
          }),
          this.prisma.client.taxCode.count(),
        ]);
        return { rows, total };
      },
    });
  }

  async findById(id: string): Promise<TaxCode> {
    const code = await this.prisma.client.taxCode.findFirst({
      where: { id, deletedAt: null },
    });
    if (!code) throw new NotFoundDomainError('Tax code not found', { id });
    return code;
  }

  async update(id: string, input: UpdateTaxCodeInput): Promise<TaxCode> {
    await this.findById(id);
    if (input.rate !== undefined) this.validateRate(input.rate);
    return this.prisma.client.taxCode.update({
      where: { id },
      data: { name: input.name, rate: input.rate, isActive: input.isActive },
    });
  }

  async deactivate(id: string): Promise<TaxCode> {
    await this.findById(id);
    return this.prisma.client.taxCode.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async softDelete(id: string, deletedBy: string): Promise<void> {
    const taxCode = await this.findById(id);
    await this.prisma.client.taxCode.tombstoneDelete(
      id,
      'code',
      taxCode.code,
      deletedBy,
    );
  }

  async seedIfEmpty(): Promise<void> {
    const count = await this.prisma.client.taxCode.count();
    if (count > 0) return;
    const allAccounts = await this.accounts.listAll();
    const idByCode = new Map(allAccounts.map((a) => [a.code, a.id]));
    try {
      await this.prisma.transaction(async (tx) => {
        for (const s of TAX_CODE_SEED) {
          const taxAccountId = idByCode.get(s.accountCode);
          if (!taxAccountId) {
            throw new Error(
              `Seed: account ${s.accountCode} not found for tax code ${s.code}`,
            );
          }
          await tx.taxCode.create({
            data: {
              code: s.code,
              name: s.name,
              kind: s.kind,
              rate: s.rate,
              taxAccountId,
            },
          });
        }
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return;
      }
      throw err;
    }
  }
}
