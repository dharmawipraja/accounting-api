/**
 * Common utility functions
 */

import Decimal from 'decimal.js';

// Re-export centralized utilities from shared modules
export {
  createErrorResponse,
  createPaginatedResponse,
  createSuccessResponse
} from '../shared/utils/response.js';

export { formatMoneyForDb, roundMoney, toDecimal } from '../core/database/utils.js';

// Sum an array of numeric/Decimal values using Decimal
export const sumDecimals = (arr = []) => {
  // Use local Decimal implementation to avoid circular dependency
  const localToDecimal = value => new Decimal(value || 0);
  return arr.reduce((acc, v) => acc.plus(localToDecimal(v)), new Decimal(0));
};
