import { Injectable } from '@nestjs/common';
import { BusinessPartner } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  ConflictDomainError,
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';
import { mapUniqueViolation } from '../common/errors/map-unique-violation';
import {
  normalizeDisplayName,
  normalizeIdentifierCode,
} from '../common/text/identifier';
import { trigramSearch } from '../common/search/trigram-search';
import { listPaginated, Paginated } from '../common/pagination/paginated';
import { tombstoneData } from '../common/prisma/tombstone';
import type { LedgerTx } from '../common/prisma/prisma.service';
import type { CreateBusinessPartnerDto } from './dto/create-business-partner.dto';
import type { UpdateBusinessPartnerDto } from './dto/update-business-partner.dto';

/** A partner role and the open items that depend on it. */
export type PartnerRole = 'CUSTOMER' | 'VENDOR';

interface OpenItemCounts {
  /** Live DRAFT invoices (customer) / bills (vendor). */
  drafts: number;
  /** POSTED invoices / bills with total > amount_paid. */
  outstanding: number;
  /** Live DRAFT RECEIPT (customer) / DISBURSEMENT (vendor) payments. */
  draftPayments: number;
}

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

  async create(raw: CreateBusinessPartnerDto): Promise<BusinessPartner> {
    // code / name are stored normalized (NFKC + trim / trim — the DTO already
    // normalized them and rejects blank or zero-width ones). Code uniqueness
    // among live partners is case-insensitive: the DB unique index on
    // lower(code) turns a `dup` vs `DUP` race into P2002 → 409 below.
    const input = {
      ...raw,
      code: normalizeIdentifierCode(raw.code),
      name: normalizeDisplayName(raw.name),
    };
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

  /** PATCH a partner. The row is locked FOR NO KEY UPDATE first and the
   *  customer-and/or-vendor rule is re-checked against the LOCKED row, so two
   *  concurrent PATCHes (one clearing isCustomer, the other isVendor) cannot
   *  both pass against a stale read and leave a partner that is neither (the
   *  DB CHECK `business_partners_customer_or_vendor` is the backstop).
   *  Clearing a role the partner currently has is refused while that role
   *  has open items (422 OPEN_ITEMS, the softDelete shape plus `role`):
   *  customer = draft invoices, POSTED invoices with an outstanding balance,
   *  draft RECEIPTs; vendor = the same for bills and DISBURSEMENTs. Draft
   *  create / payment post read the partner FOR SHARE, which conflicts with
   *  NO KEY UPDATE, so they serialize with this update (and its open-item
   *  count) too. NO KEY UPDATE (not FOR UPDATE) leaves the FK checks' FOR KEY
   *  SHARE unblocked: an invoice/bill/payment insert referencing the partner
   *  never waits on a PATCH. (A PATCH never changes a key column: `code` is
   *  not updatable, and the FKs reference `id`.) `name` is stored trimmed. */
  async update(
    id: string,
    raw: UpdateBusinessPartnerDto,
  ): Promise<BusinessPartner> {
    const input =
      raw.name === undefined
        ? raw
        : { ...raw, name: normalizeDisplayName(raw.name) };
    return this.prisma.transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        { is_customer: boolean; is_vendor: boolean }[]
      >`
        SELECT is_customer, is_vendor FROM business_partners
        WHERE id = ${id} AND deleted_at IS NULL FOR NO KEY UPDATE`;
      if (rows.length === 0)
        throw new NotFoundDomainError('Partner not found', { id });
      this.assertRole(
        input.isCustomer ?? rows[0].is_customer,
        input.isVendor ?? rows[0].is_vendor,
      );
      if (rows[0].is_customer && input.isCustomer === false)
        await this.assertNoOpenItems(tx, id, 'CUSTOMER');
      if (rows[0].is_vendor && input.isVendor === false)
        await this.assertNoOpenItems(tx, id, 'VENDOR');
      return tx.businessPartner.update({
        where: { id },
        data: { ...input },
      });
    });
  }

  /** Open items of the partner's `roles` (see OpenItemCounts), summed over
   *  the roles, read inside the caller's tx after it locked the partner row.
   *  Plain counts (no row locks): the caller's partner lock is what serializes
   *  them with draft create / payment post. */
  private async openItems(
    tx: LedgerTx,
    id: string,
    roles: PartnerRole[],
  ): Promise<OpenItemCounts> {
    const customer = roles.includes('CUSTOMER');
    const vendor = roles.includes('VENDOR');
    const [open] = await tx.$queryRaw<OpenItemCounts[]>`
      SELECT
        (SELECT count(*)::int FROM sales_invoices
           WHERE ${customer} AND partner_id = ${id} AND deleted_at IS NULL
             AND status = 'DRAFT')
        + (SELECT count(*)::int FROM purchase_bills
           WHERE ${vendor} AND partner_id = ${id} AND deleted_at IS NULL
             AND status = 'DRAFT')
          AS "drafts",
        (SELECT count(*)::int FROM sales_invoices
           WHERE ${customer} AND partner_id = ${id} AND deleted_at IS NULL
             AND status = 'POSTED' AND total > amount_paid)
        + (SELECT count(*)::int FROM purchase_bills
           WHERE ${vendor} AND partner_id = ${id} AND deleted_at IS NULL
             AND status = 'POSTED' AND total > amount_paid)
          AS "outstanding",
        (SELECT count(*)::int FROM payments
           WHERE partner_id = ${id} AND deleted_at IS NULL AND status = 'DRAFT'
             AND ((${customer} AND direction = 'RECEIPT')
               OR (${vendor} AND direction = 'DISBURSEMENT')))
          AS "draftPayments"`;
    return open;
  }

  /** 422 OPEN_ITEMS `{ id, reason, role, draftDocuments,
   *  outstandingDocuments, draftPayments }` when `role` has open items. */
  private async assertNoOpenItems(
    tx: LedgerTx,
    id: string,
    role: PartnerRole,
  ): Promise<void> {
    const open = await this.openItems(tx, id, [role]);
    if (open.drafts + open.outstanding + open.draftPayments > 0)
      throw new ValidationFailedError(
        `Cannot remove the ${role === 'CUSTOMER' ? 'customer' : 'vendor'} role while it has open items (draft documents or payments, or posted documents with an outstanding balance); settle, void or delete them first`,
        {
          id,
          reason: 'OPEN_ITEMS',
          role,
          draftDocuments: open.drafts,
          outstandingDocuments: open.outstanding,
          draftPayments: open.draftPayments,
        },
      );
  }

  /** POST /:id/deactivate — the same code path as PATCH { isActive: false }. */
  deactivate(id: string): Promise<BusinessPartner> {
    return this.update(id, { isActive: false });
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
      const open = await this.openItems(tx, id, ['CUSTOMER', 'VENDOR']);
      if (open.drafts + open.outstanding + open.draftPayments > 0)
        throw new ValidationFailedError(
          'Cannot delete a partner with open items (draft documents or payments, or posted documents with an outstanding balance); settle, void or delete them first, or deactivate the partner',
          {
            id,
            reason: 'OPEN_ITEMS',
            draftDocuments: open.drafts,
            outstandingDocuments: open.outstanding,
            draftPayments: open.draftPayments,
          },
        );
      await tx.businessPartner.update({
        where: { id },
        data: tombstoneData('code', rows[0].code, id, deletedBy),
      });
    });
  }
}
