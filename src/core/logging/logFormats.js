/**
 * Log Format Definitions
 *
 * Provides standardized log format configurations for different
 * environments and use cases.
 */

/**
 * Log format configurations
 */
export const logFormats = {
  /**
   * Development format - human readable
   */
  development: {
    level: 'debug',
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        levelFirst: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname',
        messageFormat: '{msg}',
        errorLikeObjectKeys: ['err', 'error'],
        customPrettifiers: {
          level: level => `[${level.toUpperCase()}]`,
          time: timestamp => `[${timestamp}]`
        }
      }
    }
  },

  /**
   * Production format - structured JSON
   */
  production: {
    level: 'info',
    timestamp: true,
    formatters: {
      level: label => ({ level: label }),
      log: object => {
        // Ensure consistent structure
        return {
          timestamp: new Date().toISOString(),
          service: 'accounting-api',
          environment: 'production',
          ...object
        };
      }
    },
    redact: {
      paths: [
        'password',
        'token',
        'authorization',
        'cookie',
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'user.password',
        'account.secret'
      ],
      censor: '[REDACTED]'
    }
  },

  /**
   * Testing format - minimal output
   */
  test: {
    level: 'error',
    enabled: false
  },

  /**
   * Audit format - compliance focused
   */
  audit: {
    level: 'info',
    timestamp: true,
    formatters: {
      level: label => ({ level: label }),
      log: object => {
        return {
          timestamp: new Date().toISOString(),
          service: 'accounting-api',
          logType: 'audit',
          compliance: true,
          ...object
        };
      }
    }
  },

  /**
   * Performance format - metrics focused
   */
  performance: {
    level: 'debug',
    timestamp: true,
    formatters: {
      level: label => ({ level: label }),
      log: object => {
        return {
          timestamp: new Date().toISOString(),
          service: 'accounting-api',
          logType: 'performance',
          ...object
        };
      }
    }
  },

  /**
   * Security format - security events
   */
  security: {
    level: 'warn',
    timestamp: true,
    formatters: {
      level: label => ({ level: label }),
      log: object => {
        return {
          timestamp: new Date().toISOString(),
          service: 'accounting-api',
          logType: 'security',
          severity: object.severity || 'medium',
          ...object
        };
      }
    }
  }
};

/**
 * Log level mappings
 */
export const logLevels = {
  TRACE: 10,
  DEBUG: 20,
  INFO: 30,
  WARN: 40,
  ERROR: 50,
  FATAL: 60
};

/**
 * Standard log message templates
 */
export const logTemplates = {
  // Authentication
  authSuccess: (userId, ip) => ({
    event: 'auth.login.success',
    userId,
    ip,
    message: `User ${userId} logged in successfully`
  }),

  authFailure: (email, ip, reason) => ({
    event: 'auth.login.failure',
    email,
    ip,
    reason,
    message: `Login failed for ${email}: ${reason}`
  }),

  // Business operations
  transactionCreated: (transactionId, amount, userId) => ({
    event: 'transaction.created',
    transactionId,
    amount,
    userId,
    message: `Transaction ${transactionId} created for amount ${amount}`
  }),

  accountCreated: (accountId, userId) => ({
    event: 'account.created',
    accountId,
    userId,
    message: `Account ${accountId} created by user ${userId}`
  }),

  // Security events
  unauthorizedAccess: (ip, url, userId) => ({
    event: 'security.unauthorized_access',
    ip,
    url,
    userId,
    severity: 'high',
    message: `Unauthorized access attempt to ${url} from ${ip}`
  }),

  rateLimitExceeded: (ip, endpoint) => ({
    event: 'security.rate_limit_exceeded',
    ip,
    endpoint,
    severity: 'medium',
    message: `Rate limit exceeded for ${ip} on ${endpoint}`
  }),

  // Performance events
  slowQuery: (query, duration) => ({
    event: 'performance.slow_query',
    query,
    duration,
    message: `Slow database query detected: ${duration}ms`
  }),

  slowEndpoint: (method, path, duration) => ({
    event: 'performance.slow_endpoint',
    method,
    path,
    duration,
    message: `Slow API endpoint: ${method} ${path} (${duration}ms)`
  }),

  // System events
  systemError: (error, context) => ({
    event: 'system.error',
    error: error.message,
    stack: error.stack,
    context,
    severity: 'high',
    message: `System error occurred: ${error.message}`
  }),

  systemStartup: (version, environment) => ({
    event: 'system.startup',
    version,
    environment,
    message: `Accounting API v${version} started in ${environment} mode`
  }),

  systemShutdown: reason => ({
    event: 'system.shutdown',
    reason,
    message: `System shutdown initiated: ${reason}`
  })
};

/**
 * Get log format based on environment
 */
export const getLogFormat = (environment = process.env.NODE_ENV) => {
  switch (environment) {
    case 'development':
      return logFormats.development;
    case 'production':
      return logFormats.production;
    case 'test':
      return logFormats.test;
    case 'staging':
      return logFormats.production; // Use production format for staging
    default:
      return logFormats.development;
  }
};

/**
 * Custom log level checker
 */
export const shouldLog = (level, configLevel = 'info') => {
  const levelValue = logLevels[level.toUpperCase()];
  const configLevelValue = logLevels[configLevel.toUpperCase()];

  return levelValue >= configLevelValue;
};

/**
 * Log sanitization rules
 */
export const sanitizationRules = {
  // Fields to redact completely
  redactFields: ['password', 'token', 'secret', 'key', 'authorization', 'cookie', 'session'],

  // Fields to truncate
  truncateFields: {
    query: 500,
    message: 1000,
    description: 500
  },

  // Fields to hash (for compliance while maintaining searchability)
  hashFields: ['email', 'phone', 'ssn', 'taxId']
};

/**
 * Compliance log requirements
 */
export const complianceRequirements = {
  // Required fields for audit logs
  auditRequired: ['timestamp', 'event', 'userId', 'ip', 'userAgent', 'resource', 'action'],

  // Fields required for financial transaction logs
  financialRequired: [
    'timestamp',
    'transactionId',
    'amount',
    'currency',
    'accountFrom',
    'accountTo',
    'userId',
    'status'
  ],

  // Retention periods (in days)
  retention: {
    audit: 2555, // 7 years
    security: 1095, // 3 years
    performance: 90, // 90 days
    debug: 30 // 30 days
  }
};
