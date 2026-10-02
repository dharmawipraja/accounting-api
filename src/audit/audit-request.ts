import { sanitize } from './audit-sanitize';
import { InvalidCharactersError } from '../common/errors/domain-errors';
import { isLoginAttempt } from '../common/guards/login-ip-throttle';
import { MUTATING_METHODS } from './mutating-methods';
import { normalizeEmail } from '../users/normalize-email';
import type { AuditEntry } from './audit.service';

const MUTATING: Set<string> = new Set(MUTATING_METHODS);

/** Set on the request once an audit row is (being) written for it, so the
 *  exception filter never writes a second row for a request the interceptor
 *  already covered. */
export const AUDITED = Symbol('audit.recorded');

export interface AuditableRequest {
  method: string;
  originalUrl?: string;
  url: string;
  params: Record<string, unknown>;
  body: unknown;
  ip?: string;
  /** Server-generated request id — the X-Request-Id response header / error traceId. */
  id?: unknown;
  /** Sanitized caller-supplied X-Request-Id (set in genReqId), else null/undefined. */
  clientRequestId?: string | null;
  user?: { id: string; role: string };
  [AUDITED]?: boolean;
}

export type AuditBase = Omit<
  AuditEntry,
  'statusCode' | 'durationMs' | 'entityId'
>;

/** Size caps for request-derived audit fields (every row). The path includes
 *  the query string (up to the 16KB header limit) and params are caller input. */
export const AUDIT_PATH_MAX = 512;
export const AUDIT_PARAMS_MAX = 512;

/** First `max` code points of `s` — never splits a surrogate pair, so the
 *  result is well-formed UTF-16 (a lone surrogate makes Postgres reject the
 *  jsonb value and would lose the audit row). Pure. */
export function truncateCodePoints(s: string, max: number): string {
  if (s.length <= max) return s; // ≤ max UTF-16 units ⇒ ≤ max code points
  let out = '';
  let n = 0;
  for (const ch of s) {
    if (n++ === max) break;
    out += ch;
  }
  return out;
}

function capParams(params: Record<string, unknown> | undefined): unknown {
  const value = params ?? {};
  const json = JSON.stringify(value);
  // Small (the normal case): keep the object. Oversized: store a truncated
  // JSON string (still valid JSON for the column), never the full payload.
  return json.length <= AUDIT_PARAMS_MAX
    ? value
    : truncateCodePoints(json, AUDIT_PARAMS_MAX);
}

/** Serialized-body byte cap (UTF-8) for an AUTHENTICATED row whose body the
 *  global ValidationPipe accepted (`auditBodyOf`; forbidNonWhitelisted bounds
 *  every accepted write). It sits above the largest DTO-valid body: a 100-line
 *  JE whose 500-char descriptions are all JSON-escaped control characters
 *  (6 bytes/unit) serializes to ~317 KB, a maximal bill ~210 KB — so a
 *  legitimate write is never truncated in the append-only log. Asserted by
 *  audit-request.spec.ts. */
export const AUDIT_BODY_MAX_BYTES = 512 * 1024;
/** Byte cap for every OTHER authenticated row: a rejected body (a 400, a
 *  guard 403 / 429 — it never passed validation) or a read-only POST. Junk
 *  input stays small (disk-fill DoS, AUDIT3-17 / iteration-4 / iteration-5). */
export const AUDIT_SMALL_BODY_MAX_BYTES = 8192;
/** Preview length (code points of the JSON text) kept when a body is capped. */
export const AUDIT_BODY_PREVIEW_CODE_POINTS = 1024;

/** Oversized-body marker stored instead of the body: a valid JSON OBJECT (the
 *  column is jsonb and API consumers read objects), never a string cut mid-JSON. */
export interface TruncatedAuditBody {
  _truncated: true;
  bytes: number;
  preview: string;
}

/** Caps an (already sanitized) body at `maxBytes` (default
 *  AUDIT_BODY_MAX_BYTES) of serialized UTF-8. Small bodies are returned
 *  unchanged; larger ones become a `TruncatedAuditBody` whose preview is the
 *  first AUDIT_BODY_PREVIEW_CODE_POINTS code points of the JSON
 *  (surrogate-safe). Pure. */
export function capBody(
  body: unknown,
  maxBytes: number = AUDIT_BODY_MAX_BYTES,
): unknown {
  const json = JSON.stringify(body);
  if (json === undefined) return body; // undefined / function: nothing to store
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes <= maxBytes) return body;
  const marker: TruncatedAuditBody = {
    _truncated: true,
    bytes,
    preview: truncateCodePoints(json, AUDIT_BODY_PREVIEW_CODE_POINTS),
  };
  return marker;
}

/** Route-argument paramtypes (Nest `RouteParamtypes`) that hand the handler
 *  the request body: BODY (3), the whole REQUEST (0) and RAW_BODY (12). */
const BODY_PARAMTYPES = new Set([0, 3, 12]);

/** Whether a handler's Nest route-argument metadata (`ROUTE_ARGS_METADATA`,
 *  keys `"<paramtype>:<index>"`) binds the request body. A handler with no
 *  such argument (e.g. `POST /auth/logout-all`) never reads the body, so any
 *  body sent to it is junk. Pure. */
