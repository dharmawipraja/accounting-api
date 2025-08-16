/**
 * Enhanced Security Module
 *
 * This module provides a comprehensive security layer for the accounting API,
 * extending the existing Fastify security plugins with additional functionality.
 */

export {
  authRateLimitPlugin,
  createCustomRateLimit,
  heavyRateLimitPlugin,
  rateLimitStrategies,
  sensitiveRateLimitPlugin,
  userRateLimitPlugin,
  withRateLimit
} from './rateLimiting.js';

export {
  decodeHtml,
  detectSqlInjection,
  encodeHtml,
  inputSanitizationPlugin,
  removeScripts,
  safeTextSchema,
  safeUserInputSchema,
  sanitizedString,
  sanitizeObject,
  sanitizeString,
  stripHtml
} from './inputSanitization.js';

export {
  createHmac,
  decrypt,
  decryptSensitiveFields,
  decryptWithPassword,
  deriveKey,
  encrypt,
  encryptedDataSchema,
  encryptionPlugin,
  encryptSensitiveFields,
  encryptWithPassword,
  generateIV,
  generateKey,
  generateSalt,
  generateToken,
  generateUUID,
  hash,
  passwordEncryptedDataSchema,
  verifyHmac
} from './encryption.js';

export {
  auditTrailPlugin,
  RiskLevel,
  SecurityAuditLogger,
  securityEventSchema,
  SecurityEventType
} from './auditTrail.js';

export {
  cspPolicies,
  csrfProtectionPlugin,
  hstsConfigs,
  securityHeaders,
  securityHeadersPlugin
} from './securityHeaders.js';

import { auditTrailPlugin } from './auditTrail.js';
import { encryptionPlugin } from './encryption.js';
import { inputSanitizationPlugin } from './inputSanitization.js';
import { csrfProtectionPlugin, securityHeadersPlugin } from './securityHeaders.js';

/**
 * Complete security suite plugin
 */
export async function securitySuitePlugin(fastify, options = {}) {
  const {
    // Input sanitization options
    enableInputSanitization = true,
    sanitizationOptions = {
      sanitizeBody: true,
      sanitizeQuery: true,
      sanitizeParams: true,
      globalOptions: {
        stripHtmlTags: true,
        removeScriptTags: true,
        encodeSpecialChars: true
      }
    },

    // Encryption options
    enableEncryption = false,
    encryptionKey = null,

    // Audit trail options
    enableAuditTrail = true,

    // Security headers options
    enableEnhancedHeaders = true,
    headerOptions = {
      environment: fastify.config?.nodeEnv || 'production',
      enableCSP: true,
      enableHSTS: true,
      cspPolicy: 'strict',
      hstsConfig: 'strict',
      apiOnly: true
    },

    // CSRF protection options
    enableCSRF = false,
    csrfOptions = {},

    // Rate limiting options - NEW
    enableGlobalRateLimit = true,
    rateLimitOptions = {}
  } = options;

  fastify.log.info('Initializing enhanced security suite...');

  // Global rate limiting (if enabled)
  if (enableGlobalRateLimit) {
    const config = fastify.config || {};
    const defaultRateLimitOptions = {
      max: config.security?.rateLimitMax || 100,
      timeWindow: config.security?.rateLimitWindow || '1 minute',
      cache: 10000,
      allowList: ['127.0.0.1', '::1'],
      redis: config.redis?.enabled ? { url: config.redis.url } : undefined,
      skipOnError: config.security?.rateLimitSkipOnError ?? true,
      addHeadersOnExceeding: true,
      addHeaders: {
        'x-ratelimit-limit': true,
        'x-ratelimit-remaining': true,
        'x-ratelimit-reset': true
      },
      errorResponseBuilder: (request, context) => {
        throw request.server.httpErrors.tooManyRequests(
          `Rate limit exceeded, retry in ${Math.round(context.ttl / 1000)} seconds`
        );
      }
    };

    await fastify.register(import('@fastify/rate-limit'), {
      ...defaultRateLimitOptions,
      ...rateLimitOptions
    });
    fastify.log.info('✓ Global rate limiting enabled');
  }

  // Input sanitization
  if (enableInputSanitization) {
    await fastify.register(inputSanitizationPlugin, sanitizationOptions);
    fastify.log.info('✓ Input sanitization enabled');
  }

  // Encryption utilities
  if (enableEncryption && encryptionKey) {
    await fastify.register(encryptionPlugin, { encryptionKey });
    fastify.log.info('✓ Encryption utilities enabled');
  }

  // Security audit trail
  if (enableAuditTrail) {
    await fastify.register(auditTrailPlugin);
    fastify.log.info('✓ Security audit trail enabled');
  }

  // Enhanced security headers (includes helmet)
  if (enableEnhancedHeaders) {
    await fastify.register(securityHeadersPlugin, headerOptions);
    fastify.log.info('✓ Enhanced security headers enabled');
  }

  // CSRF protection
  if (enableCSRF) {
    await fastify.register(csrfProtectionPlugin, csrfOptions);
    fastify.log.info('✓ CSRF protection enabled');
  }

  fastify.log.info('✓ Enhanced security suite initialized successfully');
} /**
 * Security middleware factory for specific route contexts
 */
export function createSecurityMiddleware(options = {}) {
  const { requireAuth = false, sensitiveOperation = false, auditLog = true } = options;

  return {
    async preHandler(request, reply) {
      // Rate limiting is handled by plugin registration

      // Authentication check
      if (requireAuth && !request.user) {
        throw reply.unauthorized('Authentication required');
      }

      // Audit logging for sensitive operations
      if (auditLog && sensitiveOperation && request.user) {
        request.log.info(
          {
            userId: request.user.id,
            userEmail: request.user.email,
            ip: request.ip,
            url: request.url,
            method: request.method,
            sensitiveOperation: true
          },
          'Sensitive operation accessed'
        );
      }
    }
  };
}

/**
 * Security configuration validator
 */
export function validateSecurityConfig(config) {
  const issues = [];

  // Check JWT secret in production
  if (config.isProduction && !config.security?.jwtSecret) {
    issues.push('JWT_SECRET is required in production');
  }

  // Check encryption key if encryption is enabled
  if (config.features?.enableEncryption && !config.security?.encryptionKey) {
    issues.push('ENCRYPTION_KEY is required when encryption is enabled');
  }

  // Check HTTPS in production
  if (config.isProduction && !config.server?.https) {
    issues.push('HTTPS should be enabled in production');
  }

  // Check rate limiting configuration
  if (!config.security?.rateLimitMax || config.security.rateLimitMax > 10000) {
    issues.push('Rate limit should be configured and reasonable (<= 10000)');
  }

  // Check CORS configuration in production
  if (config.isProduction && config.security?.corsOrigin?.includes('*')) {
    issues.push('CORS should not allow all origins in production');
  }

  return {
    valid: issues.length === 0,
    issues
  };
}
