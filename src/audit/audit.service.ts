import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { toStorableString } from '../common/text/unicode-hygiene';
import { toStorableJson } from './audit-sanitize';
import { pgSqlStateOf } from '../common/errors/exception-status';

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
  requestId: string | null;
  clientRequestId: string | null;
  entityId: string | null;
}

/** Body stored by the fallback row when the real one could not be inserted. */
export const UNSTORABLE_BODY = { _unstorable: true } as const;

/** SQLSTATEs meaning the row's CONTENT was rejected (not the database being
 *  unavailable): 22021 character_not_in_repertoire, 22P05
 *  untranslatable_character, 22P02 invalid_text_representation (e.g. bad
 *  jsonb text), 22001 string_data_right_truncation, 54000
 *  program_limit_exceeded (e.g. a jsonb value over a size limit). Only these
 *  are worth the `_unstorable` retry — on a connection / pool / timeout
 *  error the retry would just wait as long again. */
const AUDIT_CONTENT_PG_CODES = new Set([
  '22021',
  '22P05',
  '22P02',
  '22001',
  '54000',
]);

/** True when an audit INSERT failed because of what the row holds (see
 *  AUDIT_CONTENT_PG_CODES). Pure. */
export function isAuditContentError(err: unknown): boolean {
  const code = pgSqlStateOf(err);
  return code !== undefined && AUDIT_CONTENT_PG_CODES.has(code);
}

const storableOrNull = (s: string | null): string | null =>
  s === null ? null : toStorableString(s);

/** The insert payload for `entry`, with every caller-derived string made
 *  storable (see AuditService.record). Pure. */
export function storableRow(
  entry: AuditEntry,
): Prisma.AuditLogUncheckedCreateInput {
  return {
    userId: entry.userId,
    userRole: entry.userRole,
    method: toStorableString(entry.method),
    path: toStorableString(entry.path),
    params: toStorableJson(entry.params) ?? {},
    body: toStorableJson(entry.body) ?? {},
    statusCode: entry.statusCode,
    durationMs: entry.durationMs,
    ip: storableOrNull(entry.ip),
    requestId: storableOrNull(entry.requestId),
    clientRequestId: storableOrNull(entry.clientRequestId),
    entityId: entry.entityId,
  };
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  constructor(private readonly prisma: PrismaService) {}

  /** Append-only. Never throws — an audit failure must not break the request.
   *  Never drops a row because of its CONTENT: every string field is made
   *  storable first (lone surrogates → U+FFFD, U+0000 removed — jsonb and
   *  text reject them), and if the INSERT still fails on content
   *  (`isAuditContentError`) it is retried ONCE with the body replaced by
   *  `{ _unstorable: true }` and params by `{}` (method / path / user /
   *  status / requestId kept) after logging the original error. Any other
   *  failure (connection lost, pool exhausted, timeout) is logged once and
   *  NOT retried: a retry would only double the wait during an outage. */
  async record(entry: AuditEntry): Promise<void> {
    const data = storableRow(entry);
    try {
      await this.prisma.client.auditLog.create({ data });
    } catch (err) {
      if (!isAuditContentError(err)) {
        this.logger.error(`Failed to write audit log: ${String(err)}`);
        return;
      }
      this.logger.error(
        `Failed to write audit log (content rejected); retrying with an _unstorable body: ${String(err)}`,
      );
      try {
        await this.prisma.client.auditLog.create({
          data: { ...data, params: {}, body: UNSTORABLE_BODY },
        });
      } catch (retryErr) {
        this.logger.error(
          `Failed to write the fallback audit row: ${String(retryErr)}`,
        );
      }
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
