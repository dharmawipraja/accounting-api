/**
 * Express Logging Configuration
 * Pino logger setup for Express.js with daily log rotation
 */

import path from 'path';
import pino from 'pino';
import { fileURLToPath } from 'url';
import { env, isDevelopment, isProduction, isTest } from '../../config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get the project root directory (3 levels up from this file)
const PROJECT_ROOT = path.resolve(__dirname, '../../../');
const LOGS_DIR = path.join(PROJECT_ROOT, 'logs');

/**
 * Create log rotation transport configuration
 */
function createLogRotationTransport() {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
  const logFileName = `app-${today}.log`;
  const logFilePath = path.join(LOGS_DIR, logFileName);

  // Set retention days based on environment
  const retentionDays = env.LOG_RETENTION_DAYS;

  return {
    target: 'pino-roll',
    options: {
      file: logFilePath,
      frequency: 'daily',
      mkdir: true,
      size: env.LOG_MAX_SIZE, // Rotate when file reaches configured size
      limit: {
        count: retentionDays
      }
    }
  };
}

/**
 * Create development transport (pretty + file)
 */
function createDevelopmentTransports() {
  return {
    targets: [
      {
        target: 'pino-pretty',
        level: 'debug',
        options: {
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
          colorize: true,
          singleLine: false,
          messageFormat: '{req.method} {req.url} - {msg}'
        }
      },
      {
        ...createLogRotationTransport(),
        level: 'info'
      }
    ]
  };
}

/**
 * Create production transport (file only)
 */
function createProductionTransport() {
  return createLogRotationTransport();
}

/**
 * Create Pino logger instance for Express
 */
export function createLogger(config) {
  const logLevel = config?.logging?.level || (isProduction() ? 'warn' : 'info');

  const baseConfig = {
    level: logLevel,
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

  // Add formatters only for single target configurations
  const singleTargetFormatters = {
    level: label => {
      return { level: label };
    },
    bindings: bindings => {
      return {
        pid: bindings.pid,
        hostname: bindings.hostname,
        environment: env.NODE_ENV
      };
    }
  };

  // Test configuration (minimal logging)
  if (isTest()) {
    return pino({
      ...baseConfig,
      formatters: singleTargetFormatters,
      level: 'silent'
    });
  }

  // Development configuration (console + file)
  if (isDevelopment()) {
    return pino({
      ...baseConfig,
      transport: createDevelopmentTransports()
    });
  }

  // Production configuration (file only)
  return pino({
    ...baseConfig,
    formatters: singleTargetFormatters,
    transport: createProductionTransport(),
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
