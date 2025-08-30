/**
 * Response Utilities
 * Helper functions for creating consistent API responses
 */

import { t } from '../i18n/index.js';

/**
 * Create a success response
 * @param {*} data - Response data
 * @param {string} [message] - Optional success message
 * @param {Object} [meta] - Optional metadata
 * @returns {Object} Success response object
 */
export const createSuccessResponse = (
  data,
  message = t('general.operationSuccessful'),
  meta = {}
) => ({
  success: true,
  message,
  data,
  ...meta
});

/**
 * Create a paginated response
 * @param {Array} data - Array of items
 * @param {Object} pagination - Pagination metadata
 * @param {string} [message] - Optional success message
 * @returns {Object} Paginated response object
 */
export const createPaginatedResponse = (
  data,
  pagination,
  message = t('general.dataRetrievedSuccessfully')
) => ({
  success: true,
  message,
  data,
  pagination
});

/**
 * Create an error response
 * @param {string} message - Error message
 * @param {string} [error] - Error type
 * @param {number} [statusCode] - HTTP status code
 * @param {Object} [details] - Additional error details
 * @returns {Object} Error response object
 */
export const createErrorResponse = (
  message,
  error = t('general.error'),
  statusCode = 500,
  details = null
) => {
  const response = {
    success: false,
    statusCode,
    error,
    message
  };

  if (details) {
    response.details = details;
  }

  return response;
};

/**
 * Build pagination metadata for responses (unified function)
 * @param {number} page - Current page
 * @param {number} limit - Items per page
 * @param {number} total - Total items
 * @returns {Object} Pagination metadata
 */
export const buildPaginationMeta = (page, limit, total) => {
  const totalPages = Math.ceil(total / limit) || 1;
  const hasNext = page < totalPages;
  const hasPrev = page > 1;

  return {
    page,
    limit,
    total,
    totalPages,
    hasNext,
    hasPrev,
    nextPage: hasNext ? page + 1 : null,
    prevPage: hasPrev ? page - 1 : null
  };
};
