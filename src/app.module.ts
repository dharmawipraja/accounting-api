import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import Redis from 'ioredis';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { RedisModule } from './common/redis/redis.module';
import { REDIS_CLIENT } from './common/redis/redis.constants';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'crypto';
import { HealthController } from './health/health.controller';
import { validate } from './config/env.validation';
import { resolveEnvFilePaths } from './config/env-file-paths';
import { PrismaModule } from './common/prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { CompanyModule } from './company/company.module';
import { LedgerModule } from './ledger/ledger.module';
import { TaxModule } from './tax/tax.module';
import { InvoicingModule } from './invoicing/invoicing.module';
import { ReportingModule } from './reporting/reporting.module';
import { CloseModule } from './close/close.module';
import { AuditModule } from './audit/audit.module';
import { MetricsModule } from './metrics/metrics.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { ScheduleModule } from '@nestjs/schedule';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { UserThrottlerGuard } from './common/guards/user-throttler.guard';
import { RequestTimeoutInterceptor } from './common/interceptors/request-timeout.interceptor';
import {
  THROTTLE,
  THROTTLE_TTL_MS,
  REQUEST_TIMEOUT_MS,
} from './config/throttle.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: resolveEnvFilePaths(process.env.NODE_ENV),
      validate,
    }),
    ScheduleModule.forRoot(),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        autoLogging: true,
        genReqId: (req, res) => {
          // Reuse an inbound X-Request-Id only if it's a safe shape/length;
          // otherwise generate one. Prevents an oversized/garbage upstream value
          // from polluting logs (defense-in-depth — Node already rejects CR/LF).
          const inbound = req.headers['x-request-id'];
          const id =
            typeof inbound === 'string' && /^[\w.-]{1,128}$/.test(inbound)
              ? inbound
              : randomUUID();
          res.setHeader('X-Request-Id', id);
          return id;
        },
        redact: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
        ],
      },
    }),
    RedisModule,
    ThrottlerModule.forRootAsync({
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis | null) => {
        const throttlers = [{ ttl: THROTTLE_TTL_MS, limit: THROTTLE.global }];
        // null (test) → default in-memory store; otherwise share the one Redis client.
        return redis
          ? { throttlers, storage: new ThrottlerStorageRedisService(redis) }
          : { throttlers };
      },
    }),
    PrismaModule,
    UsersModule,
    AuthModule,
    CompanyModule,
    LedgerModule,
    TaxModule,
    InvoicingModule,
    ReportingModule,
    CloseModule,
    AuditModule,
    MetricsModule,
    IdempotencyModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    {
      provide: APP_INTERCEPTOR,
      useFactory: () => new RequestTimeoutInterceptor(REQUEST_TIMEOUT_MS),
    },
  ],
})
export class AppModule {}
