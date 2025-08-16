/**
 * Application Configuration
 *
 * Centralized configuration management for the accounting API.
 * This module handles environment variables, validation, and provides
 * typed configuration objects for different parts of the application.
 */

import { isDevelopment, isProduction, isTest } from '../utils/index.js';

/**
 * Validate required environment variables
 */
const validateEnvironment = () => {
  const required = ['DATABASE_URL'];
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
};

/**
 * Parse boolean environment variable
 */
const parseBoolean = (value, defaultValue = false) => {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true';
};

/**
 * Parse integer environment variable with validation
 */
const parseInteger = (value, defaultValue, min = 0, max = Infinity) => {
  const parsed = parseInt(value) || defaultValue;
  return Math.max(min, Math.min(max, parsed));
};

/**
 * Database Configuration
 */
export const databaseConfig = {
  url: process.env.DATABASE_URL,

  // Connection pool settings
  connectionLimit: parseInteger(process.env.DB_CONNECTION_LIMIT, isProduction() ? 10 : 5, 1, 50),

  // Connection timeout in milliseconds
  connectionTimeout: parseInteger(process.env.DB_CONNECTION_TIMEOUT, 10000, 1000, 60000),

  // Query timeout in milliseconds
  queryTimeout: parseInteger(process.env.DB_QUERY_TIMEOUT, 30000, 1000, 300000),

  // Transaction settings
  transactionTimeout: parseInteger(process.env.DB_TRANSACTION_TIMEOUT, 10000, 1000, 60000),

  // Retry configuration
  maxRetries: parseInteger(process.env.DB_MAX_RETRIES, 3, 0, 10),

  // Logging configuration
  enableQueryLogging: parseBoolean(process.env.DB_ENABLE_QUERY_LOGGING, isDevelopment()),

  // Slow query threshold in milliseconds
  slowQueryThreshold: parseInteger(process.env.DB_SLOW_QUERY_THRESHOLD, 1000, 100, 10000)
};

/**
 * Server Configuration
 */
export const serverConfig = {
  // Basic server settings
  host: process.env.HOST || '0.0.0.0',
  port: parseInteger(process.env.PORT, 3000, 1, 65535),

  // Environment
  nodeEnv: process.env.NODE_ENV || 'development',

  // Security settings
  trustProxy: parseBoolean(process.env.TRUST_PROXY, isProduction()),

  // Performance settings
  requestTimeout: parseInteger(process.env.REQUEST_TIMEOUT, 30000, 1000, 300000),

  bodyLimit: parseInteger(
    process.env.BODY_LIMIT,
    10485760, // 10MB
    1024,
    52428800 // 50MB max
  ),

  keepAliveTimeout: parseInteger(process.env.KEEP_ALIVE_TIMEOUT, 30000, 1000, 300000),

  headersTimeout: parseInteger(process.env.HEADERS_TIMEOUT, 31000, 1000, 300000),

  // Request logging
  disableRequestLogging: parseBoolean(process.env.DISABLE_REQUEST_LOGGING, isProduction())
};

/**
 * Logging Configuration
 */
export const loggingConfig = {
  level: process.env.LOG_LEVEL || (isProduction() ? 'warn' : 'info'),

  // Pretty printing in development
  prettyPrint: parseBoolean(process.env.LOG_PRETTY_PRINT, isDevelopment()),

  // Request/Response logging
  logRequests: parseBoolean(process.env.LOG_REQUESTS, !isProduction()),

  logResponses: parseBoolean(process.env.LOG_RESPONSES, isDevelopment()),

  // Sensitive data redaction
  redactPaths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.body.password',
    'req.body.token',
    'res.headers["set-cookie"]'
  ]
};

/**
 * Security Configuration
 */
