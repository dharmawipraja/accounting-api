/**
 * Validation Middleware and Utilities
 * Centralized validation logic using Zod
 */

import { z } from 'zod';
import ValidationError from '../errors/ValidationError.js';

/**
 * Safe validation with structured error handling
 * @param {z.ZodSchema} schema - Zod validation schema
 * @param {any} data - Data to validate
 * @returns {Object} Validation result with success/error info
 */
export function safeParse(schema, data) {
  try {
    const result = schema.parse(data);
    return { success: true, data: result };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        success: false,
        errors: error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message,
          code: err.code
        }))
      };
    }
    return {
      success: false,
      errors: [{ field: 'unknown', message: error.message, code: 'UNKNOWN_ERROR' }]
    };
  }
}

/**
 * Validation middleware factory
 * Creates middleware that validates request data using Zod schemas
 * @param {Object} schemas - Validation schemas for different parts of request
 * @param {z.ZodSchema} schemas.body - Body validation schema
 * @param {z.ZodSchema} schemas.params - Params validation schema
 * @param {z.ZodSchema} schemas.query - Query validation schema
 * @returns {Function} Middleware function
 */
export function validate(schemas = {}) {
  return async (request, _res, next) => {
    const errors = [];

    // Validate body
    if (schemas.body && request.body) {
      const result = safeParse(schemas.body, request.body);
      if (!result.success) {
        errors.push(...result.errors.map(err => ({ ...err, location: 'body' })));
      }
    }

    // Validate params
    if (schemas.params && request.params) {
      const result = safeParse(schemas.params, request.params);
      if (!result.success) {
        errors.push(...result.errors.map(err => ({ ...err, location: 'params' })));
      }
    }

    // Validate query
    if (schemas.query && request.query) {
      const result = safeParse(schemas.query, request.query);
      if (!result.success) {
        errors.push(...result.errors.map(err => ({ ...err, location: 'query' })));
      }
    }

    if (errors.length > 0) {
      console.log('============= Validation Errors =============', errors);
      const error = new ValidationError('Validation failed');
      error.details = { validationErrors: errors };
      throw error;
    }

    next();
  };
}
