/**
 * Base Application Error Class
 *
 * Provides standardized error handling across the application with consistent
 * error formatting, HTTP status codes, and structured error responses.
 */

class AppError extends Error {
  constructor(message, statusCode = 500, code = null, details = null) {
    super(message);

    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code || this.constructor.name.toUpperCase();
    this.details = details;
    this.isOperational = true;
    this.timestamp = new Date().toISOString();

    // Generate unique request ID for tracking
    this.requestId = this.generateRequestId();

    // Capture stack trace, excluding constructor call from it
    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Generate unique request ID for error tracking
   */
  generateRequestId() {
    return `err_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  /**
   * Convert error to JSON response format
   */
  toJSON() {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        details: this.details,
        requestId: this.requestId,
        timestamp: this.timestamp,
        ...(process.env.NODE_ENV === 'development' && {
          stack: this.stack
        })
      }
    };
  }

  /**
   * Convert error to log format
   */
  toLogFormat() {
    return {
      level: 'error',
      message: this.message,
      error: {
        name: this.name,
        code: this.code,
        statusCode: this.statusCode,
        details: this.details,
        requestId: this.requestId,
        timestamp: this.timestamp,
        stack: this.stack
      }
    };
  }

  /**
   * Check if error should be reported to monitoring services
   */
  shouldReport() {
    return this.statusCode >= 500;
  }

  /**
   * Check if error should expose detailed information to client
   */
  shouldExposeDetails() {
    return this.statusCode < 500 || process.env.NODE_ENV === 'development';
  }
}

export default AppError;
