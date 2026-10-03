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
import type { CreateTaxCodeDto } from './dto/create-tax-code.dto';
import type { UpdateTaxCodeDto } from './dto/update-tax-code.dto';
import { tombstoneData } from '../common/prisma/tombstone';
import {
  normalizeDisplayName,
  normalizeIdentifierCode,
} from '../common/text/identifier';

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

  async create(raw: CreateTaxCodeDto): Promise<TaxCode> {
    // code / name are stored normalized (NFKC + trim / trim) — the DTO already
    // normalized them; re-applied so a caller bypassing the DTO gets the same
    // rule (idempotent).
    const input = {
      ...raw,
      code: normalizeIdentifierCode(raw.code),
      name: normalizeDisplayName(raw.name),
    };
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

  async update(id: string, raw: UpdateTaxCodeDto): Promise<TaxCode> {
    const input =
      raw.name === undefined
        ? raw
        : { ...raw, name: normalizeDisplayName(raw.name) };
    const current = await this.findById(id);
    if (input.rate !== undefined) {
      this.validateRate(input.rate);
      if (!new Decimal(input.rate).equals(current.rate.toString()))
        await this.assertRateUnused(id);
    }
    return this.prisma.client.taxCode.update({
      where: { id },
      data: { name: input.name, rate: input.rate, isActive: input.isActive },
    });
  }

  /** A rate change on a code already on a document would silently re-rate its
   *  drafts at post and leave posted documents with no record of the rate they
   *  used. Rate changes (11% → 12%) are a new code; deactivate the old one.
   *  ponytail: check-then-update, not locked against a concurrent document
   *  create — worst case one draft posts at the new rate, never a posted one. */
  private async assertRateUnused(id: string): Promise<void> {
    const where = { taxCodeIds: { has: id } };
    const [invoiceLine, billLine] = await Promise.all([
      this.prisma.client.salesInvoiceLine.findFirst({
        where,
        select: { id: true },
      }),
      this.prisma.client.purchaseBillLine.findFirst({
        where,
        select: { id: true },
      }),
    ]);
    if (invoiceLine || billLine)
      throw new ConflictDomainError(
        'Tax code is used on documents; its rate cannot change. Create a new tax code and deactivate this one.',
        { taxCodeId: id, reason: 'TAX_CODE_IN_USE' },
      );
  }

  /** POST /:id/deactivate — the same code path as PATCH { isActive: false }. */
  deactivate(id: string): Promise<TaxCode> {
    return this.update(id, { isActive: false });
  }

  async softDelete(id: string, deletedBy: string): Promise<void> {
    const taxCode = await this.findById(id);
    await this.prisma.client.taxCode.update({
      where: { id },
      data: tombstoneData('code', taxCode.code, id, deletedBy),
    });
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
