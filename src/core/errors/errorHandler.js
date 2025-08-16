/**
 * Global Error Handler Middleware
 *
 * Centralized error handling for the entire application.
 * Provides consistent error responses and logging.
 */

import AppError from './AppError.js';
import AuthenticationError from './AuthenticationError.js';
import DatabaseError from './DatabaseError.js';
import ValidationError from './ValidationError.js';

/**
 * Global error handler middleware for Fastify
 */
function errorHandler(error, request, reply) {
  // Log the error for debugging
  logError(error, request);

  // Convert unknown errors to AppError instances
  const appError = normalizeError(error);

  // Set appropriate headers
  setErrorHeaders(reply, appError);

  // Send structured error response
  reply.status(appError.statusCode).send(appError.toJSON());
}

/**
 * Convert various error types to AppError instances
 */
function normalizeError(error) {
  // Already an AppError
  if (error instanceof AppError) {
    return error;
  }

  // Zod validation errors
  if (error.name === 'ZodError' || (error.issues && Array.isArray(error.issues))) {
    return ValidationError.fromZodError(error);
  }

  // Prisma database errors
  if (
    error.name === 'PrismaClientKnownRequestError' ||
    error.name === 'PrismaClientValidationError' ||
    error.name === 'PrismaClientUnknownRequestError'
  ) {
    return DatabaseError.fromPrismaError(error);
  }

  // Fastify validation errors
  if (error.validation && Array.isArray(error.validation)) {
    const zodLikeError = {
      errors: error.validation.map(v => ({
        path: [v.instancePath?.replace('/', '') || v.dataPath],
        message: v.message,
        code: v.keyword
      }))
    };
    return ValidationError.fromZodError(zodLikeError, 'Request validation failed');
  }

  // JWT errors
  if (error.name === 'JsonWebTokenError') {
    return AuthenticationError.invalidToken('malformed');
  }
  if (error.name === 'TokenExpiredError') {
    return AuthenticationError.invalidToken('expired');
  }

  // Network/connection errors
  if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
    return new AppError('Service temporarily unavailable', 503, 'SERVICE_UNAVAILABLE');
  }

  // Rate limiting errors (if using fastify-rate-limit)
  if (error.statusCode === 429) {
    return new AppError('Too many requests, please try again later', 429, 'RATE_LIMIT_EXCEEDED', {
      retryAfter: error.retryAfter
    });
  }

  // Generic HTTP errors
  if (error.statusCode && error.statusCode >= 400) {
    return new AppError(
      error.message || 'An error occurred',
      error.statusCode,
      error.code || 'HTTP_ERROR'
    );
  }

  // Unknown errors
  return new AppError(
    process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred'
      : error.message || 'Unknown error',
    500,
    'INTERNAL_SERVER_ERROR',
    process.env.NODE_ENV === 'development'
      ? {
          originalError: error.message,
          stack: error.stack
        }
      : null
  );
}

/**
 * Log error with appropriate level and context
 */
function logError(error, request) {
  const errorInfo = {
    message: error.message,
    stack: error.stack,
    requestId: request.id,
    method: request.method,
    url: request.url,
    userAgent: request.headers['user-agent'],
    ip: request.ip,
    userId: request.user?.id,
    timestamp: new Date().toISOString()
  };

  // Determine log level based on error type and status
  const statusCode = error.statusCode || 500;
  if (statusCode >= 500) {
    request.log.error(errorInfo, 'Server error occurred');
  } else if (statusCode >= 400) {
    request.log.warn(errorInfo, 'Client error occurred');
  } else {
    request.log.info(errorInfo, 'Request completed with error');
  }
}

/**
 * Set appropriate response headers for error types
 */
function setErrorHeaders(reply, error) {
  // Add CORS headers if needed
  reply.header('Access-Control-Allow-Origin', '*');

  // Set authentication challenge header for auth errors
  if (error instanceof AuthenticationError) {
    reply.header('WWW-Authenticate', error.getAuthChallenge());
  }

  // Set retry-after header for rate limiting or temporary errors
  if (error.details?.retryAfter) {
    reply.header('Retry-After', error.details.retryAfter);
  }

  // Set cache control for error responses
  if (error.statusCode >= 500) {
    reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}

/**
 * Handle unhandled promise rejections
 */
function handleUnhandledRejection(reason, promise) {
  console.error('Unhandled Promise Rejection:', reason);

  // Log the rejection
  const errorInfo = {
    type: 'unhandled_rejection',
    reason: reason?.message || reason,
    stack: reason?.stack,
    promise: promise.toString(),
    timestamp: new Date().toISOString()
  };

  console.error('Unhandled Rejection Details:', errorInfo);

  // In production, you might want to gracefully shutdown
  if (process.env.NODE_ENV === 'production') {
    console.error('Shutting down due to unhandled rejection...');
    process.exit(1);
  }
}

/**
 * Handle uncaught exceptions
 */
function handleUncaughtException(error) {
  console.error('Uncaught Exception:', error);

  // Log the exception
  const errorInfo = {
    type: 'uncaught_exception',
    message: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString()
  };

  console.error('Uncaught Exception Details:', errorInfo);

  // Always exit on uncaught exceptions
  console.error('Shutting down due to uncaught exception...');
  process.exit(1);
}

// Register global error handlers
process.on('unhandledRejection', handleUnhandledRejection);
process.on('uncaughtException', handleUncaughtException);

export {
  errorHandler,
  handleUncaughtException,
  handleUnhandledRejection,
  logError,
  normalizeError
};
