import type { ExecutionContext } from '@nestjs/common';
import type { ThrottlerOptions } from '@nestjs/throttler';
import { THROTTLE, THROTTLE_TTL_MS } from '../../config/throttle.config';

/** Name of the per-user report FILE-export throttler (registered in AppModule). */
export const REPORT_EXPORT_THROTTLER = 'reportExport';

/** A report request asking for a file (`?format=csv|xlsx`, or any `format`
 *  value — an invalid one is a 400 anyway and still costs a request). JSON
 *  report calls carry no `format` and are never counted here. */
export function isFileExport(req: { query?: unknown }): boolean {
  const q = req.query as Record<string, unknown> | undefined;
  return q?.format !== undefined;
}

/** Per-user ceiling on report file exports only. A route-level @Throttle
 *  would also limit the same route's JSON calls, so this is a named throttler
 *  that skips every request without `?format=` (like the login-IP one). */
export function reportExportThrottler(): ThrottlerOptions {
  return {
    name: REPORT_EXPORT_THROTTLER,
    ttl: THROTTLE_TTL_MS,
    limit: THROTTLE.reportExport,
    skipIf: (ctx: ExecutionContext) =>
      !isFileExport(ctx.switchToHttp().getRequest<{ query?: unknown }>()),
    getTracker: (req: Record<string, unknown>) => {
      const user = req.user as { id?: string } | undefined;
      return user?.id
        ? `export:user:${user.id}`
        : `export:ip:${typeof req.ip === 'string' ? req.ip : 'unknown'}`;
    },
  };
}
