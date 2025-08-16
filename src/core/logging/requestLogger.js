/**
 * Request Logger Middleware
 *
 * Provides comprehensive HTTP request/response logging with
 * performance metrics and request tracing.
 */

import { loggerUtils } from './logger.js';

/**
 * Request logging middleware for Fastify
 */
export const requestLoggerMiddleware = {
  /**
   * Register request logging hooks
   */
  register: async fastify => {
    // Log incoming requests
    fastify.addHook('onRequest', async (request, _reply) => {
      request.startTime = process.hrtime.bigint();

      // Skip logging for health checks in production
      if (shouldSkipLogging(request)) {
        return;
      }

      loggerUtils.logRequestStart(request);
    });

    // Log request completion
    fastify.addHook('onResponse', async (request, reply) => {
      if (shouldSkipLogging(request)) {
        return;
      }

      const endTime = process.hrtime.bigint();
      const responseTime = Number(endTime - request.startTime) / 1000000; // Convert to milliseconds

      loggerUtils.logRequestComplete(request, reply, responseTime);

      // Log slow requests
      if (responseTime > getSlowRequestThreshold()) {
        loggerUtils.logPerformance('slow_request', {
          requestId: request.id,
          method: request.method,
          url: request.url,
          responseTime,
          statusCode: reply.statusCode
        });
      }
    });

    // Log request errors
    fastify.addHook('onError', async (request, reply, error) => {
      if (shouldSkipLogging(request)) {
        return;
      }

      const endTime = process.hrtime.bigint();
      const responseTime = Number(endTime - request.startTime) / 1000000;

      fastify.log.error(
        {
          err: error,
          req: request,
          requestId: request.id,
          method: request.method,
          url: request.url,
          responseTime,
          userAgent: request.headers['user-agent'],
          ip: request.ip
        },
        'Request error occurred'
      );
    });
  }
};

/**
 * Determine if request logging should be skipped
 */
const shouldSkipLogging = request => {
  const skipPaths = ['/status', '/favicon.ico'];
  const isProduction = process.env.NODE_ENV === 'production';
  const isHealthCheck = request.url.startsWith('/health') || request.url.startsWith('/ready');

  return (isProduction && isHealthCheck) || skipPaths.includes(request.url);
};

/**
 * Get slow request threshold based on environment
 */
const getSlowRequestThreshold = () => {
  const threshold = process.env.SLOW_REQUEST_THRESHOLD;
  if (threshold) {
    return parseInt(threshold, 10);
  }

  // Default thresholds in milliseconds
  switch (process.env.NODE_ENV) {
    case 'production':
      return 1000; // 1 second
    case 'staging':
      return 2000; // 2 seconds
    default:
      return 5000; // 5 seconds for development
  }
};

/**
 * Request context logger
 */
export class RequestLogger {
  constructor(request) {
    this.request = request;
    this.logger =
      request.log ||
      loggerUtils.child({
        requestId: request.id,
        method: request.method,
        url: request.url
      });
  }

  /**
   * Log with request context
   */
  info(message, data = {}) {
    this.logger.info(
      {
        ...data,
        requestId: this.request.id
      },
      message
    );
  }

  warn(message, data = {}) {
    this.logger.warn(
      {
        ...data,
        requestId: this.request.id
      },
      message
    );
  }

  error(message, error = null, data = {}) {
    this.logger.error(
      {
        err: error,
        ...data,
        requestId: this.request.id
      },
      message
    );
  }

  debug(message, data = {}) {
    this.logger.debug(
      {
        ...data,
        requestId: this.request.id
      },
      message
    );
  }

  /**
   * Log authentication events with request context
   */
  logAuth(event, userId = null, data = {}) {
    loggerUtils.logAuth(event, {
      requestId: this.request.id,
      userId,
      ip: this.request.ip,
      userAgent: this.request.headers['user-agent'],
      ...data
    });
  }

  /**
   * Log business events with request context
   */
  logBusiness(event, data = {}) {
    loggerUtils.logBusiness(event, {
      requestId: this.request.id,
      userId: this.request.user?.id,
      ...data
    });
  }

  /**
   * Log security events with request context
   */
  logSecurity(event, data = {}) {
    loggerUtils.logSecurity(event, {
      requestId: this.request.id,
      ip: this.request.ip,
      userAgent: this.request.headers['user-agent'],
      userId: this.request.user?.id,
      ...data
    });
  }
}

/**
 * Create request logger instance
 */
export const createRequestLogger = request => {
  return new RequestLogger(request);
};