export const securityConfig = {
  // JWT settings
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',

  // CORS settings
  corsOrigin: process.env.CORS_ORIGIN?.split(',').map(o => o.trim()) || ['*'],
  corsCredentials: parseBoolean(process.env.CORS_CREDENTIALS, true),

  // Rate limiting
  rateLimitMax: parseInteger(process.env.RATE_LIMIT_MAX, 100, 1, 10000),
  rateLimitWindow: process.env.RATE_LIMIT_TIME_WINDOW || '1 minute',
  rateLimitSkipOnError: parseBoolean(process.env.RATE_LIMIT_SKIP_ON_ERROR, true),

  // Helmet/Security headers
  enableHSTS: parseBoolean(process.env.ENABLE_HSTS, isProduction()),
  enableCSP: parseBoolean(process.env.ENABLE_CSP, true),

  // Session settings
  sessionSecret: process.env.SESSION_SECRET,
  sessionMaxAge: parseInteger(
    process.env.SESSION_MAX_AGE,
    24 * 60 * 60 * 1000, // 24 hours
    60000, // 1 minute
    7 * 24 * 60 * 60 * 1000 // 7 days
  ),

  // Enhanced security features
  enableAdvancedRateLimit: parseBoolean(process.env.ENABLE_ADVANCED_RATE_LIMIT, true),
  enableInputSanitization: parseBoolean(process.env.ENABLE_INPUT_SANITIZATION, true),
  enableEncryption: parseBoolean(process.env.ENABLE_ENCRYPTION, false),
  enableAuditTrail: parseBoolean(process.env.ENABLE_AUDIT_TRAIL, true),
  enableEnhancedHeaders: parseBoolean(process.env.ENABLE_ENHANCED_HEADERS, true),
  enableCSRF: parseBoolean(process.env.ENABLE_CSRF, false),

  // Encryption settings
  encryptionKey: process.env.ENCRYPTION_KEY,

  // Security headers configuration
  cspPolicy: process.env.CSP_POLICY || 'strict',
  hstsConfig: process.env.HSTS_CONFIG || 'strict',
  apiOnly: parseBoolean(process.env.SECURITY_API_ONLY, true),

  // Input sanitization options
  sanitizeBody: parseBoolean(process.env.SANITIZE_BODY, true),
  sanitizeQuery: parseBoolean(process.env.SANITIZE_QUERY, true),
  sanitizeParams: parseBoolean(process.env.SANITIZE_PARAMS, true),
  stripHtmlTags: parseBoolean(process.env.STRIP_HTML_TAGS, true),
  removeScriptTags: parseBoolean(process.env.REMOVE_SCRIPT_TAGS, true),
  encodeSpecialChars: parseBoolean(process.env.ENCODE_SPECIAL_CHARS, true)
};

/**
 * Redis Configuration (for caching and rate limiting)
 */
export const redisConfig = {
  url: process.env.REDIS_URL,
  enabled: !!process.env.REDIS_URL,

  // Connection settings
  connectTimeout: parseInteger(process.env.REDIS_CONNECT_TIMEOUT, 10000),
  lazyConnect: parseBoolean(process.env.REDIS_LAZY_CONNECT, true),

  // Retry configuration
  retryDelayOnFailover: parseInteger(process.env.REDIS_RETRY_DELAY, 100),
  maxRetriesPerRequest: parseInteger(process.env.REDIS_MAX_RETRIES, 3),

  // Cache settings
  defaultTTL: parseInteger(process.env.CACHE_DEFAULT_TTL, 300), // 5 minutes

  // Key prefixes
  keyPrefix: process.env.REDIS_KEY_PREFIX || 'accounting-api:',

  // Session storage
  sessionPrefix: 'session:',
  rateLimitPrefix: 'rate-limit:'
};

/**
 * Application Features Configuration
 */
export const featuresConfig = {
  // API versioning
  enableV1: parseBoolean(process.env.ENABLE_API_V1, true),
  enableV2: parseBoolean(process.env.ENABLE_API_V2, false),

  // Monitoring and metrics
  enableMetrics: parseBoolean(process.env.ENABLE_METRICS, false),
  enableHealthCheck: parseBoolean(process.env.ENABLE_HEALTH_CHECK, true),

  // Performance features
  enableCompression: parseBoolean(process.env.ENABLE_COMPRESSION, true),
  compressionThreshold: parseInteger(process.env.COMPRESSION_THRESHOLD, 1024),

  // Development features
  enableSwagger: parseBoolean(process.env.ENABLE_SWAGGER, isDevelopment()),
  enableCors: parseBoolean(process.env.ENABLE_CORS, true),

  // Database features
  enableQueryLogging: parseBoolean(process.env.ENABLE_QUERY_LOGGING, isDevelopment()),
  enableSlowQueryLogging: parseBoolean(process.env.ENABLE_SLOW_QUERY_LOGGING, true)
};

