import { Injectable } from '@nestjs/common';
import { BusinessPartner, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  ConflictDomainError,
  NotFoundDomainError,
  ValidationFailedError,
} from '../common/errors/domain-errors';
import {
  trigramSearch,
  MIN_QUERY_LENGTH,
} from '../common/search/trigram-search';

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
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      )
        throw new ConflictDomainError('Partner code already exists', {
          code: input.code,
        });
      throw err;
    }
  }

  async listPage(q: { q?: string; limit?: number; offset?: number }): Promise<{
    data: BusinessPartner[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    const term = q.q?.trim() ?? '';
    if (term.length >= MIN_QUERY_LENGTH) {
      const { ids, total } = await trigramSearch(this.prisma, {
        table: 'business_partners',
        alias: 't',
        ownColumns: ['name', 'code', 'npwp', 'email'],
        filters: [],
        q: term,
        limit,
        offset,
      });
      const rows = ids.length
        ? await this.prisma.client.businessPartner.findMany({
            where: { id: { in: ids } },
          })
        : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      const data = ids.map((id) => byId.get(id)!).filter(Boolean);
      return { data, total, limit, offset };
    }
    const [data, total] = await Promise.all([
      this.prisma.client.businessPartner.findMany({
        orderBy: { code: 'asc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.client.businessPartner.count(),
    ]);
    return { data, total, limit, offset };
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
