/**
 * Structured Logger Configuration
 *
 * Provides centralized logging configuration with structured format,
 * multiple output streams, and environment-aware log levels.
 */

import pino from 'pino';
import { isDevelopment, isProduction } from '../../shared/utils/index.js';

/**
 * Log level configuration based on environment
 */
const getLogLevel = () => {
  if (process.env.LOG_LEVEL) {
    return process.env.LOG_LEVEL;
  }

  if (isDevelopment()) return 'debug';
  if (isProduction()) return 'info';
  return 'info';
};

/**
 * Create structured logger configuration
 */
const createLoggerConfig = () => {
  const baseConfig = {
    level: getLogLevel(),
    formatters: {
      level: label => ({ level: label }),
      log: object => {
        // Ensure all logs have a timestamp
        if (!object.timestamp) {
          object.timestamp = new Date().toISOString();
        }

        // Add environment context
        object.environment = process.env.NODE_ENV || 'development';

        // Add service information
        object.service = 'accounting-api';
        object.version = process.env.npm_package_version || '1.0.0';

        return object;
      }
    },
    serializers: {
      // Custom serializers for common objects
      req: pino.stdSerializers.req,
      res: pino.stdSerializers.res,
      err: pino.stdSerializers.err,

      // Custom serializers for business objects
      user: user => ({
        id: user?.id,
        email: user?.email,
        role: user?.role
      }),

      account: account => ({
        id: account?.id,
        code: account?.code,
        name: account?.name,
        type: account?.type
      }),

      transaction: transaction => ({
        id: transaction?.id,
        amount: transaction?.amount,
        type: transaction?.type,
        status: transaction?.status
      })
    }
  };

  // Development configuration
  if (isDevelopment()) {
    return {
      ...baseConfig,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          levelFirst: true,
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
          ignore: 'pid,hostname,environment,service,version',
          messageFormat: '{msg}',
          errorLikeObjectKeys: ['err', 'error']
        }
      }
    };
  }

  // Production configuration
  if (isProduction()) {
    return {
      ...baseConfig,
      // JSON output for production (for log aggregation systems)
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          'password',
          'token',
          'authorization',
          'cookie',
          'req.headers.authorization',
          'req.headers.cookie'
        ],
        censor: '[REDACTED]'
      }
    };
  }

  // Default configuration
  return baseConfig;
};

/**
 * Create logger instance
 */
const logger = pino(createLoggerConfig());

/**
 * Logger utility functions
 */
export const loggerUtils = {
  /**
   * Create child logger with context
   */
  child: context => logger.child(context),

  /**
   * Log request start
   */
  logRequestStart: request => {
    logger.info(
      {
        req: request,
        requestId: request.id,
        method: request.method,
        url: request.url,
        userAgent: request.headers['user-agent'],
        ip: request.ip
      },
      'Request started'
    );
  },

  /**
   * Log request completion
   */
  logRequestComplete: (request, reply, responseTime) => {
    logger.info(
      {
        req: request,
        res: reply,
        requestId: request.id,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTime,
        ip: request.ip
      },
      'Request completed'
    );
  },

  /**
   * Log authentication events
   */
  logAuth: (event, data) => {
    logger.info(
      {
        event: `auth.${event}`,
        ...data,
        timestamp: new Date().toISOString()
      },
      `Authentication: ${event}`
    );
  },

  /**
   * Log business events
   */
  logBusiness: (event, data) => {
    logger.info(
      {
        event: `business.${event}`,
        ...data,
        timestamp: new Date().toISOString()
      },
      `Business event: ${event}`
    );
  },

  /**
   * Log security events
   */
  logSecurity: (event, data) => {
    logger.warn(
      {
        event: `security.${event}`,
        ...data,
        timestamp: new Date().toISOString()
      },
      `Security event: ${event}`
    );
  },

  /**
   * Log performance metrics
   */
  logPerformance: (operation, metrics) => {
    logger.info(
      {
        event: 'performance',
        operation,
        ...metrics,
        timestamp: new Date().toISOString()
      },
      `Performance: ${operation}`
    );
  },

  /**
   * Log database operations
   */
  logDatabase: (operation, data) => {
    logger.debug(
      {
        event: `database.${operation}`,
        ...data,
        timestamp: new Date().toISOString()
      },
      `Database: ${operation}`
    );
  }
};

export default logger;
