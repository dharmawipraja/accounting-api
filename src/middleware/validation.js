/**
 * Zod Validation Middleware
 *
 * Provides validation middleware functions for Fastify using Zod schemas
 * with enhanced error handling and type safety.
 */

import { z } from 'zod';

/**
 * Create validation middleware for request body
 */
export const validateBody = schema => {
  return async (request, reply) => {
    try {
      request.body = schema.parse(request.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const validationErrors = error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message,
          code: err.code
        }));

        return reply.status(400).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request body validation failed',
            details: validationErrors
          }
        });
      }

      request.log.error('Unexpected validation error:', error);
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error during validation'
        }
      });
    }
  };
};

/**
 * Create validation middleware for query parameters
 */
export const validateQuery = schema => {
  return async (request, reply) => {
    try {
      request.query = schema.parse(request.query);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const validationErrors = error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message,
          code: err.code
        }));

        return reply.status(400).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Query parameters validation failed',
            details: validationErrors
          }
        });
      }

      request.log.error('Unexpected validation error:', error);
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error during validation'
        }
      });
    }
  };
};

/**
 * Create validation middleware for URL parameters
 */
export const validateParams = schema => {
  return async (request, reply) => {
    try {
      request.params = schema.parse(request.params);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const validationErrors = error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message,
          code: err.code
        }));

        return reply.status(400).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'URL parameters validation failed',
            details: validationErrors
          }
        });
      }

      request.log.error('Unexpected validation error:', error);
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error during validation'
        }
      });
    }
  };
};

/**
 * Combined validation middleware for multiple parts of the request
 */
export const validate = ({ body, query, params } = {}) => {
  return async (request, reply) => {
    const errors = [];

    // Validate body if schema provided
    if (body) {
      try {
        request.body = body.parse(request.body);
      } catch (error) {
        if (error instanceof z.ZodError) {
          errors.push(
            ...error.errors.map(err => ({
              location: 'body',
              field: err.path.join('.'),
              message: err.message,
              code: err.code
            }))
          );
        } else {
          request.log.error('Unexpected body validation error:', error);
          throw error;
        }
      }
    }

    // Validate query if schema provided
    if (query) {
      try {
        request.query = query.parse(request.query);
      } catch (error) {
        if (error instanceof z.ZodError) {
          errors.push(
            ...error.errors.map(err => ({
              location: 'query',
              field: err.path.join('.'),
              message: err.message,
              code: err.code
            }))
          );
        } else {
          request.log.error('Unexpected query validation error:', error);
          throw error;
        }
      }
    }

    // Validate params if schema provided
    if (params) {
      try {
        request.params = params.parse(request.params);
      } catch (error) {
        if (error instanceof z.ZodError) {
          errors.push(
            ...error.errors.map(err => ({
              location: 'params',
              field: err.path.join('.'),
              message: err.message,
              code: err.code
            }))
          );
        } else {
          request.log.error('Unexpected params validation error:', error);
          throw error;
        }
      }
    }

    // Return validation errors if any
    if (errors.length > 0) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: errors
        }
      });
    }
  };
};

/**
 * Safe parsing utility that returns success/error result
 */
export const safeParse = (schema, data) => {
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
};

/**
 * Validation preHandler for Fastify routes
 * This can be used directly in route options
 */
export const validationPreHandler = schemas => {
  return async (request, reply) => {
    await validate(schemas)(request, reply);
  };
};

/**
 * Response validation (optional - for development/testing)
 * Validates response data before sending
 */
export const validateResponse = schema => {
  return async (request, reply, payload) => {
    const parsedPayload = typeof payload === 'string' ? JSON.parse(payload) : payload;

    try {
      schema.parse(parsedPayload);
      return payload;
    } catch (error) {
      if (error instanceof z.ZodError) {
        request.log.error('Response validation failed:', {
          errors: error.errors,
          payload: parsedPayload
        });
      } else {
        request.log.error('Response validation error:', error);
      }

      // In development, throw the error to help with debugging
      if (process.env.NODE_ENV === 'development') {
        throw error;
      }

      // In production, log but don't break the response
      return payload;
    }
  };
};

/**
 * Create Fastify schema from Zod schema for OpenAPI/Swagger documentation
 * This helps maintain compatibility with Fastify's built-in schema system
 */
export const zodToJsonSchema = zodSchema => {
  try {
    // This is a basic conversion - for complex schemas,
    // consider using a proper zod-to-json-schema library
    const sample = zodSchema.safeParse({});
    if (sample.success) {
      return { type: 'object' };
    }

    // For now, return a generic object schema
    // In a real implementation, you'd want a proper converter
    return { type: 'object' };
  } catch {
    return { type: 'object' };
  }
};

export default {
  validateBody,
  validateQuery,
  validateParams,
  validate,
  validationPreHandler,
  validateResponse,
  safeParse,
  zodToJsonSchema
};