export function bindsRequestBody(routeArgs: unknown): boolean {
  if (!routeArgs || typeof routeArgs !== 'object') return false;
  return Object.keys(routeArgs).some((key) =>
    BODY_PARAMTYPES.has(Number(key.split(':')[0])),
  );
}

/** Max code points of the forensic email kept for a login attempt (RFC 5321
 *  path limit). */
export const AUDIT_LOGIN_EMAIL_MAX = 254;

/** The only part of a LOGIN body ever stored: `{ email }` normalized
 *  (normalizeEmail: trim + lowercase + NFC) and capped at 254 code points
 *  (surrogate safe) — enough to investigate credential stuffing against an
 *  account. The password (and every other field) is never stored. `{}` when
 *  there is no non-blank string email. Pure. */
export function loginAttemptBody(body: unknown): { email?: string } {
  const email =
    body && typeof body === 'object' && 'email' in body
      ? body.email
      : undefined;
  if (typeof email !== 'string') return {};
  const normalized = normalizeEmail(email);
  return normalized
    ? { email: truncateCodePoints(normalized, AUDIT_LOGIN_EMAIL_MAX) }
    : {};
}

export function isMutating(method: string): boolean {
  return MUTATING.has(method);
}

export function markAudited(req: AuditableRequest): void {
  req[AUDITED] = true;
}

/** Whether a row with outcome `status` carries a body the global
 *  ValidationPipe ACCEPTED: every body-binding handler takes a whole-body DTO
 *  and a pipe rejection is always a 400, so any outcome other than a client
 *  error — a 2xx, a 5xx, or a 408 (request timeout: the write may still have
 *  committed) — got past the pipe. Guard rejections are 4xx. Pure. */
function bodyAccepted(status: number): boolean {
  return status < 400 || status === 408 || status >= 500;
}

/** The stored body for a row with outcome `status`:
 *  - a handler that binds no body (`bindsBody: false`) → `{}`;
 *  - an ANONYMOUS request → `{}`, except a login attempt (`LOGIN_ATTEMPT`),
 *    which keeps only `{ email }` (`loginAttemptBody`): unauthenticated input
 *    is never copied into the append-only log (disk-fill DoS, AUDIT3-17);
 *  - an authenticated request → the sanitized body, size-capped (`capBody`)
 *    at `AUDIT_BODY_MAX_BYTES` when the pipe accepted it (`bodyAccepted`) on
 *    a state-changing handler, else `AUDIT_SMALL_BODY_MAX_BYTES` (incl. every
 *    row of a `@ReadOnlyPost()` handler, `readOnly`). Pure. */
export function auditBodyOf(
  req: AuditableRequest,
  status: number,
  bindsBody = true,
  readOnly = false,
): unknown {
  if (!bindsBody) return {};
  if (!req.user) return isLoginAttempt(req) ? loginAttemptBody(req.body) : {};
  const large = !readOnly && bodyAccepted(status);
  return capBody(
    sanitize(req.body),
    large ? AUDIT_BODY_MAX_BYTES : AUDIT_SMALL_BODY_MAX_BYTES,
  );
}

/** The request-derived audit fields shared by the interceptor and the
 *  exception filter, for a row with outcome `status` — see `auditBodyOf`
 *  (`bindsBody` defaults to true: the exception filter has no handler; its
 *  rejections are 4xx and so take the small cap anyway). */
export function auditBaseOf(
  req: AuditableRequest,
  opts: { status: number; bindsBody?: boolean; readOnly?: boolean },
): AuditBase {
  return {
    userId: req.user?.id ?? null,
    userRole: req.user?.role ?? null,
    method: req.method,
    path: truncateCodePoints(req.originalUrl ?? req.url, AUDIT_PATH_MAX),
    params: capParams(req.params),
    body: auditBodyOf(req, opts.status, opts.bindsBody, opts.readOnly),
    ip: req.ip ?? null,
    requestId:
      typeof req.id === 'string' || typeof req.id === 'number'
        ? String(req.id)
        : null,
    clientRequestId: req.clientRequestId ?? null,
  };
}

/** Statuses a GUARD rejects with (auth / role / password-change / throttle).
 *  Guards run before interceptors, so only the exception filter can audit them. */
const GUARD_REJECTION_STATUSES = new Set([401, 403, 429]);

/** True when the exception filter must write the audit row itself: a mutating
 *  request rejected before AuditInterceptor ran — by a guard (401/403/429),
 *  or by the InputHygieneGuard (400 INVALID_CHARACTERS: the rejected write
 *  must still leave a trail; it runs after JwtAuthGuard / UserThrottlerGuard,
 *  so the row follows the normal authenticated / anonymous body rules, and
 *  AuditService makes it storable JSON). */
export function shouldAuditRejection(
  req: AuditableRequest,
  status: number,
  exception?: unknown,
): boolean {
  return (
    isMutating(req.method) &&
    !req[AUDITED] &&
    (GUARD_REJECTION_STATUSES.has(status) ||
      exception instanceof InvalidCharactersError)
  );
}
