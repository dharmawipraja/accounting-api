/**
 * Zod Validation Middleware
 *
 * Provides validation middleware functions for Fastify using Zod schemas
 * with enhanced error handling and type safety.
 */

import * as zodToOpenapiPkg from '@asteasolutions/zod-to-openapi';
import { extendZodWithOpenApi, getRefId, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

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
 * Create Fastify schema from Zod schema for OpenAPI/Swagger documentation
 * This helps maintain compatibility with Fastify's built-in schema system
 */
export const zodToJsonSchema = (zodSchema, opts = {}) => {
  try {
    // Ensure the Zod extension is applied once so `.openapi()` is available
    if (!globalThis.__zodToOpenApiExtended) {
      try {
        extendZodWithOpenApi(z);
      } catch (error) {
        console.warn('Zod OpenAPI extension already applied or not needed:', error);
        // ignore if already extended or not needed
      }
      globalThis.__zodToOpenApiExtended = true;
    }

    // Compatibility: use generateSchema if the package exposes it (older API), else use Generator
    const generateSchemaFn = zodToOpenapiPkg && zodToOpenapiPkg.generateSchema;
    if (typeof generateSchemaFn === 'function') {
      // Some versions expose a helper that directly converts a Zod schema
      return generateSchemaFn(zodSchema, { title: opts.title || 'Schema' });
    }

    // Create a generator with the provided schema as a definition
    const generator = new OpenApiGeneratorV3([zodSchema]);
    const components = generator.generateComponents();

    // If the schema was registered with a refId/name, return a $ref to it
    const refId = getRefId(zodSchema);
    if (refId && components && components.schemas && components.schemas[refId]) {
      return { $ref: `#/components/schemas/${refId}` };
    }

    // If the generator produced a single anonymous schema, return it directly
    if (components && components.schemas) {
      const keys = Object.keys(components.schemas);
      if (keys.length === 1) {
        return components.schemas[keys[0]];
      }
      // Multiple schemas produced; attempt to find a schema that matches by structural equality is expensive
      // Fallback: return the whole components object so callers that attach components can still use it
      return components;
    }

    return { type: 'object' };
  } catch (err) {
    console.error('Error generating JSON schema from Zod schema:', err);
    // Fallback to a generic object schema
    return { type: 'object' };
  }
};

export default {
  safeParse,
  zodToJsonSchema
};
