/**
 * Application Configuration
 * Simplified configuration using centralized environment variables
 */

import { env, isDevelopment, isProduction, isTest, validateRequiredEnv } from './env.js';

/**
 * Database Configuration
 */
export const databaseConfig = {
  url: env.DATABASE_URL
};

/**
 * Server Configuration
 */
export const serverConfig = {
  host: env.HOST,
  port: env.PORT,
  nodeEnv: env.NODE_ENV
};

/**
 * Logging Configuration
 */
export const loggingConfig = {
  level: env.LOG_LEVEL,
  prettyPrint: env.LOG_PRETTY_PRINT || isDevelopment(),
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
  jwtSecret: env.JWT_SECRET,
  jwtExpiresIn: env.JWT_EXPIRES_IN,
  corsOrigin: env.CORS_ORIGIN,
  corsCredentials: env.CORS_CREDENTIALS,
  rateLimitMax: env.RATE_LIMIT_MAX,
  rateLimitWindow: env.RATE_LIMIT_TIME_WINDOW,
  sessionSecret: env.SESSION_SECRET
};

/**
 * Application Configuration
 */
export const appConfig = {
  timezone: env.APP_TIMEZONE,
  nodeEnv: env.NODE_ENV
};

/**
 * Features Configuration
 */
export const featuresConfig = {
  enableCompression: true,
  compressionThreshold: 1024
};

/**
 * Get complete configuration
 */
export const getConfig = () => {
  validateRequiredEnv();

  return {
    server: serverConfig,
    database: databaseConfig,
    logging: loggingConfig,
    security: securityConfig,
    app: appConfig,
    features: featuresConfig,
    env,
    isDevelopment: isDevelopment(),
    isProduction: isProduction(),
    isTest: isTest()
  };
};

/**
 * Configuration validation (for backward compatibility)
 */
export const validateConfig = (_config = getConfig()) => {
  // This just calls the env validation now
  return validateRequiredEnv();
};

/**
 * Export environment helpers for direct use
 */
export { env, isDevelopment, isProduction, isTest, validateRequiredEnv };

/**
 * Default export
 */
export default {
  getConfig,
  validateConfig,
  env,
  databaseConfig,
  serverConfig,
  loggingConfig,
  securityConfig,
  appConfig,
  featuresConfig,
  isDevelopment,
  isProduction,
  isTest,
  validateRequiredEnv
};
