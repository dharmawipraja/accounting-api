/**
 * Validation Error Class
 *
 * Handles validation errors and provides structured field-level
 * error information for client consumption.
 */

import AppError from './AppError.js';

class ValidationError extends AppError {
  constructor(validationErrors, message = 'Validation failed') {
    // Extract detailed field errors from validation error
    const details = ValidationError.extractValidationErrors(validationErrors);

    super(message, 400, 'VALIDATION_ERROR', details);

    this.originalError = validationErrors;
  }

  /**
   * Extract structured errors from validation error object
   */
  static extractValidationErrors(validationErrors) {
    if (!validationErrors?.errors) {
      return null;
    }

    return validationErrors.errors.map(err => {
      const field = err.path?.join?.('.') || err.path || err.field;

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
   * Create ValidationError from validation parsing result
   */
  static fromValidationError(validationErrors, customMessage = null) {
    const message = customMessage || 'Invalid input data provided';
    return new ValidationError(validationErrors, message);
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
