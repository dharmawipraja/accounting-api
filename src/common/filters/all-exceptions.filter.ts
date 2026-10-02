import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import type { Response } from 'express';
import * as Sentry from '@sentry/node';
import { classifyException } from '../errors/exception-status';
import type { AuditService } from '../../audit/audit.service';
import {
  auditBaseOf,
  markAudited,
  shouldAuditRejection,
  type AuditableRequest,
} from '../../audit/audit-request';
import {
  loggingRejectionAuditLimiter,
  RejectionAuditLimiter,
} from '../../audit/rejection-audit-limiter';

interface ErrorEnvelope {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  traceId?: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  private readonly rejectionLimiter: RejectionAuditLimiter;

  /** @param audit when given, mutating requests rejected by a GUARD (401/403/
   *  429 — guards run before AuditInterceptor) are audited here: one row, no
   *  body when anonymous (unauthenticated input is not trusted into the log).
   *  The row is written fire-and-forget AFTER the response, and capped per
   *  caller: anonymous per client IP + a global ceiling (anonymous 401s are not
   *  throttled — JwtAuthGuard runs first); authenticated per user. Pass the
   *  app's shared `RejectionAuditLimiter` (AuditModule) so AuditInterceptor's
   *  anonymous rows count against the same global ceiling. */
  constructor(
    private readonly audit?: Pick<AuditService, 'record'>,
    limiter?: RejectionAuditLimiter,
  ) {
    this.rejectionLimiter =
      limiter ?? loggingRejectionAuditLimiter(this.logger);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const req = ctx.getRequest<
      { url?: string; id?: string } & Partial<AuditableRequest>
    >();
    const url = req.url ?? 'unknown';

    const {
      status,
      envelope: base,
      log,
      sentry,
    } = classifyException(exception);
    const envelope: ErrorEnvelope = { ...base };
    if (log) {
      const [message, ...rest] = log.args(url);
      this.logger[log.level](message, ...rest);
    }
    if (sentry) {
      Sentry.captureException(exception, {
        ...(sentry.level ? { level: sentry.level } : {}),
        tags: { ...sentry.tags, traceId: req.id },
        extra: { path: url },
      });
    }

    if (req.id) envelope.traceId = req.id;
    response.status(status).json(envelope);
    this.auditRejection(req as AuditableRequest, status, exception);
  }

  /** Guard (or input-hygiene) rejection → one audit row, fire-and-forget
   *  after the response: a slow or failing audit INSERT never delays or
   *  breaks the 401/403/429/400. */
  private auditRejection(
    req: AuditableRequest,
    status: number,
    exception: unknown,
  ): void {
    if (!this.audit || !shouldAuditRejection(req, status, exception)) return;
    markAudited(req);
    if (!this.rejectionLimiter.allow(req.ip ?? 'unknown', req.user?.id)) return;
    let pending: Promise<void>;
    try {
      pending = this.audit.record({
        // No handler here: these rejections are >= 400, so an authenticated
        // row takes the 8 KiB cap and an anonymous one stores {} (a login
        // attempt keeps its normalized email).
        ...auditBaseOf(req, { status }),
        entityId: null,
        statusCode: status,
        durationMs: 0, // rejected before any handler work
      });
    } catch (err) {
      pending = Promise.reject(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
    pending.catch((err: unknown) =>
      this.logger.warn(`Guard-rejection audit write failed: ${String(err)}`),
    );
  }
}
