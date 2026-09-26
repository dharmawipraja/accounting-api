import { yearNotEndedViolation } from './close-date-rule';

describe('yearNotEndedViolation', () => {
  const end = new Date('2026-12-31');
  it('null once the year has ended (today after the last day)', () => {
    expect(yearNotEndedViolation(2026, end, new Date('2027-01-01'))).toBeNull();
  });
  it('null on the last day itself', () => {
    expect(
      yearNotEndedViolation(2026, end, new Date('2026-12-31T16:00:00Z')),
    ).toBeNull();
  });
  it('details while the year is still running', () => {
    expect(yearNotEndedViolation(2026, end, new Date('2026-12-30'))).toEqual({
      fiscalYear: 2026,
      yearEnd: '2026-12-31',
    });
  });
});
