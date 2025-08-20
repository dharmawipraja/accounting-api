/**
 * Error Classes Export
 *
 * Central export point for all error classes and error handling utilities.
 */

import AppError from './AppError.js';
import AuthenticationError from './AuthenticationError.js';
import AuthorizationError from './AuthorizationError.js';
import BusinessLogicError from './BusinessLogicError.js';
import DatabaseError from './DatabaseError.js';
import { asyncHandler, globalErrorHandler, notFoundHandler } from './errorHandler.js';
import ValidationError from './ValidationError.js';

// Convenience factory functions
export const createValidationError = (zodError, message) =>
  ValidationError.fromZodError(zodError, message);
export const createDatabaseError = (prismaError, message) =>
  DatabaseError.fromPrismaError(prismaError, message);
export const createAuthError = (message, details) => new AuthenticationError(message, details);
export const createBusinessError = (message, details, statusCode) =>
  new BusinessLogicError(message, details, statusCode);

// Common error instances
export const errors = {
  // Authentication
  INVALID_CREDENTIALS: () => AuthenticationError.invalidCredentials(),
  MISSING_TOKEN: () => AuthenticationError.missingToken(),
  INVALID_TOKEN: reason => AuthenticationError.invalidToken(reason),
  SESSION_EXPIRED: () => AuthenticationError.sessionExpired(),

  // Authorization
  INSUFFICIENT_PERMISSIONS: permission => AuthorizationError.insufficientPermissions(permission),
  RESOURCE_ACCESS_DENIED: (type, id) => AuthorizationError.resourceAccessDenied(type, id),
  OWNERSHIP_REQUIRED: type => AuthorizationError.ownershipRequired(type),

  // Business Logic
  INSUFFICIENT_BALANCE: (accountId, balance, amount) =>
    BusinessLogicError.balanceValidationFailed(accountId, balance, amount),
  DUPLICATE_TRANSACTION: (txId, existingId) =>
    BusinessLogicError.duplicateTransaction(txId, existingId),
  PERIOD_CLOSED: (periodId, closedDate) => BusinessLogicError.periodClosed(periodId, closedDate),
  LEDGER_IMBALANCE: (expected, actual, variance) =>
    BusinessLogicError.ledgerImbalance(expected, actual, variance),

  // Validation
  MISSING_FIELDS: fields => ValidationError.missingFields(fields),
  INVALID_FIELDS: fieldErrors => ValidationError.invalidFields(fieldErrors),

  // Database
  RECORD_NOT_FOUND: () => new DatabaseError({ code: 'P2025' }, 'Record not found'),
  DUPLICATE_ENTRY: () => new DatabaseError({ code: 'P2002' }, 'Duplicate entry'),
  CONNECTION_FAILED: () => DatabaseError.connectionFailed(),

  // Generic
  INTERNAL_ERROR: message => new AppError(message || 'Internal server error', 500),
  BAD_REQUEST: message => new AppError(message || 'Bad request', 400),
  NOT_FOUND: message => new AppError(message || 'Not found', 404),
  CONFLICT: message => new AppError(message || 'Conflict', 409),
  SERVICE_UNAVAILABLE: message => new AppError(message || 'Service unavailable', 503)
};

// Export error classes
export {
  AppError,
  asyncHandler,
  AuthenticationError,
  AuthorizationError,
  BusinessLogicError,
  DatabaseError,
  globalErrorHandler,
  notFoundHandler,
  ValidationError
};
