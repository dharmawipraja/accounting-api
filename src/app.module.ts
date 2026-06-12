import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'crypto';
import { HealthController } from './health/health.controller';
import { validate } from './config/env.validation';
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
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate }),
    LoggerModule.forRoot({
      pinoHttp: {
        autoLogging: true,
        genReqId: (req, res) => {
          const id =
            (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
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
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
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
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
