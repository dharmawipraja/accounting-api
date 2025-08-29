/**
 * Environment Variables Configuration
 * Centralized access to all environment variables
 */

// Helper functions
const toBoolean = (value, defaultValue = false) => {
  if (value === undefined || value === null) return defaultValue;
  return value.toLowerCase() === 'true';
};

const toNumber = (value, defaultValue = 0) => {
  const parsed = parseInt(value);
  return isNaN(parsed) ? defaultValue : parsed;
};

const toArray = (value, defaultValue = []) => {
  if (!value) return defaultValue;
  return value.split(',').map(item => item.trim());
};

// Environment variables with defaults
export const env = {
  // Environment
  NODE_ENV: process.env.NODE_ENV || 'development',

  // Server
  HOST: process.env.HOST || '0.0.0.0',
  PORT: toNumber(process.env.PORT, 3000),

  // Database
  DATABASE_URL: process.env.DATABASE_URL,

  // JWT Authentication
  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '24h',

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  LOG_RETENTION_DAYS: toNumber(
    process.env.LOG_RETENTION_DAYS,
    process.env.NODE_ENV === 'production' ? 14 : 1
  ),
  LOG_MAX_SIZE: process.env.LOG_MAX_SIZE || '100M',

  // Rate Limiting
  RATE_LIMIT_MAX: toNumber(process.env.RATE_LIMIT_MAX, 100),
  RATE_LIMIT_TIME_WINDOW: process.env.RATE_LIMIT_TIME_WINDOW || '15 minutes',

  // CORS
  CORS_ORIGIN: process.env.CORS_ORIGIN
    ? toArray(process.env.CORS_ORIGIN)
    : ['http://localhost:3000', 'http://localhost:3001'],
  CORS_CREDENTIALS: toBoolean(process.env.CORS_CREDENTIALS, true),

  // Session
  SESSION_SECRET: process.env.SESSION_SECRET,

  // Development overrides (optional)
  LOG_PRETTY_PRINT: toBoolean(process.env.LOG_PRETTY_PRINT),

  // App specific
  APP_TIMEZONE: process.env.APP_TIMEZONE || 'Asia/Makassar'
};

// Environment helpers
export const isDevelopment = () => env.NODE_ENV === 'development';
export const isProduction = () => env.NODE_ENV === 'production';
export const isTest = () => env.NODE_ENV === 'test';

// Validation function
export const validateRequiredEnv = () => {
  const required = ['DATABASE_URL'];
  const missing = required.filter(key => !env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  // Production-specific requirements
  if (isProduction()) {
    const prodRequired = ['JWT_SECRET', 'SESSION_SECRET'];
    const prodMissing = prodRequired.filter(key => !env[key]);

    if (prodMissing.length > 0) {
      throw new Error(
        `Missing required production environment variables: ${prodMissing.join(', ')}`
      );
    }
  }
};

export default env;
