/**
 * Validation Error Class
 *
 * Handles Zod validation errors and provides structured field-level
 * error information for client consumption.
 */

import AppError from './AppError.js';

class ValidationError extends AppError {
  constructor(zodError, message = 'Validation failed') {
    // Extract detailed field errors from Zod error
    const details = ValidationError.extractZodErrors(zodError);

    super(message, 400, 'VALIDATION_ERROR', details);

    this.originalError = zodError;
  }

  /**
   * Extract structured errors from Zod error object
   */
  static extractZodErrors(zodError) {
    if (!zodError?.errors) {
      return null;
    }

    return zodError.errors.map(err => {
      const field = err.path.join('.');

      return {
        field: field || 'unknown',
        message: err.message,
        code: err.code,
        received: err.received,
        expected: err.expected,
        path: err.path
      };
    });
  }

  /**
   * Create ValidationError from Zod parsing result
   */
  static fromZodError(zodError, customMessage = null) {
    const message = customMessage || 'Invalid input data provided';
    return new ValidationError(zodError, message);
  }

  /**
   * Create ValidationError for missing required fields
   */
  static missingFields(fields) {
    const details = fields.map(field => ({
      field,
      message: `${field} is required`,
      code: 'required'
    }));

    return new ValidationError(
      { errors: details.map(d => ({ path: [d.field], message: d.message, code: d.code })) },
      'Required fields are missing'
    );
  }

  /**
   * Create ValidationError for invalid field values
   */
  static invalidFields(fieldErrors) {
    const details = Object.entries(fieldErrors).map(([field, message]) => ({
      field,
      message,
      code: 'invalid'
    }));

    return new ValidationError(
      { errors: details.map(d => ({ path: [d.field], message: d.message, code: d.code })) },
      'Invalid field values provided'
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
        type: 'validation',
        fieldsWithErrors: this.details?.map(d => d.field) || []
      }
    };
  }
}

export default ValidationError;
