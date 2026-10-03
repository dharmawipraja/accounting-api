import { yearNotEndedViolation } from './close-date-rule';

describe('yearNotEndedViolation', () => {
  const end = new Date('2026-12-31');
  it('null once the year has ended (today after the last day)', () => {
    expect(yearNotEndedViolation(2026, end, new Date('2027-01-01'))).toBeNull();
  });
  it('details on the last day itself (that day can still receive postings)', () => {
    expect(
      yearNotEndedViolation(2026, end, new Date('2026-12-31T16:00:00Z')),
    ).toEqual({ fiscalYear: 2026, yearEnd: '2026-12-31' });
  });
  it('details while the year is still running', () => {
    expect(yearNotEndedViolation(2026, end, new Date('2026-12-30'))).toEqual({
      fiscalYear: 2026,
      yearEnd: '2026-12-31',
    });
  });
});
