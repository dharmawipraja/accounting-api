/**
 * Enhanced Security Features Tests
 *
 * Tests for the enhanced security layer implementation
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decrypt,
  decryptSensitiveFields,
  encrypt,
  encryptSensitiveFields,
  generateKey,
  generateToken,
  generateUUID
} from '../../src/core/security/encryption.js';
import * as inputSanitization from '../../src/core/security/inputSanitization.js';
import { createIntegrationTestApp, skipIfNoDatabaseAvailable } from '../utils.js';

describe('Enhanced Security Features', () => {
  let app;

  beforeAll(async () => {
    // Check if database is available
    const shouldSkip = await skipIfNoDatabaseAvailable();
    if (shouldSkip) {
      app = null;
      return;
    }

    try {
      app = await createIntegrationTestApp();
    } catch (error) {
      console.warn('Failed to create test app:', error.message);
      app = null;
    }
  });

  afterAll(async () => {
    if (app && app.close) {
      await app.close();
    }
  });

  describe('Encryption Utilities', () => {
    it('should encrypt and decrypt data correctly', async () => {
      // Import encryption utilities for unit testing
      const key = generateKey();
      const originalData = 'sensitive information';
      const encrypted = encrypt(originalData, key);
      const decrypted = decrypt(encrypted, key);

      expect(decrypted).toBe(originalData);
      expect(encrypted.encrypted).not.toBe(originalData);
      expect(encrypted).toHaveProperty('iv');
      expect(encrypted).toHaveProperty('tag');
      expect(encrypted).toHaveProperty('encrypted');
    });

    it('should handle sensitive fields in objects', async () => {
      const key = generateKey();
      const userData = {
        id: '123',
        name: 'John Doe',
        ssn: '123-45-6789',
        email: 'john@example.com'
      };

      const encrypted = encryptSensitiveFields(userData, ['ssn'], key);
      const decrypted = decryptSensitiveFields(encrypted, ['ssn'], key);

      expect(encrypted.ssn).not.toBe(userData.ssn);
      expect(typeof encrypted.ssn).toBe('object'); // Should be encrypted object
      expect(decrypted.ssn).toBe(userData.ssn);
      expect(encrypted.name).toBe(userData.name); // Non-sensitive field unchanged
    });

    it('should generate secure tokens and UUIDs', async () => {
      const token1 = generateToken();
      const token2 = generateToken();
      const uuid1 = generateUUID();
      const uuid2 = generateUUID();

      // Tokens should be different
      expect(token1).not.toBe(token2);
      expect(token1).toHaveLength(64); // 32 bytes = 64 hex chars

      // UUIDs should be different and valid format
      expect(uuid1).not.toBe(uuid2);
      expect(uuid1).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
      expect(uuid2).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });
  });

  describe('Input Sanitization', () => {
    it('should sanitize HTML and XSS attempts', async () => {
      const { stripHtml, removeScripts, encodeHtml, sanitizeString, detectSqlInjection } =
        inputSanitization;

      // Test HTML stripping
      expect(stripHtml('<script>alert("xss")</script>Hello')).toBe('Hello');
      expect(stripHtml('<h1>Title</h1><p>Content</p>')).toBe('TitleContent');

      // Test script removal
      expect(removeScripts('<script>alert("xss")</script>Safe content')).toBe('Safe content');

      // Test HTML encoding
      expect(encodeHtml('<script>alert("xss")</script>')).toBe(
        '&lt;script&gt;alert(&quot;xss&quot;)&lt;&#x2F;script&gt;'
      );

      // Test complete sanitization
      const maliciousInput = '<script>alert("xss")</script><h1>Title</h1>';
      const sanitized = sanitizeString(maliciousInput);
      expect(sanitized).not.toContain('<script>');
      expect(sanitized).not.toContain('<h1>');

      // Test SQL injection detection
      expect(detectSqlInjection("'; DROP TABLE users; --")).toBe(true);
      expect(detectSqlInjection('SELECT * FROM users')).toBe(true);
      expect(detectSqlInjection('normal search text')).toBe(false);
    });
  });

  describe('Security Configuration Validation', () => {
    it('should validate security configuration', () => {
      const { validateSecurityConfig } = require('../../src/core/security/index.js');

      const config = {
        isProduction: true,
        security: {
          jwtSecret: 'test-secret',
          encryptionKey: 'test-key',
          rateLimitMax: 100,
          corsOrigin: ['https://example.com']
        },
        server: {
          https: true
        },
        features: {
          enableEncryption: true
        }
      };

      const validation = validateSecurityConfig(config);

      expect(validation.valid).toBe(true);
      expect(validation.issues).toHaveLength(0);
    });

    it('should detect security configuration issues', () => {
      const { validateSecurityConfig } = require('../../src/core/security/index.js');

      const config = {
        isProduction: true,
        security: {
          // Missing JWT secret
          rateLimitMax: 15000, // Too high
          corsOrigin: ['*'] // Too permissive for production
        },
        server: {
          https: false // Not secure for production
        },
        features: {
          enableEncryption: true
        }
      };

      const validation = validateSecurityConfig(config);

      expect(validation.valid).toBe(false);
      expect(validation.issues.length).toBeGreaterThan(0);
    });
  });
});
