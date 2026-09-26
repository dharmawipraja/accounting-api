import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  AUDIT_ANON_BODY_MAX_BYTES,
  AUDIT_BODY_MAX_BYTES,
  AUDIT_LOGIN_EMAIL_MAX,
  AUDIT_SMALL_BODY_MAX_BYTES,
  auditBaseOf,
  auditBodyAllowed,
  auditBodyCap,
  auditBodyOf,
  bindsRequestBody,
  capBody,
  markAudited,
  loginAttemptBody,
  shouldAuditRejection,
  withheldBody,
  type AuditableRequest,
} from './audit-request';
import { markLoginAttempt } from '../common/guards/login-ip-throttle';
import { InvalidCharactersError } from '../common/errors/domain-errors';
import { CreateJournalEntryDto } from '../ledger/journal/dto/create-journal-entry.dto';
import { OpeningBalancesDto } from '../ledger/journal/dto/opening-balances.dto';
import { CreateSalesInvoiceDto } from '../invoicing/dto/create-sales-invoice.dto';
import { CreatePurchaseBillDto } from '../invoicing/dto/create-purchase-bill.dto';
import { CreatePaymentDto } from '../invoicing/dto/create-payment.dto';
import { PreviewJournalEntryDto } from '../invoicing/dto/preview-journal-entry.dto';
import { CalculateTaxDto } from '../tax/dto/calculate-tax.dto';
import { MAX_LINE_ITEMS, MAX_TAX_CODES_PER_LINE } from '../common/dto/limits';

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
    expect(auditBaseOf(req(), { status: 201 })).toEqual({
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

  it('an anonymous 4xx withholds the body and tolerates missing fields', () => {
    const base = auditBaseOf(
      {
        method: 'DELETE',
        url: '/v1/x',
        params: undefined as unknown as Record<string, unknown>,
        body: { a: 1 },
      },
      { status: 400 },
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
    expect(auditBaseOf(req({ id: 7 }), { status: 201 }).requestId).toBe('7');
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

  it('audits an input-hygiene 400 (InvalidCharactersError) on a mutating request only', () => {
    const bad = new InvalidCharactersError('x');
    expect(shouldAuditRejection(req(), 400, bad)).toBe(true);
    expect(shouldAuditRejection(req({ method: 'GET' }), 400, bad)).toBe(false);
    expect(shouldAuditRejection(req(), 400, new Error('x'))).toBe(false);
    expect(shouldAuditRejection(req(), 400)).toBe(false);
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
      { status: 201 },
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
        { status: 201 },
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
      { status: 201 },
    );
    expect(hasLoneSurrogate(base.path)).toBe(false);
    expect(Array.from(base.path).length).toBeLessThanOrEqual(512);
  });

  it('keeps small params as an object', () => {
    expect(auditBaseOf(req(), { status: 201 }).params).toEqual({
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

  it('keeps a body of exactly the byte cap (both caps)', () => {
    // {"k":"…"} = 8 bytes of JSON syntax + payload
    for (const cap of [AUDIT_BODY_MAX_BYTES, AUDIT_ANON_BODY_MAX_BYTES]) {
      const body = { k: 'x'.repeat(cap - 8) };
      expect(JSON.stringify(body)).toHaveLength(cap);
      expect(capBody(body, cap)).toBe(body);
      expect(capBody({ k: 'x'.repeat(cap - 7) }, cap)).toMatchObject({
        _truncated: true,
      });
    }
  });

  it('defaults to the authenticated cap', () => {
    const body = { k: 'x'.repeat(AUDIT_BODY_MAX_BYTES - 8) };
    expect(capBody(body)).toBe(body);
  });

  it('replaces an oversized body with a small, valid-JSON marker object', () => {
    const body = { junk: 'x'.repeat(AUDIT_BODY_MAX_BYTES + 1) };
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
    // 2100 emoji = 4200 UTF-16 units but 8400 UTF-8 bytes → over the anon cap
    const body = { e: '😀'.repeat(2100) };
    expect(JSON.stringify(body).length).toBeLessThan(AUDIT_ANON_BODY_MAX_BYTES);
    const capped = capBody(body, AUDIT_ANON_BODY_MAX_BYTES) as {
      preview: string;
      bytes: number;
    };
    expect(capped.bytes).toBeGreaterThan(AUDIT_ANON_BODY_MAX_BYTES);
    expect(hasLoneSurrogate(capped.preview)).toBe(false);
  });

  it('auditBaseOf stores the capped (sanitized) body — anonymous rows at 8 KiB', () => {
    const base = auditBaseOf(
      req({
        user: undefined,
        body: { password: 'p', junk: 'y'.repeat(20_000) },
      }),
      { status: 201 },
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

// ── Iteration-3 final wave ────────────────────────────────────────────────
const U = '00000000-0000-4000-8000-000000000000';
const M = '9999999999999999.9999'; // 16 integer digits + 4dp: the widest money string
// '\u0001' is escaped by JSON.stringify to 6 bytes (\u0001) — the worst case
// per UTF-16 unit, so these bodies bound EVERY DTO-valid body from above.
const worst = (n: number) => '\u0001'.repeat(n);
const docLine = () => ({
  description: worst(255),
  accountId: U,
  quantity: M,
  unitPrice: M,
  taxCodeIds: Array<string>(MAX_TAX_CODES_PER_LINE).fill(U),
});
const jeLine = () => ({
  accountId: U,
  debit: M,
  credit: M,
  description: worst(500),
});
const taxableLine = () => ({
  accountId: U,
  amount: M,
  taxCodeIds: Array<string>(MAX_TAX_CODES_PER_LINE).fill(U),
});
const allocation = () => ({ salesInvoiceId: U, purchaseBillId: U, amount: M });
const times = <T>(f: () => T) => Array.from({ length: MAX_LINE_ITEMS }, f);
const MAX_BODIES: [string, new () => object, object][] = [
  [
    'journal entry',
    CreateJournalEntryDto,
    { date: '2026-01-01', description: worst(500), lines: times(jeLine) },
  ],
  [
    'opening balances',
    OpeningBalancesDto,
    { date: '2026-01-01', balances: times(jeLine) },
  ],
  [
    'sales invoice',
    CreateSalesInvoiceDto,
    {
      partnerId: U,
      date: '2026-01-01',
      dueDate: '2026-01-31',
      description: worst(255),
      lines: times(docLine),
    },
  ],
  [
    'purchase bill',
    CreatePurchaseBillDto,
    {
      partnerId: U,
      vendorInvoiceNo: worst(64),
      date: '2026-01-01',
      dueDate: '2026-01-31',
      description: worst(255),
      lines: times(docLine),
    },
  ],
  [
    'payment',
    CreatePaymentDto,
    {
      direction: 'RECEIPT',
      partnerId: U,
      date: '2026-01-01',
      cashAccountId: U,
      description: worst(255),
      allocations: times(allocation),
    },
  ],
];

/** Read-only POSTs (`@ReadOnlyPost()`: /tax/calculate, /journal-entries/preview)
 *  change no state, so they always take the 8 KiB tier (iteration-5 ruling). */
const READ_ONLY_MAX_BODIES: [string, new () => object, object][] = [
  [
    'tax calculate',
    CalculateTaxDto,
    {
      nature: 'PURCHASE',
      settlementAccountId: U,
      lines: times(taxableLine),
    },
  ],
  [
    'journal preview',
    PreviewJournalEntryDto,
    {
      nature: 'SALE',
      date: '2026-01-01',
      settlementAccountId: U,
      lines: times(taxableLine),
    },
  ],
];

describe('I1: the authenticated body cap never truncates a DTO-valid write', () => {
  it.each(MAX_BODIES)(
    'a maximal valid %s body is stored untruncated',
    (_name, Dto, body) => {
      // Proves the body really is DTO-valid (same options as main.ts).
      const errors = validateSync(plainToInstance(Dto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      expect(errors).toEqual([]);
      const bytes = Buffer.byteLength(JSON.stringify(body));
      expect(bytes).toBeGreaterThan(AUDIT_ANON_BODY_MAX_BYTES); // would have been lost
      expect(bytes).toBeLessThanOrEqual(AUDIT_BODY_MAX_BYTES);
      expect(capBody(body)).toBe(body);
      const base = auditBaseOf(req({ body }), { status: 201 });
      expect(base.body).toEqual(body);
    },
  );

  it('anonymous rows keep the 8 KiB cap', () => {
    const body = { note: 'x'.repeat(AUDIT_ANON_BODY_MAX_BYTES) };
    expect(
      auditBaseOf(req({ user: undefined, body }), { status: 201 }).body,
    ).toMatchObject({ _truncated: true });
    expect(auditBaseOf(req({ body }), { status: 201 }).body).toEqual(body);
  });
});

describe('I2: failed-login forensic email', () => {
  it('loginAttemptBody keeps ONLY the trimmed, lowercased email', () => {
    expect(
      loginAttemptBody({ email: '  Foo@Bar.IO ', password: 'hunter2' }),
    ).toEqual({ email: 'foo@bar.io' });
  });

  it('caps the email at 254 code points without splitting a surrogate pair', () => {
    const out = loginAttemptBody({ email: 'a'.repeat(253) + '😀😀' }) as {
      email: string;
    };
    expect(Array.from(out.email)).toHaveLength(AUDIT_LOGIN_EMAIL_MAX);
    expect(hasLoneSurrogate(out.email)).toBe(false);
  });

  it('stores {} for a missing, blank or non-string email', () => {
    for (const body of [
      undefined,
      null,
      'x',
      {},
      { email: '   ' },
      { email: 42 },
      { email: ['a@b.io'] },
    ]) {
      expect(loginAttemptBody(body)).toEqual({});
    }
  });

  it('withheldBody is {} except on a marked login attempt', () => {
    const plain = req({
      user: undefined,
      body: { email: 'A@b.io', password: 'p' },
    });
    expect(withheldBody(plain)).toEqual({});
    markLoginAttempt(plain);
    expect(withheldBody(plain)).toEqual({ email: 'a@b.io' });
  });

  it('auditBaseOf on an anonymous 4xx stores the email for a login attempt, never the password', () => {
    const r = req({
      user: undefined,
      body: { email: 'X@Y.io', password: 'secret' },
    });
    markLoginAttempt(r);
    const base = auditBaseOf(r, { status: 400 });
    expect(base.body).toEqual({ email: 'x@y.io' });
    expect(JSON.stringify(base)).not.toContain('secret');
  });
});

describe('iteration-4 audit body cap ruling', () => {
  const big = { junk: 'q'.repeat(500 * 1024) };
  const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

  it('auditBodyCap: 512 KiB only for an authenticated 2xx, 8 KiB otherwise', () => {
    const user = { id: 'u1', role: 'VIEWER' };
    expect(auditBodyCap({ user }, 200)).toBe(AUDIT_BODY_MAX_BYTES);
    expect(auditBodyCap({ user }, 201)).toBe(AUDIT_BODY_MAX_BYTES);
    for (const status of [400, 403, 408, 422, 429, 500]) {
      expect(auditBodyCap({ user }, status)).toBe(AUDIT_SMALL_BODY_MAX_BYTES);
    }
    expect(auditBodyCap({}, 200)).toBe(AUDIT_SMALL_BODY_MAX_BYTES);
    expect(auditBodyCap({}, 500)).toBe(AUDIT_SMALL_BODY_MAX_BYTES);
  });

  it('an authenticated rejection (403 / 400 / 5xx) stores <= 8 KiB of a 500 KB body', () => {
    for (const status of [400, 403, 409, 422, 429, 500]) {
      const body = auditBodyOf(req({ body: big }), status, true);
      expect(body).toMatchObject({ _truncated: true });
      expect(size(body)).toBeLessThanOrEqual(AUDIT_SMALL_BODY_MAX_BYTES);
    }
  });

  it('a bodyless handler stores {} whatever the status / caller', () => {
    for (const status of [200, 201, 400, 403, 500]) {
      expect(auditBodyOf(req({ body: big }), status, false)).toEqual({});
      expect(
        auditBodyOf(req({ user: undefined, body: big }), status, false),
      ).toEqual({});
    }
    expect(
      auditBaseOf(req({ body: big }), { status: 201, bindsBody: false }).body,
    ).toEqual({});
  });

  it('an authenticated 2xx on a body-binding handler keeps up to 512 KiB (default bindsBody)', () => {
    const body = { note: 'n'.repeat(300 * 1024) };
    expect(auditBodyOf(req({ body }), 201, true)).toEqual(body);
    expect(auditBaseOf(req({ body }), { status: 200 }).body).toEqual(body);
  });

  it('bindsRequestBody reads Nest route-arg keys "<paramtype>:<index>"', () => {
    expect(bindsRequestBody({ '3:0': { index: 0 } })).toBe(true); // @Body()
    expect(bindsRequestBody({ '5:0': {}, '3:1': {} })).toBe(true);
    expect(bindsRequestBody({ '0:0': {} })).toBe(true); // @Req()
    expect(bindsRequestBody({ '12:0': {} })).toBe(true); // @RawBody()
    expect(bindsRequestBody({ '5:0': {}, '4:1': {} })).toBe(false); // @Param/@Query
    expect(
      bindsRequestBody({ '3f2c__customRouteArgs__:0': { index: 0 } }),
    ).toBe(false); // @CurrentUser()
    expect(bindsRequestBody(undefined)).toBe(false);
    expect(bindsRequestBody({})).toBe(false);
  });
});

describe('iteration-5: read-only POST handlers always use the 8 KiB tier', () => {
  const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

  it('auditBodyCap: a read-only handler is 8 KiB even for an authenticated 2xx', () => {
    const user = { id: 'u1', role: 'VIEWER' };
    for (const status of [200, 201, 400, 422, 500]) {
      expect(auditBodyCap({ user }, status, true)).toBe(
        AUDIT_SMALL_BODY_MAX_BYTES,
      );
      expect(auditBodyCap({}, status, true)).toBe(AUDIT_SMALL_BODY_MAX_BYTES);
    }
    expect(auditBodyCap({ user }, 200, false)).toBe(AUDIT_BODY_MAX_BYTES);
  });

  it.each(READ_ONLY_MAX_BODIES)(
    'a maximal valid %s body (200) is stored as a <= 8 KiB _truncated marker',
    (_name, Dto, body) => {
      const errors = validateSync(plainToInstance(Dto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      expect(errors).toEqual([]);
      expect(size(body)).toBeGreaterThan(AUDIT_SMALL_BODY_MAX_BYTES);
      const stored = auditBaseOf(req({ body }), {
        status: 200,
        readOnly: true,
      }).body;
      expect(stored).toMatchObject({ _truncated: true });
      expect(size(stored)).toBeLessThanOrEqual(AUDIT_SMALL_BODY_MAX_BYTES);
      expect(auditBodyOf(req({ body }), 200, true, true)).toEqual(stored);
    },
  );

  it('a small read-only body is kept as is', () => {
    const body = { nature: 'SALE', lines: [] };
    expect(
      auditBaseOf(req({ body }), { status: 200, readOnly: true }).body,
    ).toEqual(body);
  });
});

describe('iteration-6: a validated body keeps the 512 KiB tier on an authenticated 408 / 5xx', () => {
  const user = { id: 'u1', role: 'ADMIN' };
  const body = { note: 'n'.repeat(300 * 1024) };

  it('auditBodyCap: 408 / 5xx + bodyValidated → 512 KiB; every other combination 8 KiB', () => {
    for (const status of [408, 500, 502, 503]) {
      expect(auditBodyCap({ user }, status, false, true)).toBe(
        AUDIT_BODY_MAX_BYTES,
      );
      // not validated (pipe rejected / never ran / no DTO)
      expect(auditBodyCap({ user }, status, false, false)).toBe(
        AUDIT_SMALL_BODY_MAX_BYTES,
      );
      // read-only POST
      expect(auditBodyCap({ user }, status, true, true)).toBe(
        AUDIT_SMALL_BODY_MAX_BYTES,
      );
      // anonymous
      expect(auditBodyCap({}, status, false, true)).toBe(
        AUDIT_SMALL_BODY_MAX_BYTES,
      );
    }
    // other rejections stay small even with a validated body
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      expect(auditBodyCap({ user }, status, false, true)).toBe(
        AUDIT_SMALL_BODY_MAX_BYTES,
      );
    }
  });

  it('auditBaseOf / auditBodyOf store the full validated body on a 408 / 500', () => {
    for (const status of [408, 500]) {
      expect(
        auditBaseOf(req({ body }), { status, bodyValidated: true }).body,
      ).toEqual(body);
      expect(auditBodyOf(req({ body }), status, true, false, true)).toEqual(
        body,
      );
      expect(auditBaseOf(req({ body }), { status }).body).toMatchObject({
        _truncated: true,
      });
    }
  });

  it('a bodyless handler still stores {} even if flagged', () => {
    expect(
      auditBaseOf(req({ body }), {
        status: 408,
        bindsBody: false,
        bodyValidated: true,
      }).body,
    ).toEqual({});
  });
});
