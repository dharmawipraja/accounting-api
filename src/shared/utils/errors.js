/**
 * Centralized Error Utilities
 * Common error creation functions to reduce code duplication
 */

import { errors } from '../../core/errors/index.js';

/**
 * Create a 404 Not Found error
 * @param {string} message - Error message
 * @param {string} [code] - Error code
 * @returns {Error} Not found error
 */
export const createNotFoundError = (message = 'Resource not found') => {
  return errors.notFound(message);
};

/**
 * Create a 500 Internal Server error
 * @param {string} message - Error message
 * @param {string} [code] - Error code
 * @returns {Error} Internal server error
 */
export const createInternalError = (message = 'Internal server error') => {
  return errors.internal(message);
};

/**
 * Create a 400 Bad Request error
 * @param {string} message - Error message
 * @param {string} [code] - Error code
 * @returns {Error} Bad request error
 */
export const createBadRequestError = (message = 'Bad request') => {
  return errors.validation(message);
};

/**
 * Create a 403 Forbidden error
 * @param {string} message - Error message
 * @param {string} [code] - Error code
 * @returns {Error} Forbidden error
 */
export const createForbiddenError = (message = 'Forbidden') => {
  return errors.authorization(message);
};

/**
 * Create a 401 Unauthorized error
 * @param {string} message - Error message
 * @param {string} [code] - Error code
 * @returns {Error} Unauthorized error
 */
export const createUnauthorizedError = (message = 'Unauthorized') => {
  return errors.authentication(message);
};

/**
 * Create a 409 Conflict error
 * @param {string} message - Error message
 * @param {string} [code] - Error code
 * @returns {Error} Conflict error
 */
export const createConflictError = (message = 'Conflict') => {
  return errors.conflict(message);
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
