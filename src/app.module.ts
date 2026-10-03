import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import Redis from 'ioredis';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { RedisModule } from './common/redis/redis.module';
import { REDIS_CLIENT } from './common/redis/redis.constants';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'crypto';
import { clientRequestIdOf } from './common/http/request-id';
import { HealthController } from './health/health.controller';
import { validate } from './config/env.validation';
import { resolveEnvFilePaths } from './config/env-file-paths';
import { PrismaModule } from './common/prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { UserAdminModule } from './users/user-admin.module';
import { CompanyModule } from './company/company.module';
import { LedgerModule } from './ledger/ledger.module';
import { TaxModule } from './tax/tax.module';
import { InvoicingModule } from './invoicing/invoicing.module';
import { CoretaxModule } from './coretax/coretax.module';
import { ReportingModule } from './reporting/reporting.module';
import { CloseModule } from './close/close.module';
import { AuditModule } from './audit/audit.module';
import { MetricsModule } from './metrics/metrics.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { ScheduleModule } from '@nestjs/schedule';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { PasswordChangeGuard } from './auth/guards/password-change.guard';
import { UserThrottlerGuard } from './common/guards/user-throttler.guard';
import { loginIpThrottler } from './common/guards/login-ip-throttle';
import { AuditInterceptor } from './audit/audit.interceptor';
import { RequestTimeoutInterceptor } from './common/interceptors/request-timeout.interceptor';
import { HttpDrainService } from './common/http/http-drain.service';
import { jsonDepthGuard } from './common/http/json-depth';
import { InputHygieneGuard } from './common/http/input-hygiene';
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
          // The trace id is ALWAYS server-generated: a caller-chosen id could
          // collide with / impersonate another request's audit trail. A
          // safe-shaped inbound X-Request-Id is kept only for correlation — as
          // the `clientRequestId` log field and audit_log.client_request_id.
          (req as { clientRequestId?: string | null }).clientRequestId =
            clientRequestIdOf(req.headers['x-request-id']);
          const id = randomUUID();
          res.setHeader('X-Request-Id', id);
          return id;
        },
        customProps: (req) => {
          const cid = (req as { clientRequestId?: string | null })
            .clientRequestId;
          return cid ? { clientRequestId: cid } : {};
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
        const throttlers = [
          { ttl: THROTTLE_TTL_MS, limit: THROTTLE.global },
          loginIpThrottler(),
        ];
        // null (test) → default in-memory store; otherwise share the one Redis client.
        return redis
          ? { throttlers, storage: new ThrottlerStorageRedisService(redis) }
          : { throttlers };
      },
    }),
    PrismaModule,
    UsersModule,
    AuthModule,
    UserAdminModule,
    CompanyModule,
    LedgerModule,
    TaxModule,
    InvoicingModule,
    CoretaxModule,
    ReportingModule,
    CloseModule,
    AuditModule,
    MetricsModule,
    IdempotencyModule,
  ],
  controllers: [HealthController],
  providers: [
    HttpDrainService,
    // Global guard ORDER matters (registration order = run order):
    // authenticate → throttle (marks a login attempt) → input hygiene (400
    // INVALID_CHARACTERS, audited with the caller when authenticated) →
    // role check → forced password change.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
    { provide: APP_GUARD, useClass: InputHygieneGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PasswordChangeGuard },
    // Global interceptor ORDER matters: Nest applies APP_INTERCEPTORs in module
    // scan order (AppModule first), outermost first. AuditInterceptor MUST wrap
    // RequestTimeoutInterceptor: on timeout, rxjs `timeout` unsubscribes from
    // everything inside it, so an inner audit would never record the 408. Being
    // outermost, audit sees the RequestTimeoutException and writes exactly one
    // row (status 408). Metrics + Idempotency (their own modules) stay inside.
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    {
      provide: APP_INTERCEPTOR,
      useFactory: () => new RequestTimeoutInterceptor(REQUEST_TIMEOUT_MS),
    },
  ],
})
export class AppModule implements NestModule {
  /** Runs after body parsing, before guards/interceptors/pipes: an over-deep
   *  JSON body is a 400 before anything recurses over it —
   *  including the InputHygieneGuard's body walk. (`Cache-Control: no-store`
   *  for `/v*` is an app-level `app.use(noStoreApiResponses)` registered
   *  before the body parsers — main.ts / the e2e bootstrap — so body-parser
   *  rejections carry it too.) */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(jsonDepthGuard)
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
