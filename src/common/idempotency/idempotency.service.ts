import { Injectable } from '@nestjs/common';
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
  constructor(private readonly prisma: PrismaService) {}

  async reserve(
    key: string,
    method: string,
    path: string,
    requestHash: string,
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
        return this.resolveExisting(key, method, path, requestHash);
      }
      throw err;
    }
  }

  private async resolveExisting(
    key: string,
    method: string,
    path: string,
    requestHash: string,
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
