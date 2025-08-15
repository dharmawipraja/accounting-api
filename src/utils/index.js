/**
 * Common utility functions
 */

// lodash not required for decimal helpers (kept for other utils)
import Decimal from 'decimal.js';

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
// Pagination is provided by an in-repo plugin: src/plugins/pagination.js
// Keep the PaginationSchema for potential external validation or docs

// Environment helpers
export const isDevelopment = () => process.env.NODE_ENV === 'development';
export const isProduction = () => process.env.NODE_ENV === 'production';
export const isTest = () => process.env.NODE_ENV === 'test';

// Monetary helpers using Decimal.js to avoid floating point issues
export const toDecimal = value => {
  if (value instanceof Decimal) return value;
  // Accept strings, numbers, Prisma Decimal-like objects (with toString)
  if (value == null || value === '') return new Decimal(0);
  try {
    return new Decimal(value.toString());
  } catch {
    return new Decimal(0);
  }
};

// Round a value to `precision` decimals and return a Number (safe for JSON responses)
export const roundMoney = (value, precision = 2) => {
  const dec = toDecimal(value);
  return Number(dec.toFixed(precision));
};

// Return a string representation suitable for Prisma Decimal fields (preserves precision)
export const formatMoneyForDb = (value, precision = 2) => {
  const dec = toDecimal(value);
  // Keep a fixed scale when writing to DB to avoid precision surprises
  return dec.toFixed(precision);
};

// Sum an array of numeric/Decimal values using Decimal
export const sumDecimals = (arr = []) =>
  arr.reduce((acc, v) => acc.plus(toDecimal(v)), new Decimal(0));
