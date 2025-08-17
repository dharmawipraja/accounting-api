import fastifyCaching from '@fastify/caching';
import fastifyCompress from '@fastify/compress';
import fastifyCors from '@fastify/cors';
import fastifyEnv from '@fastify/env';
import fastifyJwt from '@fastify/jwt';
import fastifySensible from '@fastify/sensible';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import fastifyUnderPressure from '@fastify/under-pressure';
import Fastify from 'fastify';
import fastifyRequestId from 'fastify-request-id';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { databaseMiddleware, queryPerformanceMiddleware } from './config/database.js';
import config, { envSchema } from './config/index.js';
import { errorHandler } from './core/errors/index.js';
import { logFormats, registerLoggingMiddleware } from './core/logging/index.js';
import { securitySuitePlugin, validateSecurityConfig } from './core/security/index.js';
import { registerRoutes } from './router.js';

export async function build(opts = {}) {
  // Get application configuration
  const appConfig = config.getConfig();

  // Validate configuration
  config.validateConfig(appConfig);

  // Validate security configuration
  const securityValidation = validateSecurityConfig(appConfig);
  if (!securityValidation.valid) {
    throw new Error(`Security configuration issues:\n${securityValidation.issues.join('\n')}`);
  }

  // Get appropriate logger configuration based on environment
  const loggerConfig =
    opts.logger !== false ? opts.logger || logFormats.getLoggerConfig(appConfig.nodeEnv) : false;

  const app = Fastify({
    logger: loggerConfig,
    // Production optimizations
    trustProxy: appConfig.server.trustProxy,
    disableRequestLogging: true, // We'll handle this with our structured logging
    // Request timeout
    requestTimeout: appConfig.server.requestTimeout,
    // Body size limit
    bodyLimit: appConfig.server.bodyLimit,
    // Keep alive timeout
    keepAliveTimeout: appConfig.server.keepAliveTimeout,
    // Headers timeout
    headersTimeout: appConfig.server.headersTimeout
  });

  // Always use the Zod serializer: routes must provide Zod schemas for
  // validation and serialization when using the fastify-type-provider-zod.
  if (typeof app.setValidatorCompiler === 'function') {
    app.setValidatorCompiler(validatorCompiler);
  }

  if (typeof app.setSerializerCompiler === 'function') {
    app.setSerializerCompiler(serializerCompiler);
  }

  // app.withTypeProvider<ZodTypeProvider>().route({ ... })

  // Validate environment variables
  await app.register(fastifyEnv, {
    confKey: 'config',
    schema: envSchema
  });

  // Register database middleware
  await app.register(databaseMiddleware);

  // Register structured logging middleware early
  await registerLoggingMiddleware(app);

  // Query performance monitoring in development
  if (appConfig.isDevelopment) {
    await app.register(queryPerformanceMiddleware);
  }

  // Enhanced Security Suite
  await app.register(securitySuitePlugin, {
    enableAdvancedRateLimit: appConfig.security.enableAdvancedRateLimit,
    enableGlobalRateLimit: true, // Enable global rate limiting through security suite
    rateLimitOptions: {
      max: appConfig.security.rateLimitMax,
      timeWindow: appConfig.security.rateLimitWindow,
      cache: 10000,
      allowList: ['127.0.0.1', '::1'],
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
    },
    enableInputSanitization: appConfig.security.enableInputSanitization,
    sanitizationOptions: {
      sanitizeBody: appConfig.security.sanitizeBody,
      sanitizeQuery: appConfig.security.sanitizeQuery,
      sanitizeParams: appConfig.security.sanitizeParams,
      globalOptions: {
        stripHtmlTags: appConfig.security.stripHtmlTags,
        removeScriptTags: appConfig.security.removeScriptTags,
        encodeSpecialChars: appConfig.security.encodeSpecialChars
      }
    },
    enableEncryption: appConfig.security.enableEncryption,
    encryptionKey: appConfig.security.encryptionKey,
    enableAuditTrail: appConfig.security.enableAuditTrail,
    enableEnhancedHeaders: appConfig.security.enableEnhancedHeaders,
    headerOptions: {
      environment: appConfig.nodeEnv,
      enableCSP: appConfig.security.enableCSP,
      enableHSTS: appConfig.security.enableHSTS,
      cspPolicy: appConfig.security.cspPolicy,
      hstsConfig: appConfig.security.hstsConfig,
      apiOnly: appConfig.security.apiOnly
    },
    enableCSRF: appConfig.security.enableCSRF,
    csrfOptions: {
      enabled: appConfig.security.enableCSRF
    }
  });

  // JWT Plugin for authentication
  await app.register(fastifyJwt, {
    secret: appConfig.security.jwtSecret || process.env.JWT_SECRET || 'fallback-secret-key'
  });

  // Note: Helmet is now configured within the securitySuitePlugin to avoid conflicts

  // CORS
  if (appConfig.features.enableCors) {
    await app.register(fastifyCors, {
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

  // Note: Global rate limiting is now handled by the securitySuitePlugin to avoid conflicts
  // Individual routes can still use specific rate limiting strategies

  // Compression
  if (appConfig.features.enableCompression) {
    await app.register(fastifyCompress, {
      global: true,
      encodings: ['gzip', 'deflate'],
      threshold: appConfig.features.compressionThreshold
    });
  }

  // Register @fastify/sensible
  await app.register(fastifySensible);

  // Register under-pressure for health and load protection
  const underPressureConfig = {
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
    }
  };

  // Only add database health check in non-test environment
  if (!appConfig.isTest && !process.env.NODE_ENV?.includes('test')) {
    underPressureConfig.healthCheck = async () => {
      try {
        // Simple health check - just verify we can access the database
        if (!app.prisma) {
          return false;
        }
        // Basic connectivity test
        await app.prisma.$queryRaw`SELECT 1`;
        return true;
      } catch (error) {
        app.log.warn('Health check failed:', error.message);
        return false;
      }
    };
  }

  await app.register(fastifyUnderPressure, underPressureConfig);

  // Swagger/OpenAPI (optional)
  if (appConfig.features.enableSwagger) {
    // Register swagger and swagger-ui; the repo already includes @fastify/swagger
    await app.register(fastifySwagger, {
      swagger: {
        info: {
          title: 'Accounting API',
          description: 'Accounting API OpenAPI documentation',
          version: '1.0.0'
        }
      },
      exposeRoute: true
    });

    await app.register(fastifySwaggerUi, {
      routePrefix: '/docs',
      uiConfig: {
        docExpansion: 'list'
      }
    });
  }

  // Request-id and response-time
  await app.register(fastifyRequestId, {
    headerName: 'x-request-id'
  });

  // Store high-resolution start time on the request
  app.addHook('onRequest', async request => {
    request.raw.__startHrTime = process.hrtime();
  });

  // Calculate duration and set header just before sending the response
  app.addHook('onSend', async (request, reply, payload) => {
    try {
      const start = request.raw.__startHrTime;
      if (start) {
        const hrDuration = process.hrtime(start);
        const durationMs = (hrDuration[0] * 1e3 + hrDuration[1] / 1e6).toFixed(2);
        reply.header('X-Response-Time', durationMs);
      }
    } catch (e) {
      // Swallow errors here to ensure monitoring endpoints don't fail
      request.log?.warn('response-time hook failed:', e?.message || e);
    }
    return payload;
  });

  // HTTP caching (ETag/Cache-Control)
  const defaultTtlSeconds = appConfig.redis?.defaultTTL ?? 300;
  await app.register(fastifyCaching, {
    // privacy: 'public' is suitable for GET endpoints that return public data
    privacy: 'public',
    // expiresIn expects milliseconds
    expiresIn: defaultTtlSeconds * 1000,
    // Small in-memory cache size to avoid unbounded memory growth in small deployments
    cacheSize: 1000
  });

  // Register routes
  await registerRoutes(app);

  // Advanced global error handler
  app.setErrorHandler(errorHandler);

  // Not found handler using sensible
  app.setNotFoundHandler((request, reply) => {
    reply.callNotFound();
  });

  // Graceful shutdown is handled by the database middleware

  return app;
}
