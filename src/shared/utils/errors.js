/**
 * Centralized Error Utilities
 * Common error creation functions to reduce code duplication
 */

import { errors } from '../../core/errors/index.js';
import { t } from '../i18n/index.js';

/**
 * Create a 404 Not Found error
 * @param {string} message - Error message
 * @param {string} [code] - Error code
 * @returns {Error} Not found error
 */
export const createNotFoundError = (message = t('http.notFound')) => {
  return errors.notFound(message);
};

/**
 * Create a 500 Internal Server error
 * @param {string} message - Error message
 * @param {string} [code] - Error code
 * @returns {Error} Internal server error
 */
export const createInternalError = (message = t('http.internalError')) => {
  return errors.internal(message);
};

/**
 * Create a 400 Bad Request error
 * @param {string} message - Error message
 * @param {string} [code] - Error code
 * @returns {Error} Bad request error
 */
export const createBadRequestError = (message = t('http.badRequest')) => {
  return errors.validation(message);
};

/**
 * Create a 403 Forbidden error
 * @param {string} message - Error message
 * @param {string} [code] - Error code
 * @returns {Error} Forbidden error
 */
export const createForbiddenError = (message = t('http.forbidden')) => {
  return errors.authorization(message);
};

/**
 * Create a 401 Unauthorized error
 * @param {string} message - Error message
 * @param {string} [code] - Error code
 * @returns {Error} Unauthorized error
 */
export const createUnauthorizedError = (message = t('http.unauthorized')) => {
  return errors.authentication(message);
};

/**
 * Create a 409 Conflict error
 * @param {string} message - Error message
 * @param {string} [code] - Error code
 * @returns {Error} Conflict error
 */
export const createConflictError = (message = t('http.conflict')) => {
  return errors.conflict(message);
};

/**
 * Common error factory based on resource operations
 */
export const resourceErrors = {
  notFound: resourceName => createNotFoundError(t('http.notFound')),
  createFailed: resourceName => createInternalError(t('http.internalError')),
  updateFailed: resourceName => createInternalError(t('http.internalError')),
  deleteFailed: resourceName => createInternalError(t('http.internalError')),
  retrieveFailed: resourceName => createInternalError(t('http.internalError')),
  listFailed: resourceName => createInternalError(t('http.internalError'))
};
