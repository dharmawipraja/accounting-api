/**
 * Simplified Error Handling with http-errors
 * Maintains exact response format while using well-maintained library
 */

import createError from 'http-errors';
import { isProduction } from '../../config/env.js';
import { t } from '../../shared/i18n/index.js';

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
    errorType = t('errorTypes.ValidationError');
  } else if (err.name === 'UnauthorizedError' || statusCode === 401) {
    errorType = t('errorTypes.AuthenticationError');
    // Handle JWT specific errors
    if (err.name === 'JsonWebTokenError') {
      message = t('auth.invalidToken');
    } else if (err.name === 'TokenExpiredError') {
      message = t('auth.tokenExpired');
    }
  } else if (statusCode === 403) {
    errorType = t('errorTypes.AuthorizationError');
  } else if (statusCode === 404) {
    errorType = t('errorTypes.NotFoundError');
  } else if (statusCode === 409) {
    errorType = t('errorTypes.ConflictError');
  } else if (statusCode === 413) {
    errorType = t('errorTypes.PayloadTooLarge');
    message = t('http.requestBodyTooLarge');
  } else if (err.type === 'entity.parse.failed') {
    errorType = t('errorTypes.ParseError');
    message = t('http.parseError');
  } else if (err.code?.startsWith('P')) {
    // Prisma errors
    errorType = t('errorTypes.DatabaseError');
    message = isProduction() ? t('http.databaseError') : `Database error: ${err.message}`;
  } else if (statusCode >= 500) {
    errorType = t('errorTypes.InternalServerError');
    message = isProduction() ? t('http.internalError') : err.message;
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
    t('errorTypes.NotFoundError')
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
    createStandardError(400, message, t('errorTypes.ValidationError'), details),

  // Authentication errors
  authentication: (message = t('auth.notAuthenticated')) =>
    createStandardError(401, message, t('errorTypes.AuthenticationError')),

  // Authorization errors
  authorization: (message = t('auth.insufficientPermissions')) =>
    createStandardError(403, message, t('errorTypes.AuthorizationError')),

  // Not found errors
  notFound: (message = t('http.notFound')) =>
    createStandardError(404, message, t('errorTypes.NotFoundError')),

  // Conflict errors
  conflict: (message = t('http.conflict')) =>
    createStandardError(409, message, t('errorTypes.ConflictError')),

  // Business logic errors (400)
  businessLogic: (message, details = null) =>
    createStandardError(400, message, t('errorTypes.BusinessLogicError'), details),

  // Internal server errors
  internal: (message = t('http.internalError')) =>
    createStandardError(500, message, t('errorTypes.InternalServerError')),

  // Database errors
  database: (message = t('http.databaseError')) =>
    createStandardError(500, message, t('errorTypes.DatabaseError'))
};

// Common authentication error creators
export const authErrors = {
  missingToken: () => errors.authentication(t('auth.missingToken')),
  invalidToken: () => errors.authentication(t('auth.invalidToken')),
  tokenExpired: () => errors.authentication(t('auth.tokenExpired')),
  userNotFound: () => errors.authentication(t('auth.userNotFound')),
  userInactive: () => errors.authentication(t('auth.userInactive')),
  invalidCredentials: () => errors.authentication(t('auth.invalidCredentials'))
};

// Common business logic error creators
export const businessErrors = {
  accountNotFound: () => errors.notFound(t('accounts.accountsNotFound')),
  accountExists: () => errors.conflict(t('http.alreadyExists')),
  cannotDeleteAccount: reason =>
    errors.businessLogic(`${t('accounts.cannotDeleteAccount')}: ${reason}`),
  ledgerNotFound: () => errors.notFound(t('ledgers.ledgerNotFound')),
  cannotUpdatePostedLedger: () => errors.businessLogic(t('ledgers.cannotUpdatePostedLedger')),
  noPendingLedgers: () => errors.businessLogic(t('posting.noPendingLedgersFound')),
  alreadyPosted: date => errors.businessLogic(t('posting.ledgersAlreadyPosted', { date }))
};
