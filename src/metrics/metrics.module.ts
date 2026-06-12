import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { MetricsInterceptor } from './metrics.interceptor';
import { MetricsTokenGuard } from './metrics-token.guard';

@Global()
@Module({
  providers: [
    MetricsService,
    MetricsTokenGuard,
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
  controllers: [MetricsController],
  exports: [MetricsService],
})
export class MetricsModule {}
