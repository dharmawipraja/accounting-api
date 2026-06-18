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
export type UpdatePartnerInput = Partial<Omit<CreatePartnerInput, 'code'>> & {
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

  async softDelete(id: string, deletedBy: string): Promise<void> {
    const p = await this.findById(id);
    await this.prisma.client.businessPartner.update({
      where: { id },
      data: {
        code: `${p.code}#deleted-${id}`,
        deletedAt: new Date(),
        deletedBy,
      },
    });
  }
}
