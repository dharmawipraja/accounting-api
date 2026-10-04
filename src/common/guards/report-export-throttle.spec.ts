import { isFileExport, reportExportThrottler } from './report-export-throttle';

describe('report export throttler', () => {
  const ctx = (query: Record<string, string>) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ query }) }) }) as never;
  const t = reportExportThrottler();

  it('counts only file exports (?format=), never plain JSON report calls', () => {
    expect(isFileExport({ query: { format: 'csv' } })).toBe(true);
    expect(isFileExport({ query: { format: 'pdf' } })).toBe(true);
    expect(isFileExport({ query: { asOf: '2026-01-31' } })).toBe(false);
    expect(isFileExport({})).toBe(false);
    const skipIf = t.skipIf as (c: unknown) => boolean;
    expect(skipIf(ctx({ format: 'xlsx' }))).toBe(false);
    expect(skipIf(ctx({ asOf: '2026-01-31' }))).toBe(true);
  });

  it('tracks per user, falling back to the client IP', () => {
    const track = t.getTracker as (r: Record<string, unknown>) => string;
    expect(track({ user: { id: 'u1' }, ip: '1.2.3.4' })).toBe('export:user:u1');
    expect(track({ ip: '1.2.3.4' })).toBe('export:ip:1.2.3.4');
  });
});
