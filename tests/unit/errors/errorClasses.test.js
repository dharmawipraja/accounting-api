/**
 * Error Classes Unit Tests
 *
 * Tests for all custom error classes including proper inheritance,
 * error formatting, and structured response generation.
 */

import { describe, expect, test } from 'vitest';
import {
  AppError,
  AuthenticationError,
  AuthorizationError,
  BusinessLogicError,
  DatabaseError,
  normalizeError,
  ValidationError
} from '../../../src/core/errors/index.js';

describe('Error Classes', () => {
  describe('AppError', () => {
    test('should create basic error with defaults', () => {
      const error = new AppError('Test error');

      expect(error.message).toBe('Test error');
      expect(error.statusCode).toBe(500);
      expect(error.code).toBe('APPERROR');
      expect(error.isOperational).toBe(true);
      expect(error.requestId).toMatch(/^err_\d+_[a-z0-9]{6}$/);
      expect(error.timestamp).toBeDefined();
    });

    test('should create error with custom properties', () => {
      const details = { field: 'email', value: 'invalid' };
      const error = new AppError('Custom error', 400, 'CUSTOM_ERROR', details);

      expect(error.message).toBe('Custom error');
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe('CUSTOM_ERROR');
      expect(error.details).toEqual(details);
    });

    test('should convert to JSON format correctly', () => {
      const error = new AppError('Test error', 400, 'TEST_ERROR', { test: true });
      const json = error.toJSON();

      expect(json).toEqual({
        success: false,
        error: {
          code: 'TEST_ERROR',
          message: 'Test error',
          details: { test: true },
          requestId: error.requestId,
          timestamp: error.timestamp
        }
      });
    });

    test('should include stack trace in development', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      const error = new AppError('Test error');
      const json = error.toJSON();

      expect(json.error.stack).toBeDefined();

      process.env.NODE_ENV = originalEnv;
    });

    test('should convert to log format correctly', () => {
      const error = new AppError('Test error', 400, 'TEST_ERROR');
      const logFormat = error.toLogFormat();

      expect(logFormat.level).toBe('error');
      expect(logFormat.message).toBe('Test error');
      expect(logFormat.error.name).toBe('AppError');
      expect(logFormat.error.code).toBe('TEST_ERROR');
      expect(logFormat.error.statusCode).toBe(400);
    });

    test('should determine reporting correctly', () => {
      const clientError = new AppError('Client error', 400);
      const serverError = new AppError('Server error', 500);

      expect(clientError.shouldReport()).toBe(false);
      expect(serverError.shouldReport()).toBe(true);
    });
  });

  describe('ValidationError', () => {
    test('should create from Zod error', () => {
      const zodError = {
        errors: [
          {
            path: ['email'],
            message: 'Invalid email format',
            code: 'invalid_string',
            received: 'invalid-email',
            expected: 'valid email'
          },
          {
            path: ['age'],
            message: 'Expected number, received string',
            code: 'invalid_type',
            received: 'string',
            expected: 'number'
          }
        ]
      };

      const error = ValidationError.fromZodError(zodError);

      expect(error.statusCode).toBe(400);
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details).toHaveLength(2);
      expect(error.details[0]).toEqual({
        field: 'email',
        message: 'Invalid email format',
        code: 'invalid_string',
        received: 'invalid-email',
        expected: 'valid email',
        path: ['email']
      });
    });

    test('should create for missing fields', () => {
      const error = ValidationError.missingFields(['email', 'password']);

      expect(error.statusCode).toBe(400);
      expect(error.message).toBe('Required fields are missing');
      expect(error.details).toHaveLength(2);
      expect(error.details[0].field).toBe('email');
      expect(error.details[0].code).toBe('required');
    });

    test('should create for invalid fields', () => {
      const fieldErrors = {
        email: 'Invalid email format',
        age: 'Must be a positive number'
      };

      const error = ValidationError.invalidFields(fieldErrors);

      expect(error.statusCode).toBe(400);
      expect(error.message).toBe('Invalid field values provided');
      expect(error.details).toHaveLength(2);
    });

    test('should include validation type in JSON response', () => {
      const zodError = {
        errors: [{ path: ['email'], message: 'Invalid email', code: 'invalid' }]
      };

      const error = ValidationError.fromZodError(zodError);
      const json = error.toJSON();

      expect(json.error.type).toBe('validation');
      expect(json.error.fieldsWithErrors).toEqual(['email']);
    });
  });

  describe('DatabaseError', () => {
    test('should handle P2002 unique constraint violation', () => {
      const prismaError = {
        code: 'P2002',
        meta: { target: ['email'] }
      };

      const error = DatabaseError.fromPrismaError(prismaError);

      expect(error.statusCode).toBe(409);
      expect(error.code).toBe('DUPLICATE_ENTRY');
      expect(error.message).toBe('A record with this information already exists');
      expect(error.details.conflictingFields).toEqual(['email']);
    });

    test('should handle P2025 record not found', () => {
      const prismaError = {
        code: 'P2025',
        meta: { modelName: 'User', cause: 'Record to delete does not exist.' }
      };

      const error = DatabaseError.fromPrismaError(prismaError);

      expect(error.statusCode).toBe(404);
      expect(error.code).toBe('RECORD_NOT_FOUND');
      expect(error.details.model).toBe('User');
    });

    test('should handle connection errors', () => {
      const error = DatabaseError.connectionFailed();

      expect(error.statusCode).toBe(503);
      expect(error.code).toBe('DATABASE_CONNECTION_ERROR');
      expect(error.message).toBe('Unable to connect to database');
    });

    test('should determine retryability correctly', () => {
      const timeoutError = new DatabaseError({ code: 'P1008' });
      const constraintError = new DatabaseError({ code: 'P2002' });

      expect(timeoutError.isRetryable()).toBe(true);
      expect(constraintError.isRetryable()).toBe(false);
    });

    test('should include database type in JSON response', () => {
      const error = DatabaseError.connectionFailed();
      const json = error.toJSON();

      expect(json.error.type).toBe('database');
      expect(json.error.retryable).toBe(true);
    });
  });

  describe('AuthenticationError', () => {
    test('should create invalid credentials error', () => {
      const error = AuthenticationError.invalidCredentials();

      expect(error.statusCode).toBe(401);
      expect(error.code).toBe('AUTHENTICATION_ERROR');
      expect(error.message).toBe('Invalid email or password');
      expect(error.details.reason).toBe('invalid_credentials');
    });

    test('should create invalid token errors', () => {
      const expiredError = AuthenticationError.invalidToken('expired');
      const malformedError = AuthenticationError.invalidToken('malformed');

      expect(expiredError.message).toBe('Authorization token has expired');
      expect(malformedError.message).toBe('Authorization token is malformed');
      expect(expiredError.details.reason).toBe('token_expired');
      expect(malformedError.details.reason).toBe('token_malformed');
    });

    test('should create too many attempts error with retry after', () => {
      const error = AuthenticationError.tooManyAttempts(600);

      expect(error.message).toBe('Too many authentication attempts, please try again later');
      expect(error.details.retryAfter).toBe(600);
    });

    test('should include auth type and challenge in JSON response', () => {
      const error = AuthenticationError.missingToken();
      const json = error.toJSON();

      expect(json.error.type).toBe('authentication');
      expect(json.error.authHeader).toBe('Bearer');
    });
  });

  describe('AuthorizationError', () => {
    test('should create insufficient permissions error', () => {
      const error = AuthorizationError.insufficientPermissions('admin');

      expect(error.statusCode).toBe(403);
      expect(error.code).toBe('AUTHORIZATION_ERROR');
      expect(error.message).toBe('You do not have permission to perform this action');
      expect(error.details.required).toBe('admin');
    });

    test('should create resource access denied error', () => {
      const error = AuthorizationError.resourceAccessDenied('user', '123');

      expect(error.message).toBe('You do not have permission to access this resource');
      expect(error.details.resourceType).toBe('user');
      expect(error.details.resourceId).toBe('123');
    });

    test('should create ownership required error', () => {
      const error = AuthorizationError.ownershipRequired('account');

      expect(error.message).toBe('You can only access your own account');
      expect(error.details.reason).toBe('ownership_required');
    });

    test('should determine retry possibility correctly', () => {
      const permissionError = AuthorizationError.insufficientPermissions('admin');
      const timeError = AuthorizationError.timeRestricted();

      expect(permissionError.canRetry()).toBe(false);
      expect(timeError.canRetry()).toBe(true);
    });
  });

  describe('BusinessLogicError', () => {
    test('should create balance validation error', () => {
      const error = BusinessLogicError.balanceValidationFailed('acc_123', 100, 150);

      expect(error.statusCode).toBe(400);
      expect(error.message).toBe('Insufficient funds for this transaction');
      expect(error.details).toEqual({
        reason: 'insufficient_balance',
        accountId: 'acc_123',
        currentBalance: 100,
        attemptedAmount: 150,
        shortfall: 50
      });
    });

    test('should create duplicate transaction error', () => {
      const error = BusinessLogicError.duplicateTransaction('tx_123', 'tx_456');

      expect(error.statusCode).toBe(409);
      expect(error.message).toBe('This transaction has already been processed');
      expect(error.details.transactionId).toBe('tx_123');
      expect(error.details.existingTransactionId).toBe('tx_456');
    });

    test('should create period closed error', () => {
      const closedDate = '2024-01-31';
      const error = BusinessLogicError.periodClosed('period_123', closedDate);

      expect(error.message).toBe('Cannot modify transactions in a closed accounting period');
      expect(error.details.periodId).toBe('period_123');
      expect(error.details.closedDate).toBe(closedDate);
    });

    test('should determine business domain correctly', () => {
      const balanceError = BusinessLogicError.balanceValidationFailed('acc_123', 100, 150);
      const workflowError = BusinessLogicError.workflowViolation('pending', 'completed', [
        'approved'
      ]);

      expect(balanceError.getDomain()).toBe('accounting');
      expect(workflowError.getDomain()).toBe('workflow');
    });

    test('should include business logic type in JSON response', () => {
      const error = BusinessLogicError.limitExceeded('daily_transfer', 1000, 1500);
      const json = error.toJSON();

      expect(json.error.type).toBe('business_logic');
      expect(json.error.domain).toBe('general');
    });
  });

  describe('normalizeError', () => {
    test('should pass through AppError instances', () => {
      const originalError = new AppError('Test error');
      const normalized = normalizeError(originalError);

      expect(normalized).toBe(originalError);
    });

    test('should convert Zod errors to ValidationError', () => {
      const zodError = {
        name: 'ZodError',
        errors: [{ path: ['email'], message: 'Invalid email', code: 'invalid' }]
      };

      const normalized = normalizeError(zodError);

      expect(normalized).toBeInstanceOf(ValidationError);
      expect(normalized.statusCode).toBe(400);
    });

    test('should convert JWT errors to AuthenticationError', () => {
      const jwtError = { name: 'JsonWebTokenError', message: 'invalid token' };
      const expiredError = { name: 'TokenExpiredError', message: 'jwt expired' };

      const normalizedJwt = normalizeError(jwtError);
      const normalizedExpired = normalizeError(expiredError);

      expect(normalizedJwt).toBeInstanceOf(AuthenticationError);
      expect(normalizedExpired).toBeInstanceOf(AuthenticationError);
      expect(normalizedJwt.details.reason).toBe('token_malformed');
      expect(normalizedExpired.details.reason).toBe('token_expired');
    });

    test('should convert Prisma errors to DatabaseError', () => {
      const prismaError = {
        name: 'PrismaClientKnownRequestError',
        code: 'P2002',
        meta: { target: ['email'] }
      };

      const normalized = normalizeError(prismaError);

      expect(normalized).toBeInstanceOf(DatabaseError);
      expect(normalized.code).toBe('DUPLICATE_ENTRY');
    });

    test('should handle rate limit errors', () => {
      const rateLimitError = { statusCode: 429, retryAfter: 60 };
      const normalized = normalizeError(rateLimitError);

      expect(normalized.statusCode).toBe(429);
      expect(normalized.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    test('should convert unknown errors to AppError', () => {
      const unknownError = new Error('Something went wrong');
      const normalized = normalizeError(unknownError);

      expect(normalized).toBeInstanceOf(AppError);
      expect(normalized.statusCode).toBe(500);
      expect(normalized.code).toBe('INTERNAL_SERVER_ERROR');
    });
  });
});
