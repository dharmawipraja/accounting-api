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
          hostname: bindings.hostname
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

// Create and export default logger instance
const defaultLogger = createLogger({
  logging: { level: env.LOG_LEVEL }
});

export default defaultLogger;
