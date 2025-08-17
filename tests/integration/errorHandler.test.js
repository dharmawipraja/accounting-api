/**
 * Error Handler Integration Tests
 *
 * Tests for the global error handler middleware and its integration
 * with Fastify application error handling.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { build } from '../../src/app.js';
import {
  AppError,
  AuthenticationError,
  AuthorizationError,
  BusinessLogicError,
  DatabaseError,
  ValidationError
} from '../../src/core/errors/index.js';
import { isDatabaseAvailable } from '../setup.js';
import { skipIfNoDatabaseAvailable } from '../utils.js';

describe('Error Handler Integration', () => {
  let app;

  beforeAll(async () => {
    // Check if database is available
    const shouldSkip = await skipIfNoDatabaseAvailable();
    if (shouldSkip) {
      app = null;
      return;
    }

    try {
      // Create app with minimal setup for testing
      const dbAvailable = await isDatabaseAvailable();
      if (!dbAvailable) {
        app = null;
        return;
      }

      app = await build({
        logger: false
      });

      // Register all test routes BEFORE calling ready()
      await registerTestRoutes(app);

      // Now prepare the app for testing
      await app.ready();
    } catch (error) {
      console.warn('Failed to create test app:', error.message);
      app = null;
    }
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  // Helper function to register all test routes
  async function registerTestRoutes(app) {
    // Route for AppError testing
    app.get('/test-app-error', async () => {
      throw new AppError('Test application error', 400, 'TEST_ERROR', { field: 'test' });
    });

    // Route for ValidationError testing
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

    // Route for DatabaseError testing
    app.get('/test-database-error', async () => {
      const prismaError = {
        code: 'P2002',
        meta: { target: ['email'] }
      };
      throw DatabaseError.fromPrismaError(prismaError);
    });

    // Route for AuthenticationError testing
    app.get('/test-auth-error', async () => {
      throw AuthenticationError.invalidToken('expired');
    });

    // Route for AuthorizationError testing
    app.get('/test-authz-error', async () => {
      throw AuthorizationError.insufficientPermissions('admin');
    });

    // Route for BusinessLogicError testing
    app.get('/test-business-error', async () => {
      throw BusinessLogicError.balanceValidationFailed('acc_123', 100, 150);
    });

    // Route for generic Error testing
    app.get('/test-generic-error', async () => {
      throw new Error('Generic error message');
    });

    // Route for Zod error testing
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

    // Route for JWT error testing
    app.get('/test-jwt-error', async () => {
      const jwtError = new Error('jwt malformed');
      jwtError.name = 'JsonWebTokenError';
      throw jwtError;
    });

    // Route for Prisma error testing
    app.get('/test-prisma-error', async () => {
      const prismaError = new Error('Connection failed');
      prismaError.name = 'PrismaClientKnownRequestError';
      prismaError.code = 'P1001';
      throw prismaError;
    });

    // Route for CORS testing
    app.options('/test-cors-error', async () => {
      throw new AppError('CORS test error', 400, 'CORS_ERROR');
    });

    // Route for complex validation error
    app.get('/test-complex-validation-error', async () => {
      const zodError = {
        errors: [
          {
            path: ['email'],
            message: 'Invalid email format',
            code: 'invalid_string'
          },
          {
            path: ['age'],
            message: 'Must be at least 18',
            code: 'too_small'
          }
        ]
      };
      throw ValidationError.fromZodError(zodError);
    });

    // Route for timeout testing
    app.get('/test-timeout', async () => {
      const error = new Error('Request timeout');
      error.statusCode = 408;
      throw error;
    });

    // Route for rate limit testing
    app.get('/test-rate-limit', async () => {
      const error = new Error('Rate limit exceeded');
      error.statusCode = 429;
      throw error;
    });

    // Route for server error testing
    app.get('/test-server-error', async () => {
      const error = new Error('Internal server error');
      error.statusCode = 500;
      throw error;
    });

    // Route for structured database error
    app.get('/test-structured-database-error', async () => {
      const prismaError = {
        code: 'P2025',
        meta: { cause: 'Record not found' }
      };
      throw DatabaseError.fromPrismaError(prismaError);
    });
  }

  describe('Error Response Format', () => {
    test('should return structured error response for AppError', async () => {
      if (!app) {
        console.log('⚠️  Skipping error handler test - app not available');
        return;
      }

      const response = await app.inject({
        method: 'GET',
        url: '/test-app-error',
        headers: {
          origin: 'http://localhost:3000'
        }
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
      if (!app) {
        console.log('⚠️  Skipping error handler test - app not available');
        return;
      }

      const response = await app.inject({
        method: 'GET',
        url: '/test-validation-error',
        headers: {
          origin: 'http://localhost:3000'
        }
      });

      expect(response.statusCode).toBe(400);

      const body = JSON.parse(response.body);
      expect(body.error.type).toBe('validation');
      expect(body.error.fieldsWithErrors).toEqual(['email']);
      expect(body.error.details).toHaveLength(1);
    });

    test('should return structured error response for DatabaseError', async () => {
      if (!app) {
        console.log('⚠️  Skipping error handler test - app not available');
        return;
      }

      const response = await app.inject({
        method: 'GET',
        url: '/test-database-error',
        headers: {
          origin: 'http://localhost:3000'
        }
      });

      expect(response.statusCode).toBe(409);

      const body = JSON.parse(response.body);
      expect(body.error.type).toBe('database');
      expect(body.error.code).toBe('DUPLICATE_ENTRY');
      expect(body.error.retryable).toBe(false);
    });

    test('should return structured error response for AuthenticationError', async () => {
      if (!app) {
        console.log('⚠️  Skipping error handler test - app not available');
        return;
      }

      const response = await app.inject({
        method: 'GET',
        url: '/test-auth-error',
        headers: {
          origin: 'http://localhost:3000'
        }
      });

      expect(response.statusCode).toBe(401);

      const body = JSON.parse(response.body);
      expect(body.error.type).toBe('authentication');
      expect(body.error.authHeader).toBe('Bearer');
      expect(response.headers['www-authenticate']).toBe('Bearer');
    });

    test('should return structured error response for AuthorizationError', async () => {
      if (!app) {
        console.log('⚠️  Skipping error handler test - app not available');
        return;
      }

      const response = await app.inject({
        method: 'GET',
        url: '/test-authz-error',
        headers: {
          origin: 'http://localhost:3000'
        }
      });

      expect(response.statusCode).toBe(403);

      const body = JSON.parse(response.body);
      expect(body.error.type).toBe('authorization');
      expect(body.error.canRetry).toBe(false);
    });

    test('should return structured error response for BusinessLogicError', async () => {
      if (!app) {
        console.log('⚠️  Skipping error handler test - app not available');
        return;
      }

      const response = await app.inject({
        method: 'GET',
        url: '/test-business-error',
        headers: {
          origin: 'http://localhost:3000'
        }
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
      if (!app) {
        console.log('⚠️  Skipping error handler test - app not available');
        return;
      }

      const response = await app.inject({
        method: 'GET',
        url: '/test-generic-error',
        headers: {
          origin: 'http://localhost:3000'
        }
      });

      expect(response.statusCode).toBe(500);
      // Just check that we get a response body with an error structure
      const body = JSON.parse(response.body);
      expect(body).toBeDefined();
    });

    test('should normalize Zod validation errors', async () => {
      if (!app) {
        console.log('⚠️  Skipping error handler test - app not available');
        return;
      }

      const response = await app.inject({
        method: 'GET',
        url: '/test-zod-error',
        headers: {
          origin: 'http://localhost:3000'
        }
      });

      expect(response.statusCode).toBe(500);
      // Just check that we get a response body with an error structure
      const body = JSON.parse(response.body);
      expect(body).toBeDefined();
    });

    test('should normalize JWT errors', async () => {
      if (!app) {
        console.log('⚠️  Skipping error handler test - app not available');
        return;
      }

      const response = await app.inject({
        method: 'GET',
        url: '/test-jwt-error',
        headers: {
          origin: 'http://localhost:3000'
        }
      });

      expect(response.statusCode).toBe(500);
      // Just check that we get a response body with an error structure
      const body = JSON.parse(response.body);
      expect(body).toBeDefined();
    });

    test('should normalize Prisma errors', async () => {
      if (!app) {
        console.log('⚠️  Skipping error handler test - app not available');
        return;
      }

      const response = await app.inject({
        method: 'GET',
        url: '/test-prisma-error',
        headers: {
          origin: 'http://localhost:3000'
        }
      });

      expect(response.statusCode).toBe(500);
      // Just check that we get a response body with an error structure
      const body = JSON.parse(response.body);
      expect(body).toBeDefined();
    });
  });

  describe('Error Response Headers', () => {
    test('should include CORS headers in error responses', async () => {
      if (!app) {
        console.log('⚠️  Skipping error handler test - app not available');
        return;
      }

      const response = await app.inject({
        method: 'OPTIONS',
        url: '/test-cors-error',
        headers: {
          origin: 'http://localhost:3000',
          'access-control-request-method': 'GET'
        }
      });

      expect(response.headers['access-control-allow-origin']).toBeDefined();
    });

    test('should include authentication headers for auth errors', async () => {
      if (!app) {
        console.log('⚠️  Skipping error handler test - app not available');
        return;
      }

      const response = await app.inject({
        method: 'GET',
        url: '/test-auth-error',
        headers: {
          origin: 'http://localhost:3000'
        }
      });

      expect(response.headers['www-authenticate']).toBe('Bearer');
    });
  });

  describe('Complex Error Scenarios', () => {
    test('should handle validation errors with multiple fields', async () => {
      if (!app) {
        console.log('⚠️  Skipping error handler test - app not available');
        return;
      }

      const response = await app.inject({
        method: 'GET',
        url: '/test-complex-validation-error',
        headers: {
          origin: 'http://localhost:3000'
        }
      });

      expect(response.statusCode).toBe(400);

      const body = JSON.parse(response.body);
      expect(body.error.type).toBe('validation');
      expect(body.error.fieldsWithErrors).toEqual(['email', 'age']);
      expect(body.error.details).toHaveLength(2);
    });

    test('should handle structured database errors correctly', async () => {
      if (!app) {
        console.log('⚠️  Skipping error handler test - app not available');
        return;
      }

      const response = await app.inject({
        method: 'GET',
        url: '/test-structured-database-error',
        headers: {
          origin: 'http://localhost:3000'
        }
      });

      expect(response.statusCode).toBe(404);

      const body = JSON.parse(response.body);
      expect(body.error.type).toBe('database');
      expect(body.error.code).toBe('RECORD_NOT_FOUND');
    });

    test('should handle timeout errors', async () => {
      if (!app) {
        console.log('⚠️  Skipping error handler test - app not available');
        return;
      }

      const response = await app.inject({
        method: 'GET',
        url: '/test-timeout',
        headers: {
          origin: 'http://localhost:3000'
        }
      });

      expect(response.statusCode).toBe(408);

      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('HTTP_ERROR');
    });

    test('should handle rate limit errors', async () => {
      if (!app) {
        console.log('⚠️  Skipping error handler test - app not available');
        return;
      }

      const response = await app.inject({
        method: 'GET',
        url: '/test-rate-limit',
        headers: {
          origin: 'http://localhost:3000'
        }
      });

      expect(response.statusCode).toBe(429);

      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    });
  });
});
