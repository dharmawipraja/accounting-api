/**
 * Response Utilities
 * Helper functions for creating consistent API responses
 */

/**
 * Create a success response
 * @param {*} data - Response data
 * @param {string} [message] - Optional success message
 * @returns {Object} Success response object
 */
export const createSuccessResponse = (data, message) => ({
  success: true,
  data,
  ...(message && { message })
});

/**
 * Create a paginated response
 * @param {Array} data - Array of items
 * @param {Object} pagination - Pagination metadata
 * @param {number} pagination.page - Current page
 * @param {number} pagination.limit - Items per page
 * @param {number} pagination.total - Total items
 * @param {number} pagination.pages - Total pages
 * @returns {Object} Paginated response object
 */
export const createPaginatedResponse = (data, pagination) => ({
  success: true,
  data,
  pagination
});

/**
 * Create an error response
 * @param {string} error - Error message
 * @param {number} statusCode - HTTP status code
 * @param {Object} [details] - Additional error details
 * @returns {Object} Error response object
 */
export const createErrorResponse = (error, statusCode, details) => ({
  success: false,
  error,
  statusCode,
  ...(details && { details })
});

/**
 * Calculate pagination metadata
 * @param {number} page - Current page
 * @param {number} limit - Items per page
 * @param {number} total - Total items
 * @returns {Object} Pagination metadata
 */
export const calculatePagination = (page, limit, total) => ({
  page,
  limit,
  total,
  pages: Math.ceil(total / limit),
  hasNext: page < Math.ceil(total / limit),
  hasPrev: page > 1
});
