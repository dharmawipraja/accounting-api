import { SetMetadata } from '@nestjs/common';

/** Handler metadata key set by `@TokenGrant()`. */
export const TOKEN_GRANT_KEY = 'audit:token-grant';

/**
 * Marks an anonymous handler whose SUCCESS proves possession of a valid
 * credential (currently `POST /auth/refresh`: a valid, unrevoked refresh
 * token). AuditInterceptor exempts such a handler's 2xx rows — like a
 * successful login (`@LoginIpThrottle()`) — from the anonymous global audit
 * ceiling: they cannot be mass-produced without valid secrets (and stay bounded
 * by the per-route throttles), so a flood of cheap anonymous 401s must never
 * starve them out of the audit trail. Keyed on the handler (read with
 * Reflector), never on the path. Their 4xx rows stay under the ceiling.
 */
export const TokenGrant = (): MethodDecorator =>
  SetMetadata(TOKEN_GRANT_KEY, true);

/** The token owner (`sub`) of a successful token-grant response
 *  (`{ accessToken }`, a JWT the server has just signed — so its payload is
 *  trusted without re-verifying), else null. Used only to key the per-user
 *  audit budget for refresh rows (`RejectionAuditLimiter.allowTokenGrant`).
 *  Pure. */
export function tokenGrantSubject(data: unknown): string | null {
  if (!data || typeof data !== 'object' || !('accessToken' in data)) {
    return null;
  }
  const token = data.accessToken;
  if (typeof token !== 'string') return null;
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );
    const sub =
      parsed && typeof parsed === 'object' && 'sub' in parsed
        ? parsed.sub
        : undefined;
    return typeof sub === 'string' && sub.length > 0 && sub.length <= 128
      ? sub
      : null;
  } catch {
    return null;
  }
}
