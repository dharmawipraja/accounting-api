/** Thrown when a caller waited longer than its bound for a permit. */
export class SemaphoreTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Timed out after ${timeoutMs}ms waiting for a concurrency permit`);
    this.name = 'SemaphoreTimeoutError';
  }
}

interface Waiter {
  grant: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A tiny in-process counting semaphore with FIFO hand-off and a bounded wait.
 * Pure (no Nest/DB) so it is unit-testable; used to cap concurrent argon2 work.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`Semaphore capacity must be a positive integer`);
    }
  }

  get inUse(): number {
    return this.active;
  }

  get waiting(): number {
    return this.queue.length;
  }

  /** Run `task` holding a permit; wait at most `timeoutMs` to obtain one. */
  async run<T>(task: () => Promise<T>, timeoutMs: number): Promise<T> {
    await this.acquire(timeoutMs);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(timeoutMs: number): Promise<void> {
    if (this.active < this.capacity) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        // The permit is transferred directly (active is NOT decremented on
        // release when a waiter exists), so no barging between release/grant.
        grant: () => {
          clearTimeout(waiter.timer);
          resolve();
        },
        timer: setTimeout(() => {
          const i = this.queue.indexOf(waiter);
          if (i !== -1) this.queue.splice(i, 1);
          reject(new SemaphoreTimeoutError(timeoutMs));
        }, timeoutMs),
      };
      this.queue.push(waiter);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next.grant();
    else this.active--;
  }
}
