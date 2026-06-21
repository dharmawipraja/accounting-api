import {
  fiscalYearForDate,
  fiscalYearStartDate,
  fiscalYearEndDate,
} from './fiscal-year';

describe('fiscalYearForDate', () => {
  it('returns the calendar year when month >= start month', () => {
    expect(fiscalYearForDate(new Date('2026-07-01T00:00:00Z'), 7)).toBe(2026);
  });
  it('returns the prior year when month < start month', () => {
    expect(fiscalYearForDate(new Date('2026-06-30T00:00:00Z'), 7)).toBe(2025);
  });
  it('handles a January start month (calendar year)', () => {
    expect(fiscalYearForDate(new Date('2026-12-31T00:00:00Z'), 1)).toBe(2026);
  });
});

describe('fiscalYearStartDate', () => {
  it('January start → Jan 1 of the fiscal year', () => {
    expect(fiscalYearStartDate(2026, 1).toISOString().slice(0, 10)).toBe(
      '2026-01-01',
    );
  });
  it('April start → Apr 1 of the fiscal year', () => {
    expect(fiscalYearStartDate(2026, 4).toISOString().slice(0, 10)).toBe(
      '2026-04-01',
    );
  });
});

describe('fiscalYearEndDate', () => {
  it('January start → Dec 31 of the same year', () => {
    expect(fiscalYearEndDate(2026, 1).toISOString().slice(0, 10)).toBe(
      '2026-12-31',
    );
  });
  it('April start → Mar 31 of the next year', () => {
    expect(fiscalYearEndDate(2026, 4).toISOString().slice(0, 10)).toBe(
      '2027-03-31',
    );
  });
});
