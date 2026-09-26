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

/** Serialized-body byte cap (UTF-8) for an AUTHENTICATED 2xx row on a handler
 *  that binds a `@Body()` DTO — or a 408 / 5xx row whose body the global
 *  ValidationPipe accepted (`bodyValidated`): the only rows whose body passed
 *  validation (forbidNonWhitelisted bounds every accepted write). It sits above the
 *  largest DTO-valid body: a 100-line JE whose 500-char descriptions are all
 *  JSON-escaped control characters (6 bytes/unit) serializes to ~317 KB, a
 *  maximal bill ~210 KB — so a legitimate write is never truncated in the
 *  append-only log. Asserted by audit-request.spec.ts. */
export const AUDIT_BODY_MAX_BYTES = 512 * 1024;
/** Byte cap for every OTHER row that stores a body: authenticated rejections
 *  (status >= 400 — a guard 403, a 400 on an any-role route: the body never
 *  passed validation) and anonymous success / 5xx rows. Junk input stays small
 *  (disk-fill DoS, AUDIT3-17 / iteration-4). */
export const AUDIT_SMALL_BODY_MAX_BYTES = 8192;
/** Byte cap for ANONYMOUS rows that may store a body (success / 5xx). */
export const AUDIT_ANON_BODY_MAX_BYTES = AUDIT_SMALL_BODY_MAX_BYTES;
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

/** The body byte cap for a row: `AUDIT_BODY_MAX_BYTES` only for an
 *  authenticated request on a state-changing handler that either succeeded
 *  (status < 300) or — when the global ValidationPipe accepted its body DTO
 *  (`bodyValidated`, see `audit/validated-body`) — ended in a 408 (request
 *  timeout: the write may still have committed) or a 5xx: that body is
 *  DTO-bounded and may record a committed write, so it is never truncated.
 *  The caller must also have checked that the handler binds a body
 *  (`auditBodyOf`). `AUDIT_SMALL_BODY_MAX_BYTES` for everything else,
 *  including every other 4xx and every row of a read-only POST (`readOnly`,
 *  `@ReadOnlyPost()`: it writes nothing, so its body never needs the large
 *  tier). Pure. */
export function auditBodyCap(
  req: Pick<AuditableRequest, 'user'>,
  status: number,
  readOnly = false,
  bodyValidated = false,
): number {
  const largeTierStatus =
    status < 300 || (bodyValidated && (status === 408 || status >= 500));
  return req.user && largeTierStatus && !readOnly
    ? AUDIT_BODY_MAX_BYTES
    : AUDIT_SMALL_BODY_MAX_BYTES;
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

/** The stored body for a row with outcome `status`:
 *  - a handler that binds no body (`bindsBody: false`) → `{}`, whatever the status;
 *  - an anonymous 4xx → `withheldBody` (`{}`, or `{ email }` on a login attempt);
 *  - otherwise the sanitized body, size-capped (`capBody`) at `auditBodyCap`:
 *    512 KiB only for an authenticated 2xx — or 408 / 5xx with a validated
 *    body (`bodyValidated`) — on a state-changing handler, 8 KiB for every
 *    other row (incl. a read-only POST, `readOnly`). Pure. */
export function auditBodyOf(
  req: AuditableRequest,
  status: number,
  bindsBody: boolean,
  readOnly = false,
  bodyValidated = false,
): unknown {
  if (!bindsBody) return {};
  if (!auditBodyAllowed(req, status)) return withheldBody(req);
  return capBody(
    sanitize(req.body),
    auditBodyCap(req, status, readOnly, bodyValidated),
  );
}

/** The request-derived audit fields shared by the interceptor and the
 *  exception filter, for a row with outcome `status`. `bindsBody` (default
 *  true: the exception filter has no handler; its guard rejections are >= 400
 *  and so take the small cap anyway; `readOnly` / `bodyValidated` default
 *  false) — see `auditBodyOf`. */
export function auditBaseOf(
  req: AuditableRequest,
  opts: {
    status: number;
    bindsBody?: boolean;
    readOnly?: boolean;
    bodyValidated?: boolean;
  },
): AuditBase {
  return {
    userId: req.user?.id ?? null,
    userRole: req.user?.role ?? null,
    method: req.method,
    path: truncateCodePoints(req.originalUrl ?? req.url, AUDIT_PATH_MAX),
    params: capParams(req.params),
    body: auditBodyOf(
      req,
      opts.status,
      opts.bindsBody ?? true,
      opts.readOnly ?? false,
      opts.bodyValidated ?? false,
    ),
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
