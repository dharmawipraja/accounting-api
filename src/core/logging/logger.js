/**
 * Express Logging Configuration
 * Pino logger setup for Express.js
 */

import pino from 'pino';
import { env, isDevelopment, isProduction, isTest } from '../../config/env.js';

/**
 * Create Pino logger instance for Express
 */
export function createLogger(config) {
  const logLevel = config?.logging?.level || (isProduction() ? 'warn' : 'info');

  const baseConfig = {
    level: logLevel,
    formatters: {
      level: label => {
        return { level: label };
      },
      bindings: bindings => {
        return {
          pid: bindings.pid,
          hostname: bindings.hostname,
          node_version: process.version
        };
      }
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.body.password',
        'req.body.token',
        'res.headers["set-cookie"]'
      ],
      censor: '[REDACTED]'
    }
  };

  // Development configuration
  if (isDevelopment()) {
    return pino({
      ...baseConfig,
      transport: {
        target: 'pino-pretty',
        options: {
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
          colorize: true,
          singleLine: false,
          messageFormat: '{req.method} {req.url} - {msg}'
        }
      }
    });
  }

  // Test configuration (minimal logging)
  if (isTest()) {
    return pino({
      ...baseConfig,
      level: 'silent'
    });
  }

  // Production configuration
  return pino({
    ...baseConfig,
    serializers: {
      req: req => ({
        id: req.id,
        method: req.method,
        url: req.url,
        hostname: req.hostname,
        remoteAddress: req.ip,
        userAgent: req.headers?.['user-agent']
      }),
      res: res => ({
        statusCode: res.statusCode
      }),
      err: pino.stdSerializers.err
    }
  });
}

/**
 * Request ID generator
 */
export function generateRequestId() {
  return `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Performance logging middleware for Express
 */
export function performanceLogger(logger) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();

    res.on('finish', () => {
      const end = process.hrtime.bigint();
      const duration = Number(end - start) / 1000000; // Convert to milliseconds

      logger.info(
        {
          performance: {
            method: req.method,
            url: req.url,
            statusCode: res.statusCode,
            duration: `${duration.toFixed(2)}ms`,
            userId: req.user?.id,
            ip: req.ip
          }
        },
        `${req.method} ${req.url} - ${res.statusCode} - ${duration.toFixed(2)}ms`
      );
    });

    next();
  };
}

/**
 * Audit logging middleware for Express
 */
export function auditLogger(logger) {
  return (req, res, next) => {
    // Only log sensitive operations
    const sensitiveOperations = ['POST', 'PUT', 'PATCH', 'DELETE'];
    const sensitiveRoutes = ['/auth', '/users', '/accounts', '/ledgers'];

    const isSensitive =
      sensitiveOperations.includes(req.method) ||
      sensitiveRoutes.some(route => req.url.startsWith(route));

    if (isSensitive) {
      const originalSend = res.send;

      res.send = function (data) {
        // Log after response is sent
        logger.info(
          {
            audit: {
              action: `${req.method} ${req.url}`,
              userId: req.user?.id || 'anonymous',
              username: req.user?.username || 'anonymous',
              ip: req.ip,
              userAgent: req.get('User-Agent'),
              statusCode: res.statusCode,
              timestamp: new Date().toISOString(),
              resource: req.url.split('/')[1] || 'unknown'
            }
          },
          `Audit: ${req.method} ${req.url} by ${req.user?.username || 'anonymous'}`
        );

        return originalSend.call(this, data);
      };
    }

    next();
  };
}

/**
 * Error logging utility
 */
export function logError(logger, error, req = null) {
  const errorLog = {
    error: {
      name: error.name,
      message: error.message,
      stack: error.stack,
      statusCode: error.statusCode,
      isOperational: error.isOperational
    }
  };

  if (req) {
    errorLog.request = {
      id: req.id,
      method: req.method,
      url: req.url,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      userId: req.user?.id
    };
  }

  logger.error(errorLog, `Error: ${error.message}`);
}

/**
 * Security logging utility
 */
export function logSecurityEvent(logger, event, req, details = {}) {
  logger.warn(
    {
      security: {
        event,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        userId: req.user?.id,
        url: req.url,
        method: req.method,
        timestamp: new Date().toISOString(),
        ...details
      }
    },
    `Security Event: ${event}`
  );
}

// Create and export default logger instance
const defaultLogger = createLogger({
  logging: { level: env.LOG_LEVEL }
});

export default defaultLogger;