/**
 * Validation schema for Fastify env plugin
 */
export const envSchema = {
  type: 'object',
  required: ['DATABASE_URL'],
  properties: {
    // Server
    NODE_ENV: { type: 'string', default: 'development' },
    HOST: { type: 'string', default: '0.0.0.0' },
    PORT: { type: 'string', default: '3000' },

    // Database
    DATABASE_URL: { type: 'string' },
    DB_CONNECTION_LIMIT: { type: 'string' },
    DB_CONNECTION_TIMEOUT: { type: 'string' },
    DB_QUERY_TIMEOUT: { type: 'string' },

    // Logging
    LOG_LEVEL: { type: 'string', default: 'info' },
    LOG_PRETTY_PRINT: { type: 'string' },

    // Security
    JWT_SECRET: { type: 'string' },
    JWT_EXPIRES_IN: { type: 'string', default: '24h' },
    CORS_ORIGIN: { type: 'string', default: '*' },
    SESSION_SECRET: { type: 'string' },

    // Enhanced security
    ENABLE_ADVANCED_RATE_LIMIT: { type: 'string', default: 'true' },
    ENABLE_INPUT_SANITIZATION: { type: 'string', default: 'true' },
    ENABLE_ENCRYPTION: { type: 'string', default: 'false' },
    ENABLE_AUDIT_TRAIL: { type: 'string', default: 'true' },
    ENABLE_ENHANCED_HEADERS: { type: 'string', default: 'true' },
    ENABLE_CSRF: { type: 'string', default: 'false' },
    ENCRYPTION_KEY: { type: 'string' },
    CSP_POLICY: { type: 'string', default: 'strict' },
    HSTS_CONFIG: { type: 'string', default: 'strict' },
    SECURITY_API_ONLY: { type: 'string', default: 'true' },

    // Rate limiting
    RATE_LIMIT_MAX: { type: 'string', default: '100' },
    RATE_LIMIT_TIME_WINDOW: { type: 'string', default: '1 minute' },

    // Redis
    REDIS_URL: { type: 'string' },

    // Features
    ENABLE_SWAGGER: { type: 'string' },
    ENABLE_METRICS: { type: 'string' },
    ENABLE_COMPRESSION: { type: 'string', default: 'true' },
    // Application timezone (IANA name)
    APP_TIMEZONE: { type: 'string', default: 'Asia/Makassar' }
  }
};

/**
 * Application-level config
 */
export const appConfig = {
  // IANA timezone name used for date parsing/normalization
  timezone: process.env.APP_TIMEZONE || 'Asia/Makassar'
};

/**
 * Get configuration for specific environment
 */
export const getConfig = () => {
  // Validate environment first
  validateEnvironment();

  return {
    server: serverConfig,
    database: databaseConfig,
    logging: loggingConfig,
    security: securityConfig,
    redis: redisConfig,
    features: featuresConfig,
    app: appConfig,

    // Environment helpers
    isDevelopment: isDevelopment(),
    isProduction: isProduction(),
    isTest: isTest()
  };
};

/**
 * Configuration validation
 */
export const validateConfig = (config = getConfig()) => {
  const errors = [];

  // Database validation
  if (!config.database.url) {
    errors.push('DATABASE_URL is required');
  }

  // JWT validation in production
  if (config.isProduction && !config.security.jwtSecret) {
    errors.push('JWT_SECRET is required in production');
  }

  // Session secret validation
  if (config.isProduction && !config.security.sessionSecret) {
    errors.push('SESSION_SECRET is required in production');
  }

  // Encryption key validation
  if (config.security.enableEncryption && !config.security.encryptionKey) {
    errors.push('ENCRYPTION_KEY is required when encryption is enabled');
  }

  // Port validation
  if (config.server.port < 1 || config.server.port > 65535) {
    errors.push('PORT must be between 1 and 65535');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
  }

  return true;
};

/**
 * Default export with all configurations
 */
export default {
  getConfig,
  validateConfig,
  envSchema,
  databaseConfig,
  serverConfig,
  loggingConfig,
  securityConfig,
  redisConfig,
  featuresConfig,
  appConfig
};
