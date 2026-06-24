import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { parseCorsOrigins } from './config/cors-origins';
import { scrubSentryEvent } from './config/sentry-scrub';

async function bootstrap(): Promise<void> {
  if (process.env.SENTRY_DSN) {
    const Sentry = await import('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
      release: process.env.SENTRY_RELEASE,
      tracesSampleRate: 0,
      beforeSend: (event) => scrubSentryEvent(event),
    });
  }

  // Last-resort crash safety. An uncaughtException leaves the process in an
  // undefined state → log, capture, flush, exit(1) (Docker `unless-stopped`
  // restarts). An unhandledRejection is logged + captured without exiting.
  const captureFatal = async (err: unknown): Promise<void> => {
    console.error(err);
    if (process.env.SENTRY_DSN) {
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
  // Trust the single reverse proxy in front of the app so rate limiting and
  // request IPs reflect the real client, not the proxy's loopback address.
  app.set('trust proxy', 1);
  app.use(helmet());
  app.enableCors({ origin: parseCorsOrigins(process.env.CORS_ORIGIN) });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  // URI versioning — every business route is served under /v1 (hard cutover).
  // Operational probes (/health, /ready, /metrics) opt out via @Version(VERSION_NEUTRAL).
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // Harden HTTP server timeouts (the app sits behind Caddy in production).
  const server = app.getHttpServer();
  server.keepAliveTimeout = 65_000; // slightly above a typical proxy keep-alive
  server.headersTimeout = 66_000; // must exceed keepAliveTimeout
  server.requestTimeout = 30_000;
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
