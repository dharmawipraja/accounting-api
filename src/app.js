import Fastify from 'fastify';
import { databaseMiddleware, queryPerformanceMiddleware } from './config/database.js';
import config, { envSchema } from './config/index.js';
import { requestIdPlugin, timingPlugin } from './middleware/index.js';
import { apiRoutes, healthRoutes } from './routes/index.js';

export async function build(opts = {}) {
  // Get application configuration
  const appConfig = config.getConfig();

  // Validate configuration
  config.validateConfig(appConfig);

  const app = Fastify({
    logger: opts.logger || true,
    // Production optimizations
    trustProxy: appConfig.server.trustProxy,
    disableRequestLogging: appConfig.server.disableRequestLogging,
    // Request timeout
    requestTimeout: appConfig.server.requestTimeout,
    // Body size limit
    bodyLimit: appConfig.server.bodyLimit,
    // Keep alive timeout
    keepAliveTimeout: appConfig.server.keepAliveTimeout,
    // Headers timeout
    headersTimeout: appConfig.server.headersTimeout
  });

  // Environment variables validation using the centralized schema
  await app.register(import('@fastify/env'), {
    confKey: 'config',
    schema: envSchema
  });

  // Register database middleware (must be early in the setup)
  await app.register(databaseMiddleware);

  // Register database performance monitoring in development
  if (appConfig.isDevelopment) {
    await app.register(queryPerformanceMiddleware);
  }

  // Security: Helmet for security headers
  await app.register(import('@fastify/helmet'), {
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: appConfig.features.enableCSP
      ? {
          directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", 'data:', 'https:']
          }
        }
      : false,
    hsts: appConfig.security.enableHSTS
      ? {
          maxAge: 31536000,
          includeSubDomains: true,
          preload: true
        }
      : false
  });

  // CORS configuration using centralized config
  if (appConfig.features.enableCors) {
    await app.register(import('@fastify/cors'), {
      origin: (origin, callback) => {
        // Allow localhost in development
        if (appConfig.isDevelopment) {
          callback(null, true);
          return;
        }

        // Production CORS policy
        const allowedOrigins = appConfig.security.corsOrigin;
        if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(app.httpErrors.forbidden('CORS policy violation'), false);
        }
      },
      credentials: appConfig.security.corsCredentials,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization']
    });
  }

  // Rate limiting using centralized config
  await app.register(import('@fastify/rate-limit'), {
    max: appConfig.security.rateLimitMax,
    timeWindow: appConfig.security.rateLimitWindow,
    cache: 10000, // Cache size
    allowList: ['127.0.0.1', '::1'], // Whitelist localhost
    redis: appConfig.redis.enabled ? { url: appConfig.redis.url } : undefined,
    skipOnError: appConfig.security.rateLimitSkipOnError,
    addHeadersOnExceeding: true,
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true
    },
    errorResponseBuilder: (request, context) => {
      throw request.server.httpErrors.tooManyRequests(
        `Rate limit exceeded, retry in ${Math.round(context.ttl / 1000)} seconds`
      );
    }
  });

  // Compression for better performance
  if (appConfig.features.enableCompression) {
    await app.register(import('@fastify/compress'), {
      global: true,
      encodings: ['gzip', 'deflate'],
      threshold: appConfig.features.compressionThreshold
    });
  }

  // Register sensible plugin for common utilities
  await app.register(import('@fastify/sensible'));

  // Register custom middleware plugins
  await app.register(requestIdPlugin);
  await app.register(timingPlugin);

  // Register routes
  await app.register(healthRoutes);
  await app.register(apiRoutes);

  // Global error handler
  app.setErrorHandler((error, request, reply) => {
    const { statusCode = 500 } = error;

    // Log error details
    request.log.error(error, 'Request error');

    // Don't expose internal errors in production
    const message =
      appConfig.isProduction && statusCode === 500 ? 'Internal Server Error' : error.message;

    // Use sensible error response format
    const errorResponse = {
      statusCode,
      error: error.name,
      message,
      requestId: request.id,
      ...(appConfig.isDevelopment && { stack: error.stack })
    };

    reply.status(statusCode).send(errorResponse);
  });

  // Not found handler using sensible
  app.setNotFoundHandler((request, reply) => {
    reply.callNotFound();
  });

  // Graceful shutdown is handled by the database middleware

  // Request logging in development
  if (appConfig.logging.logRequests && appConfig.isDevelopment) {
    app.addHook('onRequest', async request => {
      request.log.info(
        {
          url: request.url,
          method: request.method,
          requestId: request.id
        },
        'Incoming request'
      );
    });
  }

  return app;
}
