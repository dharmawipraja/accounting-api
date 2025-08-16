/**
 * Error Handler Integration Tests
 *
 * Tests for the global error handler middleware and its integration
 * with Fastify application error handling.
 */

import { beforeEach, describe, expect, test } from 'vitest';
import { build } from '../../src/app.js';
import {
  AppError,
  AuthenticationError,
  AuthorizationError,
  BusinessLogicError,
  DatabaseError,
  ValidationError
} from '../../src/core/errors/index.js';

describe.skip('Error Handler Integration', () => {
  let app;

  beforeEach(async () => {
    // Mock the database health check to avoid needing a real database
    // const mockHealthCheck = {
    //   checkDatabaseHealth: async () => ({ healthy: true, timestamp: new Date().toISOString() })
    // };

    // Create app with minimal setup for testing
    app = await build({
      logger: false,
      // Skip actual database connection for error testing
      skipHealthCheck: true
    });
    await app.ready();
  });

  describe('Error Response Format', () => {
    test('should return structured error response for AppError', async () => {
      // Register a test route that throws an AppError
      app.get('/test-app-error', async () => {
        throw new AppError('Test application error', 400, 'TEST_ERROR', { field: 'test' });
      });

      const response = await app.inject({
        method: 'GET',
        url: '/test-app-error'
      });

      expect(response.statusCode).toBe(400);

      const body = JSON.parse(response.body);
      expect(body).toMatchObject({
        success: false,
        error: {
          code: 'TEST_ERROR',
          message: 'Test application error',
          details: { field: 'test' },
          requestId: expect.stringMatching(/^err_\d+_[a-z0-9]{6}$/),
          timestamp: expect.any(String)
        }
      });
    });

    test('should return structured error response for ValidationError', async () => {
      app.get('/test-validation-error', async () => {
        const zodError = {
          errors: [
            {
              path: ['email'],
              message: 'Invalid email format',
              code: 'invalid_string'
            }
          ]
        };
        throw ValidationError.fromZodError(zodError);
      });

      const response = await app.inject({
        method: 'GET',
        url: '/test-validation-error'
      });

      expect(response.statusCode).toBe(400);

      const body = JSON.parse(response.body);
      expect(body.error.type).toBe('validation');
      expect(body.error.fieldsWithErrors).toEqual(['email']);
      expect(body.error.details).toHaveLength(1);
    });

    test('should return structured error response for DatabaseError', async () => {
      app.get('/test-database-error', async () => {
        const prismaError = {
          code: 'P2002',
          meta: { target: ['email'] }
        };
        throw DatabaseError.fromPrismaError(prismaError);
      });

      const response = await app.inject({
        method: 'GET',
        url: '/test-database-error'
      });

      expect(response.statusCode).toBe(409);

      const body = JSON.parse(response.body);
      expect(body.error.type).toBe('database');
      expect(body.error.code).toBe('DUPLICATE_ENTRY');
      expect(body.error.retryable).toBe(false);
    });

    test('should return structured error response for AuthenticationError', async () => {
      app.get('/test-auth-error', async () => {
        throw AuthenticationError.invalidToken('expired');
      });

      const response = await app.inject({
        method: 'GET',
        url: '/test-auth-error'
      });

      expect(response.statusCode).toBe(401);

      const body = JSON.parse(response.body);
      expect(body.error.type).toBe('authentication');
      expect(body.error.authHeader).toBe('Bearer');
      expect(response.headers['www-authenticate']).toBe('Bearer');
    });

    test('should return structured error response for AuthorizationError', async () => {
      app.get('/test-authz-error', async () => {
        throw AuthorizationError.insufficientPermissions('admin');
      });

      const response = await app.inject({
        method: 'GET',
        url: '/test-authz-error'
      });

      expect(response.statusCode).toBe(403);

      const body = JSON.parse(response.body);
      expect(body.error.type).toBe('authorization');
      expect(body.error.canRetry).toBe(false);
    });

    test('should return structured error response for BusinessLogicError', async () => {
      app.get('/test-business-error', async () => {
        throw BusinessLogicError.balanceValidationFailed('acc_123', 100, 150);
      });

      const response = await app.inject({
        method: 'GET',
        url: '/test-business-error'
      });

      expect(response.statusCode).toBe(400);

      const body = JSON.parse(response.body);
      expect(body.error.type).toBe('business_logic');
      expect(body.error.domain).toBe('accounting');
      expect(body.error.details.shortfall).toBe(50);
    });
  });

  describe('Error Normalization', () => {
    test('should normalize generic JavaScript errors', async () => {
      app.get('/test-generic-error', async () => {
        throw new Error('Generic error message');
      });

      const response = await app.inject({
        method: 'GET',
        url: '/test-generic-error'
      });

      expect(response.statusCode).toBe(500);

      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('INTERNAL_SERVER_ERROR');
      expect(body.error.message).toContain('Generic error message');
    });

    test('should normalize Zod validation errors', async () => {
      app.get('/test-zod-error', async () => {
        const zodError = {
          name: 'ZodError',
          errors: [
            {
              path: ['username'],
              message: 'String must contain at least 3 character(s)',
              code: 'too_small'
            }
          ]
        };
        throw zodError;
      });

      const response = await app.inject({
        method: 'GET',
        url: '/test-zod-error'
      });

      expect(response.statusCode).toBe(400);

      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(body.error.type).toBe('validation');
    });

    test('should normalize JWT errors', async () => {
      app.get('/test-jwt-error', async () => {
        const jwtError = new Error('jwt malformed');
        jwtError.name = 'JsonWebTokenError';
        throw jwtError;
      });

      const response = await app.inject({
        method: 'GET',
        url: '/test-jwt-error'
      });

      expect(response.statusCode).toBe(401);

      const body = JSON.parse(response.body);
      expect(body.error.type).toBe('authentication');
      expect(body.error.details.reason).toBe('token_malformed');
    });
  });

  describe('Error Headers', () => {
    test('should set CORS headers on error responses', async () => {
      app.get('/test-cors-error', async () => {
        throw new AppError('Test error', 400);
      });

      const response = await app.inject({
        method: 'GET',
        url: '/test-cors-error'
      });

      expect(response.headers['access-control-allow-origin']).toBe('*');
    });

    test('should set retry-after header for rate limit errors', async () => {
      app.get('/test-retry-after', async () => {
        throw AuthenticationError.tooManyAttempts(300);
      });

      const response = await app.inject({
        method: 'GET',
        url: '/test-retry-after'
      });

      expect(response.headers['retry-after']).toBe('300');
    });

    test('should set cache control for server errors', async () => {
      app.get('/test-cache-control', async () => {
        throw new AppError('Server error', 500);
      });

      const response = await app.inject({
        method: 'GET',
        url: '/test-cache-control'
      });

      expect(response.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    });
  });

  describe('Environment-specific Behavior', () => {
    test('should include stack trace in development', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      app.get('/test-dev-error', async () => {
        throw new AppError('Development error', 500);
      });

      const response = await app.inject({
        method: 'GET',
        url: '/test-dev-error'
      });

      const body = JSON.parse(response.body);
      expect(body.error.stack).toBeDefined();

      process.env.NODE_ENV = originalEnv;
    });

    test('should hide stack trace in production', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      app.get('/test-prod-error', async () => {
        throw new AppError('Production error', 500);
      });

      const response = await app.inject({
        method: 'GET',
        url: '/test-prod-error'
      });

      const body = JSON.parse(response.body);
      expect(body.error.stack).toBeUndefined();

      process.env.NODE_ENV = originalEnv;
    });
  });

  describe('Request Context', () => {
    test('should include request ID in error response', async () => {
      app.get('/test-request-id', async _request => {
        throw new AppError('Error with request context', 400);
      });

      const response = await app.inject({
        method: 'GET',
        url: '/test-request-id',
        headers: {
          'x-request-id': 'test-request-123'
        }
      });

      const body = JSON.parse(response.body);
      expect(body.error.requestId).toBeDefined();
    });

    test('should log error with request context', async () => {
      const logs = [];
      const testApp = await build({
        logger: {
          level: 'error',
          stream: {
            write: msg => logs.push(msg)
          }
        }
      });

      testApp.get('/test-logging', async () => {
        throw new AppError('Error for logging test', 500);
      });

      await testApp.inject({
        method: 'GET',
        url: '/test-logging'
      });

      expect(logs.length).toBeGreaterThan(0);
      const logEntry = JSON.parse(logs[0]);
      expect(logEntry.msg).toContain('Server error occurred');
      expect(logEntry.method).toBe('GET');
      expect(logEntry.url).toBe('/test-logging');
    });
  });
});
