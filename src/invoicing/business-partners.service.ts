import { Injectable } from '@nestjs/common';
import { BusinessPartner } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  ConflictDomainError,
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';
import { mapUniqueViolation } from '../common/errors/map-unique-violation';
import { trigramSearch } from '../common/search/trigram-search';
import { listPaginated, Paginated } from '../common/pagination/paginated';
import { tombstoneValue } from '../common/prisma/tombstone';

export interface CreatePartnerInput {
  code: string;
  name: string;
  npwp?: string;
  email?: string;
  phone?: string;
  address?: string;
  isCustomer?: boolean;
  isVendor?: boolean;
}
export type UpdatePartnerInput = Partial<
  Omit<CreatePartnerInput, 'code' | 'npwp' | 'email' | 'phone' | 'address'>
> & {
  // nullable columns: `null` clears the stored value
  npwp?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  isActive?: boolean;
};

@Injectable()
export class BusinessPartnersService {
  constructor(private readonly prisma: PrismaService) {}

  private assertRole(isCustomer?: boolean, isVendor?: boolean): void {
    if (!isCustomer && !isVendor) {
      throw new ValidationFailedError(
        'A partner must be a customer and/or a vendor',
      );
    }
  }

  async create(input: CreatePartnerInput): Promise<BusinessPartner> {
    this.assertRole(input.isCustomer, input.isVendor);
    const existing = await this.prisma.client.businessPartner.findFirst({
      where: { code: input.code },
    });
    if (existing)
      throw new ConflictDomainError('Partner code already exists', {
        code: input.code,
      });
    try {
      return await this.prisma.client.businessPartner.create({
        data: {
          code: input.code,
          name: input.name,
          npwp: input.npwp,
          email: input.email,
          phone: input.phone,
          address: input.address,
          isCustomer: input.isCustomer ?? false,
          isVendor: input.isVendor ?? false,
        },
      });
    } catch (err) {
      mapUniqueViolation(err, 'Partner code already exists', {
        code: input.code,
      });
    }
  }

  async listPage(q: {
    q?: string;
    limit?: number;
    offset?: number;
  }): Promise<Paginated<BusinessPartner>> {
    return listPaginated<BusinessPartner, BusinessPartner>({
      q: q.q,
      limit: q.limit,
      offset: q.offset,
      present: (r) => r,
      search: ({ term, limit, offset }) =>
        trigramSearch(this.prisma, {
          table: 'business_partners',
          alias: 't',
          ownColumns: ['name', 'code', 'npwp', 'email'],
          filters: [],
          q: term,
          limit,
          offset,
        }),
      hydrate: (ids) =>
        this.prisma.client.businessPartner.findMany({
          where: { id: { in: ids } },
        }),
      page: async ({ limit: take, offset: skip }) => {
        const [rows, total] = await Promise.all([
          this.prisma.client.businessPartner.findMany({
            orderBy: { code: 'asc' },
            take,
            skip,
          }),
          this.prisma.client.businessPartner.count(),
        ]);
        return { rows, total };
      },
    });
  }

  async findById(id: string): Promise<BusinessPartner> {
    const p = await this.prisma.client.businessPartner.findFirst({
      where: { id },
    });
    if (!p) throw new NotFoundDomainError('Partner not found', { id });
    return p;
  }

  async update(
    id: string,
    input: UpdatePartnerInput,
  ): Promise<BusinessPartner> {
    const current = await this.findById(id);
    const isCustomer = input.isCustomer ?? current.isCustomer;
    const isVendor = input.isVendor ?? current.isVendor;
    this.assertRole(isCustomer, isVendor);
    return this.prisma.client.businessPartner.update({
      where: { id },
      data: { ...input },
    });
  }

  async deactivate(id: string): Promise<BusinessPartner> {
    await this.findById(id);
    return this.prisma.client.businessPartner.update({
      where: { id },
      data: { isActive: false },
    });
  }

  /** Soft-delete (tombstone) a partner that has no open items: no live draft
   *  invoice/bill/payment and no POSTED invoice/bill with an outstanding
   *  balance — deleting it would orphan receivables/payables (aging, payment
   *  allocation) behind a partner nobody can select any more. The partner row
   *  is locked FOR UPDATE first; draft create (invoice/bill/payment) and
   *  payment post re-read it FOR SHARE (lockLivePartnerForShare), so those
   *  writes and a delete serialize. 422 `{ id, reason: 'OPEN_ITEMS' }`. */
  async softDelete(id: string, deletedBy: string): Promise<void> {
    await this.prisma.transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ code: string }[]>`
        SELECT code FROM business_partners
        WHERE id = ${id} AND deleted_at IS NULL FOR UPDATE`;
      if (rows.length === 0)
        throw new NotFoundDomainError('Partner not found', { id });
      const [open] = await tx.$queryRaw<
        { drafts: number; outstanding: number; draft_payments: number }[]
      >`
        SELECT
          (SELECT count(*)::int FROM sales_invoices
             WHERE partner_id = ${id} AND deleted_at IS NULL AND status = 'DRAFT')
          + (SELECT count(*)::int FROM purchase_bills
             WHERE partner_id = ${id} AND deleted_at IS NULL AND status = 'DRAFT')
            AS drafts,
          (SELECT count(*)::int FROM sales_invoices
             WHERE partner_id = ${id} AND deleted_at IS NULL AND status = 'POSTED'
               AND total > amount_paid)
          + (SELECT count(*)::int FROM purchase_bills
             WHERE partner_id = ${id} AND deleted_at IS NULL AND status = 'POSTED'
               AND total > amount_paid)
            AS outstanding,
          (SELECT count(*)::int FROM payments
             WHERE partner_id = ${id} AND deleted_at IS NULL AND status = 'DRAFT')
            AS draft_payments`;
      if (open.drafts + open.outstanding + open.draft_payments > 0)
        throw new ValidationFailedError(
          'Cannot delete a partner with open items (draft documents or payments, or posted documents with an outstanding balance); settle, void or delete them first, or deactivate the partner',
          {
            id,
            reason: 'OPEN_ITEMS',
            draftDocuments: open.drafts,
            outstandingDocuments: open.outstanding,
            draftPayments: open.draft_payments,
          },
        );
      // Same tombstone semantics as the extension's tombstoneDelete() (not
      // available on `tx`): free the unique code, stamp deletedAt/By.
      await tx.businessPartner.update({
        where: { id },
        data: {
          code: tombstoneValue(rows[0].code, id),
          deletedAt: new Date(),
          deletedBy,
        },
      });
    });
  }
}
