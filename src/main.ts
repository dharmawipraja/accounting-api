import { NestFactory } from '@nestjs/core';
import { VersioningType } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AuditService } from './audit/audit.service';
import { RejectionAuditLimiter } from './audit/rejection-audit-limiter';
import { globalValidationPipe } from './audit/validated-body';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { noStoreApiResponses } from './common/http/no-store';
import { corsOptions } from './config/cors-origins';
import { sentryOptions } from './config/sentry-options';
import { scrubSentryEvent } from './config/sentry-scrub';
import { resolveTrustProxy } from './config/trust-proxy';

async function bootstrap(): Promise<void> {
  const sentry = sentryOptions(process.env);
  if (sentry) {
    const Sentry = await import('@sentry/node');
    Sentry.init({
      ...sentry,
      tracesSampleRate: 0,
      beforeSend: (event) => scrubSentryEvent(event),
    });
  }

  // Last-resort crash safety. An uncaughtException leaves the process in an
  // undefined state → log, capture, flush, exit(1) (Docker `unless-stopped`
  // restarts). An unhandledRejection is logged + captured without exiting.
  const captureFatal = async (err: unknown): Promise<void> => {
    console.error(err);
    if (sentry) {
      const Sentry = await import('@sentry/node');
      Sentry.captureException(err);
      await Sentry.flush(2000);
    }
  };
  process.on('uncaughtException', (err) => {
    void captureFatal(err).finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    void captureFatal(reason);
  });

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  // Trust exactly the reverse-proxy hops in front of the app (prod: Caddy -> api
  // = 1) so rate limiting and audit IPs reflect the real client, not the proxy
  // — and a client-forged X-Forwarded-For is ignored. See resolveTrustProxy.
  app.set('trust proxy', resolveTrustProxy(process.env));
  app.use(helmet());
  // API responses are Cache-Control: no-store (common/http/no-store) —
  // registered here, BEFORE the body parsers below, so a body-parser rejection
  // (malformed JSON 400, over-cap 413) carries it too. No ETags either, so a
  // conditional GET can never 304 an authenticated body.
  app.use(noStoreApiResponses);
  app.set('etag', false);
  app.enableCors(corsOptions(process.env.CORS_ORIGIN));
  // Strict validation + the validated-body audit mark (audit/validated-body).
  app.useGlobalPipes(globalValidationPipe());
  app.useGlobalFilters(
    new AllExceptionsFilter(
      app.get(AuditService),
      app.get(RejectionAuditLimiter),
    ),
  );
  app.enableShutdownHooks();
  // URI versioning — every business route is served under /v1 (hard cutover).
  // Operational probes (/health, /ready, /metrics) opt out via @Version(VERSION_NEUTRAL).
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // Harden HTTP server timeouts (the app sits behind Caddy in production).
  const server = app.getHttpServer();
  server.keepAliveTimeout = 65_000; // slightly above a typical proxy keep-alive
  server.headersTimeout = 66_000; // must exceed keepAliveTimeout
  // Above REQUEST_TIMEOUT_MS (35s) so the interceptor's clean 408 wins over a
  // socket reset. Escalation order: DB statement (30s) → 408 (35s) → socket (40s).
  server.requestTimeout = 40_000;
  // Cap request bodies (financial payloads are small); matches Caddy's edge cap.
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { limit: '1mb', extended: true });

  // Serve OpenAPI docs everywhere except production, where exposing the full
  // route/DTO surface is opt-in. Set ENABLE_SWAGGER=true to force it on.
  if (
    process.env.NODE_ENV !== 'production' ||
    process.env.ENABLE_SWAGGER === 'true'
  ) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Indonesian Accounting API')
      .setVersion('1.1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup(
      'docs',
      app,
      SwaggerModule.createDocument(app, swaggerConfig),
    );
  }

  await app.listen(process.env.PORT ? Number(process.env.PORT) : 3000);
}
void bootstrap();
