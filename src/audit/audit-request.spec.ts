import {
  auditBaseOf,
  markAudited,
  shouldAuditRejection,
  type AuditableRequest,
} from './audit-request';

const req = (over: Partial<AuditableRequest> = {}): AuditableRequest => ({
  method: 'POST',
  originalUrl: '/v1/partners?x=1',
  url: '/partners',
  params: { id: 'p1' },
  body: { name: 'A', password: 'p' },
  ip: '1.2.3.4',
  id: 'srv-1',
  clientRequestId: 'cli-1',
  user: { id: 'u1', role: 'ADMIN' },
  ...over,
});

describe('auditBaseOf', () => {
  it('builds the shared audit fields with a sanitized body', () => {
    expect(auditBaseOf(req(), { withBody: true })).toEqual({
      userId: 'u1',
      userRole: 'ADMIN',
      method: 'POST',
      path: '/v1/partners?x=1',
      params: { id: 'p1' },
      body: { name: 'A', password: '[REDACTED]' },
      ip: '1.2.3.4',
      requestId: 'srv-1',
      clientRequestId: 'cli-1',
    });
  });

  it('omits the body when asked and tolerates missing fields', () => {
    const base = auditBaseOf(
      {
        method: 'DELETE',
        url: '/v1/x',
        params: undefined as unknown as Record<string, unknown>,
        body: { a: 1 },
      },
      { withBody: false },
    );
    expect(base).toMatchObject({
      userId: null,
      userRole: null,
      path: '/v1/x',
      params: {},
      body: {},
      ip: null,
      requestId: null,
      clientRequestId: null,
    });
  });

  it('stringifies a numeric request id', () => {
    expect(auditBaseOf(req({ id: 7 }), { withBody: true }).requestId).toBe('7');
  });
});

describe('shouldAuditRejection', () => {
  it('audits guard rejections (401/403/429) on mutating requests', () => {
    for (const s of [401, 403, 429])
      expect(shouldAuditRejection(req(), s)).toBe(true);
  });

  it('skips reads, other statuses, and requests the interceptor already audited', () => {
    expect(shouldAuditRejection(req({ method: 'GET' }), 401)).toBe(false);
    expect(shouldAuditRejection(req(), 404)).toBe(false);
    expect(shouldAuditRejection(req(), 500)).toBe(false);
    const audited = req();
    markAudited(audited);
    expect(shouldAuditRejection(audited, 403)).toBe(false);
  });
});
