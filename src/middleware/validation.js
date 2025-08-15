import { z } from 'zod';

// Validate and return structured result
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

export default {
  safeParse
};
