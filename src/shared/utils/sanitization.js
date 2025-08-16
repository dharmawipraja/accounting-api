/**
 * Data Sanitization Utilities
 * Centralized sanitization functions for logging and security
 */

/**
 * Sensitive field patterns to redact
 */
const SENSITIVE_FIELDS = [
  'password',
  'token',
  'secret',
  'key',
  'apiKey',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie'
];

/**
 * Sanitize SQL query for logging
 * @param {string|Object} query - SQL query to sanitize
 * @param {number} maxLength - Maximum length to keep (default: 500)
 * @returns {string|Object} Sanitized query
 */
export const sanitizeQuery = (query, maxLength = 500) => {
  if (typeof query === 'string') {
    // Remove potential sensitive data
    const sanitized = query
      .replace(/password\s*=\s*'[^']*'/gi, "password='[REDACTED]'")
      .replace(/token\s*=\s*'[^']*'/gi, "token='[REDACTED]'")
      .replace(/secret\s*=\s*'[^']*'/gi, "secret='[REDACTED]'")
      .replace(/key\s*=\s*'[^']*'/gi, "key='[REDACTED]'");

    // Limit length
    return sanitized.substring(0, maxLength);
  }
  return query;
};

/**
 * Sanitize function arguments for logging
 * @param {Array} args - Function arguments to sanitize
 * @returns {Array} Sanitized arguments
 */
export const sanitizeArgs = (args = []) => {
  return args.map(arg => sanitizeObject(arg));
};

/**
 * Sanitize object by redacting sensitive fields
 * @param {*} obj - Object to sanitize
 * @param {number} depth - Current recursion depth
 * @param {number} maxDepth - Maximum recursion depth
 * @returns {*} Sanitized object
 */
export const sanitizeObject = (obj, depth = 0, maxDepth = 3) => {
  // Prevent infinite recursion
  if (depth > maxDepth) {
    return '[MAX_DEPTH_REACHED]';
  }

  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item, depth + 1, maxDepth));
  }

  // Handle regular objects
  const sanitized = {};

  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();

    // Check if field is sensitive
    if (SENSITIVE_FIELDS.some(field => lowerKey.includes(field))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object') {
      sanitized[key] = sanitizeObject(value, depth + 1, maxDepth);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
};

/**
 * Sanitize log data for output
 * @param {Object} data - Log data to sanitize
 * @returns {Object} Sanitized log data
 */
export const sanitizeLogData = data => {
  return sanitizeObject(data);
};

/**
 * Redact sensitive data from strings
 * @param {string} text - Text to sanitize
 * @returns {string} Sanitized text
 */
export const redactSensitiveData = text => {
  if (typeof text !== 'string') return text;

  return (
    text
      // Email patterns
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[EMAIL_REDACTED]')
      // Credit card patterns (basic)
      .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '[CARD_REDACTED]')
      // Phone number patterns
      .replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '[PHONE_REDACTED]')
      // IP addresses (optional - comment out if IPs should be logged)
      // .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP_REDACTED]')
      // JWT tokens (basic pattern)
      .replace(/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g, '[JWT_REDACTED]')
  );
};

export default {
  sanitizeQuery,
  sanitizeArgs,
  sanitizeObject,
  sanitizeLogData,
  redactSensitiveData
};
