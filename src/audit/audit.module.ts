import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';

@Module({
  // AuditInterceptor is registered as APP_INTERCEPTOR in AppModule (ordered
  // OUTSIDE RequestTimeoutInterceptor so 408s are audited) — not here.
  providers: [AuditService],
  controllers: [AuditController],
  exports: [AuditService],
})
export class AuditModule {}
