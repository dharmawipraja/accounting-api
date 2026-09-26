import {
  AUDIT_BODY_MAX_BYTES,
  auditBaseOf,
  auditBodyAllowed,
  capBody,
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

const hasLoneSurrogate = (s: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
    s,
  );

describe('auditBaseOf size caps', () => {
  it('caps path at 512 chars and serializes oversized params to ≤ 512 chars', () => {
    const base = auditBaseOf(
      req({
        originalUrl: '/v1/partners?q=' + 'x'.repeat(2_000),
        params: { a: 'y'.repeat(2_000) },
      }),
      { withBody: true },
    );
    expect(base.path).toHaveLength(512);
    expect(typeof base.params).toBe('string');
    expect((base.params as string).length).toBeLessThanOrEqual(512);
  });

  it('truncates oversized params by code point: an emoji at the boundary is never split into a lone surrogate', () => {
    // JSON.stringify({a: 'x'.repeat(n) + '😀…'}) puts the emoji's two UTF-16
    // units at positions 510/511 → a UTF-16 slice(0, 511) would end on a lone
    // high surrogate, which Postgres rejects in jsonb ("unsupported Unicode escape").
    const prefix = '{"a":"'.length; // 6
    for (const pad of [510 - prefix, 511 - prefix, 512 - prefix]) {
      const base = auditBaseOf(
        req({ params: { a: 'x'.repeat(pad) + '😀'.repeat(300) } }),
        { withBody: true },
      );
      const out = base.params as string;
      expect(typeof out).toBe('string');
      expect(Array.from(out).length).toBeLessThanOrEqual(512);
      expect(hasLoneSurrogate(out)).toBe(false);
    }
  });

  it('never leaves a lone surrogate at the path cap either', () => {
    const base = auditBaseOf(
      req({ originalUrl: '/' + 'x'.repeat(510) + '😀'.repeat(10) }),
      { withBody: true },
    );
    expect(hasLoneSurrogate(base.path)).toBe(false);
    expect(Array.from(base.path).length).toBeLessThanOrEqual(512);
  });

  it('keeps small params as an object', () => {
    expect(auditBaseOf(req(), { withBody: true }).params).toEqual({
      id: 'p1',
    });
  });
});

describe('capBody (AUDIT3-17)', () => {
  it('returns small bodies unchanged (identity)', () => {
    const body = { name: 'A', lines: [{ qty: '1' }] };
    expect(capBody(body)).toBe(body);
    expect(capBody(undefined)).toBeUndefined();
    expect(capBody(null)).toBeNull();
  });

  it('keeps a body of exactly the byte cap', () => {
    // {"k":"…"} = 8 bytes of JSON syntax + payload
    const body = { k: 'x'.repeat(AUDIT_BODY_MAX_BYTES - 8) };
    expect(JSON.stringify(body)).toHaveLength(AUDIT_BODY_MAX_BYTES);
    expect(capBody(body)).toBe(body);
  });

  it('replaces an oversized body with a small, valid-JSON marker object', () => {
    const body = { junk: 'x'.repeat(50 * 1024) };
    const capped = capBody(body) as {
      _truncated: boolean;
      bytes: number;
      preview: string;
    };
    expect(capped._truncated).toBe(true);
    expect(capped.bytes).toBe(Buffer.byteLength(JSON.stringify(body)));
    expect(Array.from(capped.preview)).toHaveLength(1024);
    expect(capped.preview.startsWith('{"junk":"xxx')).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThan(2048);
  });

  it('measures UTF-8 bytes, not UTF-16 units, and never splits a surrogate pair', () => {
    // 2100 emoji = 4200 UTF-16 units but 8400 UTF-8 bytes → over the cap
    const body = { e: '😀'.repeat(2100) };
    expect(JSON.stringify(body).length).toBeLessThan(AUDIT_BODY_MAX_BYTES);
    const capped = capBody(body) as { preview: string; bytes: number };
    expect(capped.bytes).toBeGreaterThan(AUDIT_BODY_MAX_BYTES);
    expect(hasLoneSurrogate(capped.preview)).toBe(false);
  });

  it('auditBaseOf stores the capped (sanitized) body', () => {
    const base = auditBaseOf(
      req({ body: { password: 'p', junk: 'y'.repeat(20_000) } }),
      { withBody: true },
    );
    expect(base.body).toMatchObject({ _truncated: true });
    expect((base.body as { preview: string }).preview).toContain(
      '"password":"[REDACTED]"',
    );
  });
});

describe('auditBodyAllowed', () => {
  it('anonymous 4xx never stores the body', () => {
    for (const status of [400, 401, 404, 408, 413, 429]) {
      expect(auditBodyAllowed({}, status)).toBe(false);
    }
  });

  it('anonymous success / 5xx and every authenticated outcome keep it', () => {
    expect(auditBodyAllowed({}, 200)).toBe(true);
    expect(auditBodyAllowed({}, 500)).toBe(true);
    const user = { id: 'u1', role: 'ADMIN' };
    for (const status of [200, 400, 403, 429, 500]) {
      expect(auditBodyAllowed({ user }, status)).toBe(true);
    }
  });
});
