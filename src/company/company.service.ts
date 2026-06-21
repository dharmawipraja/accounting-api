import { Injectable, OnModuleInit } from '@nestjs/common';
import { CompanySettings, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { NotFoundDomainError } from '../common/errors/domain-errors';
import {
  fiscalYearForDate,
  fiscalYearStartDate,
  fiscalYearEndDate,
} from '../common/dates/fiscal-year';

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

  /** The fiscal year a date falls into, per the configured start month. */
  async fiscalYearFor(date: Date): Promise<number> {
    const { fiscalYearStartMonth } = await this.get();
    return fiscalYearForDate(date, fiscalYearStartMonth);
  }

  /** UTC [start, end] date bounds of a fiscal year. */
  async fiscalYearBounds(
    fiscalYear: number,
  ): Promise<{ start: Date; end: Date }> {
    const { fiscalYearStartMonth } = await this.get();
    return {
      start: fiscalYearStartDate(fiscalYear, fiscalYearStartMonth),
      end: fiscalYearEndDate(fiscalYear, fiscalYearStartMonth),
    };
  }

  /** Whether a post violates segregation of duties (enabled + MANUAL + poster is the creator). */
  async isSegregationViolation(args: {
    sourceType: string;
    createdBy: string;
    postedBy: string;
  }): Promise<boolean> {
    const { segregationOfDutiesEnabled } = await this.get();
    return (
      segregationOfDutiesEnabled &&
      args.sourceType === 'MANUAL' &&
      args.postedBy === args.createdBy
    );
  }

  async update(input: UpdateCompanyInput): Promise<CompanySettings> {
    const current = await this.get();
    return this.prisma.client.companySettings.update({
      where: { id: current.id },
      data: input,
    });
  }
}
