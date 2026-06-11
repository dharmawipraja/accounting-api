import { Injectable, OnModuleInit } from '@nestjs/common';
import { CompanySettings, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotFoundDomainError } from '../common/errors/domain-errors';

export interface UpdateCompanyInput {
  legalName?: string;
  npwp?: string;
  address?: string;
  fiscalYearStartMonth?: number;
  segregationOfDutiesEnabled?: boolean;
  isPkp?: boolean;
}

@Injectable()
export class CompanyService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.seedIfEmpty();
  }

  /** Idempotent and race-safe: creates the single settings row only if none exists. */
  async seedIfEmpty(): Promise<void> {
    const existing = await this.prisma.client.companySettings.findFirst();
    if (existing) return;
    try {
      await this.prisma.client.companySettings.create({
        data: { legalName: 'My Company' },
      });
    } catch (err) {
      // Another instance won the boot race; the singleton row now exists.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return;
      }
      throw err;
    }
  }

  async get(): Promise<CompanySettings> {
    const settings = await this.prisma.client.companySettings.findFirst();
    if (!settings) {
      throw new NotFoundDomainError('Company settings not initialized');
    }
    return settings;
  }

  async update(input: UpdateCompanyInput): Promise<CompanySettings> {
    const current = await this.get();
    return this.prisma.client.companySettings.update({
      where: { id: current.id },
      data: input,
    });
  }
}
