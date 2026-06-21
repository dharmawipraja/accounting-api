import { CompanySettings } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { CompanyService } from './company.service';

function build(settings: Partial<CompanySettings>): CompanyService {
  const svc = new CompanyService(undefined as unknown as PrismaService);
  jest
    .spyOn(svc, 'get')
    .mockResolvedValue(settings as unknown as CompanySettings);
  return svc;
}

describe('CompanyService.fiscalYearFor', () => {
  it('uses the configured start month', async () => {
    const svc = build({ fiscalYearStartMonth: 4 });
    expect(await svc.fiscalYearFor(new Date('2026-03-31T00:00:00Z'))).toBe(
      2025,
    );
    expect(await svc.fiscalYearFor(new Date('2026-04-01T00:00:00Z'))).toBe(
      2026,
    );
  });
});

describe('CompanyService.fiscalYearBounds', () => {
  it('returns April-start FY bounds', async () => {
    const svc = build({ fiscalYearStartMonth: 4 });
    const { start, end } = await svc.fiscalYearBounds(2026);
    expect(start.toISOString().slice(0, 10)).toBe('2026-04-01');
    expect(end.toISOString().slice(0, 10)).toBe('2027-03-31');
  });
  it('returns January-start FY bounds', async () => {
    const svc = build({ fiscalYearStartMonth: 1 });
    const { start, end } = await svc.fiscalYearBounds(2026);
    expect(start.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(end.toISOString().slice(0, 10)).toBe('2026-12-31');
  });
});

describe('CompanyService.isSegregationViolation', () => {
  const A = { sourceType: 'MANUAL', createdBy: 'u1', postedBy: 'u1' };
  it('true when enabled, MANUAL, and poster is the creator', async () => {
    const svc = build({ segregationOfDutiesEnabled: true });
    expect(await svc.isSegregationViolation(A)).toBe(true);
  });
  it('false when the poster differs from the creator', async () => {
    const svc = build({ segregationOfDutiesEnabled: true });
    expect(await svc.isSegregationViolation({ ...A, postedBy: 'u2' })).toBe(
      false,
    );
  });
  it('false for non-MANUAL source types', async () => {
    const svc = build({ segregationOfDutiesEnabled: true });
    expect(
      await svc.isSegregationViolation({ ...A, sourceType: 'SALES_INVOICE' }),
    ).toBe(false);
  });
  it('false when the flag is disabled', async () => {
    const svc = build({ segregationOfDutiesEnabled: false });
    expect(await svc.isSegregationViolation(A)).toBe(false);
  });
});
