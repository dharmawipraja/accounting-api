import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { applySoftDelete, ExtendedPrismaClient } from './soft-delete.extension';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  /** Soft-delete-extended client. Always use this for data access. */
  readonly client: ExtendedPrismaClient;

  constructor(config: ConfigService) {
    const adapter = new PrismaPg({
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
      max: config.get<number>('DB_POOL_MAX') ?? 15,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      statement_timeout: config.get<number>('DB_STATEMENT_TIMEOUT_MS') ?? 30000,
    });
    super({ adapter });
    this.client = applySoftDelete(this);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
