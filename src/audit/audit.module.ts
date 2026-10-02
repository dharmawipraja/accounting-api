import { Logger, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import {
  loggingRejectionAuditLimiter,
  RejectionAuditLimiter,
} from './rejection-audit-limiter';

@Module({
  // AuditInterceptor is registered as APP_INTERCEPTOR in AppModule (ordered
  // OUTSIDE RequestTimeoutInterceptor so 408s are audited) — not here.
  providers: [
    AuditService,
    // ONE limiter shared by AuditInterceptor (anonymous rows) and
    // AllExceptionsFilter (guard rejections — main.ts passes app.get(...)),
    // so the anonymous global ceiling bounds both writers together.
    {
      provide: RejectionAuditLimiter,
      useFactory: () =>
        loggingRejectionAuditLimiter(new Logger('RejectionAuditLimiter')),
    },
  ],
  controllers: [AuditController],
  exports: [AuditService, RejectionAuditLimiter],
})
export class AuditModule {}
