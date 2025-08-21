/**
 * Controller Helper Utilities
 * Helper functions for controller operations
 */

/**
 * Extract ID from request parameters
 * @param {Object} request - Express request object
 * @returns {string} ID from params
 */
export const extractId = request => {
  const { id } = request.params;
  return id;
};

/**
 * Extract pagination data from request
 * @param {Object} request - Express request object
 * @returns {Object} Pagination data
 */
export const extractPagination = request => {
  const { page, limit, skip } = request.pagination || {};
  return { page, limit, skip };
};

/**
 * Extract account number from request parameters
 * @param {Object} request - Express request object
 * @returns {string} Account number from params
 */
export const extractAccountNumber = request => {
  const { accountNumber } = request.params;
  return accountNumber;
};
