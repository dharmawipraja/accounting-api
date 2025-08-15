import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { databaseMiddleware, queryPerformanceMiddleware } from './config/database.js';
import { checkDatabaseHealth } from './config/db-utils.js';
import config, { envSchema } from './config/index.js';
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

  // Use fastify-type-provider-zod validators/serializers for Zod route schemas
  if (typeof app.setValidatorCompiler === 'function') {
    app.setValidatorCompiler(validatorCompiler);
  }
  if (typeof app.setSerializerCompiler === 'function') {
    app.setSerializerCompiler(serializerCompiler);
  }

  // app.withTypeProvider<ZodTypeProvider>().route({ ... })

  // Validate environment variables
  await app.register(import('@fastify/env'), {
    confKey: 'config',
    schema: envSchema
  });

  // Register database middleware
  await app.register(databaseMiddleware);

  // Query performance monitoring in development
  if (appConfig.isDevelopment) {
    await app.register(queryPerformanceMiddleware);
  }

  // Helmet for security headers
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

  // CORS
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

  // Rate limiting
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

  // Compression
  if (appConfig.features.enableCompression) {
    await app.register(import('@fastify/compress'), {
      global: true,
      encodings: ['gzip', 'deflate'],
      threshold: appConfig.features.compressionThreshold
    });
  }

  // Register @fastify/sensible
  await app.register(import('@fastify/sensible'));

  // In-repo pagination plugin
  await app.register(import('./plugins/pagination.js'));

  // Register under-pressure for health and load protection
  await app.register(import('@fastify/under-pressure'), {
    // sensible defaults; can be overridden by appConfig.health in the future
    maxEventLoopDelay: appConfig.health?.maxEventLoopDelay ?? 1000,
    maxHeapUsedBytes: appConfig.health?.maxHeapUsedBytes ?? 200 * 1024 * 1024,
    maxRssBytes: appConfig.health?.maxRssBytes ?? 300 * 1024 * 1024,
    sampleInterval: appConfig.health?.sampleInterval ?? 5000,
    message: 'Server is under heavy load, please try again later',
    // Expose a lightweight under-pressure status route for quick probe checks.
    // This is mapped to `/status` and complements the richer `/health` and `/ready` endpoints.
    exposeStatusRoute: true,
    statusRoute: {
      url: '/status'
    },
    // Integrate Prisma DB health check
    healthCheck: async () => {
      const dbHealth = await checkDatabaseHealth(app.prisma);
      if (!dbHealth || !dbHealth.healthy) {
        throw new Error('Database unavailable');
      }
      return true;
    }
  });

  // Swagger/OpenAPI (optional)
  if (appConfig.features.enableSwagger) {
    // Register swagger and swagger-ui; the repo already includes @fastify/swagger
    await app.register(import('@fastify/swagger'), {
      swagger: {
        info: {
          title: 'Accounting API',
          description: 'Accounting API OpenAPI documentation',
          version: '1.0.0'
        }
      },
      exposeRoute: true
    });

    await app.register(import('@fastify/swagger-ui'), {
      routePrefix: '/docs',
      uiConfig: {
        docExpansion: 'list'
      }
    });
  }

  // Request-id and response-time
  await app.register(import('fastify-request-id'), {
    headerName: 'x-request-id'
  });

  await app.register(import('fastify-response-time'));

  // HTTP caching (ETag/Cache-Control)
  const defaultTtlSeconds = appConfig.redis?.defaultTTL ?? 300;
  await app.register(import('@fastify/caching'), {
    // privacy: 'public' is suitable for GET endpoints that return public data
    privacy: 'public',
    // expiresIn expects milliseconds
    expiresIn: defaultTtlSeconds * 1000,
    // Small in-memory cache size to avoid unbounded memory growth in small deployments
    cacheSize: 1000
  });

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
