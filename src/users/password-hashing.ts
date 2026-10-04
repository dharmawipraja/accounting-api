import { ServiceUnavailableException } from '@nestjs/common';
import * as argon2 from 'argon2';
import {
  Semaphore,
  SemaphoreTimeoutError,
} from '../common/concurrency/semaphore';

/** Longest a caller queues for an argon2 permit before a 503 (ms). */
const ARGON2_QUEUE_TIMEOUT_MS = 5_000;

interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

/**
 * argon2id hash/verify behind a process-wide concurrency cap. Each operation
 * allocates ~64 MiB and burns CPU for tens of ms, so an unbounded burst (e.g. a
 * login spray against the decoy hash) could exhaust memory. Excess callers wait
 * FIFO; waiting longer than `timeoutMs` fails fast with 503 (retryable) rather
 * than piling up requests until the 35s request timeout.
 */
export function createPasswordHasher(
  capacity: number,
  timeoutMs: number,
): PasswordHasher {
  const gate = new Semaphore(capacity);
  const guarded = async <T>(task: () => Promise<T>): Promise<T> => {
    try {
      return await gate.run(task, timeoutMs);
    } catch (err) {
      if (err instanceof SemaphoreTimeoutError) {
        throw new ServiceUnavailableException(
          'Authentication is busy, retry shortly',
        );
      }
      throw err;
    }
  };
  return {
    hash: (password) => guarded(() => argon2.hash(password)),
    verify: (hash, password) => guarded(() => argon2.verify(hash, password)),
  };
}

/** The shared per-process hasher (ARGON2_MAX_CONCURRENCY, default 8). Read at
 *  module load like throttle.config; EnvVars validates the override (1-64). */
export const passwordHasher: PasswordHasher = createPasswordHasher(
  Number(process.env.ARGON2_MAX_CONCURRENCY) || 8,
  ARGON2_QUEUE_TIMEOUT_MS,
);
