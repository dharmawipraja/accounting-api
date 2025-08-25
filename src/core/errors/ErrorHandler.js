/**
 * Simplified Error Handling with http-errors
 * Maintains exact response format while using well-maintained library
 */

import createError from 'http-errors';
import { isProduction } from '../../config/env.js';

/**
 * Create standardized error with consistent response format
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {string} errorType - Error type for response
 * @param {Object} details - Additional error details
 */
export function createStandardError(statusCode, message, errorType = 'Error', details = null) {
  const error = createError(statusCode, message);
  error.errorType = errorType;
  error.details = details;
  return error;
}

/**
 * Simplified global error handler for Express
 */
export function errorHandler(err, req, res, _next) {
  // Log the error with context
  const logContext = {
    error: {
      name: err.name,
      message: err.message,
      stack: err.stack,
      statusCode: err.statusCode || err.status
    },
    request: {
      method: req.method,
      url: req.url,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      userId: req.user?.id
    }
  };

  if (err.statusCode >= 500 || (!err.statusCode && !err.status)) {
    req.log?.error(logContext, 'Request error occurred');
  } else {
    req.log?.warn(logContext, 'Client error occurred');
  }

  // Determine status code
  const statusCode = err.statusCode || err.status || 500;

  // Determine error type and message
  let errorType = err.errorType || 'Error';
  let { message } = err;
  const { details } = err;

  // Handle specific error types and maintain your exact response format
  if (err.name === 'ValidationError' || statusCode === 400) {
    errorType = 'Validation Error';
  } else if (err.name === 'UnauthorizedError' || statusCode === 401) {
    errorType = 'Authentication Error';
    // Handle JWT specific errors
    if (err.name === 'JsonWebTokenError') {
      message = 'Invalid token';
    } else if (err.name === 'TokenExpiredError') {
      message = 'Token expired';
    }
  } else if (statusCode === 403) {
    errorType = 'Authorization Error';
  } else if (statusCode === 404) {
    errorType = 'Not Found Error';
  } else if (statusCode === 409) {
    errorType = 'Conflict Error';
  } else if (statusCode === 413) {
    errorType = 'Payload Too Large';
    message = 'Request body too large';
  } else if (err.type === 'entity.parse.failed') {
    errorType = 'Parse Error';
    message = 'Invalid JSON in request body';
  } else if (err.code?.startsWith('P')) {
    // Prisma errors
    errorType = 'Database Error';
    message = isProduction() ? 'Database operation failed' : `Database error: ${err.message}`;
  } else if (statusCode >= 500) {
    errorType = 'Internal Server Error';
    message = isProduction() ? 'Internal server error' : err.message;
  }

  // Build response in your exact format
  const response = {
    success: false,
    error: errorType,
    message
  };

  // Add details if they exist
  if (details) {
    response.details = details;
  }

  // Add stack trace in development
  if (!isProduction() && statusCode >= 500) {
    response.stack = err.stack;
  }

  res.status(statusCode).json(response);
}

/**
 * 404 Not Found handler
 */
export function notFoundHandler(req, res, next) {
  const error = createStandardError(
    404,
    `Route ${req.method} ${req.url} not found`,
    'Not Found Error'
  );
  next(error);
}

/**
 * Async error wrapper - same as before
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Convenience error creators that maintain your response format
export const errors = {
  // Validation errors
  validation: (message, details = null) =>
    createStandardError(400, message, 'Validation Error', details),

  // Authentication errors
  authentication: (message = 'Authentication failed') =>
    createStandardError(401, message, 'Authentication Error'),

  // Authorization errors
  authorization: (message = 'Access denied') =>
    createStandardError(403, message, 'Authorization Error'),

  // Not found errors
  notFound: (message = 'Resource not found') =>
    createStandardError(404, message, 'Not Found Error'),

  // Conflict errors
  conflict: (message = 'Resource conflict') => createStandardError(409, message, 'Conflict Error'),

  // Business logic errors (400)
  businessLogic: (message, details = null) =>
    createStandardError(400, message, 'Business Logic Error', details),

  // Internal server errors
  internal: (message = 'Internal server error') =>
    createStandardError(500, message, 'Internal Server Error'),

  // Database errors
  database: (message = 'Database operation failed') =>
    createStandardError(500, message, 'Database Error')
};

// Common authentication error creators
export const authErrors = {
  missingToken: () => errors.authentication('Authorization token is required'),
  invalidToken: () => errors.authentication('Invalid authentication token'),
  tokenExpired: () => errors.authentication('Authentication token has expired'),
  userNotFound: () => errors.authentication('User not found'),
  userInactive: () => errors.authentication('User account is inactive'),
  invalidCredentials: () => errors.authentication('Invalid username or password')
};

// Common business logic error creators
export const businessErrors = {
  accountNotFound: () => errors.notFound('Account not found'),
  accountExists: () => errors.conflict('Account number already exists'),
  cannotDeleteAccount: reason => errors.businessLogic(`Cannot delete account: ${reason}`),
  ledgerNotFound: () => errors.notFound('Ledger entry not found'),
  cannotUpdatePostedLedger: () => errors.businessLogic('Cannot update posted ledger entries'),
  noPendingLedgers: () => errors.businessLogic('No pending ledgers found for the specified date'),
  alreadyPosted: () => errors.businessLogic('Records have already been posted for this date')
};
