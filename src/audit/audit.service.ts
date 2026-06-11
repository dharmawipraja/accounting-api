import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

export interface AuditEntry {
  userId: string | null;
  userRole: string | null;
  method: string;
  path: string;
  params: unknown;
  body: unknown;
  statusCode: number;
  durationMs: number;
  ip: string | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  constructor(private readonly prisma: PrismaService) {}

  /** Append-only. Never throws — an audit failure must not break the request. */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.client.auditLog.create({
        data: {
          userId: entry.userId,
          userRole: entry.userRole,
          method: entry.method,
          path: entry.path,
          params: entry.params ?? {},
          body: entry.body ?? {},
          statusCode: entry.statusCode,
          durationMs: entry.durationMs,
          ip: entry.ip,
        },
      });
    } catch (err) {
      this.logger.error(`Failed to write audit log: ${String(err)}`);
    }
  }

  async list(filter: {
    userId?: string;
    method?: string;
    from?: Date;
    to?: Date;
    limit: number;
    offset: number;
  }) {
    return this.prisma.client.auditLog.findMany({
      where: {
        userId: filter.userId,
        method: filter.method,
        timestamp: { gte: filter.from, lte: filter.to },
      },
      orderBy: { timestamp: 'desc' },
      take: filter.limit,
      skip: filter.offset,
    });
  }
}
