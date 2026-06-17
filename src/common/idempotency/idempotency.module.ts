import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { IdempotencyService } from './idempotency.service';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { IdempotencyPurgeService } from './idempotency-purge.service';

// PrismaModule is @Global, so IdempotencyService resolves PrismaService here.
@Module({
  providers: [
    IdempotencyService,
    IdempotencyPurgeService,
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class IdempotencyModule {}
