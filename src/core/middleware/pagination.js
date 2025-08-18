/**
 * Pagination Middleware
 * Standardized pagination handling
 */

import { PAGINATION } from '../../shared/constants/index.js';

/**
 * Parse and validate pagination parameters from query
 * Decorates request with parsed pagination data
 * @param {Object} options - Pagination options
 * @param {number} options.defaultLimit - Default items per page
 * @param {number} options.maxLimit - Maximum items per page
 * @returns {Function} Middleware function
 */
export function parsePagination(options = {}) {
  const { defaultLimit = PAGINATION.DEFAULT_LIMIT, maxLimit = PAGINATION.MAX_LIMIT } = options;

  return async (request, _res, next) => {
    const query = request.query || {};

    let page = parseInt(query.page) || 1;
    let limit = parseInt(query.limit) || defaultLimit;

    // Validate and clamp values
    if (page < 1) page = 1;
    if (limit < PAGINATION.MIN_LIMIT) limit = defaultLimit;
    if (limit > maxLimit) limit = maxLimit;

    const skip = (page - 1) * limit;

    // Add pagination data to request
    request.pagination = {
      page,
      limit,
      skip,
      defaultLimit,
      maxLimit
    };

    next();
  };
}

/**
 * Build pagination metadata for responses
 * @param {number} page - Current page
 * @param {number} limit - Items per page
 * @param {number} total - Total items
 * @returns {Object} Pagination metadata
 */
export function buildPaginationMeta(page, limit, total) {
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
}
