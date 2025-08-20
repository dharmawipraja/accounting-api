/**
 * Express Error Handling Middleware
 * Global error handling for Express.js application
 */

import { isProduction } from '../../config/env.js';
import logger from '../logging/index.js';
import AppError from './AppError.js';
import AuthenticationError from './AuthenticationError.js';
import AuthorizationError from './AuthorizationError.js';
import BusinessLogicError from './BusinessLogicError.js';
import DatabaseError from './DatabaseError.js';
import ValidationError from './ValidationError.js';

/**
 * Global error handler for Express
 */
export function globalErrorHandler(err, req, res, _next) {
  // Log the error
  req.log?.error(
    {
      error: {
        name: err.name,
        message: err.message,
        stack: err.stack,
        statusCode: err.statusCode,
        isOperational: err.isOperational
      },
      request: {
        method: req.method,
        url: req.url,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        userId: req.user?.id
      }
    },
    'Request error occurred'
  );

  // Handle different error types
  if (err instanceof ValidationError) {
    return res.status(400).json({
      success: false,
      error: 'Validation Error',
      message: err.message,
      details: err.details || []
    });
  }

  if (err instanceof AuthenticationError) {
    return res.status(401).json({
      success: false,
      error: 'Authentication Error',
      message: err.message
    });
  }

  if (err instanceof AuthorizationError) {
    return res.status(403).json({
      success: false,
      error: 'Authorization Error',
      message: err.message
    });
  }

  if (err instanceof BusinessLogicError) {
    return res.status(400).json({
      success: false,
      error: 'Business Logic Error',
      message: err.message,
      details: err.details
    });
  }

  if (err instanceof DatabaseError) {
    // Don't expose database details in production
    const message = isProduction() ? 'Database operation failed' : err.message;

    return res.status(500).json({
      success: false,
      error: 'Database Error',
      message
    });
  }

  // Handle Prisma errors
  if (err.code?.startsWith('P')) {
    const message = isProduction() ? 'Database operation failed' : `Database error: ${err.message}`;

    return res.status(500).json({
      success: false,
      error: 'Database Error',
      message
    });
  }

  // Handle JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      error: 'Authentication Error',
      message: 'Invalid token'
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      error: 'Authentication Error',
      message: 'Token expired'
    });
  }

  // Handle validation errors from express-validator
  if (err.name === 'ValidationError' && err.errors) {
    return res.status(400).json({
      success: false,
      error: 'Validation Error',
      message: 'Invalid input data',
      details: err.errors
    });
  }

  // Handle known AppError instances
  if (err instanceof AppError && err.isOperational) {
    return res.status(err.statusCode).json({
      success: false,
      error: err.name,
      message: err.message
    });
  }

  // Handle CORS errors
  if (err.message === 'CORS policy violation') {
    return res.status(403).json({
      success: false,
      error: 'CORS Error',
      message: 'Cross-origin request not allowed'
    });
  }

  // Handle body parser errors
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      success: false,
      error: 'Parse Error',
      message: 'Invalid JSON in request body'
    });
  }

  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      error: 'Payload Too Large',
      message: 'Request body too large'
    });
  }

  // Log unexpected errors
  (req.log || logger).error('Unexpected error:', err);

  // Generic error response for unexpected errors
  const statusCode = err.statusCode || 500;
  const message = isProduction() ? 'Internal server error' : err.message;

  res.status(statusCode).json({
    success: false,
    error: 'Internal Server Error',
    message,
    ...(!isProduction() && { stack: err.stack })
  });
}

/**
 * 404 Not Found handler for Express
 */
export function notFoundHandler(req, res, next) {
  const err = new AppError(`Route ${req.method} ${req.url} not found`, 404);
  err.isOperational = true;
  next(err);
}

/**
 * Async error wrapper
 * Wraps async route handlers to catch errors automatically
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
