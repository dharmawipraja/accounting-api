import { Semaphore, SemaphoreTimeoutError } from './semaphore';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('Semaphore', () => {
  it('rejects a non-positive capacity', () => {
    expect(() => new Semaphore(0)).toThrow();
  });

  it('runs up to `capacity` tasks concurrently and queues the rest', async () => {
    const sem = new Semaphore(2);
    const gates = [deferred(), deferred(), deferred()];
    let running = 0;
    let peak = 0;
    const tasks = gates.map((g) =>
      sem.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await g.promise;
        running--;
      }, 1_000),
    );
    await Promise.resolve();
    expect(sem.inUse).toBe(2);
    expect(sem.waiting).toBe(1);
    gates.forEach((g) => g.resolve());
    await Promise.all(tasks);
    expect(peak).toBe(2);
    expect(sem.inUse).toBe(0);
    expect(sem.waiting).toBe(0);
  });

  it('releases the permit when the task throws', async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(() => Promise.reject(new Error('boom')), 1_000),
    ).rejects.toThrow('boom');
    expect(sem.inUse).toBe(0);
    await expect(sem.run(() => Promise.resolve(7), 1_000)).resolves.toBe(7);
  });

  it('times out a waiter after the bounded wait and never runs its task', async () => {
    jest.useFakeTimers();
    try {
      const sem = new Semaphore(1);
      const hold = deferred();
      const first = sem.run(() => hold.promise, 1_000);
      const task = jest.fn(() => Promise.resolve());
      const second = sem.run(task, 50);
      jest.advanceTimersByTime(51);
      await expect(second).rejects.toBeInstanceOf(SemaphoreTimeoutError);
      expect(sem.waiting).toBe(0);
      hold.resolve();
      await first;
      expect(task).not.toHaveBeenCalled();
      expect(sem.inUse).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('hands a released permit to the oldest waiter (FIFO)', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const hold = deferred();
    const first = sem.run(() => hold.promise, 1_000);
    const a = sem.run(() => {
      order.push(1);
      return Promise.resolve();
    }, 1_000);
    const b = sem.run(() => {
      order.push(2);
      return Promise.resolve();
    }, 1_000);
    hold.resolve();
    await Promise.all([first, a, b]);
    expect(order).toEqual([1, 2]);
  });
});
