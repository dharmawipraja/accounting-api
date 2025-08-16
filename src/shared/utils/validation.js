/**
 * Schema Validation Utilities
 * Enhanced validation utilities with better error handling
 */

import { z } from 'zod';

/**
 * Enhanced safe parse with structured error formatting
 */
export const enhancedSafeParse = (schema, data, _options = {}) => {
  try {
    const result = schema.parse(data);
    return {
      success: true,
      data: result,
      errors: null
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const formattedErrors = (error.errors || error.issues || []).map(err => ({
        field: (err.path || []).join('.') || 'root',
        message: err.message,
        code: err.code,
        expected: err.expected || null,
        received: err.received || null
      }));

      return {
        success: false,
        data: null,
        errors: formattedErrors,
        errorCount: formattedErrors.length
      };
    }

    // Handle non-Zod errors
    return {
      success: false,
      data: null,
      errors: [
        {
          field: 'unknown',
          message: error.message || 'Unknown validation error',
          code: 'UNKNOWN_ERROR'
        }
      ],
      errorCount: 1
    };
  }
};

/**
 * Validate multiple schemas against different data
 */
export const validateMultiple = validations => {
  const results = [];
  let hasErrors = false;

  for (const { schema, data, name } of validations) {
    const result = enhancedSafeParse(schema, data);
    results.push({
      name: name || 'unnamed',
      ...result
    });

    if (!result.success) {
      hasErrors = true;
    }
  }

  return {
    success: !hasErrors,
    results,
    totalErrors: results.reduce((sum, r) => sum + (r.errorCount || 0), 0)
  };
};

/**
 * Create a conditional schema based on another field
 */
export const createConditionalSchema = (
  conditionField,
  conditionValue,
  schemaIfTrue,
  schemaIfFalse
) => {
  return z.union([schemaIfTrue, schemaIfFalse]).superRefine((data, ctx) => {
    const shouldUseFirst = data[conditionField] === conditionValue;
    const targetSchema = shouldUseFirst ? schemaIfTrue : schemaIfFalse;

    const result = targetSchema.safeParse(data);
    if (!result.success) {
      result.error.errors.forEach(err => {
        ctx.addIssue({
          ...err,
          path: err.path
        });
      });
    }
  });
};

/**
 * Create a schema that validates array items with different schemas based on a field
 */
export const createPolymorphicArraySchema = (discriminatorField, schemaMap) => {
  return z.array(
    z.union([
      ...Object.entries(schemaMap).map(([key, schema]) =>
        schema.refine(
          data => data[discriminatorField] === key,
          `Invalid ${discriminatorField} for this schema type`
        )
      )
    ])
  );
};

/**
 * Merge schemas with conflict resolution
 */
export const mergeSchemas = (baseSchema, ...additionalSchemas) => {
  return additionalSchemas.reduce((merged, schema) => {
    return merged.merge(schema);
  }, baseSchema);
};

/**
 * Create a schema that validates nested objects recursively
 */
export const createDeepValidationSchema = schemaDefinition => {
  const createNestedSchema = def => {
    if (def instanceof z.ZodType) {
      return def;
    }

    if (Array.isArray(def)) {
      return z.array(createNestedSchema(def[0]));
    }

    if (typeof def === 'object' && def !== null) {
      const shape = {};
      for (const [key, value] of Object.entries(def)) {
        shape[key] = createNestedSchema(value);
      }
      return z.object(shape);
    }

    throw new Error(`Invalid schema definition: ${typeof def}`);
  };

  return createNestedSchema(schemaDefinition);
};

export default {
  enhancedSafeParse,
  validateMultiple,
  createConditionalSchema,
  createPolymorphicArraySchema,
  mergeSchemas,
  createDeepValidationSchema
};
