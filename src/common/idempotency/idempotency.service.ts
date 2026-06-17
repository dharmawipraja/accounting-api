import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ConflictDomainError,
  ValidationFailedError,
} from '../errors/domain-errors';

export type ReserveResult =
  | { replay: false }
  | { replay: true; response: unknown; httpStatus: number };

/**
 * Reserve-first idempotency: a fresh key inserts a reservation row (response
 * null = in flight); a repeated key replays the stored response, 422s on
 * endpoint/body mismatch, or 409s while still in flight. complete() stores a
 * JSON snapshot of the response; release() drops a reservation after a failure
 * so a retry can re-attempt (failures are never cached).
 */
@Injectable()
export class IdempotencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get inflightTtlMs(): number {
    return this.config.get<number>('IDEMPOTENCY_INFLIGHT_TTL_MS') ?? 120_000;
  }

  async reserve(
    key: string,
    method: string,
    path: string,
    requestHash: string,
  ): Promise<ReserveResult> {
    return this.reserveOnce(key, method, path, requestHash, true);
  }

  private async reserveOnce(
    key: string,
    method: string,
    path: string,
    requestHash: string,
    allowReclaim: boolean,
  ): Promise<ReserveResult> {
    try {
      await this.prisma.client.idempotencyKey.create({
        data: { key, method, path, requestHash },
      });
      return { replay: false };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return this.resolveExisting(
          key,
          method,
          path,
          requestHash,
          allowReclaim,
        );
      }
      throw err;
    }
  }

  private async resolveExisting(
    key: string,
    method: string,
    path: string,
    requestHash: string,
    allowReclaim: boolean,
  ): Promise<ReserveResult> {
    const record = await this.prisma.client.idempotencyKey.findUnique({
      where: { key },
    });
    if (!record) {
      // The owner errored and released the row between our create and read.
      throw new ConflictDomainError(
        'A request with this idempotency key is in progress',
        { key },
      );
    }
    if (record.method !== method || record.path !== path) {
      throw new ValidationFailedError(
        'Idempotency-Key already used for a different endpoint',
        { key },
      );
    }
    if (record.requestHash !== requestHash) {
      throw new ValidationFailedError(
        'Idempotency-Key already used with a different request body',
        { key },
      );
    }
    if (record.response === null || record.httpStatus === null) {
      // In-flight. If the reservation is older than the TTL, the owner crashed
      // between its commit and complete(); reclaim it once so this retry can
      // proceed. The atomic deleteMany ensures only one racing retry wins.
      if (allowReclaim && this.isStale(record.createdAt)) {
        // isStale() is a fast in-memory early-exit; the createdAt predicate
        // below is the authoritative atomic filter so only one racing retry wins.
        const cleared = await this.prisma.client.idempotencyKey.deleteMany({
          where: {
            key,
            // DbNull matches SQL NULL (the real in-flight state — response was
            // never set). JsonNull would match the JSON literal null, not SQL NULL,
            // and would always match zero rows, making the reclaim a no-op.
            response: { equals: Prisma.DbNull },
            completedAt: null,
            createdAt: { lt: new Date(Date.now() - this.inflightTtlMs) },
          },
        });
        if (cleared.count > 0) {
          return this.reserveOnce(key, method, path, requestHash, false);
        }
      }
      throw new ConflictDomainError(
        'A request with this idempotency key is in progress',
        { key },
      );
    }
    return {
      replay: true,
      response: record.response,
      httpStatus: record.httpStatus,
    };
  }

  private isStale(createdAt: Date | null | undefined): boolean {
    if (!createdAt) return false;
    return Date.now() - new Date(createdAt).getTime() > this.inflightTtlMs;
  }

  async complete(
    key: string,
    response: unknown,
    httpStatus: number,
  ): Promise<void> {
    await this.prisma.client.idempotencyKey.update({
      where: { key },
      data: {
        // Round-trip to a pure JSON value so Dates serialize exactly as the HTTP
        // response would, and Prisma accepts it as Json.
        response: JSON.parse(
          JSON.stringify(response ?? null),
        ) as Prisma.InputJsonValue,
        httpStatus,
        completedAt: new Date(),
      },
    });
  }

  async release(key: string): Promise<void> {
    await this.prisma.client.idempotencyKey
      .delete({ where: { key } })
      .catch(() => undefined);
  }
}
