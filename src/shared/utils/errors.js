/**
 * Centralized Error Utilities
 * Common error creation functions to reduce code duplication
 */

import AppError from '../../core/errors/AppError.js';

/**
 * Create a 404 Not Found error
 * @param {string} message - Error message
 * @param {string} [code] - Error code
 * @returns {AppError} Not found error
 */
export const createNotFoundError = (message = 'Resource not found', code = 'NOT_FOUND') => {
  return new AppError(message, 404, code);
};

/**
 * Create a 500 Internal Server error
 * @param {string} message - Error message
 * @param {string} [code] - Error code
 * @returns {AppError} Internal server error
 */
export const createInternalError = (message = 'Internal server error', code = 'INTERNAL_ERROR') => {
  return new AppError(message, 500, code);
};

/**
 * Create a 400 Bad Request error
 * @param {string} message - Error message
 * @param {string} [code] - Error code
 * @returns {AppError} Bad request error
 */
export const createBadRequestError = (message = 'Bad request', code = 'BAD_REQUEST') => {
  return new AppError(message, 400, code);
};

/**
 * Create a 403 Forbidden error
 * @param {string} message - Error message
 * @param {string} [code] - Error code
 * @returns {AppError} Forbidden error
 */
export const createForbiddenError = (message = 'Forbidden', code = 'FORBIDDEN') => {
  return new AppError(message, 403, code);
};

/**
 * Create a 401 Unauthorized error
 * @param {string} message - Error message
 * @param {string} [code] - Error code
 * @returns {AppError} Unauthorized error
 */
export const createUnauthorizedError = (message = 'Unauthorized', code = 'UNAUTHORIZED') => {
  return new AppError(message, 401, code);
};

/**
 * Create a 409 Conflict error
 * @param {string} message - Error message
 * @param {string} [code] - Error code
 * @returns {AppError} Conflict error
 */
export const createConflictError = (message = 'Conflict', code = 'CONFLICT') => {
  return new AppError(message, 409, code);
};

/**
 * Common error factory based on resource operations
 */
export const resourceErrors = {
  notFound: resourceName => createNotFoundError(`${resourceName} not found`),
  createFailed: resourceName =>
    createInternalError(`Failed to create ${resourceName.toLowerCase()}`),
  updateFailed: resourceName =>
    createInternalError(`Failed to update ${resourceName.toLowerCase()}`),
  deleteFailed: resourceName =>
    createInternalError(`Failed to delete ${resourceName.toLowerCase()}`),
  retrieveFailed: resourceName =>
    createInternalError(`Failed to retrieve ${resourceName.toLowerCase()}`),
  listFailed: resourceName =>
    createInternalError(`Failed to retrieve ${resourceName.toLowerCase()} list`)
};
