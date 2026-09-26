import { sanitize } from './audit-sanitize';
import { isLoginAttempt } from '../common/guards/login-ip-throttle';
import { MUTATING_METHODS } from './mutating-methods';
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

/** Serialized-body byte cap (UTF-8) for AUTHENTICATED rows. It sits above the
 *  largest DTO-valid body (forbidNonWhitelisted bounds every accepted write):
 *  a 100-line JE whose 500-char descriptions are all JSON-escaped control
 *  characters (6 bytes/unit) serializes to ~317 KB, a maximal bill ~210 KB —
 *  so a legitimate write is never truncated in the append-only log. Only an
 *  already-rejected oversized body (bounded by the 1 MB parser cap) is
 *  replaced by the marker. Asserted by audit-request.spec.ts. */
export const AUDIT_BODY_MAX_BYTES = 512 * 1024;
/** Byte cap for ANONYMOUS rows that may store a body (success / 5xx):
 *  unauthenticated input stays small (disk-fill DoS, AUDIT3-17). */
export const AUDIT_ANON_BODY_MAX_BYTES = 8192;
/** Preview length (code points of the JSON text) kept when a body is capped. */
export const AUDIT_BODY_PREVIEW_CODE_POINTS = 1024;

/** Oversized-body marker stored instead of the body: a valid JSON OBJECT (the
 *  column is jsonb and API consumers read objects), never a string cut mid-JSON. */
export interface TruncatedAuditBody {
  _truncated: true;
  bytes: number;
  preview: string;
}

/** Caps an (already sanitized) body at `maxBytes` (default: the authenticated
 *  AUDIT_BODY_MAX_BYTES) of serialized UTF-8. Small bodies are returned unchanged; larger ones become a
 *  `TruncatedAuditBody` whose preview is the first
 *  AUDIT_BODY_PREVIEW_CODE_POINTS code points of the JSON (surrogate-safe). Pure. */
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

/** Whether an audit row for this outcome may store the request body. An
 *  ANONYMOUS (no `req.user`) client error (4xx) stores `withheldBody` instead:
 *  unauthenticated junk is never copied into the append-only log (disk-fill
 *  DoS, AUDIT3-17). */
export function auditBodyAllowed(
  req: Pick<AuditableRequest, 'user'>,
  status: number,
): boolean {
  return !(status >= 400 && status < 500 && !req.user);
}

/** Max code points of the forensic email kept for a failed login (RFC 5321
 *  path limit). */
export const AUDIT_LOGIN_EMAIL_MAX = 254;

/** The only part of a LOGIN body kept on a rejected anonymous attempt:
 *  `{ email }` trimmed, lowercased and capped at 254 code points (surrogate
 *  safe) — enough to investigate credential stuffing against an account. The
 *  password (and every other field) is never stored. `{}` when there is no
 *  non-blank string email. Pure. */
export function loginAttemptBody(body: unknown): { email?: string } {
  const email =
    body && typeof body === 'object' && 'email' in body
      ? body.email
      : undefined;
  if (typeof email !== 'string') return {};
  const normalized = email.trim().toLowerCase();
  return normalized
    ? { email: truncateCodePoints(normalized, AUDIT_LOGIN_EMAIL_MAX) }
    : {};
}

/** The body stored when the full body is withheld (`auditBodyAllowed` false):
 *  the forensic email on a login attempt, `{}` everywhere else. */
export function withheldBody(req: AuditableRequest): unknown {
  return isLoginAttempt(req) ? loginAttemptBody(req.body) : {};
}

export function isMutating(method: string): boolean {
  return MUTATING.has(method);
}

export function markAudited(req: AuditableRequest): void {
  req[AUDITED] = true;
}

/** The request-derived audit fields shared by the interceptor and the
 *  exception filter. `withBody: false` stores `withheldBody` (anonymous 4xx:
 *  `{}`, or `{ email }` on a login attempt); a stored body is sanitized, then
 *  size-capped (`capBody`) — 512 KiB authenticated, 8 KiB anonymous. */
export function auditBaseOf(
  req: AuditableRequest,
  opts: { withBody: boolean },
): AuditBase {
  return {
    userId: req.user?.id ?? null,
    userRole: req.user?.role ?? null,
    method: req.method,
    path: truncateCodePoints(req.originalUrl ?? req.url, AUDIT_PATH_MAX),
    params: capParams(req.params),
    body: opts.withBody
      ? capBody(
          sanitize(req.body),
          req.user ? AUDIT_BODY_MAX_BYTES : AUDIT_ANON_BODY_MAX_BYTES,
        )
      : withheldBody(req),
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
 *  request rejected before AuditInterceptor ran (i.e. by a guard). */
export function shouldAuditRejection(
  req: AuditableRequest,
  status: number,
): boolean {
  return (
    isMutating(req.method) &&
    !req[AUDITED] &&
    GUARD_REJECTION_STATUSES.has(status)
  );
}
