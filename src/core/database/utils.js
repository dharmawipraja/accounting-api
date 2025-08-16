/**
 * Database Utilities
 * Helper functions for database operations and health checks
 */

import Decimal from 'decimal.js';

/**
 * Database connection health check
 * @param {Object} prismaClient - Prisma client instance
 * @returns {Promise<Object>} Health status
 */
export const checkDatabaseHealth = async prismaClient => {
  try {
    // Simple query to check database connectivity
    await prismaClient.$queryRaw`SELECT 1`;
    return { healthy: true, timestamp: new Date().toISOString() };
  } catch (error) {
    return {
      healthy: false,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
};

/**
 * Get database statistics
 * @param {Object} prismaClient - Prisma client instance
 * @returns {Promise<Object>} Database statistics
 */
export const getDatabaseStats = async prismaClient => {
  try {
    // This is a mock implementation - replace with actual database queries
    return {
      database: {
        activeConnections: 10,
        version: 'PostgreSQL 14'
      },
      tables: {
        total: 8,
        users: await prismaClient.user.count(),
        accountGeneral: await prismaClient.accountGeneral.count(),
        accountDetail: await prismaClient.accountDetail.count(),
        ledger: await prismaClient.ledger.count()
      }
    };
  } catch (error) {
    throw new Error(`Failed to get database statistics: ${error.message}`);
  }
};

/**
 * Pagination helper for database queries
 * @param {Object} options - Pagination options
 * @param {number} options.page - Page number (1-based)
 * @param {number} options.limit - Items per page
 * @returns {Object} Pagination parameters for Prisma
 */
export const paginate = ({ page = 1, limit = 10 } = {}) => {
  const parsedPage = Math.max(parseInt(page) || 1, 1);
  const parsedLimit = Math.min(Math.max(parseInt(limit) || 10, 1), 100);
  const skip = (parsedPage - 1) * parsedLimit;

  return {
    take: parsedLimit,
    skip,
    page: parsedPage,
    limit: parsedLimit
  };
};

/**
 * Build pagination metadata
 * @param {number} page - Current page
 * @param {number} limit - Items per page
 * @param {number} total - Total items
 * @returns {Object} Pagination metadata
 */
export const buildPaginationMeta = (page, limit, total) => {
  const totalPages = Math.ceil(total / limit);
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

/**
 * Format money value for database storage
 * @param {number|string} amount - Amount to format
 * @returns {Decimal} Decimal value
 */
export const formatMoneyForDb = amount => {
  return new Decimal(amount).toDecimalPlaces(2);
};

/**
 * Round money to 2 decimal places
 * @param {number|string|Decimal} amount - Amount to round
 * @returns {number} Rounded amount
 */
export const roundMoney = amount => {
  return new Decimal(amount).toDecimalPlaces(2).toNumber();
};

/**
 * Convert to Decimal for precise calculations
 * @param {number|string} value - Value to convert
 * @returns {Decimal} Decimal value
 */
export const toDecimal = value => {
  return new Decimal(value);
};

/**
 * Build where clause for text search
 * @param {string} searchTerm - Search term
 * @param {string[]} fields - Fields to search in
 * @returns {Object} Prisma where clause
 */
export const buildSearchWhere = (searchTerm, fields) => {
  if (!searchTerm) return {};

  return {
    OR: fields.map(field => ({
      [field]: {
        contains: searchTerm,
        mode: 'insensitive'
      }
    }))
  };
};

/**
 * Build date range filter
 * @param {Date|string} startDate - Start date
 * @param {Date|string} endDate - End date
 * @param {string} field - Date field name
 * @returns {Object} Prisma where clause
 */
export const buildDateRangeFilter = (startDate, endDate, field = 'createdAt') => {
  const filter = {};

  if (startDate) {
    filter[field] = { gte: new Date(startDate) };
  }

  if (endDate) {
    filter[field] = {
      ...filter[field],
      lte: new Date(endDate)
    };
  }

  return filter;
};
