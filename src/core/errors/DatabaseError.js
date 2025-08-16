/**
 * Database Error Class
 *
 * Handles Prisma database errors and provides meaningful error messages
 * while protecting sensitive database information.
 */

import AppError from './AppError.js';

class DatabaseError extends AppError {
  constructor(prismaError, message = 'Database operation failed') {
    const { statusCode, code, userMessage, details } =
      DatabaseError.analyzePrismaError(prismaError);

    super(userMessage || message, statusCode, code, details);

    this.originalError = prismaError;
    this.errorCode = prismaError?.code;
    this.meta = prismaError?.meta;
  }

  /**
   * Analyze Prisma error and return structured information
   */
  static analyzePrismaError(error) {
    if (!error) {
      return {
        statusCode: 500,
        code: 'DATABASE_ERROR',
        userMessage: 'Database operation failed',
        details: null
      };
    }

    // Handle known Prisma error codes
    switch (error.code) {
      case 'P2002': // Unique constraint violation
        return {
          statusCode: 409,
          code: 'DUPLICATE_ENTRY',
          userMessage: 'A record with this information already exists',
          details: {
            constraint: error.meta?.target,
            conflictingFields: Array.isArray(error.meta?.target)
              ? error.meta.target
              : [error.meta?.target]
          }
        };

      case 'P2025': // Record not found
        return {
          statusCode: 404,
          code: 'RECORD_NOT_FOUND',
          userMessage: 'The requested record was not found',
          details: {
            model: error.meta?.modelName,
            cause: error.meta?.cause
          }
        };

      case 'P2003': // Foreign key constraint violation
        return {
          statusCode: 400,
          code: 'FOREIGN_KEY_VIOLATION',
          userMessage: 'Referenced record does not exist',
          details: {
            constraint: error.meta?.field_name,
            referencedTable: error.meta?.table
          }
        };

      case 'P2014': // Required relation missing
        return {
          statusCode: 400,
          code: 'REQUIRED_RELATION_MISSING',
          userMessage: 'Required related record is missing',
          details: {
            relation: error.meta?.relation_name
          }
        };

      case 'P2021': // Table does not exist
        return {
          statusCode: 500,
          code: 'TABLE_NOT_FOUND',
          userMessage: 'Database configuration error',
          details: null // Don't expose table names
        };

      case 'P2022': // Column does not exist
        return {
          statusCode: 500,
          code: 'COLUMN_NOT_FOUND',
          userMessage: 'Database configuration error',
          details: null // Don't expose column names
        };

      case 'P1008': // Operation timed out
        return {
          statusCode: 408,
          code: 'DATABASE_TIMEOUT',
          userMessage: 'Database operation timed out',
          details: null
        };

      case 'P1001': // Can't reach database server
        return {
          statusCode: 503,
          code: 'DATABASE_UNAVAILABLE',
          userMessage: 'Database service is currently unavailable',
          details: null
        };

      case 'P1002': // Database server unreachable
        return {
          statusCode: 503,
          code: 'DATABASE_CONNECTION_ERROR',
          userMessage: 'Unable to connect to database',
          details: null
        };

      default:
        // Generic database error
        return {
          statusCode: 500,
          code: 'DATABASE_ERROR',
          userMessage: 'An unexpected database error occurred',
          details:
            process.env.NODE_ENV === 'development'
              ? {
                  code: error.code,
                  message: error.message
                }
              : null
        };
    }
  }

  /**
   * Create DatabaseError from Prisma error
   */
  static fromPrismaError(prismaError, customMessage = null) {
    return new DatabaseError(prismaError, customMessage);
  }

  /**
   * Create DatabaseError for connection issues
   */
  static connectionFailed(_details = null) {
    return new DatabaseError(
      { code: 'P1002', message: 'Database connection failed' },
      'Unable to connect to database'
    );
  }

  /**
   * Create DatabaseError for transaction failures
   */
  static transactionFailed(reason = null) {
    return new DatabaseError(
      { code: 'TRANSACTION_FAILED', message: reason || 'Transaction failed' },
      'Database transaction could not be completed'
    );
  }

  /**
   * Convert to structured response format
   */
  toJSON() {
    const baseResponse = super.toJSON();

    return {
      ...baseResponse,
      error: {
        ...baseResponse.error,
        type: 'database',
        retryable: this.isRetryable()
      }
    };
  }

  /**
   * Determine if the error is potentially retryable
   */
  isRetryable() {
    const retryableCodes = ['P1008', 'P1001', 'P1002'];
    return retryableCodes.includes(this.errorCode) || this.statusCode >= 500;
  }
}

export default DatabaseError;
