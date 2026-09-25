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
 *
 * Exactly-once: the business transaction marks the row `committedAt` as its
 * last statement (PrismaService.transaction). A committed row is never
 * released or stale-reclaimed, so if the response is lost after the commit
 * (complete() failed, process crashed) a same-key retry gets a 409 saying the
 * write committed — never a second execution.
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

  private get completedTtlMs(): number {
    return (
      this.config.get<number>('IDEMPOTENCY_COMPLETED_TTL_MS') ?? 86_400_000
    );
  }

  async reserve(
    userId: string,
    key: string,
    method: string,
    path: string,
    requestHash: string,
  ): Promise<ReserveResult> {
    return this.reserveOnce(userId, key, method, path, requestHash, true);
  }

  private async reserveOnce(
    userId: string,
    key: string,
    method: string,
    path: string,
    requestHash: string,
    allowReclaim: boolean,
  ): Promise<ReserveResult> {
    try {
      await this.prisma.client.idempotencyKey.create({
        data: { userId, key, method, path, requestHash },
      });
      return { replay: false };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return this.resolveExisting(
          userId,
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
    userId: string,
    key: string,
    method: string,
    path: string,
    requestHash: string,
    allowReclaim: boolean,
  ): Promise<ReserveResult> {
    const record = await this.prisma.client.idempotencyKey.findUnique({
      where: { userId_key: { userId, key } },
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
      if (record.committedAt) {
        // The original request's write committed but its response was never
        // recorded (complete() failed or the process died). Re-executing would
        // duplicate the write, so this key is spent: 409, never a re-run.
        throw new ConflictDomainError(
          "The original request with this idempotency key committed its write, but its response is unavailable; don't retry — look up the resource instead",
          { key, committed: true },
        );
      }
      // In-flight and uncommitted. If the reservation is older than the TTL,
      // the owner died before committing anything; reclaim it once so this
      // retry can proceed. The atomic deleteMany ensures only one racing retry
      // wins, and its committedAt predicate never reclaims a committed row.
      if (allowReclaim && this.isStale(record.createdAt)) {
        // isStale() is a fast in-memory early-exit; the createdAt predicate
        // below is the authoritative atomic filter so only one racing retry wins.
        const cleared = await this.prisma.client.idempotencyKey.deleteMany({
          where: {
            userId,
            key,
            // DbNull matches SQL NULL (the real in-flight state — response was
            // never set). JsonNull would match the JSON literal null, not SQL NULL,
            // and would always match zero rows, making the reclaim a no-op.
            response: { equals: Prisma.DbNull },
            completedAt: null,
            // A committing owner holds this row's lock (its in-tx mark); the
            // delete waits, then re-checks this predicate against the committed
            // row and skips it.
            committedAt: null,
            createdAt: { lt: new Date(Date.now() - this.inflightTtlMs) },
          },
        });
        if (cleared.count > 0) {
          return this.reserveOnce(
            userId,
            key,
            method,
            path,
            requestHash,
            false,
          );
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
    userId: string,
    key: string,
    response: unknown,
    httpStatus: number,
  ): Promise<void> {
    await this.prisma.client.idempotencyKey.update({
      where: { userId_key: { userId, key } },
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

  /** Drop a reservation after a failed request so a retry can re-attempt —
   *  unless its write committed (committedAt set), in which case the row stays
   *  and a retry gets the committed-409. One atomic statement; best-effort. */
  async release(userId: string, key: string): Promise<void> {
    await this.prisma.client.idempotencyKey
      .deleteMany({ where: { userId, key, committedAt: null } })
      .catch(() => undefined);
  }

  /** Best-effort out-of-tx committed mark, for when the handler succeeded but
   *  complete() failed: covers a handler whose write didn't go through
   *  PrismaService.transaction. Swallows errors (the DB may be the failure). */
  async markCommitted(userId: string, key: string): Promise<void> {
    await this.prisma.client.idempotencyKey
      .updateMany({
        where: { userId, key, committedAt: null },
        data: { committedAt: new Date() },
      })
      .catch(() => undefined);
  }

  /**
   * Delete completed idempotency keys older than the retention window, and
   * committed-but-never-completed ones (response lost) likewise — they are
   * never reclaimed, so this is their only expiry. Uncommitted in-flight rows
   * are excluded — the FIN-L2 lazy-expiry remains the sole owner of those.
   * Returns the number of rows deleted.
   */
  async purgeCompleted(
    olderThanMs: number = this.completedTtlMs,
  ): Promise<number> {
    const threshold = new Date(Date.now() - olderThanMs);
    const { count } = await this.prisma.client.idempotencyKey.deleteMany({
      where: {
        OR: [
          { completedAt: { lt: threshold } },
          { completedAt: null, committedAt: { lt: threshold } },
        ],
      },
    });
    return count;
  }
}
