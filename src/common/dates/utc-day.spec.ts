import { truncateToUtcDay } from './utc-day';

describe('truncateToUtcDay', () => {
  it('drops the time-of-day in UTC', () => {
    expect(
      truncateToUtcDay(new Date('2026-03-15T13:45:30.500Z')).toISOString(),
    ).toBe('2026-03-15T00:00:00.000Z');
  });
  it('is idempotent on an already-truncated date', () => {
    const d = new Date('2026-03-15T00:00:00.000Z');
    expect(truncateToUtcDay(d).toISOString()).toBe('2026-03-15T00:00:00.000Z');
  });
});
