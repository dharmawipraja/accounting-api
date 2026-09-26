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
