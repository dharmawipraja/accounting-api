/**
 * Logging System Exports
 *
 * Central export point for all logging utilities and middleware.
 */

import { AUDIT_EVENTS, AuditLogger, auditMiddleware, withAudit } from './auditLogger.js';
import {
  complianceRequirements,
  getLogFormat,
  logFormats,
  logLevels,
  logTemplates,
  sanitizationRules,
  shouldLog
} from './logFormats.js';
import logger, { loggerUtils } from './logger.js';
import {
  PerformanceLogger,
  performanceMiddleware,
  withQueryPerformance
} from './performanceLogger.js';
import { RequestLogger, createRequestLogger, requestLoggerMiddleware } from './requestLogger.js';

// Main logger instance
export default logger;
export { logger };

// Logger utilities
export { loggerUtils };

// Request logging
export { RequestLogger, createRequestLogger, requestLoggerMiddleware };

// Audit logging
export { AUDIT_EVENTS, AuditLogger, auditMiddleware, withAudit };

// Performance logging
export { PerformanceLogger, performanceMiddleware, withQueryPerformance };

// Log formats and configuration
export {
  complianceRequirements,
  getLogFormat,
  logFormats,
  logLevels,
  logTemplates,
  sanitizationRules,
  shouldLog
};

// Convenience functions
export const createLogger = context => logger.child(context);

// Logging middleware bundle for easy registration
export const loggingMiddleware = {
  async register(fastify) {
    // Register all logging middleware
    await fastify.register(requestLoggerMiddleware.register);
    await fastify.register(auditMiddleware.register);
    await fastify.register(performanceMiddleware.register);
  }
};

// Alias for easier use
export const registerLoggingMiddleware = loggingMiddleware.register;

// Quick access logging functions
export const log = {
  info: (message, data = {}) => logger.info(data, message),
  warn: (message, data = {}) => logger.warn(data, message),
  error: (message, error = null, data = {}) => logger.error({ err: error, ...data }, message),
  debug: (message, data = {}) => logger.debug(data, message),
  trace: (message, data = {}) => logger.trace(data, message),

  // Business event shortcuts
  auth: (event, data) => AuditLogger.logAuth(event, data.userId, data),
  business: (event, data) => AuditLogger.log(event, data),
  security: (event, data) => AuditLogger.logSecurity(event, data),
  performance: (operation, duration, data) =>
    PerformanceLogger.logBusinessOperation(operation, duration, data)
};
