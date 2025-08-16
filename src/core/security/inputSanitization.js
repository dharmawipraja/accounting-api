/**
 * Input Sanitization and XSS Prevention
 *
 * This module provides utilities for sanitizing user input and preventing
 * XSS attacks using Zod validation and built-in string methods.
 */

import { z } from 'zod';

/**
 * HTML sanitization patterns
 */
const HTML_TAGS_REGEX = /<[^>]*>/g;
const SCRIPT_REGEX = /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi;
const DANGEROUS_ATTRS_REGEX = /(?:on\w+|href|src)\s*=\s*["'][^"']*["']/gi;
const SQL_INJECTION_PATTERNS = [
  /(\b(union|select|insert|update|delete|drop|create|alter|exec|execute)\b)/gi,
  /(--|\/\*|\*\/|;)/g,
  /(\bor\b|\band\b)\s+\d+\s*=\s*\d+/gi
];

/**
 * Remove HTML tags from string
 */
export function stripHtml(input) {
  if (typeof input !== 'string') return input;

  // First remove script tags and their content
  let result = input.replace(SCRIPT_REGEX, '');
  // Then remove all other HTML tags
  result = result.replace(HTML_TAGS_REGEX, '');

  return result;
}

/**
 * Remove script tags and dangerous attributes
 */
export function removeScripts(input) {
  if (typeof input !== 'string') return input;
  return input.replace(SCRIPT_REGEX, '').replace(DANGEROUS_ATTRS_REGEX, '');
}

/**
 * Basic XSS prevention by encoding special characters
 */
export function encodeHtml(input) {
  if (typeof input !== 'string') return input;

  const entityMap = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
    '/': '&#x2F;'
  };

  return input.replace(/[&<>"'/]/g, char => entityMap[char]);
}

/**
 * Decode HTML entities
 */
export function decodeHtml(input) {
  if (typeof input !== 'string') return input;

  const entityMap = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#x27;': "'",
    '&#x2F;': '/'
  };

  return input.replace(/&[#\w]+;/g, entity => entityMap[entity] || entity);
}

/**
 * Check for potential SQL injection patterns
 */
export function detectSqlInjection(input) {
  if (typeof input !== 'string') return false;

  return SQL_INJECTION_PATTERNS.some(pattern => {
    // Reset regex state for global patterns
    pattern.lastIndex = 0;
    return pattern.test(input);
  });
}

/**
 * Sanitize string input by removing dangerous content
 */
export function sanitizeString(input, options = {}) {
  if (typeof input !== 'string') return input;

  const {
    stripHtmlTags = true,
    removeScriptTags = true,
    encodeSpecialChars = true,
    maxLength = null,
    allowedChars = null
  } = options;

  let sanitized = input;

  // Remove script tags first
  if (removeScriptTags) {
    sanitized = removeScripts(sanitized);
  }

  // Strip HTML tags
  if (stripHtmlTags) {
    sanitized = stripHtml(sanitized);
  }

  // Encode special characters
  if (encodeSpecialChars) {
    sanitized = encodeHtml(sanitized);
  }

  // Apply character whitelist
  if (allowedChars) {
    const allowedRegex = new RegExp(`[^${allowedChars}]`, 'g');
    sanitized = sanitized.replace(allowedRegex, '');
  }

  // Trim to max length
  if (maxLength && sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }

  return sanitized.trim();
}

/**
 * Sanitize object recursively
 */
export function sanitizeObject(obj, options = {}) {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    return sanitizeString(obj, options);
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item, options));
  }

  if (typeof obj === 'object') {
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
      const sanitizedKey = sanitizeString(key, { stripHtmlTags: true, encodeSpecialChars: false });
      sanitized[sanitizedKey] = sanitizeObject(value, options);
    }
    return sanitized;
  }

  return obj;
}

/**
 * Zod transformer for sanitizing strings
 */
export const sanitizedString = (options = {}) => {
  return z.string().transform(value => sanitizeString(value, options));
};

/**
 * Zod schema for safe text input
 */
export const safeTextSchema = z.object({
  text: sanitizedString({
    stripHtmlTags: true,
    removeScriptTags: true,
    encodeSpecialChars: true,
    maxLength: 1000
  })
});

/**
 * Zod schema for safe user input (names, descriptions)
 */
export const safeUserInputSchema = sanitizedString({
  stripHtmlTags: true,
  removeScriptTags: true,
  encodeSpecialChars: false, // Allow some special chars for names
  maxLength: 255,
  allowedChars: 'a-zA-Z0-9\\s\\-_.,!?@#$%&*()+={}\\[\\]:;"\'<>/|\\\\~`'
});

/**
 * Fastify plugin for automatic input sanitization
 */
export async function inputSanitizationPlugin(fastify, options = {}) {
  const {
    sanitizeBody = true,
    sanitizeQuery = true,
    sanitizeParams = true,
    globalOptions = {}
  } = options;

  fastify.addHook('preHandler', async request => {
    try {
      // Sanitize request body
      if (sanitizeBody && request.body) {
        request.body = sanitizeObject(request.body, globalOptions);
      }

      // Sanitize query parameters
      if (sanitizeQuery && request.query) {
        request.query = sanitizeObject(request.query, globalOptions);
      }

      // Sanitize route parameters
      if (sanitizeParams && request.params) {
        request.params = sanitizeObject(request.params, globalOptions);
      }

      // Log potential security threats
      const bodyStr = JSON.stringify(request.body || {});
      const queryStr = JSON.stringify(request.query || {});
      const paramsStr = JSON.stringify(request.params || {});

      if (
        detectSqlInjection(bodyStr) ||
        detectSqlInjection(queryStr) ||
        detectSqlInjection(paramsStr)
      ) {
        fastify.log.warn(
          {
            ip: request.ip,
            userAgent: request.headers['user-agent'],
            url: request.url,
            method: request.method,
            userId: request.user?.id,
            suspiciousInput: true
          },
          'Potential SQL injection attempt detected'
        );
      }
    } catch (error) {
      fastify.log.error(
        {
          error: error.message,
          url: request.url,
          method: request.method
        },
        'Input sanitization failed'
      );

      throw fastify.httpErrors.badRequest('Invalid input format');
    }
  });
}
