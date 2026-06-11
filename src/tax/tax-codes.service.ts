import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma, TaxCode, TaxKind } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { AccountsService } from '../ledger/accounts/accounts.service';
import {
  ConflictDomainError,
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';
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

  private requiredNormalBalance(kind: TaxKind): 'DEBIT' | 'CREDIT' {
    return kind === 'PPN_INPUT' || kind === 'PPH_PREPAID' ? 'DEBIT' : 'CREDIT';
  }

  private validateRate(rate: string): void {
    const r = Number(rate);
    if (!(r > 0 && r < 1)) {
      throw new ValidationFailedError(
        'Rate must be greater than 0 and less than 1',
        { rate },
      );
    }
  }

  private async validateAccountForKind(
    taxAccountId: string,
    kind: TaxKind,
  ): Promise<void> {
    const account = await this.accounts.findById(taxAccountId);
    if (!account.isPostable) {
      throw new ValidationFailedError('Tax account must be postable', {
        taxAccountId,
      });
    }
    const required = this.requiredNormalBalance(kind);
    if (account.normalBalance !== required) {
      throw new ValidationFailedError(
        `Tax kind ${kind} requires a ${required}-normal account`,
        { taxAccountId, kind, normalBalance: account.normalBalance },
      );
    }
  }

  async create(input: CreateTaxCodeInput): Promise<TaxCode> {
    this.validateRate(input.rate);
    await this.validateAccountForKind(input.taxAccountId, input.kind);
    const existing = await this.prisma.client.taxCode.findFirst({
      where: { code: input.code },
    });
    if (existing) {
      throw new ConflictDomainError('Tax code already exists', {
        code: input.code,
      });
    }
    try {
      return await this.prisma.client.taxCode.create({
        data: {
          code: input.code,
          name: input.name,
          kind: input.kind,
          rate: input.rate,
          taxAccountId: input.taxAccountId,
        },
      });
    } catch (err) {
      // A concurrent create with the same code lost the race past the pre-check.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictDomainError('Tax code already exists', {
          code: input.code,
        });
      }
      throw err;
    }
  }

  async list(): Promise<TaxCode[]> {
    return this.prisma.client.taxCode.findMany({
      where: { deletedAt: null },
      orderBy: { code: 'asc' },
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
    await this.prisma.client.taxCode.update({
      where: { id },
      data: {
        code: `${taxCode.code}#deleted-${id}`,
        deletedAt: new Date(),
        deletedBy,
      },
    });
  }

  async seedIfEmpty(): Promise<void> {
    const count = await this.prisma.client.taxCode.count();
    if (count > 0) return;
    const allAccounts = await this.accounts.list();
    const idByCode = new Map(allAccounts.map((a) => [a.code, a.id]));
    try {
      await this.prisma.client.$transaction(async (tx) => {
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
