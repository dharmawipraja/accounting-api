/**
 * Common utility functions
 */

import { PaginationSchema } from '../schemas/index.js';

// Success response builder
export const createSuccessResponse = (data, meta = {}) => ({
  success: true,
  data,
  meta: {
    timestamp: new Date().toISOString(),
    ...meta
  }
});

// Pagination helper using Zod validation
export const getPaginationMeta = (page, limit, total) => {
  const totalPages = Math.ceil(total / limit);
  const hasNext = page < totalPages;
  const hasPrev = page > 1;

  return {
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext,
      hasPrev,
      nextPage: hasNext ? page + 1 : null,
      prevPage: hasPrev ? page - 1 : null
    }
  };
};

// Validate pagination parameters using Zod
export const validatePagination = query => {
  const result = PaginationSchema.safeParse(query);

  if (!result.success) {
    throw new Error(`Invalid pagination parameters: ${result.error.message}`);
  }

  const { page, limit } = result.data;
  const skip = (page - 1) * limit;

  return { page, limit, skip };
};

// Environment helpers
export const isDevelopment = () => process.env.NODE_ENV === 'development';
export const isProduction = () => process.env.NODE_ENV === 'production';
export const isTest = () => process.env.NODE_ENV === 'test';
